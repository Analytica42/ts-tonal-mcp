import assert from 'node:assert/strict';
import test from 'node:test';
import type { TonalMovement } from '@dlwiest/ts-tonal-client';
import {
  ASSUMED_LOAD_FACTOR,
  ENGAGEMENT_CLASS_CALIBRATION,
  factorBasisStatement,
  type LoadFactorResolution,
  convertPoundsToPercentage,
  type LoadReference,
  MOVEMENT_CALIBRATION_REGISTRY,
  resolveLoadFactor,
  unverifiedFactorWarning,
} from '../src/utils/load-calibration.js';
import { formatLoadReferenceReport } from '../src/utils/load-report.js';

// Measured calibration, 2026-10-08. Two workouts, one per cable-engagement class, are the
// only numbers in this feature that came off a physical machine:
//
//   both cables  Barbell Bench Press    pct 50/75/100 displayed  84/125/167 lb, 1RM 83.50363
//   one cable    Standing Leg Extension pct 25/50/75  displayed  26/52/78    lb, 1RM 104.21186002414206
//
// The single-cable read rules out factor 2 outright: at factor 2 those percentages would
// have displayed 52/104/156 lb.
const BENCH_ONE_REP_MAX = 83.50363;
const LEG_EXTENSION_ONE_REP_MAX = 104.21186002414206;

/** A resolution no measurement backs. Unreachable in production; the machinery must survive. */
function unverifiedResolution(
  cableEngagement: 'simultaneous' | 'single' = 'single'
): LoadFactorResolution {
  return {
    factor: ASSUMED_LOAD_FACTOR,
    factorVerified: false,
    factorBasis: 'unverified',
    cableEngagement,
    singleCableHypothesis: {
      factor: 1,
      likelihood: cableEngagement === 'single' ? 'likely' : 'unlikely',
      rationale: 'synthetic resolution: no calibration covers this engagement class',
    },
  };
}

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

function legExtensionReference(): LoadReference {
  const factor = resolveLoadFactor(
    movement({ name: 'Standing Leg Extension', onMachineInfo: { trainerArmsPulledAtSameTime: false } })
  );
  return reference({
    movementId: 'm-leg-extension',
    movementName: 'Standing Leg Extension',
    oneRepMax: LEG_EXTENSION_ONE_REP_MAX,
    denominatorPounds: factor.factor * LEG_EXTENSION_ONE_REP_MAX,
    poundsPerPercentagePoint: (factor.factor * LEG_EXTENSION_ONE_REP_MAX) / 100,
    factor,
  });
}

test('both engagement classes are calibrated, each from its own trainer measurement', () => {
  assert.equal(ENGAGEMENT_CLASS_CALIBRATION.size, 2, 'one entry per cable-engagement class');

  const simultaneous = ENGAGEMENT_CLASS_CALIBRATION.get('simultaneous');
  assert.ok(simultaneous);
  assert.equal(simultaneous.factor, 2);
  assert.equal(simultaneous.verifiedOn, '2026-10-08');
  assert.match(simultaneous.evidence, /84\/125\/167/);
  assert.match(simultaneous.evidence, /83\.50363/);
  assert.match(simultaneous.evidence, /Barbell Bench Press/, 'the class must name the movement measured');

  const single = ENGAGEMENT_CLASS_CALIBRATION.get('single');
  assert.ok(single);
  assert.equal(single.factor, 1, 'the single-cable factor is 1, measured, not 2');
  assert.equal(single.verifiedOn, '2026-10-08');
  assert.match(single.evidence, /26\/52\/78/);
  assert.match(single.evidence, /104\.21186002414206/);
  assert.match(single.evidence, /Standing Leg Extension/);
});

