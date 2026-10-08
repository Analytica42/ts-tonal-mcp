import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import type TonalClient from '@dlwiest/ts-tonal-client';
import type { TonalMovement, TonalWorkoutEstimateSet } from '@dlwiest/ts-tonal-client';
import {
  clearLoadReferenceCache,
  DEFAULT_LOOKBACK_ACTIVITIES,
  MAX_LOOKBACK_ACTIVITIES,
  resolveLoadReference,
} from '../src/utils/load-reference.js';
import { convertTargetWeight, getLoadReference } from '../src/tools/load-prescription.js';
import { createWorkout } from '../src/tools/custom-workouts.js';
import { updateWorkout } from '../src/tools/workout-editing.js';
import { estimateWorkoutDuration } from '../src/tools/workout-duration.js';
import {
  collectPoundPrescribedMovementNames,
  exercisesToSetsDetailed,
} from '../src/utils/workout-conversion.js';
import { toolsRegistry } from '../src/tools/registry.js';
import type { MCPResponse } from '../src/types/index.js';

const BENCH_ONE_REP_MAX = 83.50363;
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

const BENCH: TonalMovement = {
  id: 'm-bench',
  name: 'Barbell Bench Press',
  countReps: true,
  onMachine: true,
  isBilateral: true,
  isTwoSided: false,
  onMachineInfo: { trainerArmsPulledAtSameTime: true },
} as unknown as TonalMovement;

const ROW: TonalMovement = {
  id: 'm-row',
  name: 'Single-Arm Bent Over Row',
  countReps: true,
  onMachine: true,
  isBilateral: false,
  isTwoSided: true,
  onMachineInfo: { trainerArmsPulledAtSameTime: false },
} as unknown as TonalMovement;

const REST: TonalMovement = {
  id: 'm-rest',
  name: 'Rest',
  countReps: true,
  isBilateral: true,
} as unknown as TonalMovement;

// No cable attribute and onMachine false -- the shape every one of the 125 attribute-less
// catalog movements has. isBilateral is present and true, which a limb-based fallback would
// have happily converted at factor 2.
const PLANK: TonalMovement = {
  id: 'm-plank',
  name: 'Plank',
  countReps: false,
  onMachine: false,
  isBilateral: true,
} as unknown as TonalMovement;

const UNTRAINED: TonalMovement = {
  id: 'm-untrained',
  name: 'Seated Calf Raise',
  countReps: true,
  onMachine: true,
  isBilateral: true,
  onMachineInfo: { trainerArmsPulledAtSameTime: true },
} as unknown as TonalMovement;

interface ActivityFixture {
  id: string;
  timestamp: string;
  sets: Record<string, unknown>[];
}

/** Newest-first list of activities; the stub returns them in a deliberately shuffled order. */
function stubClient(
  activities: ActivityFixture[],
  extra: Record<string, unknown> = {}
): { client: TonalClient; detailFetches: string[]; summaryFetches: number } {
  const detailFetches: string[] = [];
  const counters = { summaryFetches: 0 };

  const client = {
    getMovements: async () => [BENCH, ROW, REST, UNTRAINED, PLANK],
    getActivitySummaries: async () => {
      counters.summaryFetches += 1;
      // Reversed on purpose: resolution must sort by timestamp, not trust API order.
      return [...activities]
        .reverse()
        .map((activity) => ({
          id: activity.id,
          timestamp: activity.timestamp,
          deletedAt: null,
        }));
    },
    getWorkoutActivityById: async (activityId: string) => {
      detailFetches.push(activityId);
      const activity = activities.find((candidate) => candidate.id === activityId);
      assert.ok(activity, `unexpected activity fetch: ${activityId}`);
      return {
        id: activity.id,
        beginTime: activity.timestamp,
        workoutSetActivity: activity.sets,
      };
    },
    ...extra,
  } as unknown as TonalClient;

  return {
    client,
    detailFetches,
    get summaryFetches() {
      return counters.summaryFetches;
    },
  };
}

function benchSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    movementId: 'm-bench',
    oneRepMax: BENCH_ONE_REP_MAX,
    baseWeight: 69.5,
    avgWeight: 64.3,
    repCount: 8,
    weightPercentage: 42,
    ...overrides,
  };
}

