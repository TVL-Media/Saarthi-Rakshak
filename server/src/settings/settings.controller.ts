import { Body, Controller, Get, HttpCode, Patch, Req } from '@nestjs/common';
import { z } from 'zod';
import { NoAudit, Roles } from '../auth/auth.decorators';
import { parseBody, requestMeta, type HttpRequest } from '../common/http';
import { DEFAULT_SETTINGS, type SettingKey } from './default-settings';
import { SettingsService } from './settings.service';

// Every setting: a whole number inside its own range. Unknown keys are refused.
const valuesSchema = z
  .object(
    Object.fromEntries(
      (Object.keys(DEFAULT_SETTINGS) as SettingKey[]).map((key) => [
        key,
        z
          .number({ error: 'Must be a whole number' })
          .int({ error: 'Must be a whole number' })
          .min(DEFAULT_SETTINGS[key].min, { error: `Must be ${DEFAULT_SETTINGS[key].min} or more` })
          .max(DEFAULT_SETTINGS[key].max, { error: `Must be ${DEFAULT_SETTINGS[key].max} or less` })
          .optional(),
      ]),
    ) as Record<SettingKey, z.ZodOptional<z.ZodNumber>>,
  )
  .strict();

const changeSchema = z.object({
  version: z.string(),
  reason: z.string().trim().min(10, { error: 'Write a reason (at least 10 characters)' }).max(500),
  values: valuesSchema,
});

/** Settings (Super Admin only). */
@Roles('super_admin')
@Controller('admin/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** A view: written to the audit log by the audit step. */
  @Get()
  view() {
    return this.settings.view();
  }

  // Writes its own named audit rows (settings.changed, with before/after and the reason).
  @NoAudit()
  @Patch()
  @HttpCode(200)
  async change(@Body() body: unknown, @Req() req: HttpRequest) {
    const input = parseBody(changeSchema, body);
    return this.settings.change(req.admin!, input, requestMeta(req));
  }
}
