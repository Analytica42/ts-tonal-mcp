import assert from 'node:assert/strict';
import test from 'node:test';
import type TonalClient from '@dlwiest/ts-tonal-client';
import type {
  TonalStrengthScore,
  TonalStrengthScoreHistoryEntry,
} from '@dlwiest/ts-tonal-client';
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

function historyEntry(
  index: number,
  activityTime: string
): TonalStrengthScoreHistoryEntry {
  return {
    id: `history-row-${index}`,
    userId: 'user-1',
    workoutActivityId: `activity-${index}`,
    upper: 100 + index,
    lower: 200 + index,
    core: 300 + index,
    overall: 400 + index,
    activityTime,
  };
}

function recordingClient(history: TonalStrengthScoreHistoryEntry[]): {
  client: TonalClient;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  return {
    client: fakeClient({
      getStrengthScoreHistory: async (...args: unknown[]) => {
        calls.push(args);
        return history;
      },
    }),
    calls,
  };
}

// This fixture intentionally omits optional familyActivity. Since npm run typecheck includes
// tests, tightening the published client type incorrectly would fail this suite at compile time.
const SPARSE_STRENGTH_SCORE: TonalStrengthScore = {
  id: 'overall-score',
  createdAt: '2026-08-31T12:00:00Z',
  updatedAt: '0001-01-01T00:00:00Z',
  userId: 'user-1',
  workoutActivityId: '00000000-0000-0000-0000-000000000000',
  strengthBodyRegion: 'Overall',
  bodyRegionDisplay: '',
  score: 400,
  current: true,
};

const HISTORY = [
  historyEntry(1, '2026-08-10T12:00:00Z'),
  historyEntry(2, '2026-08-30T12:00:00Z'),
  historyEntry(3, '2026-08-20T12:00:00Z'),
];

test('keeps the sparse optional client field fixture typechecked', () => {
  assert.equal('familyActivity' in SPARSE_STRENGTH_SCORE, false);
});

test('registers list_workout_activities with the approved schema and annotations', () => {
  const tool = toolsRegistry.get('list_workout_activities');
  assert.ok(tool);
  assert.equal(
    tool.description,
    'Enumerate performed activity IDs and dates from Strength Score history so a specific activity can be inspected. Tonal is queried once; paging parameters affect presentation only.'
  );
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        description: 'Calendar-day enumeration lookback, not a row count. Omit to query from account creation.',
      },
      startIndex: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Number of newest-first enumeration rows to skip in the rendered result. This is local presentation paging, not a Tonal API offset.',
      },
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
        description: 'Maximum rows to render from the already-fetched enumeration. This is not sent to Tonal.',
      },
    },
    required: [],
  });
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.destructiveHint, false);
});

test('makes exactly one history call per invocation and keeps presentation paging local', async () => {
  const { client, calls } = recordingClient(HISTORY);

  await listWorkoutActivities(client, { startIndex: 0, pageSize: 1 });
  await listWorkoutActivities(client, { startIndex: 1, pageSize: 2 });
  await listWorkoutActivities(client, { days: 45, startIndex: 999, pageSize: 50 });

  assert.deepEqual(calls, [['all'], ['all'], [45]]);
});

test("passes days unchanged and uses 'all' when days is omitted", async () => {
  const { client, calls } = recordingClient([]);

  await listWorkoutActivities(client, { days: 37 });
  await listWorkoutActivities(client, {});
  await listWorkoutActivities(client);

  assert.deepEqual(calls, [[37], ['all'], ['all']]);
});