function reportText(response: MCPResponse): string {
  const [content] = response.content;
  assert.ok(content && content.type === 'text', 'expected a text content block');
  return content.text;
}

beforeEach(() => {
  clearLoadReferenceCache();
});

test('both load tools are registered, read-only and non-destructive', () => {
  for (const name of ['get_load_reference', 'convert_target_weight']) {
    const tool = toolsRegistry.get(name);
    assert.ok(tool, `${name} must be registered`);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.match(tool.description, /cached in-process for 5 minutes/, 'cache lifetime must be documented');
  }
  assert.deepEqual(toolsRegistry.get('get_load_reference')!.inputSchema.required, ['movementName']);
  assert.deepEqual(toolsRegistry.get('convert_target_weight')!.inputSchema.required, [
    'movementName',
    'targetPounds',
  ]);
});

test('a reference comes from the most recent performed set and reports its staleness', async () => {
  const stub = stubClient([
    { id: 'a-new', timestamp: daysAgo(3), sets: [benchSet({ baseWeight: 71, repCount: 6 })] },
    { id: 'a-old', timestamp: daysAgo(40), sets: [benchSet({ baseWeight: 55, repCount: 12 })] },
  ]);

  const reference = await resolveLoadReference(stub.client, 'Barbell Bench Press');

  assert.equal(reference.movementId, 'm-bench');
  assert.equal(reference.oneRepMax, BENCH_ONE_REP_MAX);
  assert.equal(reference.denominatorPounds, 2 * BENCH_ONE_REP_MAX);
  assert.equal(reference.referenceSet.activityId, 'a-new', 'the newest activity wins');
  assert.equal(reference.referenceSet.baseWeight, 71);
  assert.equal(reference.referenceSet.repCount, 6);
  assert.equal(reference.referenceSet.ageDays, 3, 'staleness is surfaced, not refused');
  assert.equal(reference.activitiesScanned, 1, 'scanning stops at the first match');
  assert.deepEqual(stub.detailFetches, ['a-new'], 'the older activity is never fetched');
});

test('the implied percentage of the last performed load is the documented self-check', async () => {
  const stub = stubClient([
    { id: 'a-1', timestamp: daysAgo(1), sets: [benchSet()] },
  ]);
  const reference = await resolveLoadReference(stub.client, 'Barbell Bench Press');

  // 69.5 / (2 x 83.50363) x 100 = 41.61%, independently corroborated by the 41.6% median
  // across 3,857 historical sets. Above 50% would mean a working load above a one-rep max.
  assert.equal(reference.referenceSet.impliedPercentage, 41.61);
  assert.equal(reference.referenceSet.impliedPercentageBasis, 'baseWeight');
  assert.ok(reference.referenceSet.impliedPercentage! <= 50, 'the 50% ceiling is the correctness check');
  assert.equal(
    Math.round(reference.poundsPerPercentagePoint * 1000) / 1000,
    1.67,
    'granularity is the pounds bought by one percentage point'
  );
});

test('a movement is matched case-insensitively and reported under its catalog name', async () => {
  const stub = stubClient([{ id: 'a-1', timestamp: daysAgo(1), sets: [benchSet()] }]);
  const reference = await resolveLoadReference(stub.client, '  barbell BENCH press  ');
  assert.equal(reference.movementName, 'Barbell Bench Press');
});

test('sets with no real load are excluded from reference selection', async () => {
  const stub = stubClient([
    {
      id: 'a-junk',
      timestamp: daysAgo(1),
      // avgWeight 0 and baseWeight 0: a logged but unloaded set.
      sets: [benchSet({ baseWeight: 0, avgWeight: 0, oneRepMax: BENCH_ONE_REP_MAX })],
    },
    { id: 'a-real', timestamp: daysAgo(5), sets: [benchSet({ baseWeight: 69.5 })] },
  ]);

  const reference = await resolveLoadReference(stub.client, 'Barbell Bench Press');
  assert.equal(reference.referenceSet.activityId, 'a-real', 'the unloaded set must not win');
  assert.equal(reference.activitiesScanned, 2);
});

