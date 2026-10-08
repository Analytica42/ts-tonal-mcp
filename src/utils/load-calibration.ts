import type { TonalMovement } from '@dlwiest/ts-tonal-client';
import { TonalMCPError } from './error-handler.js';

/**
 * Pound-based load prescription.
 *
 * Tonal's write API accepts load only as `weightPercentage`; there is no absolute-weight
 * field on the writable set type. The percentage resolves on the trainer at run time
 * against the user's one-rep max for that movement:
 *
 *   displayed_lb = (weightPercentage / 100) x factor x oneRepMax
 *
 * so the inverse used here is
 *
 *   weightPercentage = round(target_lb / (factor x oneRepMax) x 100)
 *
 * `factor` is how many cables are summed into the one number the trainer displays.
 * `oneRepMax` is reported PER CABLE, and the trainer displays load PER IMPLEMENT -- not
 * per cable -- so the factor is the number of cables the attached implement gathers:
 *
 *   StraightBar   one implement bolted to BOTH cables -> the display is the sum  -> 2
 *   Handles, Rope, AnkleStraps, PilatesLoops   separate per-limb implements, each
 *                 showing its own cable                                         -> 1
 *
 * Two attachments therefore do NOT imply doubling: two handles are two implements, each
 * displaying its own cable, and the number on the screen is one cable's load.
 *
 * The discriminator is `onMachineInfo.accessory` and nothing else. See
 * ACCESSORY_CALIBRATION for the measurements, and resolveLoadFactor for why the
 * previous discriminator was abandoned rather than kept as a fallback.
 */

// Published 0.6.0 declarations omit onMachineInfo.accessory, which the runtime returns.
// Overlay it rather than widening the client type; remove once a client release publishes it.
type MovementOnMachineInfo = NonNullable<TonalMovement['onMachineInfo']> & {
  accessory?: string | null;
};
type MovementWithAccessory = Omit<TonalMovement, 'onMachineInfo'> & {
  onMachineInfo?: MovementOnMachineInfo | null;
};

/**
 * Percentages above this round-tripped in testing but sit outside the measured calibration
 * range, so a computed value above it is flagged, not capped.
 */
export const CALIBRATED_PERCENTAGE_CEILING = 100;

/** Movements that carry load-bearing records but are not lifts. */
export const NON_LIFT_MOVEMENT_NAMES: ReadonlySet<string> = new Set(['rest']);

/**
 * Every accessory the movement catalog reports on an on-machine movement.
 *
 * Enumerated across all 236 on-machine movements; there are exactly five, and StraightBar
 * is the only bar-like one. A sixth appearing here is a code change, not a default --
 * see resolveLoadFactor.
 */
export type MovementAccessory =
  | 'StraightBar'
  | 'Handles'
  | 'Rope'
  | 'AnkleStraps'
  | 'PilatesLoops';

export interface CalibrationEntry {
  /** Cables summed into the trainer's displayed number for this implement. */
  factor: number;
  /** ISO date a live trainer reading established this factor, or null if it is inferred. */
  verifiedOn: string | null;
  /** What was observed (or what the inference rests on), so the number can be challenged. */
  evidence: string;
}

/**
 * Cable factor per accessory. This is the normal source of the factor.
 *
 * Catalog coverage and status, all measurements taken 2026-10-08:
 *
 *   accessory      on-machine movements   factor   basis
 *   StraightBar                      34        2   measured (Barbell Bench Press)
 *   Handles                         140        1   measured (Skull Crusher)
 *   Rope                             23        1   measured (Hammer Curl)
 *   AnkleStraps                      12        1   measured (Standing Leg Extension)
 *   PilatesLoops                     27        1   INFERRED, never read off a trainer
 *                                   ---
 *                                   236
 *
 * Four of five accessories rest on a direct trainer reading of one of their movements,
 * generalized to the accessory on the per-implement argument at the top of this file.
 * PilatesLoops rests on the argument alone and is reported as unverified everywhere.
 *
 * Add or change a measured entry here only after reading displayed weight off a trainer.
 */
