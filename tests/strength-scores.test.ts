import assert from 'node:assert/strict';
import test from 'node:test';
import type TonalClient from '@dlwiest/ts-tonal-client';
import type {
  TonalStrengthScore,
  TonalStrengthScoreHistoryEntry,
  TonalStrengthScoreHistoryLookback,
} from '@dlwiest/ts-tonal-client';
import { getStrengthScores } from '../src/tools/strength-scores.js';
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

// The Overall row intentionally omits familyActivity. Keeping this fixture assigned directly
// to TonalStrengthScore[] makes npm run typecheck fail if the client type becomes dishonest and
// marks that field required again.
const CURRENT_SCORES: TonalStrengthScore[] = [
  {
    id: 'current-overall',
    createdAt: '2026-08-20T12:00:00Z',
    updatedAt: '0001-01-01T00:00:00Z',
    userId: 'user-1',
    workoutActivityId: '00000000-0000-0000-0000-000000000000',
    strengthBodyRegion: 'Overall',
    bodyRegionDisplay: '',
    score: 900,
    current: true,
  },
  {
    id: 'current-upper',
    createdAt: '2026-08-20T12:00:00Z',
    updatedAt: '2026-08-20T12:01:00Z',
    userId: 'user-1',
    workoutActivityId: 'activity-current',
    strengthBodyRegion: 'Upper Body',
    bodyRegionDisplay: 'Upper',
    score: 910,
    current: true,
    familyActivity: [],
  },
  {
    id: 'current-core',
    createdAt: '2026-08-20T12:00:00Z',
    updatedAt: '2026-08-20T12:02:00Z',
    userId: 'user-1',
    workoutActivityId: 'activity-current',
    strengthBodyRegion: 'Core',
    bodyRegionDisplay: 'Core',
    score: 920,
    current: true,
    familyActivity: [],
  },
  {
    id: 'current-lower',
    createdAt: '2026-08-20T12:00:00Z',
    updatedAt: '2026-08-20T12:03:00Z',
    userId: 'user-1',
    workoutActivityId: 'activity-current',
    strengthBodyRegion: 'Lower Body',
    bodyRegionDisplay: 'Lower',
    score: 930,
    current: true,
    familyActivity: [],
  },
];

