import assert from 'node:assert/strict';
import test from 'node:test';
import type { TonalMovement } from '@dlwiest/ts-tonal-client';
import {
  ACCESSORY_CALIBRATION,
  assertFactorIsWritable,
  factorBasisStatement,
  type LoadFactorResolution,
  convertPoundsToPercentage,
  KNOWN_ACCESSORIES,
  type LoadReference,
  MOVEMENT_CALIBRATION_REGISTRY,
  resolveLoadFactor,
  unverifiedFactorWarning,
} from '../src/utils/load-calibration.js';
import { formatLoadReferenceReport } from '../src/utils/load-report.js';

// Measured calibration, 2026-10-08. Four live trainer readings, one per accessory, are the
// only numbers in this feature that came off a physical machine:
//
//   StraightBar   Barbell Bench Press    pct 50/75/100 displayed 84/125/167 lb, 1RM 83.50363
//   AnkleStraps   Standing Leg Extension pct 25/50/75  displayed 26/52/78   lb, 1RM 104.21186002414206
//   Handles       Skull Crusher          displayed 12 lb vs 12.05 predicted at 1x, 24 at 2x
//   Rope          Hammer Curl            displayed 46 lb vs 44.87 predicted at 1x, 90 at 2x
//
// Skull Crusher is the discriminating case: it carries trainerArmsPulledAtSameTime TRUE, so
// the previous model predicted factor 2 and would have sent half the intended load. The
// reading rules that out, and with it the whole trainerArmsPulledAtSameTime discriminator.
const BENCH_ONE_REP_MAX = 83.50363;
const LEG_EXTENSION_ONE_REP_MAX = 104.21186002414206;

// Neither triceps reading recorded the one-rep max it was taken against, only the predicted
// pounds at each candidate factor. These 1RMs are back-solved so the measured prediction
// lands on a whole percentage; they are arithmetic scaffolding for the test, NOT observed
// values, and nothing but these two tests may rely on them.
const SKULL_CRUSHER_SYNTHETIC_ONE_REP_MAX = 24.1; // 50% x 1 x 24.1 = 12.05, the 1x prediction
const HAMMER_CURL_SYNTHETIC_ONE_REP_MAX = 89.74; // 50% x 1 x 89.74 = 44.87, the 1x prediction

/** A resolution no measurement backs. resolveLoadFactor throws instead; the machinery must survive. */
function unresolvedResolution(accessory = 'SomethingNew'): LoadFactorResolution {
  return {
    factor: 1,
    factorVerified: false,
    factorBasis: 'unresolved',
    accessory,
  };
}

/**
 * Default fixture: Handles WITH trainerArmsPulledAtSameTime true.
 *
 * That pairing is the falsifying case, so every test that takes the default is also a
 * regression against the old discriminator creeping back in.
 */
function movement(overrides: Record<string, unknown>): TonalMovement {
  return {
    id: 'm-1',
    name: 'Test Movement',
    onMachine: true,
    isBilateral: true,
    isTwoSided: false,
    onMachineInfo: { accessory: 'Handles', trainerArmsPulledAtSameTime: true },
    ...overrides,
  } as unknown as TonalMovement;
}

