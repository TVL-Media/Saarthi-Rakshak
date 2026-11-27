import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../../auth/auth.decorators';
import { parseBody, type HttpRequest } from '../../common/http';
import { CyberService } from './cyber';
import { GlassesService } from './glasses';
import { MonitoringService } from './monitoring';
import { PoliceHandoffService } from './police';
import { SafetyScoringService } from './safety';
import { SchoolService } from './school';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException('Not found') });
const reason = z.string().trim().min(5, { error: 'Write a reason (at least 5 characters)' }).max(500);

const schoolBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{4,20}$/, { error: 'Use 4 to 20 letters, numbers or dashes' }),
  name: z.string().trim().min(2).max(120),
  city: z.string().trim().max(80).nullish(),
});
const schoolStatus = z.object({ status: z.enum(['pending', 'verified', 'suspended']) });
const linkDecision = z.object({ status: z.enum(['pending', 'active', 'rejected', 'suspended']), note: z.string().trim().max(200).optional() });
const linkQuery = z.object({ status: z.enum(['requested', 'pending', 'active', 'rejected', 'suspended', 'revoked']).optional() });

const glassesBody = z.object({
  manufacturer: z.string().trim().min(2).max(60),
  model: z.string().trim().min(1).max(60),
  minFirmware: z.string().trim().min(1).max(40),
  sdkVersion: z.string().trim().max(40).nullish(),
  capabilities: z.array(z.string().trim().min(2).max(30)).max(12).default([]),
  knownLimits: z.string().trim().max(300).nullish(),
  supported: z.boolean().default(true),
});

const datasetBody = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['incident', 'lighting', 'activity', 'support_point']),
  source: z.string().trim().min(2).max(200),
  licence: z.string().trim().min(2).max(200),
  refreshDays: z.number().int().min(1).max(3650).default(90),
});
const datasetStatus = z.object({ status: z.enum(['draft', 'active', 'paused']) });
const importBody = z.object({ records: z.array(z.unknown()).min(1).max(5000) });
const modelBody = z.object({
  version: z.string().trim().min(1).max(30),
  activate: z.boolean().default(false),
  config: z.object({
    radiusM: z.number().min(20).max(1000),
    sampleEveryM: z.number().min(25).max(500),
    minCoverage: z.number().int().min(1).max(100),
    coverageRadiusM: z.number().min(50).max(2000).optional(),
    scale: z.number().min(1).max(100).optional(),
    categoryWeights: z.record(z.string(), z.number().min(-2).max(2)),
    halfLifeDays: z.number().min(1).max(3650),
    bands: z.array(z.tuple([z.number(), z.string()])).min(1).max(6),
  }),
});
const feedbackReview = z.object({ status: z.enum(['reviewed', 'actioned', 'rejected']) });

const endpointBody = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['erss', 'cctns']),
  jurisdiction: z.string().trim().min(2).max(120),
  environment: z.enum(['sandbox', 'production']),
  baseUrl: z.url({ error: 'Enter the endpoint address' }),
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/, { error: 'Use the secret’s name, e.g. ERSS_SANDBOX_TOKEN' }),
  credentialOwner: z.string().trim().min(2).max(120),
  credentialExpiresAt: z.iso.datetime({ offset: true }).nullish(),
  permittedOps: z.array(z.enum(['send_event', 'verify'])).min(1),
  permittedFields: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
const enabledBody = z.object({ enabled: z.boolean() });
const verifyBody = z.object({ purpose: reason, fields: z.record(z.string(), z.string().trim().min(1).max(80)) });
const ackBody = z.object({ reason });

