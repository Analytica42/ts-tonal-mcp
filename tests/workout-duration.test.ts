import assert from 'node:assert/strict';
import test from 'node:test';
import type TonalClient from '@dlwiest/ts-tonal-client';
import type { TonalMovement, TonalWorkoutEstimateSet } from '@dlwiest/ts-tonal-client';
import { estimateWorkoutDuration } from '../src/tools/workout-duration.js';
import type { MCPResponse } from '../src/types/index.js';

function fakeClient(methods: Record<string, unknown>): TonalClient {
  // Test seam: only the methods under exercise are stubbed, so the real TonalClient shape
  // is deliberately not satisfied.
  const stub = methods as unknown as TonalClient;
  return stub;
}

function reportText(response: MCPResponse): string {
  const [content] = response.content;
  assert.ok(content && content.type === 'text', 'expected a text content block');
  return content.text;
}

const BENCH = { id: 'bench', name: 'Bench Press', countReps: true } as unknown as TonalMovement;
const PLANK = { id: 'plank', name: 'Plank', countReps: false } as unknown as TonalMovement;

function client(estimate: (sets: TonalWorkoutEstimateSet[]) => Promise<{ duration: number }>) {
  return fakeClient({
    getMovements: async () => [BENCH, PLANK],
    estimateWorkoutDuration: estimate,
  });
}

test('estimates duration through the client without creating a workout', async () => {
  let received: TonalWorkoutEstimateSet[] | undefined;
  const response = await estimateWorkoutDuration(
    client(async sets => {
      received = sets;
      return { duration: 725 };
    }),
    { exercises: [{ movementName: 'Bench Press', sets: 3, reps: 10 }] }
  );

  const text = reportText(response);
  assert.notEqual(response.isError, true);
  assert.match(text, /\*\*12 minutes\*\*/, '725s rounds to 12 minutes');
  assert.match(text, /725s across 3 sets/);
  assert.match(text, /1\. \*\*Bench Press\*\* - 3 sets × 10 reps/);
  assert.match(text, /nothing was created or modified/);
  assert.equal(received?.length, 3, 'three sets must reach the client');
});

test('singularizes a one-set estimate', async () => {
  const text = reportText(
    await estimateWorkoutDuration(client(async () => ({ duration: 60 })), {
      exercises: [{ movementName: 'Bench Press', sets: 1, reps: 5 }],
    })
  );

  assert.match(text, /60s across 1 set\b/, 'one set must not read "1 sets"');
  assert.match(text, /\*\*1 minute\*\*/, 'one minute must not read "1 minutes"');
});

test('reports duration-based exercises in seconds, not reps', async () => {
  const text = reportText(
    await estimateWorkoutDuration(client(async () => ({ duration: 180 })), {
      exercises: [{ movementName: 'Plank', sets: 3, duration: 45 }],
    })
  );

  assert.match(text, /\*\*Plank\*\* - 3 sets × 45s/);
  assert.doesNotMatch(text, /reps/);
});

test('labels an exercise weight as a fallback when only some sets specify their own', async () => {
  // exercisesToSets resolves per-set weight as (setDetail.weight ?? exercise.weight ?? 0),
  // so 70 reaches only the set that omits a weight. A bare "@ 70%" would imply all three.
  let received: TonalWorkoutEstimateSet[] | undefined;
  const text = reportText(
    await estimateWorkoutDuration(
      client(async sets => {
        received = sets;
        return { duration: 300 };
      }),
      {
        exercises: [
          {
            movementName: 'Bench Press',
            weight: 70,
            setDetails: [{ reps: 10 }, { reps: 8, weight: 85 }, { reps: 6, weight: 95 }],
          },
        ],
      }
    )
  );

  assert.match(text, /3 sets with per-set programming @ 70% where unspecified/);
  assert.equal(received?.[0].weightPercentage, 70, 'set without its own weight inherits 70');
  assert.equal(received?.[1].weightPercentage, 85, 'set with its own weight keeps 85');
  assert.equal(received?.[2].weightPercentage, 95, 'set with its own weight keeps 95');
});

test('omits the exercise weight entirely when every set specifies its own', async () => {
  const text = reportText(
    await estimateWorkoutDuration(client(async () => ({ duration: 200 })), {
      exercises: [
        {
          movementName: 'Bench Press',
          weight: 70,
          setDetails: [{ reps: 10, weight: 80 }, { reps: 8, weight: 90 }],
        },
      ],
    })
  );

  // 70 reaches no set, so printing it at all would be false.
  assert.doesNotMatch(text, /70%/);
  assert.match(text, /2 sets with per-set programming$/m);
});

test('singularizes the per-exercise set count, matching the header line', async () => {
  const text = reportText(
    await estimateWorkoutDuration(client(async () => ({ duration: 60 })), {
      exercises: [{ movementName: 'Bench Press', sets: 1, reps: 5 }],
    })
  );

  assert.match(text, /- 1 set × 5 reps/, 'must not read "1 sets" while the header reads "1 set"');
});

test('marks warmup exercises', async () => {
  const text = reportText(
    await estimateWorkoutDuration(client(async () => ({ duration: 120 })), {
      exercises: [{ movementName: 'Bench Press', sets: 2, reps: 12, isWarmup: true }],
    })
  );

  assert.match(text, /\(Warmup\)/);
});

test('missing exercises is a validation error, not a throw', async () => {
  const response = await estimateWorkoutDuration(client(async () => ({ duration: 0 })), {});

  assert.equal(response.isError, true);
  assert.match(reportText(response), /At least one exercise is required/);
});

test('an unknown movement surfaces as a tool error before any request is made', async () => {
  let called = false;
  const response = await estimateWorkoutDuration(
    client(async () => {
      called = true;
      return { duration: 0 };
    }),
    { exercises: [{ movementName: 'Nonexistent Movement', sets: 2, reps: 10 }] }
  );

  assert.equal(response.isError, true);
  assert.equal(called, false, 'no estimate request should be sent for an unknown movement');
});

test('a client-level failure surfaces with its real message intact', async () => {
  // The shape the pre-0.3.1 payload bug produced in practice. Even though the client is
  // fixed, the tool must still report a thrown client error rather than swallowing it or
  // relabeling it as a validation problem.
  const response = await estimateWorkoutDuration(
    client(async () => {
      throw new Error('HTTP 400: json: cannot unmarshal object into Go value of type content.SetList');
    }),
    { exercises: [{ movementName: 'Bench Press', sets: 3, reps: 10 }] }
  );

  assert.equal(response.isError, true);
  const text = reportText(response);
  assert.match(text, /estimate_workout_duration/);
  assert.match(text, /cannot unmarshal object into Go value of type content\.SetList/);
});