test('a set with no usable one-rep max is excluded', async () => {
  const stub = stubClient([
    { id: 'a-bad', timestamp: daysAgo(1), sets: [benchSet({ oneRepMax: 0 })] },
    { id: 'a-good', timestamp: daysAgo(2), sets: [benchSet()] },
  ]);
  const reference = await resolveLoadReference(stub.client, 'Barbell Bench Press');
  assert.equal(reference.referenceSet.activityId, 'a-good');
});

test('the Rest pseudo-movement is rejected outright rather than converted', async () => {
  const stub = stubClient([
    { id: 'a-1', timestamp: daysAgo(1), sets: [{ movementId: 'm-rest', oneRepMax: 5, avgWeight: 0 }] },
  ]);
  await assert.rejects(
    () => resolveLoadReference(stub.client, 'Rest'),
    /non-lift pseudo-movement/
  );
});

test('a movement with no performed-set history fails explicitly and fabricates nothing', async () => {
  const stub = stubClient([
    { id: 'a-1', timestamp: daysAgo(1), sets: [benchSet()] },
  ]);

  await assert.rejects(
    () => resolveLoadReference(stub.client, 'Seated Calf Raise'),
    (error: Error) => {
      assert.match(error.message, /No recent set found for "Seated Calf Raise"/);
      assert.match(error.message, /cannot convert pounds/);
      assert.match(error.message, /no oneRepMax to convert against/);
      assert.match(error.message, /weight \(percentage\) instead of weightLb/, 'the failure is actionable');
      return true;
    }
  );
});

test('an unknown movement names the search tool instead of guessing', async () => {
  const stub = stubClient([{ id: 'a-1', timestamp: daysAgo(1), sets: [benchSet()] }]);
  await assert.rejects(
    () => resolveLoadReference(stub.client, 'Nonexistent Lift'),
    /not found in the Tonal catalog.*search_movements/s
  );
});

test('the lookback is bounded by default and capped at the hard ceiling', async () => {
  const activities = Array.from({ length: 30 }, (unused, index) => ({
    id: `a-${index}`,
    timestamp: daysAgo(index + 1),
    sets: [{ movementId: 'm-row', oneRepMax: 40, baseWeight: 30, avgWeight: 28, repCount: 10 }],
  }));
  // The bench never appears, so the scan runs to the end of the window.
  const stub = stubClient(activities);

  await assert.rejects(() => resolveLoadReference(stub.client, 'Barbell Bench Press'));
  assert.equal(stub.detailFetches.length, DEFAULT_LOOKBACK_ACTIVITIES, 'default lookback is 10 activities');

  clearLoadReferenceCache();
  const wider = stubClient(activities);
  await assert.rejects(() =>
    resolveLoadReference(wider.client, 'Barbell Bench Press', { lookbackActivities: 25 })
  );
  assert.equal(wider.detailFetches.length, 25);

  await assert.rejects(
    () =>
      resolveLoadReference(stub.client, 'Barbell Bench Press', {
        lookbackActivities: MAX_LOOKBACK_ACTIVITIES + 1,
      }),
    new RegExp(`lookbackActivities must be an integer from 1 to ${MAX_LOOKBACK_ACTIVITIES}`)
  );
});

test('resolved references are cached, so converting many exercises scans once', async () => {
  const stub = stubClient([
    { id: 'a-1', timestamp: daysAgo(2), sets: [benchSet()] },
  ]);

  for (let call = 0; call < 8; call++) {
    await resolveLoadReference(stub.client, 'Barbell Bench Press');
  }

  assert.equal(stub.detailFetches.length, 1, 'eight lookups must not re-scan the activity list');
  assert.equal(stub.summaryFetches, 1);

  clearLoadReferenceCache();
  await resolveLoadReference(stub.client, 'Barbell Bench Press');
  assert.equal(stub.detailFetches.length, 2, 'clearing the cache forces a fresh scan');
});

