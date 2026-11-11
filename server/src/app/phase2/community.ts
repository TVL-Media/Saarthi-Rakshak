import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  AreaName,
  CommunityPhotoUploadRequest,
  CommunityReportRequest,
  FlagPostRequest,
  MAX_SOS_PHOTO_BYTES,
  type CommunityPost,
  type MyCommunityReport,
  type UploadLink,
} from '@sarthi/shared';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.module';
import type { CommunityPostsTable } from '../../database/types';
import { StorageService, UPLOAD_LINK_SECONDS } from '../../storage/storage.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';

const PHOTO_TYPE = 'image/jpeg';
const PHOTO_LINK_SECONDS = 3600;
/** A published post flagged by this many users is hidden until an admin looks at it again. */
export const FLAGS_TO_HIDE = 3;

/** Noida areas offered in the app (users may also type another area). */
export const NOIDA_AREAS = [
  ...Array.from({ length: 168 }, (_, i) => `Sector ${i + 1}`),
  'Greater Noida West',
  'Noida Extension',
  'Film City',
];

export const communityPhotoKey = (owner: string, id: string) => `community/${owner}/${id}.jpg`;

type PostRow = Pick<
  CommunityPostsTable,
  'id' | 'category' | 'area' | 'body' | 'photo_key' | 'author_admin_id' | 'reason'
> & { status: 'pending' | 'published' | 'rejected' | 'removed'; created_at: Date };

