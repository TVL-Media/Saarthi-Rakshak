import { hkdfSync, randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Req,
} from '@nestjs/common';
import {
  RakshakApplicationRequest,
  RakshakDocumentUploadRequest,
  type RakshakApplication,
  type UploadLink,
} from '@sarthi/shared';
import { decrypt, encrypt } from '../../auth/crypto-box';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import { StorageService, UPLOAD_LINK_SECONDS } from '../../storage/storage.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';

const DOC_TYPE = 'image/jpeg';
const MAX_DOC_BYTES = 3 * 1024 * 1024;
const CONTEXT = 'rakshak-application';

/** Storage key of a Rakshak document; the folder proves whose it is. */
export const rakshakDocKey = (userId: string, name: string) =>
  `rakshak/${userId}/${name}-${randomUUID()}.jpg`;

export interface RakshakDetails {
  fullName: string;
  dateOfBirth: string;
  address: string;
  motivation: string;
}

/**
 * The key for Rakshak details (derived from the server key; separate from the admin login keys).
 * Admins must read the details, so this is server-side encryption, not end-to-end.
 */
export function rakshakKey(env: Env): Buffer {
  if (!env.ADMIN_TOTP_ENCRYPTION_KEY)
    throw appError.serviceUnavailable('Rakshak sign-up is not set up.');
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(env.ADMIN_TOTP_ENCRYPTION_KEY, 'base64'),
      Buffer.alloc(0),
      'sarthi-rakshak rakshak-details aes-256-gcm v1',
      32,
    ),
  );
}

export const lockDetails = (env: Env, d: RakshakDetails) =>
  encrypt(rakshakKey(env), Buffer.from(JSON.stringify(d)), CONTEXT);
export const unlockDetails = (env: Env, stored: string) =>
  JSON.parse(decrypt(rakshakKey(env), stored, CONTEXT).toString('utf8')) as RakshakDetails;

export function ageOn(dateOfBirth: string, now = new Date()): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

const toApp = (r: {
  id: string;
  status: RakshakApplication['status'];
  reason: string | null;
  area: string;
  areas: string[];
  created_at: Date;
  decided_at: Date | null;
}): RakshakApplication => ({
  id: r.id,
  status: r.status,
  reason: r.status === 'rejected' ? r.reason : null,
  area: r.area,
  areas: r.areas,
  createdAt: new Date(r.created_at).toISOString(),
  decidedAt: r.decided_at?.toISOString() ?? null,
});

/** Rakshak sign-up (feature 24): applications reviewed by hand; no Rakshak features yet. */
@Injectable()
export class RakshakService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly rateLimiter: AppRateLimiter,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async documentUpload(userId: string, input: RakshakDocumentUploadRequest): Promise<UploadLink> {
    await this.rateLimiter.check(`rakshak-doc:${userId}`, 20, 3600);
    const key = rakshakDocKey(userId, input.document);
    const uploadUrl = await this.storage.uploadUrl(key, DOC_TYPE, input.sizeBytes);
    return {
      key,
      uploadUrl,
      headers: { 'Content-Type': DOC_TYPE, 'Content-Length': String(input.sizeBytes) },
      expiresAt: new Date(Date.now() + UPLOAD_LINK_SECONDS * 1000).toISOString(),
    };
  }

  async apply(userId: string, input: RakshakApplicationRequest): Promise<RakshakApplication> {
    if (ageOn(input.dateOfBirth) < 18)
      throw appError.invalidInput('You must be 18 or older to apply.');
    const open = await this.current(userId);
    if (open && (open.status === 'under_review' || open.status === 'approved')) {
      throw appError.conflict('You already have an application.');
    }
    for (const [name, key] of Object.entries(input.documents)) {
      if (!key.startsWith(`rakshak/${userId}/${name}-`) || key.includes('..')) {
        throw appError.invalidInput(`documents.${name}: Not an upload made for you.`);
      }
      const file = await this.storage.info(key);
      if (!file) throw appError.invalidInput(`documents.${name}: Nothing was uploaded yet.`);
      if (file.contentType !== DOC_TYPE || file.sizeBytes > MAX_DOC_BYTES) {
        throw appError.invalidInput(`documents.${name}: Must be a JPEG photo of at most 3 MB.`);
      }
    }
    // Up to 5 areas; an app from before multi-area sends only `area`. The first is the main one.
    const areas = input.areas ?? [input.area];
    const row = await this.database.db
      .insertInto('rakshak_applications')
      .values({
        user_id: userId,
        locked_details: lockDetails(this.env, {
          fullName: input.fullName,
          dateOfBirth: input.dateOfBirth,
          address: input.address,
          motivation: input.motivation,
        }),
        area: areas[0],
        areas,
        id_type: input.idType,
        id_last4: input.idLast4,
        documents: JSON.stringify(input.documents),
        consent_at: new Date(),
      })
      .returning(['id', 'status', 'reason', 'area', 'areas', 'created_at', 'decided_at'])
      .executeTakeFirstOrThrow();
    return toApp(row);
  }

  async get(userId: string): Promise<RakshakApplication | null> {
    const row = await this.current(userId);
    return row ? toApp(row) : null;
  }

  /** Withdraw: the application details and documents are deleted at once. */
  async withdraw(userId: string): Promise<void> {
    const rows = await this.database.db
      .selectFrom('rakshak_applications')
      .select(['id', 'documents'])
      .where('user_id', '=', userId)
      .execute();
    if (rows.length === 0) throw appError.notFound('No application.');
    for (const r of rows) await this.deleteDocuments(r.documents);
    await this.database.db
      .deleteFrom('rakshak_applications')
      .where('user_id', '=', userId)
      .execute();
  }

  async deleteDocuments(documents: unknown): Promise<void> {
    for (const key of Object.values((documents ?? {}) as Record<string, string>)) {
      await this.storage.delete(key).catch(() => undefined);
    }
  }

  private current(userId: string) {
    return this.database.db
      .selectFrom('rakshak_applications')
      .select(['id', 'status', 'reason', 'area', 'areas', 'created_at', 'decided_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }
}

@Controller('v1/rakshak')
export class RakshakController {
  constructor(private readonly rakshak: RakshakService) {}

  @Post('document-upload')
  @HttpCode(200)
  upload(@Req() req: AppRequest, @Body() body: unknown): Promise<UploadLink> {
    return this.rakshak.documentUpload(
      req.user!.id,
      parseAppBody(RakshakDocumentUploadRequest, body),
    );
  }

  @Post('application')
  @HttpCode(200)
  apply(@Req() req: AppRequest, @Body() body: unknown): Promise<RakshakApplication> {
    return this.rakshak.apply(req.user!.id, parseAppBody(RakshakApplicationRequest, body));
  }

  @Get('application')
  async get(@Req() req: AppRequest): Promise<{ application: RakshakApplication | null }> {
    return { application: await this.rakshak.get(req.user!.id) };
  }

  @Delete('application')
  @HttpCode(204)
  async withdraw(@Req() req: AppRequest): Promise<void> {
    await this.rakshak.withdraw(req.user!.id);
  }
}
