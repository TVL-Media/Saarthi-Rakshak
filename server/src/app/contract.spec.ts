import {
  AddGuardianRequest,
  LocationsRequest,
  StartSosRequest,
  UpdateProfileRequest,
} from '@sarthi/shared';

const id = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('API contract (@sarthi/shared)', () => {
  it('accepts a valid SOS start and refuses an unknown trigger', () => {
    const sos = { id, trigger: 'button', isTest: false, startedAt: '2026-10-27T18:30:00+05:30' };
    expect(StartSosRequest.safeParse(sos).success).toBe(true);
    expect(StartSosRequest.safeParse({ ...sos, trigger: 'shake' }).success).toBe(false);
  });

  it('needs sosId or journeyId on every location point', () => {
    const point = { clientPointId: id, lat: 28.57, lng: 77.32, recordedAt: '2026-10-27T13:00:00Z' };
    expect(LocationsRequest.safeParse({ points: [point] }).success).toBe(false);
    expect(LocationsRequest.safeParse({ points: [{ ...point, sosId: id }] }).success).toBe(true);
  });

  it('allows at most 50 points per batch', () => {
    const point = {
      clientPointId: id,
      sosId: id,
      lat: 0,
      lng: 0,
      recordedAt: '2026-10-27T13:00:00Z',
    };
    expect(LocationsRequest.safeParse({ points: Array(51).fill(point) }).success).toBe(false);
  });

  it('needs at least one field to change the profile; null clears the blood group', () => {
    expect(UpdateProfileRequest.safeParse({}).success).toBe(false);
    expect(UpdateProfileRequest.safeParse({ bloodGroup: null }).success).toBe(true);
    expect(UpdateProfileRequest.safeParse({ bloodGroup: 'C+' }).success).toBe(false);
  });

  it('trims guardian names and limits the relation to 40 characters', () => {
    const parsed = AddGuardianRequest.parse({ name: '  Ravi  ', phone: '98123 44521' });
    expect(parsed.name).toBe('Ravi');
    expect(
      AddGuardianRequest.safeParse({ name: 'Ravi', phone: '9812344521', relation: 'x'.repeat(41) })
        .success,
    ).toBe(false);
  });
});
