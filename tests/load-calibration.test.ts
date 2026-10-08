import assert from 'node:assert/strict';
import test from 'node:test';
import type { TonalMovement } from '@dlwiest/ts-tonal-client';
import {
  ASSUMED_LOAD_FACTOR,
  CALIBRATION_REGISTRY,
  convertPoundsToPercentage,
  type LoadReference,
  resolveLoadFactor,
  unverifiedFactorWarning,
} from '../src/utils/load-calibration.js';

// Measured calibration, 2026-10-08: a workout with three Barbell Bench Press sets at
// weightPercentage 50/75/100 displayed 84/125/167 lb on the trainer against an API
// oneRepMax of 83.50363. These are the only numbers in this feature that came off a
// physical machine, so they are the fixture everything else is checked against.
const BENCH_ONE_REP_MAX = 83.50363;

function movement(overrides: Record<string, unknown>): TonalMovement {
  return {
    id: 'm-1',
    name: 'Test Movement',
    onMachine: true,
    isBilateral: true,
    isTwoSided: false,
    onMachineInfo: { trainerArmsPulledAtSameTime: true },
    ...overrides,
  } as unknown as TonalMovement;
}

function reference(overrides: Partial<LoadReference> = {}): LoadReference {
  const factor = overrides.factor ?? resolveLoadFactor(movement({ name: 'Barbell Bench Press' }));
  const oneRepMax = overrides.oneRepMax ?? BENCH_ONE_REP_MAX;
  const denominatorPounds = overrides.denominatorPounds ?? factor.factor * oneRepMax;
  return {
    movementId: 'm-1',
    movementName: 'Barbell Bench Press',
    oneRepMax,
    denominatorPounds,
    poundsPerPercentagePoint: denominatorPounds / 100,
    factor,
    referenceSet: {
      activityId: 'a-1',
      performedAt: '2026-10-07T12:00:00Z',
      ageDays: 1,
      baseWeight: 69.5,
      avgWeight: 64.3,
      repCount: 8,
      weightPercentage: 42,
      impliedPercentage: 41.61,
      impliedPercentageBasis: 'baseWeight',
    },
    activitiesScanned: 1,
    resolvedAt: Date.parse('2026-10-08T12:00:00Z'),
    ...overrides,
  };
}

test('the registry holds exactly the one movement measured against a trainer', () => {
  assert.equal(CALIBRATION_REGISTRY.size, 1, 'no movement may be marked verified without a measurement');
  const bench = CALIBRATION_REGISTRY.get('barbell bench press');
  assert.ok(bench);
  assert.equal(bench.factor, 2);
  assert.equal(bench.verifiedOn, '2026-10-08');
  assert.match(bench.evidence, /84\/125\/167/);
  assert.match(bench.evidence, /83\.50363/);
});

test('conversion reproduces the three measured calibration points', () => {
  const ref = reference();
  assert.equal(ref.denominatorPounds, 2 * BENCH_ONE_REP_MAX);

  // target_lb -> expected weightPercentage, straight off the trainer readout.
  for (const [targetPounds, expectedPercentage] of [
    [83.5, 50],
    [125.26, 75],
    [167.01, 100],
  ] as const) {
    const conversion = convertPoundsToPercentage(targetPounds, ref);
    assert.equal(
      conversion.weightPercentage,
      expectedPercentage,
      `${targetPounds} lb must convert to ${expectedPercentage}%`
    );
    assert.ok(Number.isInteger(conversion.weightPercentage), 'the wire value must be an integer');
    assert.ok(
      Math.abs(conversion.deltaPounds) < ref.poundsPerPercentagePoint,
      'rounding error cannot exceed one percentage point'
    );
  }
});

test('a target between percentage points returns an integer with the achievable load and delta', () => {
  const ref = reference();
  const conversion = convertPoundsToPercentage(100, ref);

  // 100 / 167.00726 * 100 = 59.8776..., which is not a whole percentage point.
  assert.equal(conversion.weightPercentage, 60);
  assert.ok(Number.isInteger(conversion.weightPercentage));
  assert.equal(conversion.achievablePounds, 100.2, '60% of 167.00726 lb');
  assert.equal(conversion.deltaPounds, 0.2, 'delta is signed and reported in pounds');
  assert.equal(conversion.targetPounds, 100, 'the request is echoed, not overwritten');
  assert.equal(conversion.exceedsCalibratedRange, false);
  assert.equal(conversion.roundedToZero, false);
});