test('get_load_reference reports the factor, denominator, granularity and verification', async () => {
  const stub = stubClient([{ id: 'a-1', timestamp: daysAgo(4), sets: [benchSet()] }]);
  const text = reportText(await getLoadReference(stub.client, { movementName: 'Barbell Bench Press' }));

  assert.match(text, /One-rep max \(oneRepMax\): 83\.50363 lb/);
  assert.match(text, /Cable factor: 2x/);
  assert.match(text, /Factor verified: yes/);
  assert.match(text, /Factor basis: calibrated/);
  assert.match(text, /Conversion denominator \(factor x oneRepMax\): 167\.00726 lb at weightPercentage 100/);
  assert.match(text, /Granularity: 1\.67 lb per percentage point/);
  assert.match(text, /Base weight \(baseWeight, dialled in on the machine\): 69\.5 lb/);
  assert.match(text, /Reps \(repCount\): 8/);
  assert.match(text, /\(4 days ago\)/, 'staleness must be visible');
  assert.match(text, /Implied percentage of that load: 41\.61%/);
  assert.match(text, /live trainer read 84\/125\/167/, 'the calibration evidence travels with the report');
  assert.doesNotMatch(text, /Unverified Cable Factor/);
});

test('get_load_reference warns prominently for an unverified movement', async () => {
  const stub = stubClient([
    {
      id: 'a-1',
      timestamp: daysAgo(1),
      sets: [{ movementId: 'm-row', oneRepMax: 40, baseWeight: 30, avgWeight: 28, repCount: 10 }],
    },
  ]);
  const text = reportText(
    await getLoadReference(stub.client, { movementName: 'Single-Arm Bent Over Row' })
  );

  assert.match(text, /Factor verified: NO/);
  assert.match(text, /Factor basis: trainerArmsPulledAtSameTime/);
  assert.match(text, /Cable engagement: single/);
  assert.match(text, /## ⚠️ Unverified Cable Factor/);
  assert.match(text, /HALF the pounds requested/);
  assert.doesNotMatch(text, /DOUBLE/);
});

test('convert_target_weight converts an array of targets in one call', async () => {
  const stub = stubClient([{ id: 'a-1', timestamp: daysAgo(1), sets: [benchSet()] }]);
  const text = reportText(
    await convertTargetWeight(stub.client, {
      movementName: 'Barbell Bench Press',
      targetPounds: [83.5, 125.26, 167.01],
    })
  );

  assert.match(text, /requested 83\.5 lb -> send weightPercentage 50 -> trainer should show 83\.5 lb/);
  assert.match(text, /requested 125\.26 lb -> send weightPercentage 75 -> trainer should show 125\.26 lb/);
  assert.match(text, /requested 167\.01 lb -> send weightPercentage 100 -> trainer should show 167\.01 lb/);
  assert.match(text, /factorVerified: true/);
  assert.equal(stub.detailFetches.length, 1, 'one scan covers every target');
});

test('convert_target_weight accepts a single target and rejects a negative one', async () => {
  const stub = stubClient([{ id: 'a-1', timestamp: daysAgo(1), sets: [benchSet()] }]);

  const single = reportText(
    await convertTargetWeight(stub.client, { movementName: 'Barbell Bench Press', targetPounds: 100 })
  );
  assert.match(single, /requested 100 lb -> send weightPercentage 60 -> trainer should show 100\.2 lb \(delta \+0\.2 lb\)/);

  const negative = await convertTargetWeight(stub.client, {
    movementName: 'Barbell Bench Press',
    targetPounds: -5,
  });
  assert.equal(negative.isError, true);
  assert.match(reportText(negative), /negative weightPercentage is invalid/);
});

test('convert_target_weight surfaces a no-history movement as an error, not a guess', async () => {
  const stub = stubClient([{ id: 'a-1', timestamp: daysAgo(1), sets: [benchSet()] }]);
  const response = await convertTargetWeight(stub.client, {
    movementName: 'Seated Calf Raise',
    targetPounds: 80,
  });

  assert.equal(response.isError, true);
  const text = reportText(response);
  assert.match(text, /No recent set found for "Seated Calf Raise"/);
  assert.doesNotMatch(text, /weightPercentage \d/, 'no percentage may be reported without a reference');
});

// ---------------------------------------------------------------------------
// Write path: weightLb on create_workout / update_workout / estimate_duration
// ---------------------------------------------------------------------------

function creatingClient(
  activities: ActivityFixture[],
  onCreate?: (payload: { sets: TonalWorkoutEstimateSet[] }) => void
) {
  const created: { count: number } = { count: 0 };
  const stub = stubClient(activities, {
    createWorkout: async (payload: { sets: TonalWorkoutEstimateSet[]; title: string }) => {
      created.count += 1;
      onCreate?.(payload);
      return { id: 'wk-1', title: payload.title, duration: 1800, sets: payload.sets };
    },
  });
  return { ...stub, created };
}

const BENCH_ACTIVITY: ActivityFixture[] = [
  { id: 'a-1', timestamp: daysAgo(2), sets: [benchSet()] },
];

test('weight and weightLb on the same set is rejected as ambiguous', () => {
  assert.throws(
    () =>
      exercisesToSetsDetailed(
        [
          {
            movementName: 'Barbell Bench Press',
            setDetails: [{ reps: 8, weight: 70, weightLb: 125 }],
          },
        ],
        [BENCH]
      ),
    /setDetails\[0\] cannot specify both weight \(70%\) and weightLb \(125 lb\).*Use one/s
  );
});

test('weight and weightLb on the same exercise is rejected as ambiguous', () => {
  assert.throws(
    () =>
      exercisesToSetsDetailed(
        [{ movementName: 'Barbell Bench Press', sets: 3, reps: 8, weight: 70, weightLb: 125 }],
        [BENCH]
      ),
    /cannot specify both weight \(70%\) and weightLb \(125 lb\)/
  );
});

test('create_workout rejects the weight/weightLb conflict without creating anything', async () => {
  const stub = creatingClient(BENCH_ACTIVITY);
  const response = await createWorkout(stub.client, {
    title: 'Ambiguous Day',
    exercises: [
      { movementName: 'Barbell Bench Press', setDetails: [{ reps: 8, weight: 70, weightLb: 125 }] },
    ],
  });

  assert.equal(response.isError, true);
  assert.equal(stub.created.count, 0, 'an ambiguous load must never be written');
  assert.match(reportText(response), /cannot specify both weight .* and weightLb/);
});

test('weightLb of 0 is a real zero load and is distinct from omitting the field', async () => {
  const stub = stubClient(BENCH_ACTIVITY);
  const reference = await resolveLoadReference(stub.client, 'Barbell Bench Press');
  const loadReferences = new Map([[reference.movementId, reference]]);

  const explicitZero = exercisesToSetsDetailed(
    [{ movementName: 'Barbell Bench Press', setDetails: [{ reps: 10, weightLb: 0 }] }],
    [BENCH],
    { loadReferences }
  );
  const omitted = exercisesToSetsDetailed(
    [{ movementName: 'Barbell Bench Press', setDetails: [{ reps: 10 }] }],
    [BENCH],
    { loadReferences }
  );

  // Both land on weightPercentage 0 on the wire, but only the explicit 0 is a prescription.
  assert.equal(explicitZero.sets[0].weightPercentage, 0);
  assert.equal(omitted.sets[0].weightPercentage, 0);
  assert.equal(explicitZero.conversions.length, 1, 'weightLb: 0 is a converted prescription');
  assert.equal(explicitZero.conversions[0].conversion.targetPounds, 0);
  assert.equal(explicitZero.conversions[0].conversion.roundedToZero, false);
  assert.equal(omitted.conversions.length, 0, 'an absent weight prescribes nothing');

  // The same distinction must hold at the pre-scan that decides which references to resolve.
  assert.deepEqual(
    collectPoundPrescribedMovementNames([
      { movementName: 'Barbell Bench Press', setDetails: [{ reps: 10, weightLb: 0 }] },
    ]),
    ['Barbell Bench Press']
  );
  assert.deepEqual(
    collectPoundPrescribedMovementNames([
      { movementName: 'Barbell Bench Press', setDetails: [{ reps: 10 }] },
    ]),
    []
  );
});

test('create_workout converts weightLb per set and reports exactly what it wrote', async () => {
  let received: TonalWorkoutEstimateSet[] | undefined;
  const stub = creatingClient(BENCH_ACTIVITY, (payload) => {
    received = payload.sets;
  });

  const text = reportText(
    await createWorkout(stub.client, {
      title: 'Pound Day',
      exercises: [
        {
          movementName: 'Barbell Bench Press',
          setDetails: [
            { reps: 10, weightLb: 83.5 },
            { reps: 8, weightLb: 125.26 },
            { reps: 5, weightLb: 100 },
          ],
        },
      ],
    })
  );

  assert.equal(stub.created.count, 1);
  assert.deepEqual(
    received?.map((set) => set.weightPercentage),
    [50, 75, 60],
    'the measured calibration points plus one rounded value'
  );
  received?.forEach((set) => {
    assert.ok(Number.isInteger(set.weightPercentage), 'Tonal rejects a JSON float here');
  });

  assert.match(text, /## Pound-Based Load Conversion/);
  assert.match(text, /3 sets were converted/);
  assert.match(text, /block 1, set 1: requested 83\.5 lb -> send weightPercentage 50 -> trainer should show 83\.5 lb/);
  assert.match(text, /block 1, set 2: requested 125\.26 lb -> send weightPercentage 75 -> trainer should show 125\.26 lb/);
  assert.match(text, /block 1, set 3: requested 100 lb -> send weightPercentage 60 -> trainer should show 100\.2 lb \(delta \+0\.2 lb\)/);
  assert.match(text, /oneRepMax 83\.50363 lb x factor 2 = 167\.00726 lb at 100%/);
  assert.match(text, /\(2 days ago\)/);
  assert.doesNotMatch(text, /Unverified Cable Factor/, 'the bench is calibrated');
});

test('an exercise-level weightLb converts as the per-set fallback and is labelled as such', async () => {
  let received: TonalWorkoutEstimateSet[] | undefined;
  const stub = creatingClient(BENCH_ACTIVITY, (payload) => {
    received = payload.sets;
  });

  const text = reportText(
    await createWorkout(stub.client, {
      title: 'Fallback Day',
      exercises: [{ movementName: 'Barbell Bench Press', sets: 2, reps: 8, weightLb: 125.26 }],
    })
  );

  assert.deepEqual(received?.map((set) => set.weightPercentage), [75, 75]);
  assert.match(text, /@ 125\.26 lb \(converted to a percentage\)/);
  assert.match(text, /\(from the exercise-level weightLb\)/);
});

test('a per-set weight percentage still wins over an exercise-level weightLb', async () => {
  let received: TonalWorkoutEstimateSet[] | undefined;
  const stub = creatingClient(BENCH_ACTIVITY, (payload) => {
    received = payload.sets;
  });

  const text = reportText(
    await createWorkout(stub.client, {
      title: 'Mixed Day',
      exercises: [
        {
          movementName: 'Barbell Bench Press',
          weightLb: 125.26,
          setDetails: [{ reps: 10, weight: 42 }, { reps: 8 }],
        },
      ],
    })
  );

  assert.deepEqual(
    received?.map((set) => set.weightPercentage),
    [42, 75],
    'the explicit percentage is untouched; only the unspecified set converts'
  );
  assert.match(text, /set 2 \(from the exercise-level weightLb\): requested 125\.26 lb -> send weightPercentage 75/);
  assert.doesNotMatch(text, /set 1 .*requested/, 'a percentage set is not a conversion');
  assert.match(text, /1 set was converted/, 'only the unspecified set is reported');
});

test('an unverified movement writes a result and says so once, prominently', async () => {
  let received: TonalWorkoutEstimateSet[] | undefined;
  const stub = creatingClient(
    [
      {
        id: 'a-1',
        timestamp: daysAgo(1),
        sets: [{ movementId: 'm-row', oneRepMax: 40, baseWeight: 30, avgWeight: 28, repCount: 10 }],
      },
    ],
    (payload) => {
      received = payload.sets;
    }
  );

  const text = reportText(
    await createWorkout(stub.client, {
      title: 'Row Day',
      exercises: [
        {
          movementName: 'Single-Arm Bent Over Row',
          setDetails: [{ reps: 10, weightLb: 40 }, { reps: 10, weightLb: 48 }],
        },
      ],
    })
  );

  // The conversion still happens -- the coach needs a number -- at the safe factor of 2.
  assert.equal(stub.created.count, 1);
  assert.deepEqual(received?.map((set) => set.weightPercentage), [50, 60]);

  assert.match(text, /### ⚠️ Unverified Cable Factor — Check The Trainer Before Lifting/);
  assert.match(text, /1 movement in this workout had load prescribed in pounds against an UNVERIFIED cable factor/);
  assert.match(text, /HALF the pounds requested/);
  assert.match(text, /if the single-cable hypothesis holds .* about 20 lb/);
  assert.doesNotMatch(text, /DOUBLE|doubling/, 'the safe default cannot over-load');

  const headingCount = text.split('Unverified Cable Factor').length - 1;
  assert.equal(headingCount, 1, 'the caution is stated once, not once per set');
});

test('create_workout writes nothing when a weightLb movement has no load reference', async () => {
  const stub = creatingClient(BENCH_ACTIVITY);
  const response = await createWorkout(stub.client, {
    title: 'Unresolvable Day',
    exercises: [{ movementName: 'Seated Calf Raise', sets: 3, reps: 10, weightLb: 80 }],
  });

  assert.equal(response.isError, true);
  assert.equal(stub.created.count, 0, 'resolution must fail before the mutation');
  assert.match(reportText(response), /No recent set found for "Seated Calf Raise"/);
});

test('a percentage-only workout needs no reference lookup at all', async () => {
  const stub = creatingClient(BENCH_ACTIVITY);
  const text = reportText(
    await createWorkout(stub.client, {
      title: 'Percentage Day',
      exercises: [{ movementName: 'Barbell Bench Press', sets: 3, reps: 8, weight: 42 }],
    })
  );

  assert.equal(stub.created.count, 1);
  assert.equal(stub.detailFetches.length, 0, 'no activity scan without weightLb');
  assert.doesNotMatch(text, /Pound-Based Load Conversion/);
  assert.match(text, /@ 42%/, 'the existing percentage path is untouched');
});

test('a percentage above the calibrated range is flagged on the write path', async () => {
  const stub = creatingClient(BENCH_ACTIVITY);
  const text = reportText(
    await createWorkout(stub.client, {
      title: 'Overload Day',
      exercises: [{ movementName: 'Barbell Bench Press', sets: 1, reps: 1, weightLb: 250 }],
    })
  );

  assert.match(text, /send weightPercentage 150/);
  assert.match(text, /EXCEEDS the measured calibration range/);
});

test('update_workout converts weightLb and reports it, and writes nothing when unresolvable', async () => {
  const updates: { count: number; sets?: TonalWorkoutEstimateSet[] } = { count: 0 };

  const workoutMethods = {
    getUserWorkouts: async (offset: number) =>
      offset === 0 ? [{ id: 'wk-1', title: 'Pound Day', createdAt: daysAgo(10) }] : [],
    getWorkoutById: async () => ({
      id: 'wk-1',
      title: 'Pound Day',
      shortDescription: '',
      description: '',
      coachId: 'c-1',
      assetId: 'as-1',
      level: 'All',
      duration: 1800,
      sets: [],
    }),
    updateWorkout: async (payload: { sets: TonalWorkoutEstimateSet[]; title: string }) => {
      updates.count += 1;
      updates.sets = payload.sets;
      return { id: 'wk-1', title: payload.title, duration: 1800, sets: payload.sets };
    },
  };

  const ok = stubClient(BENCH_ACTIVITY, workoutMethods);
  const text = reportText(
    await updateWorkout(ok.client, {
      workoutName: 'Pound Day',
      exercises: [
        { movementName: 'Barbell Bench Press', setDetails: [{ reps: 8, weightLb: 125.26 }] },
      ],
    })
  );

  assert.equal(updates.count, 1);
  assert.deepEqual(updates.sets?.map((set) => set.weightPercentage), [75]);
  assert.match(text, /## Pound-Based Load Conversion/);
  assert.match(text, /requested 125\.26 lb -> send weightPercentage 75 -> trainer should show 125\.26 lb/);

  clearLoadReferenceCache();
  updates.count = 0;
  const bad = stubClient(BENCH_ACTIVITY, workoutMethods);
  const failure = await updateWorkout(bad.client, {
    workoutName: 'Pound Day',
    exercises: [{ movementName: 'Seated Calf Raise', sets: 3, reps: 10, weightLb: 80 }],
  });

  assert.equal(failure.isError, true);
  assert.equal(updates.count, 0, 'an existing workout must not be overwritten on a failed conversion');
});

test('estimate_workout_duration converts weightLb without mutating anything', async () => {
  const stub = stubClient(BENCH_ACTIVITY, {
    estimateWorkoutDuration: async (sets: TonalWorkoutEstimateSet[]) => {
      assert.deepEqual(sets.map((set) => set.weightPercentage), [50, 75]);
      return { duration: 600 };
    },
  });

  const text = reportText(
    await estimateWorkoutDuration(stub.client, {
      exercises: [
        {
          movementName: 'Barbell Bench Press',
          setDetails: [{ reps: 10, weightLb: 83.5 }, { reps: 8, weightLb: 125.26 }],
        },
      ],
    })
  );

  assert.match(text, /## Pound-Based Load Conversion/);
  assert.match(text, /requested 83\.5 lb -> send weightPercentage 50/);
  assert.match(text, /nothing was created or modified/);
});

test('an exercise-level weightLb shows as "where unspecified" in the duration estimate', async () => {
  const stub = stubClient(BENCH_ACTIVITY, {
    estimateWorkoutDuration: async () => ({ duration: 600 }),
  });

  const text = reportText(
    await estimateWorkoutDuration(stub.client, {
      exercises: [
        {
          movementName: 'Barbell Bench Press',
          weightLb: 125.26,
          setDetails: [{ reps: 10, weight: 42 }, { reps: 8 }],
        },
      ],
    })
  );

  assert.match(text, /@ 125\.26 lb where unspecified/);
});

test('an off-machine movement fails before any activity is scanned', async () => {
  const stub = stubClient(BENCH_ACTIVITY);

  await assert.rejects(
    () => resolveLoadReference(stub.client, 'Plank'),
    /off-machine movement — it carries no cable load/
  );
  assert.equal(stub.detailFetches.length, 0, 'an unconvertible movement must not cost a scan');
  assert.equal(stub.summaryFetches, 0);
});

test('get_load_reference reports the off-machine failure rather than a factor', async () => {
  const stub = stubClient(BENCH_ACTIVITY);
  const response = await getLoadReference(stub.client, { movementName: 'Plank' });

  assert.equal(response.isError, true);
  const text = reportText(response);
  assert.match(text, /carries no cable load/);
  assert.match(text, /use weight: 0 if a load field is required/);
  assert.doesNotMatch(text, /Cable factor/, 'no factor may be reported for a movement with no cables');
});

test('create_workout writes nothing when weightLb is used on an off-machine movement', async () => {
  const stub = creatingClient(BENCH_ACTIVITY);
  const response = await createWorkout(stub.client, {
    title: 'Off Machine Day',
    exercises: [{ movementName: 'Plank', sets: 3, duration: 45, weightLb: 25 }],
  });

  assert.equal(response.isError, true);
  assert.equal(stub.created.count, 0);
  assert.match(reportText(response), /off-machine movement/);
});

test('an off-machine movement is still fine without weightLb', async () => {
  const stub = creatingClient(BENCH_ACTIVITY);
  const text = reportText(
    await createWorkout(stub.client, {
      title: 'Core Day',
      exercises: [{ movementName: 'Plank', sets: 3, duration: 45 }],
    })
  );

  assert.equal(stub.created.count, 1, 'only a pounds prescription needs a cable factor');
  assert.equal(stub.detailFetches.length, 0);
  assert.doesNotMatch(text, /Pound-Based Load Conversion/);
});