test('the per-movement override layer holds exactly the two movements actually measured', () => {
  assert.equal(MOVEMENT_CALIBRATION_REGISTRY.size, 2);
  assert.equal(MOVEMENT_CALIBRATION_REGISTRY.get('barbell bench press')?.factor, 2);
  assert.equal(MOVEMENT_CALIBRATION_REGISTRY.get('standing leg extension')?.factor, 1);
  // Every per-movement entry must agree with its class, or the disagreement is the finding.
  MOVEMENT_CALIBRATION_REGISTRY.forEach((entry) => {
    assert.ok(entry.evidence.length > 0, 'an override without evidence is a guess');
  });
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

test('a movement measured directly reports itself as movement-calibrated', () => {
  const bench = resolveLoadFactor(
    movement({ name: 'Barbell Bench Press', onMachineInfo: { trainerArmsPulledAtSameTime: true } })
  );
  assert.equal(bench.factor, 2);
  assert.equal(bench.factorVerified, true);
  assert.equal(bench.factorBasis, 'movement-calibrated');
  assert.equal(bench.cableEngagement, 'simultaneous');
  assert.equal(bench.singleCableHypothesis, undefined);
  assert.ok(bench.calibration);
  assert.match(factorBasisStatement(bench), /measured on this movement itself/);

  const legExtension = resolveLoadFactor(
    movement({ name: 'Standing Leg Extension', onMachineInfo: { trainerArmsPulledAtSameTime: false } })
  );
  assert.equal(legExtension.factor, 1, 'the single-cable measurement resolved factor 1');
  assert.equal(legExtension.factorVerified, true);
  assert.equal(legExtension.factorBasis, 'movement-calibrated');
  assert.equal(legExtension.cableEngagement, 'single');
  assert.equal(legExtension.singleCableHypothesis, undefined);
});

test('an unmeasured movement inherits its engagement class, keyed on the cable attribute', () => {
  const simultaneous = resolveLoadFactor(
    movement({ name: 'Lateral Raise', isBilateral: true, onMachineInfo: { trainerArmsPulledAtSameTime: true } })
  );
  assert.equal(simultaneous.factorBasis, 'class-calibrated');
  assert.equal(simultaneous.cableEngagement, 'simultaneous');
  assert.equal(simultaneous.factor, 2);
  assert.equal(simultaneous.factorVerified, true, 'the class it belongs to was measured');
  assert.equal(simultaneous.singleCableHypothesis, undefined, 'a verified class has no open hypothesis');

  const single = resolveLoadFactor(
    movement({
      name: 'Single-Arm Bent Over Row',
      isBilateral: false,
      isTwoSided: true,
      onMachineInfo: { trainerArmsPulledAtSameTime: false },
    })
  );
  assert.equal(single.factorBasis, 'class-calibrated');
  assert.equal(single.cableEngagement, 'single');
  assert.equal(single.factor, 1, 'single-cable movements resolve at the measured factor 1');
  assert.equal(single.factorVerified, true);
  assert.equal(single.singleCableHypothesis, undefined);
});

test('a class-calibrated factor states that it is an inference, not a measurement here', () => {
  const statement = factorBasisStatement(
    resolveLoadFactor(
      movement({ name: 'Lateral Raise', onMachineInfo: { trainerArmsPulledAtSameTime: true } })
    )
  );
  assert.match(statement, /cable-engagement class/);
  assert.match(statement, /ONE movement's live trainer measurement/);
  assert.match(statement, /Barbell Bench Press/, 'the measurement behind the class is named');
  assert.match(statement, /not a measurement of this movement/);
});

test('a renamed bench inherits its class, never the per-movement measurement', () => {
  const resolution = resolveLoadFactor(
    movement({ name: 'Barbell Bench Press (Wide Grip)', onMachineInfo: { trainerArmsPulledAtSameTime: true } })
  );
  assert.equal(
    resolution.factorBasis,
    'class-calibrated',
    'only the exact measured name claims a per-movement measurement'
  );
  assert.equal(resolution.factor, 2, 'the class factor still applies');
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
  assert.equal(resolution.factorBasis, 'class-calibrated');
  assert.equal(resolution.cableEngagement, 'simultaneous', 'limbs must not override cables');
  assert.equal(resolution.factor, 2, 'both cables bear load, so the measured factor is 2');
  assert.equal(resolution.factorVerified, true);
  assert.equal(resolution.singleCableHypothesis, undefined);
});

test('the cable attribute is read, never isBilateral: one cable, both legs', () => {
  const resolution = resolveLoadFactor(
    movement({
      name: 'Goblet Squat',
      isBilateral: true, // both legs
      onMachineInfo: { trainerArmsPulledAtSameTime: false }, // single handle at the chest
    })
  );
  assert.equal(resolution.factorBasis, 'class-calibrated');
  assert.equal(resolution.cableEngagement, 'single', 'limbs must not override cables');
  assert.equal(
    resolution.factor,
    1,
    'one cable bears load: the single-cable measurement makes this 1, not the old assumed 2'
  );
  assert.equal(resolution.factorVerified, true);
  assert.equal(resolution.singleCableHypothesis, undefined);
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

test('every movement with a cable attribute now resolves verified, by class or by measurement', () => {
  // The fallback exists for a class with no calibration; with both classes measured, no
  // real movement may land on it. If one does, the registry lost an entry.
  for (const [name, armsPulledAtSameTime, expectedFactor] of [
    ['Single-Arm Bent Over Row', false, 1],
    ['Lateral Raise', true, 2],
    ['Goblet Squat', false, 1],
    ['Racked Reverse Lunge', true, 2],
  ] as const) {
    const resolution = resolveLoadFactor(
      movement({ name, onMachineInfo: { trainerArmsPulledAtSameTime: armsPulledAtSameTime } })
    );
    assert.equal(resolution.factorVerified, true, `${name} must resolve against a measurement`);
    assert.notEqual(resolution.factorBasis, 'unverified');
    assert.equal(resolution.factor, expectedFactor, `${name} must convert at factor ${expectedFactor}`);
  }

  // Unchanged, and still the safe direction if it is ever reached: over-assuming the factor
  // under-loads, under-assuming it doubles the load.
  assert.equal(ASSUMED_LOAD_FACTOR, 2);
});

test('an unverified conversion reports the half-load consequence, never a doubling', () => {
  // No catalog movement reaches this path now that both classes are calibrated, so the
  // resolution is synthesised. The machinery must still fire if a class entry disappears.
  const unverified = reference({
    movementName: 'Uncalibrated Movement',
    factor: unverifiedResolution('single'),
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
  assert.doesNotMatch(
    warning,
    /Barbell Bench Press/,
    'the warning must not claim the bench is the only measurement any more'
  );
  assert.match(factorBasisStatement(unverified.factor), /UNVERIFIED/);
});

test('a verified conversion carries no single-cable alternative at all', () => {
  const conversion = convertPoundsToPercentage(125.26, reference());
  assert.equal(conversion.singleCableDisplayPounds, undefined);
});

test('conversion reproduces the three measured single-cable calibration points', () => {
  const ref = legExtensionReference();
  assert.equal(ref.factor.factor, 1);
  assert.equal(ref.denominatorPounds, LEG_EXTENSION_ONE_REP_MAX, 'factor 1 means the denominator is the 1RM');

  // target_lb -> expected weightPercentage, straight off the trainer readout (26/52/78 lb).
  for (const [targetPounds, expectedPercentage] of [
    [26.05, 25],
    [52.11, 50],
    [78.16, 75],
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

test('the ruled-out factor 2 would have halved every single-cable prescription', () => {
  // The bug this measurement fixed: 52 lb asked for, 25% sent, ~26 lb displayed.
  const ref = legExtensionReference();
  assert.equal(convertPoundsToPercentage(52, ref).weightPercentage, 50);
  assert.equal(
    Math.round((52 / (2 * LEG_EXTENSION_ONE_REP_MAX)) * 100),
    25,
    'at the old assumed factor the same request sent 25% -- half the load'
  );
});

test('a movement covered by a verified class emits no half-load warning', () => {
  const classVerified = reference({
    movementName: 'Goblet Squat',
    factor: resolveLoadFactor(
      movement({ name: 'Goblet Squat', onMachineInfo: { trainerArmsPulledAtSameTime: false } })
    ),
    oneRepMax: LEG_EXTENSION_ONE_REP_MAX,
    denominatorPounds: LEG_EXTENSION_ONE_REP_MAX,
    poundsPerPercentagePoint: LEG_EXTENSION_ONE_REP_MAX / 100,
  });

  assert.equal(classVerified.factor.factorVerified, true);
  assert.equal(
    convertPoundsToPercentage(52.11, classVerified).singleCableDisplayPounds,
    undefined,
    'a verified factor has no alternative figure to report'
  );
  assert.doesNotMatch(
    formatLoadReferenceReport(classVerified),
    /Unverified Cable Factor/,
    'warning a user about a measured factor teaches them to ignore warnings'
  );
});

test('an unresolved movement still gets the full warning machinery in the report', () => {
  const unverified = reference({
    movementName: 'Uncalibrated Movement',
    factor: unverifiedResolution('single'),
  });
  const report = formatLoadReferenceReport(unverified);

  assert.match(report, /Factor verified: NO/);
  assert.match(report, /Factor basis: unverified/);
  assert.match(report, /## ⚠️ Unverified Cable Factor/);
  assert.match(report, /HALF the pounds requested/);
});