export const ACCESSORY_CALIBRATION: ReadonlyMap<MovementAccessory, CalibrationEntry> = new Map([
  [
    'StraightBar' as MovementAccessory,
    {
      factor: 2,
      verifiedOn: '2026-10-08',
      evidence:
        'live trainer read 84/125/167 at pct 50/75/100 on Barbell Bench Press against oneRepMax 83.50363; the bar is one implement on both cables, so the display is the sum of the two',
    },
  ],
  [
    'Handles' as MovementAccessory,
    {
      factor: 1,
      verifiedOn: '2026-10-08',
      evidence:
        'live trainer read 12 on Skull Crusher against 12.05 predicted at factor 1 (24 at factor 2); each handle is its own implement showing its own cable',
    },
  ],
  [
    'Rope' as MovementAccessory,
    {
      factor: 1,
      verifiedOn: '2026-10-08',
      evidence:
        'live trainer read 46 on Hammer Curl against 44.87 predicted at factor 1 (90 at factor 2)',
    },
  ],
  [
    'AnkleStraps' as MovementAccessory,
    {
      factor: 1,
      verifiedOn: '2026-10-08',
      evidence:
        'live trainer read 26/52/78 at pct 25/50/75 on Standing Leg Extension against oneRepMax 104.21186002414206',
    },
  ],
  [
    'PilatesLoops' as MovementAccessory,
    {
      factor: 1,
      verifiedOn: null,
      evidence:
        'UNMEASURED: no trainer reading exists for any of the 27 PilatesLoops movements. Factor 1 is inferred from the per-implement argument alone -- the loops attach per limb, so each should display its own cable, as measured for Handles, Rope and AnkleStraps',
    },
  ],
]);

/** Case-insensitive index onto the canonical accessory spellings. */
const CANONICAL_ACCESSORY_BY_LOWERCASE: ReadonlyMap<string, MovementAccessory> = new Map(
  Array.from(ACCESSORY_CALIBRATION.keys()).map((accessory) => [
    accessory.toLowerCase(),
    accessory,
  ])
);

/** The accessories carrying a calibration, in catalog spelling, for error messages. */
export const KNOWN_ACCESSORIES: readonly MovementAccessory[] = Array.from(
  ACCESSORY_CALIBRATION.keys()
);

/**
 * Per-movement override layer: a factor measured on one specific movement.
 *
 * Beats the accessory default for that movement alone. It holds exactly the four movements
 * the accessory factors were measured on, so each reports itself as individually measured
 * rather than inheriting an accessory-level inference. A future measurement that
 * CONTRADICTS its accessory belongs here too -- that is what this layer is for, and it is
 * how the Skull Crusher reading would have been recorded had it disagreed with Handles.
 */
export const MOVEMENT_CALIBRATION_REGISTRY: ReadonlyMap<string, CalibrationEntry> = new Map([
  [
    'barbell bench press',
    {
      factor: 2,
      verifiedOn: '2026-10-08',
      evidence:
        'live trainer read 84/125/167 at pct 50/75/100 against oneRepMax 83.50363',
    },
  ],
  [
    'skull crusher',
    {
      factor: 1,
      verifiedOn: '2026-10-08',
      evidence:
        'live trainer read 12 against 12.05 predicted at factor 1 (24 at factor 2) -- the reading that falsified trainerArmsPulledAtSameTime, which is true for this movement',
    },
  ],
  [
    'hammer curl',
    {
      factor: 1,
      verifiedOn: '2026-10-08',
      evidence:
        'live trainer read 46 against 44.87 predicted at factor 1 (90 at factor 2)',
    },
  ],
  [
    'standing leg extension',
    {
      factor: 1,
      verifiedOn: '2026-10-08',
      evidence:
        'live trainer read 26/52/78 at pct 25/50/75 against oneRepMax 104.21186002414206',
    },
  ],
]);

/**
 * How the factor was arrived at.
 *
 * 'movement-calibrated'  -- a trainer reading on THIS movement.
 * 'accessory-calibrated' -- a trainer reading on one movement sharing this accessory,
 *                           generalized here. The normal case, and an inference.
 * 'accessory-inferred'   -- the accessory itself has never been read off a trainer; the
 *                           factor comes from the per-implement argument. PilatesLoops only.
 * 'unresolved'           -- no factor could be established. resolveLoadFactor THROWS
 *                           instead of returning this, so it never reaches a conversion;
 *                           the basis exists so the report machinery stays total over the
 *                           type and can never print a confident number for one.
 */
export type LoadFactorBasis =
  | 'movement-calibrated'
  | 'accessory-calibrated'
  | 'accessory-inferred'
  | 'unresolved';