/** Community safety feed (feature 23): nothing appears until an admin approves it. */
@Injectable()
export class CommunityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly settings: AppSettings,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  async toPost(r: PostRow): Promise<CommunityPost> {
    return {
      id: r.id,
      category: r.category,
      area: r.area,
      body: r.body,
      photoUrl: r.photo_key
        ? await this.storage.downloadUrl(r.photo_key, PHOTO_LINK_SECONDS)
        : null,
      official: r.author_admin_id !== null,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async published(area: string | undefined, before?: string): Promise<CommunityPost[]> {
    let q = this.database.db
      .selectFrom('community_posts')
      .selectAll()
      .where('status', '=', 'published');
    if (area) q = q.where((eb) => eb.or([eb('area', '=', area), eb('area', '=', 'All Noida')]));
    if (before) q = q.where('created_at', '<', new Date(before));
    const rows = await q.orderBy('created_at', 'desc').limit(30).execute();
    return Promise.all(rows.map((r) => this.toPost(r)));
  }

  async photoUploadLink(userId: string, sizeBytes: number): Promise<UploadLink> {
    await this.rateLimiter.check(`community-photo:${userId}`, 10, 3600);
    const key = communityPhotoKey(userId, randomUUID());
    const uploadUrl = await this.storage.uploadUrl(key, PHOTO_TYPE, sizeBytes);
    return {
      key,
      uploadUrl,
      headers: { 'Content-Type': PHOTO_TYPE, 'Content-Length': String(sizeBytes) },
      expiresAt: new Date(Date.now() + UPLOAD_LINK_SECONDS * 1000).toISOString(),
    };
  }

  async report(userId: string, input: CommunityReportRequest): Promise<MyCommunityReport> {
    const existing = await this.database.db
      .selectFrom('community_posts')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (existing) {
      if (existing.author_user_id !== userId)
        throw appError.conflict('This report id is already used.');
      return this.toMine(existing);
    }
    const perDay = await this.settings.get('community.reports_per_day');
    const { count } = await this.database.db
      .selectFrom('community_posts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('author_user_id', '=', userId)
      .where('created_at', '>', sql<Date>`now() - interval '1 day'`)
      .executeTakeFirstOrThrow();
    if (Number(count) >= perDay)
      throw appError.limitReached(`You can send up to ${perDay} reports a day.`);

    if (input.photoKey) {
      if (!input.photoKey.startsWith(`community/${userId}/`) || input.photoKey.includes('..')) {
        throw appError.invalidInput('photoKey: Not an upload made for you.');
      }
      const file = await this.storage.info(input.photoKey);
      if (!file) throw appError.invalidInput('photoKey: Nothing was uploaded with this link yet.');
      if (file.contentType !== PHOTO_TYPE || file.sizeBytes > MAX_SOS_PHOTO_BYTES) {
        await this.storage.delete(input.photoKey);
        throw appError.invalidInput('The photo must be a JPEG of at most 1 MB.');
      }
    }
    await this.database.db
      .insertInto('community_posts')
      .values({
        id: input.id,
        author_user_id: userId,
        category: input.category,
        area: input.area,
        body: input.body,
        photo_key: input.photoKey ?? null,
      })
      .execute();
    const row = await this.database.db
      .selectFrom('community_posts')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirstOrThrow();
    return this.toMine(row);
  }

  async mine(userId: string): Promise<MyCommunityReport[]> {
    const rows = await this.database.db
      .selectFrom('community_posts')
      .selectAll()
      .where('author_user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return Promise.all(rows.map((r) => this.toMine(r)));
  }

  /** "Flag this post": enough flags hide it until an admin reviews it again. */
  async flag(userId: string, postId: string, reason: string): Promise<void> {
    await this.rateLimiter.check(`community-flag:${userId}`, 20, 86_400);
    const post = await this.database.db
      .selectFrom('community_posts')
      .select(['status'])
      .where('id', '=', postId)
      .executeTakeFirst();
    if (!post || post.status !== 'published') throw appError.notFound('Post not found.');
    await this.database.db.transaction().execute(async (trx) => {
      const added = await trx
        .insertInto('community_flags')
        .values({ post_id: postId, user_id: userId, reason })
        .onConflict((oc) => oc.columns(['post_id', 'user_id']).doNothing())
        .executeTakeFirst();
      if (Number(added.numInsertedOrUpdatedRows ?? 0) === 0) return;
      await trx
        .updateTable('community_posts')
        .set((eb) => ({
          flags_count: eb('flags_count', '+', 1),
          status: sql`CASE WHEN flags_count + 1 >= ${FLAGS_TO_HIDE} THEN 'pending' ELSE status END`,
        }))
        .where('id', '=', postId)
        .execute();
    });
  }

  private async toMine(r: PostRow): Promise<MyCommunityReport> {
    return {
      ...(await this.toPost(r)),
      status: r.status,
      reason: r.status === 'rejected' ? r.reason : null,
    };
  }
}

const listQuery = z.object({
  area: AreaName.optional(),
  before: z.iso.datetime({ offset: true }).optional(),
});

@Controller('v1/community')
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Get('areas')
  areas(): { areas: string[] } {
    return { areas: NOIDA_AREAS };
  }

  @Get('posts')
  posts(@Query() query: unknown): Promise<CommunityPost[]> {
    const q = parseAppBody(listQuery, query);
    return this.community.published(q.area, q.before);
  }

  @Post('photo-upload')
  @HttpCode(200)
  photo(@Req() req: AppRequest, @Body() body: unknown): Promise<UploadLink> {
    return this.community.photoUploadLink(
      req.user!.id,
      parseAppBody(CommunityPhotoUploadRequest, body).sizeBytes,
    );
  }

  @Post('reports')
  @HttpCode(200)
  report(@Req() req: AppRequest, @Body() body: unknown): Promise<MyCommunityReport> {
    return this.community.report(req.user!.id, parseAppBody(CommunityReportRequest, body));
  }

  @Get('my-reports')
  mine(@Req() req: AppRequest): Promise<MyCommunityReport[]> {
    return this.community.mine(req.user!.id);
  }

  @Post('posts/:id/flag')
  @HttpCode(204)
  async flag(
    @Req() req: AppRequest,
    @Param(
      'id',
      new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('Post not found.') }),
    )
    id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.community.flag(req.user!.id, id, parseAppBody(FlagPostRequest, body).reason);
  }
}
