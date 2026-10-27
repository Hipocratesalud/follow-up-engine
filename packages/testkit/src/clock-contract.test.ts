import { FakeClock, SystemClock } from '@follow-up-engine/core';
import { describeClockContract } from './clock-contract.ts';

describeClockContract('SystemClock', () => new SystemClock());
describeClockContract('FakeClock', () => new FakeClock(new Date('2026-11-01T09:00:00.000Z')));
