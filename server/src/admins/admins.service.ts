import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';
import type { AuthedAdmin, RequestMeta } from '../common/http';
import { DatabaseService } from '../database/database.module';

@Injectable()
export class AdminsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  /** The admin team (no password or 2-step secrets). */
  async list() {
    const rows = await this.database.db
      .selectFrom('admins')
      .select(['id', 'name', 'email', 'role', 'status', 'last_login_at', 'totp_enabled_at'])
      .orderBy('created_at')
      .execute();
    return rows.map(({ totp_enabled_at, ...admin }) => ({
      ...admin,
      twoStepEnabled: totp_enabled_at !== null,
    }));
  }

  /**
   * A Super Admin resets a Support Admin's 2-step setup (lost phone). The Support Admin sets it
   * up again at next login. Super Admins are reset only with `pnpm app:setup --reissue`.
   */
  async resetTwoStep(
    actor: AuthedAdmin,
    targetId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    const target = await this.database.db
      .selectFrom('admins')
      .select(['id', 'role'])
      .where('id', '=', targetId)
      .executeTakeFirst();
    if (!target) throw new NotFoundException('Admin not found');
    if (target.id === actor.id)
      throw new BadRequestException('You cannot reset your own 2-step setup');
    if (target.role !== 'support_admin') {
      throw new ForbiddenException(
        "Only a Support Admin's 2-step setup can be reset here. For a Super Admin, use --reissue on the server.",
      );
    }

    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('admins')
        .set({ totp_secret_encrypted: null, totp_enabled_at: null, totp_last_step: null })
        .where('id', '=', target.id)
        .execute();
      await trx.deleteFrom('admin_backup_codes').where('admin_id', '=', target.id).execute();
      await this.sessions.endAllForAdmin(target.id, '2-step setup reset', undefined, trx);
      await this.audit.record(
        {
          action: 'admin.2fa_reset',
          admin_id: actor.id,
          session_id: actor.sessionId,
          target_type: 'admin',
          target_id: target.id,
          reason,
        },
        meta,
        trx,
      );
    });
  }
}
