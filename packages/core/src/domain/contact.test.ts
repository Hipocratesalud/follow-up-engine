import { describe, expect, it } from 'vitest';
import { compareCommunicationVersions, type ContactCommunication } from './contact.ts';
import type { CaseId, ClinicId, ContactRequestId, PatientId } from './ids.ts';

const base: ContactCommunication = {
  id: 'wa-1',
  clinicId: 'c' as ClinicId,
  patientId: 'p' as PatientId,
  caseId: 'case-1' as CaseId,
  requestId: 'cr-1' as ContactRequestId,
  status: 'completed',
  outcome: 'delivered',
  sender: { type: 'host' },
  recordedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('compareCommunicationVersions', () => {
  it('orders numeric versions, whatever the content', () => {
    const v2 = { ...base, versionId: '2', outcome: 'replied' as const };
    expect(compareCommunicationVersions(v2, { ...base, versionId: '1' })).toBe(1);
    expect(compareCommunicationVersions({ ...base, versionId: '1' }, v2)).toBe(-1);
    expect(compareCommunicationVersions({ ...v2, outcome: 'read' }, v2)).toBe(0);
  });

  it('falls back to lastUpdated, then to the content', () => {
    const earlier = { ...base, lastUpdated: new Date('2026-01-02T00:00:00.000Z') };
    const later = { ...base, lastUpdated: new Date('2026-01-03T00:00:00.000Z') };
    expect(compareCommunicationVersions(earlier, later)).toBe(-1);
    expect(compareCommunicationVersions(later, earlier)).toBe(1);
    expect(compareCommunicationVersions(base, { ...base })).toBe(0);
    expect(compareCommunicationVersions({ ...base, outcome: 'replied' }, base)).toBe(1);
  });
});
