import { SetMetadata } from '@nestjs/common';
import type { SessionStage } from '../database/types';

export const IS_PUBLIC = 'auth:public';
export const ALLOWED_STAGES = 'auth:stages';
export const ROLES = 'auth:roles';
export const NO_AUDIT = 'audit:skip';

/** No session needed (only the login route). Every other /admin route needs one. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Which session stages may call the route. Default: only a full (finished) login. */
export const AllowStages = (...stages: SessionStage[]) => SetMetadata(ALLOWED_STAGES, stages);

/** Which roles may call the route. Default: any admin. Checked on the server. */
export const Roles = (...roles: ('super_admin' | 'support_admin')[]) => SetMetadata(ROLES, roles);

/**
 * A background check by the panel (like /me every minute). It does not count as activity, so it
 * never keeps an idle session alive past the 30-minute auto logout.
 */
export const PASSIVE = 'auth:passive';
export const Passive = () => SetMetadata(PASSIVE, true);

/**
 * Do not write a per-request audit row: for background refreshes (like /me), and for routes
 * that write their own named audit events.
 */
export const NoAudit = () => SetMetadata(NO_AUDIT, true);