function historyEntry(
  index: number,
  overrides: Partial<TonalStrengthScoreHistoryEntry> = {}
): TonalStrengthScoreHistoryEntry {
  return {
    id: `history-id-${index}`,
    userId: 'user-1',
    workoutActivityId: `activity-${index}`,
    upper: 100 + index,
    lower: 200 + index,
    core: 300 + index,
    overall: 400 + index,
    activityTime: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00Z`,
    ...overrides,
  };
}

function clientWithHistory(
  history: TonalStrengthScoreHistoryEntry[],
  onLookback?: (lookback: TonalStrengthScoreHistoryLookback) => void
): TonalClient {
  return fakeClient({
    getCurrentStrengthScores: async () => CURRENT_SCORES,
    getStrengthScoreHistory: async (lookback: TonalStrengthScoreHistoryLookback) => {
      onLookback?.(lookback);
      return history;
    },
  });
}

test('registers get_strength_scores with the approved schema and annotations', () => {
  const tool = toolsRegistry.get('get_strength_scores');
  assert.ok(tool);
  assert.equal(
    tool.description,
    "Get Tonal's headline current Strength Score by body region and a compact per-activity trend. This is distinct from the weekly Functional Strength Score goal metric."
  );
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        description: 'Calendar-day history lookback, not a workout or row count. Omit to query from account creation (all available strength-score history).',
      },
    },
    required: [],
  });
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.destructiveHint, false);
});

test('renders a sparse Overall row with its fallback label and without its zero date', async () => {
  const text = reportText(await getStrengthScores(clientWithHistory([]), {}));

  assert.match(text, /\*\*Overall\*\*: 900/);
  assert.doesNotMatch(text, /0001-01-01/);
  assert.match(text, /\*\*Upper\*\*: 910 \(updated 2026-08-20T12:01:00Z\)/);
  assert.match(text, /\*\*Core\*\*: 920 \(updated 2026-08-20T12:02:00Z\)/);
  assert.match(text, /\*\*Lower\*\*: 930 \(updated 2026-08-20T12:03:00Z\)/);
});

test('passes numeric days through to the history client unchanged', async () => {
  let received: TonalStrengthScoreHistoryLookback | undefined;
  await getStrengthScores(clientWithHistory([], lookback => { received = lookback; }), { days: 37 });
  assert.equal(received, 37);
});

test("passes 'all' to the history client when days is omitted", async () => {
  let received: TonalStrengthScoreHistoryLookback | undefined;
  await getStrengthScores(clientWithHistory([], lookback => { received = lookback; }), {});
  assert.equal(received, 'all');
});

test('rejects every invalid days value before making a client call', async (t) => {
  const invalidValues = [1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  for (const value of invalidValues) {
    await t.test(String(value), async () => {
      let calls = 0;
      const client = fakeClient({
        getCurrentStrengthScores: async () => {
          calls += 1;
          return CURRENT_SCORES;
        },
        getStrengthScoreHistory: async () => {
          calls += 1;
          return [];
        },
      });

      const response = await getStrengthScores(client, { days: value });
      assert.equal(response.isError, true);
      assert.match(reportText(response), /days must be a positive integer/);
      assert.equal(calls, 0);
    });
  }
});

test('keeps current scores when a numeric history window is empty', async () => {
  const text = reportText(await getStrengthScores(clientWithHistory([]), { days: 30 }));

  assert.match(text, /\*\*Overall\*\*: 900/);
  assert.match(text, /Returned scored activities: 0/);
  assert.match(text, /0 scored activities in the requested 30 calendar days/);
  assert.doesNotMatch(text, /account has no history/i);
});

test('shows only the 10 newest history points and labels truncation', async () => {
  const history = Array.from({ length: 12 }, (_, index) => historyEntry(index));
  const text = reportText(await getStrengthScores(clientWithHistory(history), { days: 365 }));
  const renderedPoints = text.match(/^- 2026-08-\d{2}T12:00:00Z:/gm) ?? [];

  assert.match(text, /Recent History \(showing 10 of 12\)/);
  assert.equal(renderedPoints.length, 10);
  assert.match(text, /2026-08-12T12:00:00Z: Overall 411/);
  assert.match(text, /2026-08-03T12:00:00Z: Overall 402/);
  assert.doesNotMatch(text, /2026-08-02T12:00:00Z: Overall/);
  assert.doesNotMatch(text, /2026-08-01T12:00:00Z: Overall/);
});

test('computes each score change from the oldest activity to the newest', async () => {
  const newest = historyEntry(2, {
    activityTime: '2026-08-20T12:00:00Z',
    overall: 530,
    upper: 210,
    core: 295,
    lower: 400,
  });
  const oldest = historyEntry(1, {
    activityTime: '2026-08-01T12:00:00Z',
    overall: 500,
    upper: 200,
    core: 300,
    lower: 400,
  });
  const text = reportText(
    await getStrengthScores(clientWithHistory([newest, oldest]), { days: 30 })
  );

  assert.match(text, /Earliest activity: 2026-08-01T12:00:00Z/);
  assert.match(text, /Latest activity: 2026-08-20T12:00:00Z/);
  assert.match(text, /\*\*Overall\*\*: \+30/);
  assert.match(text, /\*\*Upper\*\*: \+10/);
  assert.match(text, /\*\*Core\*\*: -5/);
  assert.match(text, /\*\*Lower\*\*: 0/);
});

test('omits transport-only fields and raw JSON from the report', async () => {
  const text = reportText(
    await getStrengthScores(clientWithHistory([historyEntry(0)]), { days: 1 })
  );

  assert.doesNotMatch(text, /history-id-0|user-1|activity-0|familyActivity/);
  assert.doesNotMatch(text, /```json/);
});
