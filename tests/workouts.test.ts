import assert from 'node:assert/strict';
import test from 'node:test';
import type TonalClient from '@dlwiest/ts-tonal-client';
import type { TonalActivitySummary } from '@dlwiest/ts-tonal-client';
import { getRecentWorkouts } from '../src/tools/workouts.js';
import type { MCPResponse } from '../src/types/index.js';

function fakeClient(methods: Record<string, unknown>): TonalClient {
  return methods as unknown as TonalClient;
}

function reportText(response: MCPResponse): string {
  const [content] = response.content;
  assert.ok(content && content.type === 'text', 'expected a text content block');
  return content.text;
}

const ACTIVITY: TonalActivitySummary = {
  id: 'activity-42',
  deletedAt: null,
  userId: 'user-1',
  name: 'Upper Body Builder',
  workoutId: 'workout-1',
  isInProgram: true,
  isGuidedWorkout: false,
  isBaselineWorkout: false,
  timestamp: '2026-02-24T12:00:00Z',
  UTCTimestamp: '2026-02-24T12:00:00Z',
  localTimestamp: '2026-02-24T04:00:00',
  endTime: '2026-02-24T15:02:00Z',
  timeZone: 'America/Los_Angeles',
  targetArea: 'Upper Body',
  duration: 10_920,
  timeUnderTension: 360,
  repGoalPercentage: 100,
  totalReps: 25,
  totalVolume: 1_250,
  totalWork: 42,
  level: 'INTERMEDIATE',
  programWeeks: 4,
  programWorkoutsPerWeek: 3,
  groupIds: [],
  workoutType: 'Custom',
  completed: true,
  deviceId: 'device-1',
  appVersion: '1.0.0',
  activityType: 'Workout',
  triggeredTimedWeightOff: false,
};

test('exposes a recent workout activity ID for direct detail and summary lookup', async () => {
  const text = reportText(await getRecentWorkouts(fakeClient({
    getActivitySummaries: async () => [ACTIVITY],
  }), { limit: 1 }));

  assert.match(text, /workoutActivityId activity-42/);
});

test('distinguishes wall-clock duration from time under tension in totals and entries', async () => {
  const text = reportText(await getRecentWorkouts(fakeClient({
    getActivitySummaries: async () => [ACTIVITY],
  }), { limit: 1 }));

  assert.match(text, /Total Wall-clock Time: 182 minutes/);
  assert.match(text, /Average Wall-clock Duration: 182 minutes/);
  assert.match(text, /Total Time Under Tension: 6 minutes/);
  assert.match(text, /Average Time Under Tension: 6 minutes/);
  assert.match(text, /Wall-clock duration \(duration\): 182 min/);
  assert.match(text, /Time under tension \(timeUnderTension\): 6 min/);
  assert.doesNotMatch(text, /^- Duration:/m);
  assert.doesNotMatch(text, /Average Duration:/);
});
