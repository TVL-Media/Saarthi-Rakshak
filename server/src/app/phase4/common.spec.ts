import { distanceM, distanceToRouteM, newReference } from './common';

describe('Phase 4 helpers', () => {
  it('measures distance in metres', () => {
    // About 111 m for 0.001 degree of latitude.
    expect(Math.round(distanceM(28.57, 77.32, 28.571, 77.32))).toBeGreaterThan(105);
    expect(Math.round(distanceM(28.57, 77.32, 28.571, 77.32))).toBeLessThan(117);
    expect(distanceM(10, 10, 10, 10)).toBe(0);
  });

  it('measures how far a point is from a route, to the nearest segment', () => {
    const route: [number, number][] = [
      [28.57, 77.32],
      [28.58, 77.32],
    ];
    expect(distanceToRouteM(28.575, 77.32, route)).toBeLessThan(1);
    // About 100 m east of the middle of the route.
    const side = distanceToRouteM(28.575, 77.321, route);
    expect(side).toBeGreaterThan(90);
    expect(side).toBeLessThan(110);
    // Past the end: the distance is to the end point, not to the extended line.
    expect(distanceToRouteM(28.59, 77.32, route)).toBeGreaterThan(1000);
    expect(distanceToRouteM(28.57, 77.32, [])).toBe(Number.POSITIVE_INFINITY);
  });

  it('makes references without look-alike characters', () => {
    for (let i = 0; i < 50; i++) expect(newReference()).toMatch(/^SR-[A-HJ-NP-Z2-9]{8}$/);
  });
});
