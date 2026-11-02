import { Body, Controller, HttpCode, Patch, Post, Put, Req } from '@nestjs/common';
import {
  DeviceRequest,
  PhotoUploadRequest,
  SavePhotoRequest,
  UpdateProfileRequest,
  type Me,
  type UploadLink,
} from '@sarthi/shared';
import { parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { ProfileService } from './profile.service';

/** Upload links per user per hour. */
export const PHOTO_UPLOADS_PER_HOUR = 10;

@Controller('v1/me')
export class ProfileController {
  constructor(
    private readonly profile: ProfileService,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  @Patch()
  update(@Req() req: AppRequest, @Body() body: unknown): Promise<Me> {
    return this.profile.update(req.user!.id, parseAppBody(UpdateProfileRequest, body));
  }

  @Post('photo-upload')
  @HttpCode(200)
  async photoUpload(@Req() req: AppRequest, @Body() body: unknown): Promise<UploadLink> {
    const { sizeBytes } = parseAppBody(PhotoUploadRequest, body);
    await this.rateLimiter.check(`photo:${req.user!.id}`, PHOTO_UPLOADS_PER_HOUR, 3600);
    return this.profile.photoUploadLink(req.user!.id, sizeBytes);
  }

  @Post('photo')
  @HttpCode(200)
  savePhoto(@Req() req: AppRequest, @Body() body: unknown): Promise<Me> {
    const { key } = parseAppBody(SavePhotoRequest, body);
    return this.profile.savePhoto(req.user!.id, key);
  }

  @Put('device')
  @HttpCode(204)
  async device(@Req() req: AppRequest, @Body() body: unknown): Promise<void> {
    await this.profile.saveDevice(
      req.user!.id,
      req.user!.sessionId,
      parseAppBody(DeviceRequest, body),
    );
  }
}