function reference(overrides: Partial<LoadReference> = {}): LoadReference {
  const factor =
    overrides.factor ??
    resolveLoadFactor(
      movement({ name: 'Barbell Bench Press', onMachineInfo: { accessory: 'StraightBar' } })
    );
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

/** A reference for one of the three measured factor-1 movements. */
function factorOneReference(
  name: string,
  accessory: string,
  oneRepMax: number
): LoadReference {
  const factor = resolveLoadFactor(movement({ name, onMachineInfo: { accessory } }));
  assert.equal(factor.factor, 1, `${name} must resolve at factor 1 before it is converted`);
  return reference({
    movementId: `m-${name.toLowerCase().replace(/\s+/g, '-')}`,
    movementName: name,
    oneRepMax,
    denominatorPounds: oneRepMax,
    poundsPerPercentagePoint: oneRepMax / 100,
    factor,
  });
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

test('every accessory in the catalog carries a calibration, four of them measured', () => {
  assert.equal(ACCESSORY_CALIBRATION.size, 5, 'the catalog has exactly five accessories');
  assert.deepEqual(
    [...KNOWN_ACCESSORIES],
    ['StraightBar', 'Handles', 'Rope', 'AnkleStraps', 'PilatesLoops']
  );

  const straightBar = ACCESSORY_CALIBRATION.get('StraightBar');
  assert.ok(straightBar);
  assert.equal(straightBar.factor, 2, 'the bar is one implement on both cables');
  assert.equal(straightBar.verifiedOn, '2026-10-08');
  assert.match(straightBar.evidence, /84\/125\/167/);
  assert.match(straightBar.evidence, /83\.50363/);
  assert.match(straightBar.evidence, /Barbell Bench Press/);

  const handles = ACCESSORY_CALIBRATION.get('Handles');
  assert.ok(handles);
  assert.equal(handles.factor, 1, 'handles are per-limb implements: factor 1, measured');
  assert.equal(handles.verifiedOn, '2026-10-08');
  assert.match(handles.evidence, /Skull Crusher/);
  assert.match(handles.evidence, /12\.05/);

  const rope = ACCESSORY_CALIBRATION.get('Rope');
  assert.ok(rope);
  assert.equal(rope.factor, 1);
  assert.match(rope.evidence, /Hammer Curl/);
  assert.match(rope.evidence, /44\.87/);

  const ankleStraps = ACCESSORY_CALIBRATION.get('AnkleStraps');
  assert.ok(ankleStraps);
  assert.equal(ankleStraps.factor, 1);
  assert.match(ankleStraps.evidence, /26\/52\/78/);
  assert.match(ankleStraps.evidence, /104\.21186002414206/);

  const pilatesLoops = ACCESSORY_CALIBRATION.get('PilatesLoops');
  assert.ok(pilatesLoops);
  assert.equal(pilatesLoops.factor, 1);
  assert.equal(pilatesLoops.verifiedOn, null, 'PilatesLoops has never been read off a trainer');
  assert.match(pilatesLoops.evidence, /UNMEASURED/);
});

test('exactly one accessory is bar-like, so exactly one converts at factor 2', () => {
  const doubling = [...ACCESSORY_CALIBRATION.entries()].filter(([, entry]) => entry.factor === 2);
  assert.deepEqual(
    doubling.map(([accessory]) => accessory),
    ['StraightBar'],
    'any new factor-2 accessory needs its own trainer reading, not inheritance'
  );
});

test('the per-movement override layer holds exactly the four movements actually measured', () => {
  assert.equal(MOVEMENT_CALIBRATION_REGISTRY.size, 4);
  assert.equal(MOVEMENT_CALIBRATION_REGISTRY.get('barbell bench press')?.factor, 2);
  assert.equal(MOVEMENT_CALIBRATION_REGISTRY.get('skull crusher')?.factor, 1);
  assert.equal(MOVEMENT_CALIBRATION_REGISTRY.get('hammer curl')?.factor, 1);
  assert.equal(MOVEMENT_CALIBRATION_REGISTRY.get('standing leg extension')?.factor, 1);
  MOVEMENT_CALIBRATION_REGISTRY.forEach((entry) => {
    assert.ok(entry.evidence.length > 0, 'an override without evidence is a guess');
    assert.ok(entry.verifiedOn, 'an override exists only because a trainer was read');
  });
});

// ---------------------------------------------------------------------------
// The four measured points
// ---------------------------------------------------------------------------

test('conversion reproduces the measured StraightBar points (Barbell Bench Press)', () => {
  const ref = reference();
  assert.equal(ref.factor.factor, 2);
  assert.equal(ref.denominatorPounds, 2 * BENCH_ONE_REP_MAX);

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

test('conversion reproduces the measured AnkleStraps points (Standing Leg Extension)', () => {
  const ref = factorOneReference(
    'Standing Leg Extension',
    'AnkleStraps',
    LEG_EXTENSION_ONE_REP_MAX
  );
  assert.equal(ref.denominatorPounds, LEG_EXTENSION_ONE_REP_MAX, 'factor 1 means the denominator is the 1RM');

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
    assert.ok(Number.isInteger(conversion.weightPercentage));
    assert.ok(Math.abs(conversion.deltaPounds) < ref.poundsPerPercentagePoint);
  }
});

test('Skull Crusher reproduces its measured 1x prediction, not the 2x one', () => {
  // The reading: 12 lb displayed. Predicted 12.05 at factor 1, 24 at factor 2. 12 is the
  // 1x prediction to within a rounding step, and nowhere near the 2x one.
  assert.ok(Math.abs(12 - 12.05) < Math.abs(12 - 24), 'the reading matches 1x, not 2x');

  const ref = factorOneReference('Skull Crusher', 'Handles', SKULL_CRUSHER_SYNTHETIC_ONE_REP_MAX);
  assert.equal(ref.factor.factorBasis, 'movement-calibrated');
  assert.match(ref.factor.calibration?.evidence ?? '', /falsified trainerArmsPulledAtSameTime/);

  const conversion = convertPoundsToPercentage(12.05, ref);
  assert.equal(conversion.weightPercentage, 50);
  assert.equal(conversion.achievablePounds, 12.05, 'the trainer shows what was asked for');

  // The old model: Handles + the attribute true predicted factor 2, so the same request
  // would have been written at half the percentage and lifted at half the load.
  assert.equal(Math.round((12.05 / (2 * SKULL_CRUSHER_SYNTHETIC_ONE_REP_MAX)) * 100), 25);
});

test('Hammer Curl reproduces its measured 1x prediction, not the 2x one', () => {
  assert.ok(Math.abs(46 - 44.87) < Math.abs(46 - 90), 'the reading matches 1x, not 2x');

  const ref = factorOneReference('Hammer Curl', 'Rope', HAMMER_CURL_SYNTHETIC_ONE_REP_MAX);
  assert.equal(ref.factor.factorBasis, 'movement-calibrated');

  const conversion = convertPoundsToPercentage(44.87, ref);
  assert.equal(conversion.weightPercentage, 50);
  assert.equal(conversion.achievablePounds, 44.87);
});

// ---------------------------------------------------------------------------
// The falsifying case: Handles with trainerArmsPulledAtSameTime true
// ---------------------------------------------------------------------------

test('a Handles movement with trainerArmsPulledAtSameTime TRUE resolves factor 1', () => {
  // The regression that matters. Every one of these is a Handles movement the catalog tags
  // trainerArmsPulledAtSameTime true, every one resolved at factor 2 under the previous
  // model, and every one was therefore prescribed at HALF the intended load. Handles is 140
  // of the 236 on-machine movements, so this is the largest group in the program.
  for (const name of [
    'Lateral Raise',
    'Incline Chest Fly',
    'X-Pulldown',
    'Standing Incline Press',
    'Reverse Fly',
  ]) {
    const resolution = resolveLoadFactor(
      movement({
        name,
        onMachineInfo: { accessory: 'Handles', trainerArmsPulledAtSameTime: true },
      })
    );
    assert.equal(resolution.factor, 1, `${name} must now resolve at factor 1, not the old 2`);
    assert.equal(resolution.factorBasis, 'accessory-calibrated');
    assert.equal(resolution.accessory, 'Handles');
    assert.equal(resolution.factorVerified, true, 'Handles was measured on Skull Crusher');
    assert.equal(resolution.alternateFactorHypothesis, undefined);
  }
});

test('a StraightBar movement with trainerArmsPulledAtSameTime FALSE still resolves factor 2', () => {
  // The accessory decides in both directions: the attribute cannot pull a bar down to 1 any
  // more than it can push handles up to 2.
  const resolution = resolveLoadFactor(
    movement({
      name: 'Barbell Deadlift',
      onMachineInfo: { accessory: 'StraightBar', trainerArmsPulledAtSameTime: false },
    })
  );
  assert.equal(resolution.factor, 2);
  assert.equal(resolution.factorBasis, 'accessory-calibrated');
  assert.equal(resolution.accessory, 'StraightBar');
});

test('factor resolution never reads trainerArmsPulledAtSameTime', () => {
  const readKeys: string[] = [];
  const info = new Proxy(
    { accessory: 'Handles', trainerArmsPulledAtSameTime: true } as Record<string, unknown>,
    {
      get(target, key) {
        if (typeof key === 'string') {
          readKeys.push(key);
        }
        return target[key as string];
      },
    }
  );

  const resolution = resolveLoadFactor(
    movement({ name: 'Lateral Raise', onMachineInfo: info })
  );

  assert.equal(resolution.factor, 1);
  assert.ok(readKeys.includes('accessory'), 'the accessory is the discriminator');
  assert.ok(
    !readKeys.includes('trainerArmsPulledAtSameTime'),
    `the falsified attribute must not be read at all; keys read: ${readKeys.join(', ')}`
  );
});

test('trainerArmsPulledAtSameTime alone resolves nothing, in either of its values', () => {
  // Not even as a fallback: a movement carrying only the falsified attribute must fail.
  for (const trainerArmsPulledAtSameTime of [true, false]) {
    assert.throws(
      () =>
        resolveLoadFactor(
          movement({ name: 'Attribute Only', onMachineInfo: { trainerArmsPulledAtSameTime } })
        ),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'UNRESOLVED_LOAD_FACTOR');
        assert.match(error.message, /did not report onMachineInfo\.accessory/);
        return true;
      }
    );
  }
});

test('isBilateral is never consulted either, in either direction', () => {
  // isBilateral describes the athlete's LIMBS, a third thing again. Racked Reverse Lunge is
  // one leg on a bar; Goblet Squat is both legs on one handle. Only the implement counts.
  const lunge = resolveLoadFactor(
    movement({
      name: 'Racked Reverse Lunge',
      isBilateral: false, // one leg at a time
      onMachineInfo: { accessory: 'StraightBar', trainerArmsPulledAtSameTime: true },
    })
  );
  assert.equal(lunge.factor, 2, 'a bar spans both cables however many legs push it');

  const goblet = resolveLoadFactor(
    movement({
      name: 'Goblet Squat',
      isBilateral: true, // both legs
      onMachineInfo: { accessory: 'Handles', trainerArmsPulledAtSameTime: false },
    })
  );
  assert.equal(goblet.factor, 1, 'a handle shows its own cable however many legs push it');
});

// ---------------------------------------------------------------------------
// Basis reporting
// ---------------------------------------------------------------------------

test('a movement measured directly reports itself as movement-calibrated', () => {
  const bench = resolveLoadFactor(
    movement({ name: 'Barbell Bench Press', onMachineInfo: { accessory: 'StraightBar' } })
  );
  assert.equal(bench.factor, 2);
  assert.equal(bench.factorVerified, true);
  assert.equal(bench.factorBasis, 'movement-calibrated');
  assert.equal(bench.accessory, 'StraightBar');
  assert.equal(bench.alternateFactorHypothesis, undefined);
  assert.match(factorBasisStatement(bench), /measured on this movement itself/);

  const skullCrusher = resolveLoadFactor(
    movement({ name: 'Skull Crusher', onMachineInfo: { accessory: 'Handles' } })
  );
  assert.equal(skullCrusher.factor, 1);
  assert.equal(skullCrusher.factorBasis, 'movement-calibrated');
});

test('an accessory-calibrated factor states that it is an inference, not a measurement here', () => {
  const statement = factorBasisStatement(
    resolveLoadFactor(movement({ name: 'Lateral Raise', onMachineInfo: { accessory: 'Handles' } }))
  );
  assert.match(statement, /"Handles" accessory/);
  assert.match(statement, /ONE movement's live trainer measurement/);
  assert.match(statement, /Skull Crusher/, 'the measurement behind the accessory is named');
  assert.match(statement, /per implement rather than per cable/);
  assert.match(statement, /not a measurement of this movement/);
});

test('the per-implement argument is stated in the direction the factor actually runs', () => {
  const bar = factorBasisStatement(
    resolveLoadFactor(movement({ name: 'Barbell Row', onMachineInfo: { accessory: 'StraightBar' } }))
  );
  assert.match(bar, /single implement attached to both cables/);
  assert.match(bar, /sum of the two/);

  const rope = factorBasisStatement(
    resolveLoadFactor(movement({ name: 'Rope Pushdown', onMachineInfo: { accessory: 'Rope' } }))
  );
  assert.match(rope, /separate per-limb implement/);
  assert.match(rope, /only its own cable/);
});

test('a renamed bench inherits its accessory, never the per-movement measurement', () => {
  const resolution = resolveLoadFactor(
    movement({
      name: 'Barbell Bench Press (Wide Grip)',
      onMachineInfo: { accessory: 'StraightBar' },
    })
  );
  assert.equal(
    resolution.factorBasis,
    'accessory-calibrated',
    'only the exact measured name claims a per-movement measurement'
  );
  assert.equal(resolution.factor, 2, 'the accessory factor still applies');
});

test('the accessory match tolerates case but not novelty', () => {
  const resolution = resolveLoadFactor(
    movement({ name: 'Cased Oddly', onMachineInfo: { accessory: '  straightbar ' } })
  );
  assert.equal(resolution.factor, 2);
  assert.equal(resolution.accessory, 'StraightBar', 'the canonical spelling is reported back');
});

// ---------------------------------------------------------------------------
// PilatesLoops: inferred, never measured
// ---------------------------------------------------------------------------

test('PilatesLoops resolves at factor 1 but reports itself as inferred, not measured', () => {
  const resolution = resolveLoadFactor(
    movement({ name: 'Loop Leg Circle', onMachineInfo: { accessory: 'PilatesLoops' } })
  );

  assert.equal(resolution.factor, 1);
  assert.equal(resolution.factorVerified, false, 'no trainer has ever been read for this accessory');
  assert.equal(resolution.factorBasis, 'accessory-inferred');
  assert.equal(resolution.accessory, 'PilatesLoops');
  assert.equal(resolution.alternateFactorHypothesis?.factor, 2);
  assert.equal(resolution.alternateFactorHypothesis?.direction, 'double');

  const statement = factorBasisStatement(resolution);
  assert.match(statement, /INFERRED and NOT MEASURED/);
  assert.match(statement, /per-implement argument/);
});

test('an inferred factor warns about DOUBLING, the reverse of the old half-load warning', () => {
  const ref = reference({
    movementId: 'm-loops',
    movementName: 'Loop Leg Circle',
    factor: resolveLoadFactor(
      movement({ name: 'Loop Leg Circle', onMachineInfo: { accessory: 'PilatesLoops' } })
    ),
    oneRepMax: 60,
    denominatorPounds: 60,
    poundsPerPercentagePoint: 0.6,
  });

  const conversion = convertPoundsToPercentage(30, ref);
  assert.equal(conversion.weightPercentage, 50);
  assert.equal(conversion.achievablePounds, 30);
  assert.equal(conversion.alternateFactorDisplayPounds, 60, 'the alternate factor 2 doubles it');
  assert.ok(
    conversion.alternateFactorDisplayPounds! > conversion.achievablePounds,
    'the open risk is now the HEAVIER figure, not the lighter one'
  );

  const warning = unverifiedFactorWarning(ref);
  assert.match(warning, /UNVERIFIED/);
  assert.match(warning, /factorVerified: false/);
  assert.match(warning, /PilatesLoops/);
  assert.match(warning, /INFERRED/);
  assert.match(warning, /DOUBLE the pounds requested/);
  assert.match(warning, /dangerous direction/);
  assert.match(warning, /trainer displays before lifting/i);
  assert.doesNotMatch(warning, /HALF the pounds requested/, 'the old failure mode is reversed');

  const report = formatLoadReferenceReport(ref);
  assert.match(report, /Factor verified: NO/);
  assert.match(report, /Factor basis: accessory-inferred/);
  assert.match(report, /Accessory \(the implement the factor is keyed on\): PilatesLoops/);
  assert.match(report, /## ⚠️ Unverified Cable Factor/);
  assert.match(report, /DOUBLE the pounds requested/);
});

test('a measured accessory emits no warning and no alternate figure at all', () => {
  const ref = factorOneReference('Lateral Raise', 'Handles', 40);
  assert.equal(ref.factor.factorVerified, true);
  assert.equal(
    convertPoundsToPercentage(20, ref).alternateFactorDisplayPounds,
    undefined,
    'a measured factor has no alternative figure to report'
  );
  assert.doesNotMatch(
    formatLoadReferenceReport(ref),
    /Unverified Cable Factor/,
    'warning a user about a measured factor teaches them to ignore warnings'
  );
});

test('an inferred factor may be reported but may not be written', () => {
  const inferred = reference({
    movementId: 'm-loops',
    movementName: 'Loop Leg Circle',
    factor: resolveLoadFactor(
      movement({ name: 'Loop Leg Circle', onMachineInfo: { accessory: 'PilatesLoops' } })
    ),
    oneRepMax: 60,
    denominatorPounds: 60,
    poundsPerPercentagePoint: 0.6,
  });

  // The read path already converted it above. The write path refuses, under its own code so
  // "known implement, never measured" is tellable apart from "no idea what this implement is".
  assert.throws(
    () => assertFactorIsWritable(inferred),
    (error: Error & { code?: string; statusCode?: number }) => {
      assert.equal(error.code, 'UNMEASURED_ACCESSORY_FACTOR');
      assert.notEqual(error.code, 'UNRESOLVED_LOAD_FACTOR');
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /Refusing to write a pounds-based load/);
      assert.match(error.message, /NEVER been measured against a live trainer/);
      assert.match(error.message, /DOUBLE the pounds requested/);
      assert.match(error.message, /weight \(raw percentage\) instead of weightLb/);
      return true;
    }
  );
});

test('a measured factor is writable, on the movement or on its accessory', () => {
  assert.equal(assertFactorIsWritable(reference()), undefined, 'StraightBar, movement-calibrated');
  assert.equal(
    assertFactorIsWritable(factorOneReference('Lateral Raise', 'Handles', 40)),
    undefined,
    'Handles, accessory-calibrated'
  );
});

// ---------------------------------------------------------------------------
// Failure paths: nothing defaults
// ---------------------------------------------------------------------------

test('an unrecognised accessory fails with UNRESOLVED_LOAD_FACTOR rather than defaulting', () => {
  assert.throws(
    () =>
      resolveLoadFactor(
        movement({ name: 'Mystery Press', onMachineInfo: { accessory: 'TricepsBar' } })
      ),
    (error: Error & { code?: string; statusCode?: number }) => {
      assert.equal(error.code, 'UNRESOLVED_LOAD_FACTOR');
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /accessory "TricepsBar" carries no calibration/);
      assert.match(error.message, /StraightBar, Handles, Rope, AnkleStraps, PilatesLoops/);
      assert.match(error.message, /DOUBLE/, 'the error states which way a guess would go wrong');
      return true;
    }
  );
});

test('a missing accessory on an on-machine movement is an explicit failure, not a default', () => {
  for (const onMachine of [true, undefined]) {
    assert.throws(
      () => resolveLoadFactor(movement({ name: 'Partial Info', onMachine, onMachineInfo: {} })),
      /Cannot resolve the cable factor for "Partial Info".*onMachineInfo\.accessory/s
    );
  }
  assert.throws(
    () => resolveLoadFactor(movement({ name: 'No Info', onMachineInfo: undefined })),
    /onMachineInfo\.accessory/
  );
  assert.throws(
    () => resolveLoadFactor(movement({ name: 'Blank', onMachineInfo: { accessory: '   ' } })),
    /onMachineInfo\.accessory/
  );
});

test('an off-machine movement fails explicitly instead of resolving a factor', () => {
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

test('neither an accessory nor a calibration entry can rescue a movement with no cable load', () => {
  // Calibration overrides the FACTOR, not the existence of cable resistance.
  assert.throws(
    () =>
      resolveLoadFactor(
        movement({ name: 'Barbell Bench Press', onMachine: false, onMachineInfo: undefined })
      ),
    /off-machine movement/
  );
  assert.throws(
    () =>
      resolveLoadFactor(
        movement({ name: 'Odd Plank', onMachine: false, onMachineInfo: { accessory: 'Handles' } })
      ),
    /off-machine movement/
  );
});

test('a synthetic unresolved resolution still refuses to sound confident', () => {
  const ref = reference({
    movementName: 'Uncalibrated Movement',
    factor: unresolvedResolution(),
  });

  assert.match(factorBasisStatement(ref.factor), /UNRESOLVED/);
  const warning = unverifiedFactorWarning(ref);
  assert.match(warning, /UNRESOLVED/);
  assert.match(warning, /No pound figure here can be trusted in either direction/);

  const report = formatLoadReferenceReport(ref);
  assert.match(report, /Factor verified: NO/);
  assert.match(report, /Factor basis: unresolved/);
  assert.match(report, /## ⚠️ Unverified Cable Factor/);
});

// ---------------------------------------------------------------------------
// Arithmetic, unchanged by the re-keying
// ---------------------------------------------------------------------------

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
  assert.throws(() => convertPoundsToPercentage(-10, reference()), /greater than or equal to 0/);
});

test('a non-numeric target is rejected', () => {
  assert.throws(() => convertPoundsToPercentage('100' as unknown, reference()), /finite number/);
  assert.throws(() => convertPoundsToPercentage(Number.NaN, reference()), /finite number/);
});

test('the falsified model would have halved every Handles prescription', () => {
  // The bug this measurement fixed, in the units a user feels: 20 lb asked for on a 40 lb
  // one-rep max. Factor 1 sends 50% and the trainer shows 20. Factor 2 sent 25% and showed 10.
  const ref = factorOneReference('Lateral Raise', 'Handles', 40);
  assert.equal(convertPoundsToPercentage(20, ref).weightPercentage, 50);
  assert.equal(convertPoundsToPercentage(20, ref).achievablePounds, 20);
  assert.equal(
    Math.round((20 / (2 * 40)) * 100),
    25,
    'at the falsified factor the same request sent 25% -- half the load'
  );
});
