import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { SettingKey } from '../../settings/default-settings';
import { appError } from '../common/app-http';
import { AppSettings } from '../common/app-settings';

/** The staged-release switches: off means "not built yet" to the app ("Not available yet."). */
@Injectable()
export class Phase4Gate {
  constructor(private readonly settings: AppSettings) {}

  async require(...keys: SettingKey[]): Promise<void> {
    for (const key of keys) if ((await this.settings.get(key)) >= 1) return;
    throw appError.notFound('Not available yet.');
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A short reference the user can quote (no look-alike characters), e.g. SR-K7M2QX9D. */
export function newReference(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `SR-${out}`;
}

const EARTH_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Straight-line distance between two points in metres. */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** How far a point is from a route (a list of [lat, lng]), in metres. Fine for city-sized routes. */
export function distanceToRouteM(lat: number, lng: number, route: [number, number][]): number {
  if (route.length === 0) return Number.POSITIVE_INFINITY;
  if (route.length === 1) return distanceM(lat, lng, route[0][0], route[0][1]);
  const kx = Math.cos(rad(lat)) * EARTH_M * (Math.PI / 180);
  const ky = EARTH_M * (Math.PI / 180);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < route.length - 1; i++) {
    const ax = (route[i][1] - lng) * kx;
    const ay = (route[i][0] - lat) * ky;
    const bx = (route[i + 1][1] - lng) * kx;
    const by = (route[i + 1][0] - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