test('a target of 0 converts to 0 and is not treated as a rounding failure', () => {
  const conversion = convertPoundsToPercentage(0, reference());
  assert.equal(conversion.weightPercentage, 0);
  assert.equal(conversion.achievablePounds, 0);
  assert.equal(conversion.deltaPounds, 0);
  assert.equal(conversion.roundedToZero, false, '0 lb asked for 0 lb and got it');
});

test('a non-zero target that rounds down to no resistance is flagged', () => {
  const conversion = convertPoundsToPercentage(0.5, reference());
  assert.equal(conversion.weightPercentage, 0);
  assert.equal(conversion.roundedToZero, true);
  assert.equal(conversion.deltaPounds, -0.5);
});

test('a percentage above the measured range is flagged, not capped', () => {
  const conversion = convertPoundsToPercentage(250, reference());
  assert.equal(conversion.weightPercentage, 150, 'values above 100 round-trip, so they are not capped');
  assert.equal(conversion.exceedsCalibratedRange, true);
});

test('a negative target is rejected rather than producing a negative percentage', () => {
  assert.throws(
    () => convertPoundsToPercentage(-10, reference()),
    /greater than or equal to 0/
  );
});

test('a non-numeric target is rejected', () => {
  assert.throws(() => convertPoundsToPercentage('100' as unknown, reference()), /finite number/);
  assert.throws(() => convertPoundsToPercentage(Number.NaN, reference()), /finite number/);
});

test('the calibrated movement is verified and carries no single-cable hypothesis', () => {
  const resolution = resolveLoadFactor(
    movement({ name: 'Barbell Bench Press', onMachineInfo: { trainerArmsPulledAtSameTime: true } })
  );
  assert.equal(resolution.factor, 2);
  assert.equal(resolution.factorVerified, true);
  assert.equal(resolution.factorBasis, 'calibrated');
  assert.equal(resolution.cableEngagement, 'simultaneous');
  assert.equal(resolution.singleCableHypothesis, undefined);
  assert.ok(resolution.calibration);
});

test('the factor keys on trainerArmsPulledAtSameTime, not on the movement name', () => {
  const simultaneous = resolveLoadFactor(
    movement({ name: 'Lateral Raise', isBilateral: true, onMachineInfo: { trainerArmsPulledAtSameTime: true } })
  );
  assert.equal(simultaneous.factorBasis, 'trainerArmsPulledAtSameTime');
  assert.equal(simultaneous.cableEngagement, 'simultaneous');
  assert.equal(simultaneous.factorVerified, false, 'matching the bench attribute is not a measurement');
  assert.equal(simultaneous.singleCableHypothesis?.likelihood, 'unlikely');

  const single = resolveLoadFactor(
    movement({
      name: 'Single-Arm Bent Over Row',
      isBilateral: false,
      isTwoSided: true,
      onMachineInfo: { trainerArmsPulledAtSameTime: false },
    })
  );
  assert.equal(single.factorBasis, 'trainerArmsPulledAtSameTime');
  assert.equal(single.cableEngagement, 'single');
  assert.equal(single.factorVerified, false);
  assert.equal(single.singleCableHypothesis?.likelihood, 'likely');
});

test('the attribute wins over the name: a renamed bench is not auto-verified', () => {
  const resolution = resolveLoadFactor(
    movement({ name: 'Barbell Bench Press (Wide Grip)', onMachineInfo: { trainerArmsPulledAtSameTime: true } })
  );
  assert.equal(resolution.factorVerified, false, 'only the exact calibrated name is verified');
  assert.equal(resolution.factorBasis, 'trainerArmsPulledAtSameTime');
});

// isBilateral describes the athlete's LIMBS; trainerArmsPulledAtSameTime describes the
// CABLES. Across all 361 catalog movements the two disagree on 37, and only the cable count
// sets resistance. These two movements are in the disagreement set and in the user's actual
// program, so reading the wrong field would mis-prescribe real sessions.
test('the cable attribute is read, never isBilateral: both cables, one leg', () => {
  const resolution = resolveLoadFactor(
    movement({
      name: 'Racked Reverse Lunge',
      isBilateral: false, // one leg at a time
      onMachineInfo: { trainerArmsPulledAtSameTime: true }, // bar on both cables
    })
  );
  assert.equal(resolution.factorBasis, 'trainerArmsPulledAtSameTime');
  assert.equal(resolution.cableEngagement, 'simultaneous', 'limbs must not override cables');
  assert.equal(resolution.factor, 2);
  assert.equal(resolution.singleCableHypothesis?.likelihood, 'unlikely');
});