test('sorts newest first while reporting discovery count and pre-slice boundaries', async () => {
  const { client } = recordingClient(HISTORY);
  const text = reportText(
    await listWorkoutActivities(client, { days: 365, startIndex: 0, pageSize: 2 })
  );

  assert.match(text, /Source: strength-score-history/);
  assert.match(text, /Requested lookback: 365 calendar days/);
  assert.match(text, /Discovered activities: 3/);
  assert.match(text, /Earliest activity: 2026-08-10T12:00:00Z/);
  assert.match(text, /Latest activity: 2026-08-30T12:00:00Z/);
  assert.match(text, /Showing 0\.\.1 of 3/);
  assert.match(text, /Presentation truncated: yes/);
  assert.match(text, /nextStartIndex: 2/);

  const newestPosition = text.indexOf('2026-08-30T12:00:00Z | workoutActivityId activity-2');
  const secondPosition = text.indexOf('2026-08-20T12:00:00Z | workoutActivityId activity-3');
  assert.ok(newestPosition >= 0);
  assert.ok(secondPosition > newestPosition);
  assert.doesNotMatch(text, /workoutActivityId activity-1/);
  assert.match(text, /Overall 402 \| Upper 102 \| Core 302 \| Lower 202/);
  assert.match(text, /completeness is relative to activity IDs emitted by Tonal strength-score history/i);
  assert.doesNotMatch(text, /history-row-|user-1|```json/);
});

test('includes nextStartIndex only when a further page exists', async () => {
  const first = recordingClient(HISTORY);
  const firstText = reportText(
    await listWorkoutActivities(first.client, { startIndex: 0, pageSize: 2 })
  );
  assert.match(firstText, /nextStartIndex: 2/);

  const last = recordingClient(HISTORY);
  const lastText = reportText(
    await listWorkoutActivities(last.client, { startIndex: 2, pageSize: 2 })
  );
  assert.match(lastText, /Showing 2\.\.2 of 3/);
  assert.doesNotMatch(lastText, /nextStartIndex/);
  assert.equal(first.calls.length, 1);
  assert.equal(last.calls.length, 1);
});

test('returns an explicit empty page with no nextStartIndex beyond the end', async () => {
  const { client, calls } = recordingClient(HISTORY);
  const text = reportText(
    await listWorkoutActivities(client, { startIndex: 10, pageSize: 5 })
  );

  assert.match(text, /Showing: empty page at startIndex 10 of 3/);
  assert.match(text, /No activity rows in this presentation page/);
  assert.match(text, /Presentation truncated: yes/);
  assert.doesNotMatch(text, /nextStartIndex/);
  assert.deepEqual(calls, [['all']]);
});

test('reports an explicit untruncated empty page for an empty discovery set', async () => {
  const { client } = recordingClient([]);
  const text = reportText(await listWorkoutActivities(client, {}));

  assert.match(text, /Discovered activities: 0/);
  assert.match(text, /Earliest activity: none/);
  assert.match(text, /Latest activity: none/);
  assert.match(text, /Showing: empty page at startIndex 0 of 0/);
  assert.match(text, /Presentation truncated: no/);
  assert.doesNotMatch(text, /nextStartIndex/);
});

test('rejects every invalid argument before making a client call', async (t) => {
  const invalidCases: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'days zero', args: { days: 0 } },
    { name: 'days negative', args: { days: -1 } },
    { name: 'days fractional', args: { days: 1.5 } },
    { name: 'days NaN', args: { days: Number.NaN } },
    { name: 'days infinite', args: { days: Number.POSITIVE_INFINITY } },
    { name: 'days unsafe', args: { days: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'days string', args: { days: '30' } },
    { name: 'days null', args: { days: null } },
    { name: 'startIndex negative', args: { startIndex: -1 } },
    { name: 'startIndex fractional', args: { startIndex: 1.5 } },
    { name: 'startIndex NaN', args: { startIndex: Number.NaN } },
    { name: 'startIndex infinite', args: { startIndex: Number.POSITIVE_INFINITY } },
    { name: 'startIndex unsafe', args: { startIndex: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'startIndex string', args: { startIndex: '0' } },
    { name: 'startIndex null', args: { startIndex: null } },
    { name: 'pageSize zero', args: { pageSize: 0 } },
    { name: 'pageSize too large', args: { pageSize: 51 } },
    { name: 'pageSize fractional', args: { pageSize: 1.5 } },
    { name: 'pageSize NaN', args: { pageSize: Number.NaN } },
    { name: 'pageSize infinite', args: { pageSize: Number.POSITIVE_INFINITY } },
    { name: 'pageSize unsafe', args: { pageSize: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'pageSize string', args: { pageSize: '20' } },
    { name: 'pageSize null', args: { pageSize: null } },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async () => {
      const { client, calls } = recordingClient(HISTORY);
      const response = await listWorkoutActivities(client, invalidCase.args);

      assert.equal(response.isError, true);
      assert.match(reportText(response), /VALIDATION_ERROR/);
      assert.equal(calls.length, 0);
    });
  }
});
