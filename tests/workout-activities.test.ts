import assert from 'node:assert/strict';
import test from 'node:test';
import type TonalClient from '@dlwiest/ts-tonal-client';
import type { TonalWorkoutActivity } from '@dlwiest/ts-tonal-client';
import { listWorkoutActivities } from '../src/tools/workout-activities.js';
import { toolsRegistry } from '../src/tools/registry.js';
import type { MCPResponse } from '../src/types/index.js';

function fakeClient(methods: Record<string, unknown>): TonalClient {
  return methods as unknown as TonalClient;
}

function reportText(response: MCPResponse): string {
  const [content] = response.content;
  assert.ok(content && content.type === 'text', 'expected a text content block');
  return content.text;
}

function activity(
  id: string,
  beginTime: string,
  overrides: Partial<TonalWorkoutActivity> = {}
): TonalWorkoutActivity {
  return {
    id,
    userId: 'user-1',
    workoutId: `workout-${id}`,
    beginTime,
    endTime: beginTime,
    totalDuration: 600,
    activeDuration: 120,
    totalSets: 3,
    totalReps: 30,
    totalVolume: 1_500,
    completed: true,
    workoutSetActivity: [],
    ...overrides,
  };
}

function recordingClient(activities: TonalWorkoutActivity[]): {
  client: TonalClient;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  return {
    client: fakeClient({
      getWorkoutActivities: async (...args: unknown[]) => {
        calls.push(args);
        return activities;
      },
    }),
    calls,
  };
}

const ACTIVITIES = [
  activity('activity-1', '2026-08-10T12:00:00Z'),
  activity('activity-2', '2026-08-30T12:00:00Z', {
    totalSets: 5,
    totalReps: 42,
    totalVolume: 2_400,
  }),
  activity('activity-3', '2026-08-20T12:00:00Z'),
];

test('registers list_workout_activities with real API paging and read-only annotations', () => {
  const tool = toolsRegistry.get('list_workout_activities');
  assert.ok(tool);
  assert.equal(
    tool.description,
    "List one Tonal workout-activity API page. Offset 0 selects the account's oldest activities and increasing offset advances toward newer ones; rows are displayed newest-first only within the selected page. Use get_recent_workouts for recent sessions."
  );
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Tonal API offset into the oldest-first activity sequence.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'Maximum activities requested from Tonal for this API page.',
      },
    },
    required: [],
  });
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.destructiveHint, false);
});

test('sends offset and limit to getWorkoutActivities with honest defaults', async () => {
  const { client, calls } = recordingClient([]);

  await listWorkoutActivities(client);
  await listWorkoutActivities(client, { offset: 40, limit: 100 });

  assert.deepEqual(calls, [[0, 20], [40, 100]]);
});

test('sorts the returned oldest-first API page newest-first without changing its membership', async () => {
  const { client } = recordingClient(ACTIVITIES);
  const text = reportText(
    await listWorkoutActivities(client, { offset: 20, limit: 3 })
  );

  const newestPosition = text.indexOf('2026-08-30T12:00:00Z | workoutActivityId activity-2');
  const middlePosition = text.indexOf('2026-08-20T12:00:00Z | workoutActivityId activity-3');
  const oldestPosition = text.indexOf('2026-08-10T12:00:00Z | workoutActivityId activity-1');
  assert.ok(newestPosition >= 0);
  assert.ok(middlePosition > newestPosition);
  assert.ok(oldestPosition > middlePosition);
  assert.match(text, /Sets 5 \| Reps 42 \| Volume 2,400 lb/);
});

test('states that API page selection and display use opposite orderings', async () => {
  const { client } = recordingClient(ACTIVITIES);
  const text = reportText(await listWorkoutActivities(client));

  assert.match(text, /API offset: 0/);
  assert.match(text, /API limit: 20/);
  assert.match(text, /API page selection: oldest-first/);
  assert.match(text, /Display order: newest-first within this API-selected page only/);
});

test('identifies offset zero as oldest and reports the selected page date range', async () => {
  const tool = toolsRegistry.get('list_workout_activities');
  assert.ok(tool);
  assert.match(tool.description, /Offset 0 selects the account's oldest activities/);
  assert.match(tool.description, /increasing offset advances toward newer ones/);
  assert.match(tool.description, /Use get_recent_workouts for recent sessions/);

  const { client } = recordingClient(ACTIVITIES);
  const text = reportText(await listWorkoutActivities(client));

  assert.match(text, /offset 0 requests the account's oldest activities/);
  assert.match(text, /increasing offset advances toward newer activities/);
  assert.match(
    text,
    /Page beginTime range: 2026-08-10T12:00:00Z \(oldest\) to 2026-08-30T12:00:00Z \(newest\)/
  );
  assert.match(text, /For the account's recent workouts, use get_recent_workouts/);
});

test('offers a possible next offset only when Tonal returns a full page', async () => {
  const fullPage = recordingClient(ACTIVITIES.slice(0, 2));
  const fullText = reportText(
    await listWorkoutActivities(fullPage.client, { offset: 10, limit: 2 })
  );
  assert.match(fullText, /nextOffset: 12 \(the full page means additional activities may exist\)/);

  const shortPage = recordingClient(ACTIVITIES.slice(0, 1));
  const shortText = reportText(
    await listWorkoutActivities(shortPage.client, { offset: 10, limit: 2 })
  );
  assert.doesNotMatch(shortText, /nextOffset/);
});

test('reports an explicit empty API page', async () => {
  const { client } = recordingClient([]);
  const text = reportText(
    await listWorkoutActivities(client, { offset: 500, limit: 20 })
  );

  assert.match(text, /Activities returned: 0/);
  assert.match(text, /No workout activities found at this API offset/);
  assert.doesNotMatch(text, /nextOffset/);
});

test('turns a workout activity API failure into an MCP error response', async () => {
  const response = await listWorkoutActivities(fakeClient({
    getWorkoutActivities: async () => {
      throw new Error('activity endpoint unavailable');
    },
  }));

  assert.equal(response.isError, true);
  assert.match(reportText(response), /activity endpoint unavailable/);
});

test('rejects every invalid paging argument before making a client call', async (t) => {
  const invalidCases: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'offset negative', args: { offset: -1 } },
    { name: 'offset fractional', args: { offset: 1.5 } },
    { name: 'offset NaN', args: { offset: Number.NaN } },
    { name: 'offset infinite', args: { offset: Number.POSITIVE_INFINITY } },
    { name: 'offset unsafe', args: { offset: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'offset string', args: { offset: '0' } },
    { name: 'offset null', args: { offset: null } },
    { name: 'limit zero', args: { limit: 0 } },
    { name: 'limit too large', args: { limit: 101 } },
    { name: 'limit fractional', args: { limit: 1.5 } },
    { name: 'limit NaN', args: { limit: Number.NaN } },
    { name: 'limit infinite', args: { limit: Number.POSITIVE_INFINITY } },
    { name: 'limit unsafe', args: { limit: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'limit string', args: { limit: '20' } },
    { name: 'limit null', args: { limit: null } },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async () => {
      const { client, calls } = recordingClient(ACTIVITIES);
      const response = await listWorkoutActivities(client, invalidCase.args);

      assert.equal(response.isError, true);
      assert.match(reportText(response), /VALIDATION_ERROR/);
      assert.equal(calls.length, 0);
    });
  }
});
