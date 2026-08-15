import assert from 'node:assert/strict';
import test from 'node:test';
import type { TonalMovement, WorkoutSet } from '@dlwiest/ts-tonal-client';
import {
  exercisesToSets,
  reconstructExercisesFromSets,
} from '../src/utils/workout-conversion.js';

// Regression coverage for movements OUTSIDE the cached catalog.
//
// getMovements() serves a 24h-cached /movements snapshot, so a workout can legitimately
// reference a movement the snapshot does not contain: newly added, retired, or simply a
// stale cache. The golden fixture and the real-data diff both run against a warm,
// complete 331-movement cache, so neither can catch this class -- hence a dedicated test.
//
// The read and write paths MUST classify a movement identically. exercisesToSets uses
// `isDurationBased = !movement.countReps` (truthy), so reconstructExercisesFromSets must
// mirror that with a truthy check. A `!== false` form diverges for a nullish countReps:
// read takes the reps branch while write calls it duration-based, and the edit then throws.

function movement(id: string, name: string, countReps: boolean): TonalMovement {
  return {
    id,
    createdAt: '',
    updatedAt: '',
    name,
    shortName: name,
    muscleGroups: [],
    countReps,
  } as unknown as TonalMovement;
}

function durationSet(movementId: string, seconds: number): WorkoutSet {
  return {
    movementId,
    blockNumber: 1,
    setGroup: 1,
    repetition: 1,
    repetitionTotal: 1,
    round: 1,
    blockStart: true,
    weightPercentage: 50,
    warmUp: false,
    dropSet: false,
    burnout: false,
    description: '',
    prescribedDuration: seconds,
    durationBasedRepGoal: seconds,
  } as unknown as WorkoutSet;
}

test('a set whose movement is missing from the catalog keeps its duration goal', () => {
  // Empty catalog stands in for a stale/incomplete snapshot.
  const exercises = reconstructExercisesFromSets([durationSet('ghost-movement', 45)], []);

  assert.equal(exercises.length, 1, 'the exercise must survive reconstruction');
  const detail = exercises[0].setDetails?.[0];
  assert.ok(detail, 'setDetails must be populated');
  assert.equal(detail.duration, 45, 'the 45s goal must not be silently dropped');
  assert.equal(detail.reps, undefined, 'a duration goal must not be reported as reps');
});

test('a reps set whose movement is missing from the catalog keeps its reps goal', () => {
  const repsSet = {
    ...durationSet('ghost-movement', 0),
    prescribedDuration: undefined,
    durationBasedRepGoal: 0,
    prescribedReps: 12,
  } as unknown as WorkoutSet;

  const exercises = reconstructExercisesFromSets([repsSet], []);
  const detail = exercises[0].setDetails?.[0];
  assert.ok(detail);
  assert.equal(detail.reps, 12, 'the reps goal must not be silently dropped');
  assert.equal(detail.duration, undefined, 'no duration should be invented');
});

test('read and write agree for a duration movement, so the edit round trip does not throw', () => {
  // The movement IS known here and is duration-based. Reconstructing and re-emitting must
  // round-trip rather than throwing "requires a duration in seconds" -- the second failure
  // mode the misaligned predicate produced.
  const catalog = [movement('hold-1', 'Echo Hold', false)];
  const exercises = reconstructExercisesFromSets([durationSet('hold-1', 30)], catalog);

  assert.doesNotThrow(() => exercisesToSets(exercises, catalog));
  const regenerated = exercisesToSets(exercises, catalog);
  assert.equal(regenerated.length, 1);
  assert.equal(regenerated[0].prescribedDuration, 30);
  assert.equal(regenerated[0].prescribedReps, undefined);
});

test('the legacy durationBasedRepGoal name still resolves when prescribedDuration is absent', () => {
  const legacy = {
    ...durationSet('hold-1', 0),
    prescribedDuration: undefined,
    durationBasedRepGoal: 20,
  } as unknown as WorkoutSet;

  const catalog = [movement('hold-1', 'Echo Hold', false)];
  const exercises = reconstructExercisesFromSets([legacy], catalog);
  assert.equal(exercises[0].setDetails?.[0].duration, 20);
});
