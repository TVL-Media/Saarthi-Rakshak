import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { SavePlaceRequest, type SavedPlace } from '@sarthi/shared';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { PlacesService } from './places.service';

@Controller('v1/places')
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get()
  list(@Req() req: AppRequest): Promise<SavedPlace[]> {
    return this.places.list(req.user!.id);
  }

  @Post()
  @HttpCode(200)
  save(@Req() req: AppRequest, @Body() body: unknown): Promise<SavedPlace> {
    return this.places.save(req.user!.id, parseAppBody(SavePlaceRequest, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Req() req: AppRequest,
    @Param(
      'id',
      new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('Place not found.') }),
    )
    id: string,
  ): Promise<void> {
    await this.places.remove(req.user!.id, id);
  }
}
