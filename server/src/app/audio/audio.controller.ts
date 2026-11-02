import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ClipUploadRequest,
  KeepClipRequest,
  SaveClipRequest,
  type AudioClip,
  type ClipLink,
  type UploadLink,
} from '@sarthi/shared';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AudioService } from './audio.service';

const uuid = (what: string) =>
  new ParseUUIDPipe({ exceptionFactory: () => appError.notFound(`${what} not found.`) });

@Controller('v1')
export class AudioController {
  constructor(private readonly audio: AudioService) {}

  @Post('sos/:id/audio-upload')
  @HttpCode(200)
  uploadLink(
    @Req() req: AppRequest,
    @Param('id', uuid('SOS')) id: string,
    @Body() body: unknown,
  ): Promise<UploadLink> {
    return this.audio.uploadLink(req.user!.id, id, parseAppBody(ClipUploadRequest, body));
  }

  @Post('sos/:id/audio')
  @HttpCode(200)
  save(
    @Req() req: AppRequest,
    @Param('id', uuid('SOS')) id: string,
    @Body() body: unknown,
  ): Promise<AudioClip> {
    return this.audio.save(req.user!.id, id, parseAppBody(SaveClipRequest, body));
  }

  @Patch('audio/:id')
  keep(
    @Req() req: AppRequest,
    @Param('id', uuid('Clip')) id: string,
    @Body() body: unknown,
  ): Promise<AudioClip> {
    return this.audio.keep(req.user!.id, id, parseAppBody(KeepClipRequest, body).keep);
  }

  @Get('audio/:id/play')
  play(@Req() req: AppRequest, @Param('id', uuid('Clip')) id: string): Promise<ClipLink> {
    return this.audio.playLink(req.user!.id, id);
  }
}