/** Which way the load moves if an inferred factor is wrong. */
export type AlternateFactorDirection = 'double' | 'half';

export interface AlternateFactorHypothesis {
  /** The factor that would apply if the inference is wrong. */
  factor: number;
  /** What the trainer would then show relative to the request. */
  direction: AlternateFactorDirection;
  /** Why that is the live alternative. */
  rationale: string;
}

export interface LoadFactorResolution {
  /** The factor actually used for conversion. */
  factor: number;
  /** True when a trainer reading backs this factor, on this movement or on its accessory. */
  factorVerified: boolean;
  factorBasis: LoadFactorBasis;
  /** The catalog accessory the factor was keyed on. */
  accessory: string;
  /** The calibration backing the factor. Absent only when factorBasis is 'unresolved'. */
  calibration?: CalibrationEntry;
  /** Present only when the factor is not backed by a measurement. */
  alternateFactorHypothesis?: AlternateFactorHypothesis;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** The catalog accessory string, trimmed, or undefined when absent or empty. */
function readAccessory(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Maps a catalog accessory string onto a calibrated accessory, case-insensitively.
 *
 * Case folding is safe because no two accessories differ only by case, and it keeps a
 * cosmetic change upstream from failing every prescription. An accessory that is genuinely
 * new still falls through to undefined, which is a failure, not a default.
 */
function canonicalizeAccessory(accessory: string): MovementAccessory | undefined {
  return CANONICAL_ACCESSORY_BY_LOWERCASE.get(accessory.toLowerCase());
}

/** The per-implement reason a given factor follows from a given accessory. */
function implementArgument(accessory: string, factor: number): string {
  return factor === 2
    ? `"${accessory}" is a single implement attached to both cables, so the trainer displays the sum of the two`
    : `"${accessory}" is a separate per-limb implement, so each one displays only its own cable`;
}

/**
 * Resolves the cable factor for a movement: per-movement calibration first, then the
 * calibration for its accessory.
 *
 * The ONLY discriminator is `onMachineInfo.accessory`, because the trainer displays load
 * per implement and the accessory IS the implement (see the header comment).
 *
 * `trainerArmsPulledAtSameTime` was the previous discriminator and is deliberately not
 * read -- not even as a fallback. It is FALSIFIED: Skull Crusher reports it true with the
 * Handles accessory, and the trainer displayed 12 lb against 12.05 predicted at factor 1
 * (24 at factor 2), so the flag's "both arms" claim does not mean the display doubles. A
 * falsified signal is worse than none, because it is confidently wrong on the largest group
 * of movements in the catalog: 140 of 236 on-machine movements use Handles, and every one
 * of those with the flag true was previously prescribed at HALF the intended load.
 *
 * `isBilateral` is likewise never consulted: it describes the athlete's limbs, which is a
 * third thing again, orthogonal to both the implement and the flag.
 *
 * @throws TonalMCPError when no factor can be established: OFF_MACHINE_MOVEMENT for a
 *   movement that carries no cable load, UNRESOLVED_LOAD_FACTOR when the accessory is
 *   missing or unrecognised. Never defaults -- a silent default on a new accessory would
 *   under- or over-load a real person by 2x.
 */
export function resolveLoadFactor(movement: TonalMovement): LoadFactorResolution {
  // Checked first and unconditionally: calibration overrides the FACTOR, not the existence
  // of cable load, so nothing downstream can rescue a movement that has no cables to load.
  if (readBoolean(movement.onMachine) === false) {
    throw new TonalMCPError(
      `"${movement.name}" is an off-machine movement — it carries no cable load, so pounds cannot be converted to a weightPercentage. Prescribe it with reps or duration, and use weight: 0 if a load field is required.`,
      'OFF_MACHINE_MOVEMENT',
      400
    );
  }

  const onMachineInfo = (movement as MovementWithAccessory).onMachineInfo;
  const accessory = readAccessory(onMachineInfo?.accessory);

  if (accessory === undefined) {
    throw new TonalMCPError(
      `Cannot resolve the cable factor for "${movement.name}": the movement catalog did not report onMachineInfo.accessory, and no factor may be assumed without it. The accessory is the implement, and the implement is what decides whether the trainer displays one cable's load or the sum of both — so a guess here is wrong by 2x in one direction or the other. Every on-machine movement is expected to carry this field, so this is unexpected — report it rather than working around it. Prescribe this movement with weight (percentage) instead of weightLb.`,
      'UNRESOLVED_LOAD_FACTOR',
      502
    );
  }

  const movementCalibration = MOVEMENT_CALIBRATION_REGISTRY.get(movement.name.trim().toLowerCase());
  if (movementCalibration) {
    return {
      factor: movementCalibration.factor,
      factorVerified: true,
      factorBasis: 'movement-calibrated',
      accessory,
      calibration: movementCalibration,
    };
  }

  const canonicalAccessory = canonicalizeAccessory(accessory);
  const accessoryCalibration =
    canonicalAccessory === undefined ? undefined : ACCESSORY_CALIBRATION.get(canonicalAccessory);

  if (canonicalAccessory === undefined || accessoryCalibration === undefined) {
    throw new TonalMCPError(
      `Cannot resolve the cable factor for "${movement.name}": accessory "${accessory}" carries no calibration (calibrated accessories: ${KNOWN_ACCESSORIES.join(', ')}), and no factor may be assumed for an unrecognised implement. Guessing 1 would make the trainer display DOUBLE the requested load if the implement spans both cables; guessing 2 would halve it. Read the displayed weight off a trainer for one movement with this accessory and add it to ACCESSORY_CALIBRATION. Until then, prescribe this movement with weight (percentage) instead of weightLb.`,
      'UNRESOLVED_LOAD_FACTOR',
      502
    );
  }

  if (accessoryCalibration.verifiedOn === null) {
    // Inferred, not measured. The factor is 1, so the open risk is that the implement
    // actually spans both cables and the trainer shows double -- the dangerous direction.
    return {
      factor: accessoryCalibration.factor,
      factorVerified: false,
      factorBasis: 'accessory-inferred',
      accessory: canonicalAccessory,
      calibration: accessoryCalibration,
      alternateFactorHypothesis: {
        factor: 2,
        direction: 'double',
        rationale: `no trainer reading exists for any "${canonicalAccessory}" movement, so factor ${accessoryCalibration.factor} rests on the per-implement argument alone; if "${canonicalAccessory}" in fact behaves like a straight bar — one implement spanning both cables — the real factor is 2 and the trainer displays double the request`,
      },
    };
  }

  return {
    factor: accessoryCalibration.factor,
    factorVerified: true,
    factorBasis: 'accessory-calibrated',
    accessory: canonicalAccessory,
    calibration: accessoryCalibration,
  };
}

/**
 * One sentence stating exactly what backs the factor in use, without overstating it.
 *
 * An accessory factor is a generalization from a single movement's measurement; saying so
 * is the difference between a reader trusting the number appropriately and trusting it
 * blindly. An inferred accessory factor rests on no measurement at all and says that too.
 */
export function factorBasisStatement(resolution: LoadFactorResolution): string {
  const { calibration, accessory, factor } = resolution;

  if (resolution.factorBasis === 'movement-calibrated' && calibration) {
    return `Factor ${factor}x was measured on this movement itself (${calibration.verifiedOn}): ${calibration.evidence}.`;
  }
  if (resolution.factorBasis === 'accessory-calibrated' && calibration) {
    return `Factor ${factor}x comes from the "${accessory}" accessory, which rests on ONE movement's live trainer measurement (${calibration.verifiedOn}): ${calibration.evidence}. It is generalized to every "${accessory}" movement because the trainer displays load per implement rather than per cable, and ${implementArgument(accessory, factor)} — an accessory-level inference from one measurement, not a measurement of this movement.`;
  }
  if (resolution.factorBasis === 'accessory-inferred' && calibration) {
    return `Factor ${factor}x for the "${accessory}" accessory is INFERRED and NOT MEASURED: no live trainer reading exists for any "${accessory}" movement. It follows only from the per-implement argument, that ${implementArgument(accessory, factor)}. ${calibration.evidence}.`;
  }
  return `Factor ${factor}x is UNRESOLVED: no live trainer measurement covers this movement, and its "${accessory}" accessory carries no calibration.`;
}

/**
 * Refuses a pounds prescription whose factor rests on no trainer measurement.
 *
 * Called on the WRITE path only (create_workout, update_workout). The read tools
 * deliberately still resolve an inferred factor: they report it with its doubling warning
 * and commit nothing, so a person — or an agent about to show its work — sees the caveat
 * attached to the number.
 *
 * A write is different in kind. It commits a number to a workout someone then lifts, and
 * the warning travels through a summarizing layer that may drop it. That asymmetry is the
 * whole reason an unrecognised accessory fails rather than defaulting; an accessory that is
 * recognised but UNMEASURED is the same case with a plausible guess attached, and the guess
 * is wrong in the direction that doubles the load.
 *
 * Distinct from UNRESOLVED_LOAD_FACTOR on purpose: that means "no idea what this implement
 * is", this means "known implement, never read off a trainer". The remedies differ.
 *
 * @throws TonalMCPError UNMEASURED_ACCESSORY_FACTOR when the factor is not backed by a
 *   measurement on the movement or on its accessory.
 */
export function assertFactorIsWritable(reference: LoadReference): void {
  const { factor } = reference;
  if (factor.factorVerified) {
    return;
  }
  throw new TonalMCPError(
    `Refusing to write a pounds-based load for "${reference.movementName}": the ${factor.factor}x cable factor for its "${factor.accessory}" accessory has NEVER been measured against a live trainer — it is inferred from the per-implement argument alone. If that inference is wrong, the trainer displays DOUBLE the pounds requested, and writing it commits that number to a workout where the warning may never be read. Two ways forward: read the displayed weight off a trainer for any one "${factor.accessory}" movement (30 seconds — set a known weightPercentage, note the pounds shown) and record it in ACCESSORY_CALIBRATION, or prescribe this movement with weight (raw percentage) instead of weightLb. Inspecting it is still allowed: get_load_reference and convert_target_weight report the inferred factor with its warning and commit nothing.`,
    'UNMEASURED_ACCESSORY_FACTOR',
    400
  );
}

/** Basis of the reference set's implied percentage, since baseWeight may be absent. */
export type ReferenceLoadBasis = 'baseWeight' | 'avgWeight';

/** The most recent performed set the reference was derived from. */
export interface ReferenceSet {
  activityId: string;
  /** ISO timestamp of the set, or of its activity when the set carries no time. */
  performedAt: string;
  /** Whole days between performedAt and resolution. */
  ageDays: number;
  /** Load dialled in on the machine. Null when the API omitted it. */
  baseWeight: number | null;
  /** Force averaged over the range of motion; does not match the dialled-in load. */
  avgWeight: number | null;
  repCount: number | null;
  /** The percentage Tonal itself recorded for the set, when present. */
  weightPercentage: number | null;
  /**
   * baseWeight / (factor x oneRepMax) x 100 -- the self-check. A working load equal to a
   * one-rep max implies 100 / factor percent, so a value above that (50 at factor 2, 100 at
   * factor 1) means the working load exceeded a one-rep max and the factor is suspect.
   *
   * The 28.9%-50.0% band observed across 3,857 historical sets was computed at factor 2 for
   * every movement. Only the 34 StraightBar movements actually convert at factor 2, so for
   * the other 202 on-machine movements that band understates the real one by half; treat it
   * as a factor-2 figure until it is re-derived per accessory.
   */
  impliedPercentage: number | null;
  impliedPercentageBasis: ReferenceLoadBasis | null;
}

export interface LoadReference {
  movementId: string;
  /** Catalog-canonical name, not the caller's spelling. */
  movementName: string;
  oneRepMax: number;
  /** factor x oneRepMax: the pounds that weightPercentage 100 corresponds to. */
  denominatorPounds: number;
  /** Pounds bought by one integer percentage point -- the rounding granularity. */
  poundsPerPercentagePoint: number;
  factor: LoadFactorResolution;
  referenceSet: ReferenceSet;
  /** How many activities were fetched before the movement was found. */
  activitiesScanned: number;
  /** Epoch ms the reference was resolved, so staleness is auditable. */
  resolvedAt: number;
}

export interface WeightConversion {
  targetPounds: number;
  /** Integer, as Tonal's Go backend rejects a JSON float for this field. */
  weightPercentage: number;
  /** What the trainer should display for weightPercentage, after integer rounding. */
  achievablePounds: number;
  /** achievablePounds - targetPounds. Signed; negative means lighter than asked. */
  deltaPounds: number;
  /** Computed percentage sits outside the measured calibration range. */
  exceedsCalibratedRange: boolean;
  /** A non-zero target rounded down to no added resistance. */
  roundedToZero: boolean;
  /** What the trainer would display if the unmeasured alternate factor is the real one. */
  alternateFactorDisplayPounds?: number;
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/**
 * Converts a target pound load into the integer weightPercentage to send.
 *
 * @throws Error if targetPounds is not a finite number >= 0. A negative percentage is
 *   invalid on the wire, and there is no sane reading of negative resistance.
 */
export function convertPoundsToPercentage(
  targetPounds: unknown,
  reference: LoadReference
): WeightConversion {
  if (typeof targetPounds !== 'number' || !Number.isFinite(targetPounds)) {
    throw new Error(
      `targetPounds must be a finite number; received ${JSON.stringify(targetPounds)}`
    );
  }
  if (targetPounds < 0) {
    throw new Error(
      `targetPounds must be greater than or equal to 0; received ${targetPounds}. A negative weightPercentage is invalid.`
    );
  }
  if (!(reference.denominatorPounds > 0)) {
    throw new Error(
      `Cannot convert pounds for "${reference.movementName}": conversion denominator is ${reference.denominatorPounds}`
    );
  }

  const weightPercentage = Math.round((targetPounds / reference.denominatorPounds) * 100);
  const achievablePounds = roundTo(
    (weightPercentage / 100) * reference.denominatorPounds,
    2
  );
  const conversion: WeightConversion = {
    targetPounds,
    weightPercentage,
    achievablePounds,
    deltaPounds: roundTo(achievablePounds - targetPounds, 2),
    exceedsCalibratedRange: weightPercentage > CALIBRATED_PERCENTAGE_CEILING,
    roundedToZero: weightPercentage === 0 && targetPounds > 0,
  };

  const hypothesis = reference.factor.alternateFactorHypothesis;
  if (!reference.factor.factorVerified && hypothesis) {
    conversion.alternateFactorDisplayPounds = roundTo(
      (weightPercentage / 100) * hypothesis.factor * reference.oneRepMax,
      2
    );
  }

  return conversion;
}

/**
 * The caution that must accompany a conversion whose factor no measurement backs.
 *
 * Only reachable for a movement that resolves with factorVerified false, which today means
 * exactly one thing: a PilatesLoops movement, whose accessory has never been read off a
 * trainer. A movement covered by a measured accessory is NOT warned about: the warning would
 * be false, and a false warning is how a reader learns to skip real ones.
 *
 * The stated failure mode is DOUBLING, and that is the reverse of what this warning said
 * under the previous model. There, an unbacked factor defaulted UP to 2 and the risk was a
 * light session. Here the inferred factor is 1, so if the inference is wrong the trainer
 * shows twice the pounds requested -- the direction that hurts someone.
 */
export function unverifiedFactorWarning(reference: LoadReference): string {
  const { factor } = reference;
  const hypothesis = factor.alternateFactorHypothesis;

  if (factor.factorBasis === 'unresolved') {
    return [
      `The cable factor for "${reference.movementName}" is UNRESOLVED (factorVerified: false): no trainer measurement covers this movement and its "${factor.accessory}" accessory carries no calibration.`,
      `No pound figure here can be trusted in either direction. Prescribe this movement with weight (percentage) instead, and read the load off the trainer.`,
    ].join(' ');
  }

  const lines = [
    `The ${factor.factor}x cable factor for "${reference.movementName}" is UNVERIFIED (factorVerified: false).`,
    `Its "${factor.accessory}" accessory has never been read off a live trainer. Factor ${factor.factor} is INFERRED from the per-implement argument — the trainer displays load per implement rather than per cable, and ${implementArgument(factor.accessory, factor.factor)} — which is how Handles, Rope and AnkleStraps did measure, but is not a measurement of "${factor.accessory}".`,
    `If that inference is wrong, the trainer will display roughly DOUBLE the pounds requested — a heavier session than prescribed, which is the dangerous direction. Check the weight the trainer displays before lifting and halve the prescription if it reads high.`,
  ];
  if (hypothesis) {
    lines.push(
      `Alternate hypothesis (factor ${hypothesis.factor}, would ${hypothesis.direction} the load): ${hypothesis.rationale}.`
    );
  }
  return lines.join(' ');
}