test('the cable attribute is read, never isBilateral: one cable, both legs', () => {
  const resolution = resolveLoadFactor(
    movement({
      name: 'Goblet Squat',
      isBilateral: true, // both legs
      onMachineInfo: { trainerArmsPulledAtSameTime: false }, // single handle at the chest
    })
  );
  assert.equal(resolution.factorBasis, 'trainerArmsPulledAtSameTime');
  assert.equal(resolution.cableEngagement, 'single', 'limbs must not override cables');
  assert.equal(resolution.singleCableHypothesis?.likelihood, 'likely');
});

test('an off-machine movement fails explicitly instead of resolving a factor', () => {
  // All 125 movements lacking the cable attribute have onMachine false: no cable load at
  // all, so a pounds conversion is meaningless rather than merely uncertain.
  assert.throws(
    () =>
      resolveLoadFactor(
        movement({ name: 'Plank', onMachine: false, isBilateral: true, onMachineInfo: undefined })
      ),
    (error: Error) => {
      assert.match(error.message, /off-machine movement/);
      assert.match(error.message, /carries no cable load/);
      assert.match(error.message, /pounds cannot be converted/);
      return true;
    }
  );
});

test('a missing cable attribute on an on-machine movement is an explicit failure, not a default', () => {
  // No on-machine movement lacks the attribute today, so this should not occur -- but it
  // must never silently resolve to a factor if the payload changes.
  for (const onMachine of [true, undefined]) {
    assert.throws(
      () =>
        resolveLoadFactor(
          movement({ name: 'Partial Info', onMachine, onMachineInfo: { accessory: 'Handles' } })
        ),
      /Cannot resolve the cable factor for "Partial Info".*trainerArmsPulledAtSameTime/s
    );
  }
});

test('a calibration entry cannot rescue a movement with no cable load', () => {
  // The registry overrides the numeric factor, not the existence of cable resistance.
  assert.throws(
    () =>
      resolveLoadFactor(
        movement({ name: 'Barbell Bench Press', onMachine: false, onMachineInfo: undefined })
      ),
    /off-machine movement/
  );
});

test('every uncalibrated movement converts at the assumed factor, which is the safe direction', () => {
  // Over-assuming the factor under-loads (target / 2); under-assuming it doubles the load.
  // So an unknown movement must never be converted at 1.
  for (const name of ['Single-Arm Bent Over Row', 'Lateral Raise', 'Goblet Squat']) {
    const resolution = resolveLoadFactor(
      movement({ name, onMachineInfo: { trainerArmsPulledAtSameTime: name === 'Lateral Raise' } })
    );
    assert.equal(resolution.factor, ASSUMED_LOAD_FACTOR, `${name} must not be converted at factor 1`);
    assert.equal(ASSUMED_LOAD_FACTOR, 2);
  }
});

test('an unverified conversion reports the half-load consequence, never a doubling', () => {
  const unverified = reference({
    movementName: 'Single-Arm Bent Over Row',
    factor: resolveLoadFactor(
      movement({ name: 'Single-Arm Bent Over Row', onMachineInfo: { trainerArmsPulledAtSameTime: false } })
    ),
  });
  const conversion = convertPoundsToPercentage(83.5, unverified);

  assert.equal(conversion.weightPercentage, 50);
  // The asymmetry made visible: at factor 1 the same 50% shows ~41.75 lb, i.e. half.
  assert.equal(conversion.singleCableDisplayPounds, 41.75);
  assert.ok(
    conversion.singleCableDisplayPounds! < conversion.achievablePounds,
    'the hypothesis figure must be the lighter one'
  );

  const warning = unverifiedFactorWarning(unverified);
  assert.match(warning, /UNVERIFIED/);
  assert.match(warning, /factorVerified: false/);
  assert.match(warning, /HALF/, 'the stated failure mode is under-loading');
  assert.doesNotMatch(warning, /double|DOUBLE/, 'the default factor cannot over-load');
  assert.match(warning, /trainer displays before lifting/i);
});

test('a verified conversion carries no single-cable alternative at all', () => {
  const conversion = convertPoundsToPercentage(125.26, reference());
  assert.equal(conversion.singleCableDisplayPounds, undefined);
});