@Controller('admin/phase4b')
export class AdminServicesController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly school: SchoolService,
    private readonly cyber: CyberService,
    private readonly glasses: GlassesService,
    private readonly safety: SafetyScoringService,
    private readonly police: PoliceHandoffService,
  ) {}

  // P4-06: metadata only, never a location
  @Get('monitoring')
  monitoringList() {
    return this.monitoring.adminList();
  }

  // P4-08: counts only
  @Get('cyber')
  cyberSummary() {
    return this.cyber.adminSummary();
  }

  // P4-07
  @Get('schools')
  schools() {
    return this.school.adminSchools();
  }

  @Roles('super_admin')
  @Post('schools')
  @HttpCode(200)
  createSchool(@Body() body: unknown) {
    return this.school.createSchool(parseBody(schoolBody, body));
  }

  @Roles('super_admin')
  @Post('schools/:id/status')
  @HttpCode(200)
  schoolStatusSet(@Param('id', uuid) id: string, @Body() body: unknown) {
    return this.school.setSchoolStatus(id, parseBody(schoolStatus, body).status);
  }

  @Roles('super_admin')
  @Post('schools/:id/rotate-key')
  @HttpCode(200)
  rotate(@Param('id', uuid) id: string) {
    return this.school.rotateKey(id);
  }

  @Get('school-links')
  schoolLinks(@Query() query: unknown) {
    return this.school.adminLinks(parseBody(linkQuery, query).status);
  }

  @Post('school-links/:id/decision')
  @HttpCode(200)
  decide(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    const b = parseBody(linkDecision, body);
    return this.school.decideLink(req.admin!.id, id, b.status, b.note);
  }

  @Get('school-quarantine')
  quarantine() {
    return this.school.quarantineList();
  }

  // P4-12
  @Get('glasses-models')
  glassesModels() {
    return this.glasses.adminModels();
  }

  @Roles('super_admin')
  @Post('glasses-models')
  @HttpCode(200)
  addGlasses(@Body() body: unknown) {
    return this.glasses.saveModel(null, parseBody(glassesBody, body));
  }

  @Roles('super_admin')
  @Put('glasses-models/:id')
  updateGlasses(@Param('id', uuid) id: string, @Body() body: unknown) {
    return this.glasses.saveModel(id, parseBody(glassesBody, body));
  }

  // P4-13
  @Get('safety/datasets')
  datasets() {
    return this.safety.datasets();
  }

  @Roles('super_admin')
  @Post('safety/datasets')
  @HttpCode(200)
  createDataset(@Body() body: unknown) {
    return this.safety.createDataset(parseBody(datasetBody, body));
  }

  @Roles('super_admin')
  @Post('safety/datasets/:id/status')
  @HttpCode(200)
  datasetStatusSet(@Param('id', uuid) id: string, @Body() body: unknown) {
    return this.safety.setDatasetStatus(id, parseBody(datasetStatus, body).status);
  }

  @Roles('super_admin')
  @Post('safety/datasets/:id/import')
  @HttpCode(200)
  importRecords(@Param('id', uuid) id: string, @Body() body: unknown) {
    return this.safety.importRecords(id, parseBody(importBody, body).records);
  }

  @Get('safety/models')
  safetyModels() {
    return this.safety.models();
  }

  @Roles('super_admin')
  @Post('safety/models')
  @HttpCode(200)
  addModel(@Body() body: unknown) {
    const b = parseBody(modelBody, body);
    return this.safety.addModel(b.version, b.config, b.activate);
  }

  @Roles('super_admin')
  @Post('safety/models/:id/activate')
  @HttpCode(200)
  activate(@Param('id', uuid) id: string) {
    return this.safety.activateModel(id);
  }

  @Get('safety/feedback')
  feedback() {
    return this.safety.feedbackQueue();
  }

  @Post('safety/feedback/:id/review')
  @HttpCode(200)
  reviewFeedback(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.safety.reviewFeedback(req.admin!.id, id, parseBody(feedbackReview, body).status);
  }

  // P4-14
  @Roles('super_admin')
  @Get('authority/endpoints')
  endpoints() {
    return this.police.endpoints();
  }

  @Roles('super_admin')
  @Post('authority/endpoints')
  @HttpCode(200)
  createEndpoint(@Body() body: unknown) {
    return this.police.createEndpoint(parseBody(endpointBody, body));
  }

  @Roles('super_admin')
  @Post('authority/endpoints/:id/enabled')
  @HttpCode(200)
  setEnabled(@Param('id', uuid) id: string, @Body() body: unknown) {
    return this.police.setEnabled(id, parseBody(enabledBody, body).enabled);
  }

  @Roles('super_admin')
  @Post('authority/endpoints/:id/sandbox-passed')
  @HttpCode(200)
  sandbox(@Param('id', uuid) id: string) {
    return this.police.markSandboxPassed(id);
  }

  @Roles('super_admin')
  @Post('authority/endpoints/:id/health')
  @HttpCode(200)
  health(@Param('id', uuid) id: string) {
    return this.police.health(id);
  }

  @Get('authority/attempts')
  attempts() {
    return this.police.attempts();
  }

  @Post('authority/attempts/:id/fallback')
  @HttpCode(200)
  fallback(@Param('id', uuid) id: string) {
    return this.police.manualFallback(id);
  }

  @Roles('super_admin')
  @Post('authority/attempts/:id/acknowledged')
  @HttpCode(200)
  acknowledged(@Param('id', uuid) id: string, @Body() body: unknown) {
    parseBody(ackBody, body);
    return this.police.markAcknowledged(id);
  }

  @Roles('super_admin')
  @Post('authority/endpoints/:id/verify')
  @HttpCode(200)
  verify(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    const b = parseBody(verifyBody, body);
    return this.police.verify(req.admin!.id, id, b.purpose, b.fields);
  }

  @Roles('super_admin')
  @Get('authority/queries')
  queries() {
    return this.police.queries();
  }
}
