import assert from 'node:assert/strict';
import test from 'node:test';
import type TonalClient from '@dlwiest/ts-tonal-client';
import type {
  TonalMovement,
  TonalWorkout,
  TonalWorkoutEstimateSet,
} from '@dlwiest/ts-tonal-client';
import {
  deleteCustomWorkout,
  findWorkoutByName,
  getCustomWorkoutDetails,
} from '../src/tools/custom-workouts.js';
import { updateWorkout } from '../src/tools/workout-editing.js';

function workout(
  id: string,
  title: string,
  overrides: Partial<TonalWorkout> = {}
): TonalWorkout {
  return {
    id,
    title,
    createdAt: '2026-01-01T00:00:00.000Z',
    shortDescription: '',
    description: '',
    assetId: 'asset-id',
    coachId: 'coach-id',
    sets: [],
    duration: 600,
    level: 'Intermediate',
    ...overrides,
  } as TonalWorkout;
}

function tonalClient(methods: Record<string, unknown>): TonalClient {
  return methods as unknown as TonalClient;
}

const BENCH_MOVEMENT = {
  id: 'bench',
  name: 'Bench Press',
  countReps: true,
} as TonalMovement;

test('name lookup preserves complete pagination and caps an always-full response', async () => {
  const exactlyOnePage = Array.from({ length: 100 }, (_, index) =>
    workout(`exact-${index}`, `Workout ${index}`)
  );
  const exactOffsets: number[] = [];
  const exactClient = tonalClient({
    getUserWorkouts: async (offset: number, limit: number) => {
      exactOffsets.push(offset);
      return exactlyOnePage.slice(offset, offset + limit);
    },
  });
  assert.deepEqual(await findWorkoutByName(exactClient, 'missing'), []);
  assert.deepEqual(exactOffsets, [0, 100]);

  const manyWorkouts = Array.from({ length: 250 }, (_, index) =>
    workout(
      `many-${index}`,
      index === 20 || index === 220 ? 'Duplicate' : `Workout ${index}`
    )
  );
  const manyOffsets: number[] = [];
  const manyClient = tonalClient({
    getUserWorkouts: async (offset: number, limit: number) => {
      manyOffsets.push(offset);
      return manyWorkouts.slice(offset, offset + limit);
    },
  });
  assert.deepEqual(
    (await findWorkoutByName(manyClient, 'duplicate')).map(({ id }) => id),
    ['many-20', 'many-220']
  );
  assert.deepEqual(manyOffsets, [0, 100, 200]);

  let emptyCalls = 0;
  const emptyClient = tonalClient({
    getUserWorkouts: async () => {
      emptyCalls++;
      return [];
    },
  });
  assert.deepEqual(await findWorkoutByName(emptyClient, 'missing'), []);
  assert.equal(emptyCalls, 1);

  const cachedFullPage = Array.from({ length: 100 }, (_, index) =>
    workout(`cached-${index}`, `Cached ${index}`)
  );
  let pathologicalCalls = 0;
  const pathologicalClient = tonalClient({
    getUserWorkouts: async () => {
      pathologicalCalls++;
      if (pathologicalCalls > 50) {
        throw new Error('Synthetic request budget exceeded');
      }
      return cachedFullPage;
    },
  });
  await assert.rejects(
    () => findWorkoutByName(pathologicalClient, 'missing'),
    /Workout lookup exceeded pagination limit of 50 pages/
  );
  assert.equal(pathologicalCalls, 50);
});

test('update_workout forwards the fetched short description', async () => {
  const existingWorkout = workout('workout-id', 'Existing Workout', {
    shortDescription: 'Keep this app-created summary',
    description: 'Long description',
  });
  let submittedPayload: Record<string, unknown> | undefined;
  const client = tonalClient({
    getUserWorkouts: async () => [existingWorkout],
    getWorkoutById: async () => existingWorkout,
    getMovements: async () => [BENCH_MOVEMENT],
    updateWorkout: async (payload: Record<string, unknown>) => {
      submittedPayload = payload;
      return workout('workout-id', String(payload.title), {
        shortDescription: existingWorkout.shortDescription,
        description: String(payload.description),
        sets: payload.sets as TonalWorkoutEstimateSet[] as TonalWorkout['sets'],
      });
    },
  });

  const response = await updateWorkout(client, {
    workoutName: 'Existing Workout',
    exercises: [{ movementName: 'Bench Press', sets: 1, reps: 5 }],
  });

  assert.equal(response.isError, undefined);
  assert.equal(
    submittedPayload?.shortDescription,
    'Keep this app-created summary'
  );
});

test('an existing workout deletion preview succeeds without deleting', async () => {
  const existingWorkout = workout('preview-id', 'Preview Me');
  let deleteCalls = 0;
  const client = tonalClient({
    getUserWorkouts: async () => [existingWorkout],
    deleteWorkout: async () => {
      deleteCalls++;
    },
  });

  const preview = await deleteCustomWorkout(client, {
    workoutName: 'Preview Me',
    confirm: false,
  });
  assert.equal(preview.isError, undefined);
  assert.equal(deleteCalls, 0);

  const missing = await deleteCustomWorkout(
    tonalClient({ getUserWorkouts: async () => [] }),
    { workoutName: 'Does Not Exist', confirm: false }
  );
  assert.equal(missing.isError, true);
});

test('custom workout details render stored 1-based block headings unchanged', async () => {
  const storedSets: TonalWorkoutEstimateSet[] = [1, 2].map((blockNumber) => ({
    blockStart: true,
    movementId: 'bench',
    prescribedReps: 5,
    repetition: 1,
    repetitionTotal: 1,
    blockNumber,
    burnout: false,
    spotter: false,
    eccentric: false,
    chains: false,
    flex: false,
    warmUp: false,
    weightPercentage: 50,
    setGroup: 1,
    round: 1,
    description: '',
    dropSet: false,
  }));
  const detailedWorkout = workout('stored-blocks', 'Stored Blocks', {
    sets: storedSets as TonalWorkout['sets'],
  });
  const client = tonalClient({
    getUserWorkouts: async () => [detailedWorkout],
    getWorkoutById: async () => detailedWorkout,
    getMovements: async () => [BENCH_MOVEMENT],
  });

  const response = await getCustomWorkoutDetails(client, {
    workoutName: 'Stored Blocks',
  });

  assert.equal(response.isError, undefined);
  const content = response.content[0];
  assert.ok(content && content.type === 'text');
  assert.deepEqual(content.text.match(/^### Block \d+$/gm), [
    '### Block 1',
    '### Block 2',
  ]);
});
