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
 * `factor` is the number of trainer cables bearing load simultaneously. It is MEASURED
 * for exactly one movement (see CALIBRATION_REGISTRY) and inferred from the movement's own
 * cable attribute for every other.
 */

// Published 0.6.0 declarations omit trainerArmsPulledAtSameTime, which the runtime returns.
// Overlay it rather than widening the client type; remove once a client release publishes it.
type MovementOnMachineInfo = NonNullable<TonalMovement['onMachineInfo']> & {
  trainerArmsPulledAtSameTime?: boolean | null;
};
type MovementWithCableInfo = Omit<TonalMovement, 'onMachineInfo'> & {
  onMachineInfo?: MovementOnMachineInfo | null;
};

/**
 * Factor used for any movement that has not been calibrated against a trainer reading.
 *
 * Two is deliberate and is the SAFE default, because the error is asymmetric:
 *
 *   assume 2, truth is 1 -> displayed = target / 2   (half the load; a wasted set)
 *   assume 1, truth is 2 -> displayed = target x 2   (double the load; an injury risk)
 *
 * Under-loading is recoverable, so an uncalibrated movement is always converted at 2 and
 * the single-cable possibility is reported alongside the result instead of being applied.
 */
export const ASSUMED_LOAD_FACTOR = 2;

/** Factor a one-cable-at-a-time movement would use if the hypothesis holds. Never applied. */
export const SINGLE_CABLE_HYPOTHESIS_FACTOR = 1;

/**
 * Percentages above this round-tripped in testing but sit outside the measured calibration
 * range (historical sets span 28.9%-50.0%), so a computed value above it is flagged, not capped.
 */
export const CALIBRATED_PERCENTAGE_CEILING = 100;

/** Movements that carry load-bearing records but are not lifts. */
export const NON_LIFT_MOVEMENT_NAMES: ReadonlySet<string> = new Set(['rest']);

export interface CalibrationEntry {
  /** Cable count measured against a live trainer reading. */
  factor: number;
  /** ISO date the measurement was taken. */
  verifiedOn: string;
  /** What was observed, so the number can be re-derived or challenged. */
  evidence: string;
}

/**
 * Movements whose factor has been confirmed against a live trainer readout.
 *
 * This is an OVERRIDE layer only -- the factor for everything else is inferred from the
 * movement's own API attributes (see resolveLoadFactor). Add an entry here only after
 * reading the displayed weight off a trainer; never to record a guess.
 */
export const CALIBRATION_REGISTRY: ReadonlyMap<string, CalibrationEntry> = new Map([
  [
    'barbell bench press',
    {
      factor: 2,
      verifiedOn: '2026-10-08',
      evidence:
        'live trainer read 84/125/167 at pct 50/75/100 against oneRepMax 83.50363',
    },
  ],
]);

/**
 * How the factor was arrived at.
 *
 * 'calibrated' means a real trainer reading; 'trainerArmsPulledAtSameTime' means it was
 * inferred from the movement's cable attribute. The distinction matters to a reader, which
 * is why the basis travels in the output next to factorVerified.
 */
export type LoadFactorBasis = 'calibrated' | 'trainerArmsPulledAtSameTime';

/** Whether both trainer cables bear load at once, per the movement catalog. */
export type CableEngagement = 'simultaneous' | 'single';

/** How plausible the untested one-cable factor is for this movement. */
export type SingleCableLikelihood = 'likely' | 'unlikely';

export interface SingleCableHypothesis {
  factor: number;
  likelihood: SingleCableLikelihood;
  /** Why the likelihood reads the way it does. */
  rationale: string;
}

export interface LoadFactorResolution {
  /** The factor actually used for conversion. */
  factor: number;
  /** True only when a trainer reading confirmed this movement's factor. */
  factorVerified: boolean;
  factorBasis: LoadFactorBasis;
  cableEngagement: CableEngagement;
  /** The registry entry, when this movement is calibrated. */
  calibration?: CalibrationEntry;
  /** Present only when the factor is unverified. */
  singleCableHypothesis?: SingleCableHypothesis;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Resolves the cable factor for a movement from its cable attribute, with the calibration
 * registry as an override on the numeric factor.
 *
 * The ONLY discriminator is `onMachineInfo.trainerArmsPulledAtSameTime`, which states how
 * many cables bear load. `isBilateral` is deliberately NOT consulted: it describes the
 * athlete's limbs, not the cables, and the two are orthogonal. Measured across all 361
 * catalog movements they disagree on 37 (16% of those where both are present), and the
 * disagreements are not noise -- Racked Reverse Lunge pulls both cables with one leg
 * (cables true, limbs false) while Goblet Squat pulls one cable with both legs (cables
 * false, limbs true). Both fields are correct; only the cable count sets resistance, so
 * reading limbs would produce a confidently wrong factor on real programmed movements.
 *
 * The attribute is also complete where it matters: all 125 movements lacking it have
 * `onMachine: false`, i.e. no cable resistance at all, and no on-machine movement lacks it.
 * So an absent attribute is never a case for a fallback -- it means pounds are meaningless
 * here, and that is reported rather than papered over.
 *
 * @throws TonalMCPError when the cable attribute is absent: OFF_MACHINE_MOVEMENT for a
 *   movement that carries no cable load, UNRESOLVED_LOAD_FACTOR otherwise. Never defaults.
 */
export function resolveLoadFactor(movement: TonalMovement): LoadFactorResolution {
  const onMachineInfo = (movement as MovementWithCableInfo).onMachineInfo;
  const armsPulledAtSameTime = readBoolean(onMachineInfo?.trainerArmsPulledAtSameTime);

  if (armsPulledAtSameTime === undefined) {
    // The registry overrides the FACTOR, not the existence of cable load, so a calibration
    // entry cannot rescue a movement that has no cables to load.
    if (readBoolean(movement.onMachine) === false) {
      throw new TonalMCPError(
        `"${movement.name}" is an off-machine movement — it carries no cable load, so pounds cannot be converted to a weightPercentage. Prescribe it with reps or duration, and use weight: 0 if a load field is required.`,
        'OFF_MACHINE_MOVEMENT',
        400
      );
    }
    throw new TonalMCPError(
      `Cannot resolve the cable factor for "${movement.name}": the movement catalog did not report onMachineInfo.trainerArmsPulledAtSameTime, and no factor may be assumed without it. Every on-machine movement is expected to carry this field, so this is unexpected — report it rather than working around it. Prescribe this movement with weight (percentage) instead of weightLb.`,
      'UNRESOLVED_LOAD_FACTOR',
      502
    );
  }

  const cableEngagement: CableEngagement = armsPulledAtSameTime ? 'simultaneous' : 'single';
  const calibration = CALIBRATION_REGISTRY.get(movement.name.trim().toLowerCase());

  if (calibration) {
    return {
      factor: calibration.factor,
      factorVerified: true,
      factorBasis: 'calibrated',
      cableEngagement,
      calibration,
    };
  }

  return {
    factor: ASSUMED_LOAD_FACTOR,
    factorVerified: false,
    factorBasis: 'trainerArmsPulledAtSameTime',
    cableEngagement,
    singleCableHypothesis: {
      factor: SINGLE_CABLE_HYPOTHESIS_FACTOR,
      likelihood: cableEngagement === 'single' ? 'likely' : 'unlikely',
      rationale:
        cableEngagement === 'single'
          ? 'trainerArmsPulledAtSameTime is false, so the trainer arms are not reported to pull together'
          : 'trainerArmsPulledAtSameTime is true, the same cable reading as the calibrated Barbell Bench Press',
    },
  };
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
   * baseWeight / (factor x oneRepMax) x 100 -- the self-check. Across 3,857 historical
   * sets this lands in 28.9%-50.0%, and 50% is exactly 1x oneRepMax, so a value above 50
   * means the working load exceeded a one-rep max and the factor is suspect.
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
  /** What the trainer would display if the untested one-cable factor is the real one. */
  singleCableDisplayPounds?: number;
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

  if (!reference.factor.factorVerified) {
    conversion.singleCableDisplayPounds = roundTo(
      (weightPercentage / 100) * SINGLE_CABLE_HYPOTHESIS_FACTOR * reference.oneRepMax,
      2
    );
  }

  return conversion;
}

/**
 * The caution that must accompany any conversion for an uncalibrated movement.
 *
 * Deliberately does NOT warn about doubling. This tool always converts at
 * ASSUMED_LOAD_FACTOR, and over-assuming the factor under-loads; doubling could only come
 * from assuming a factor of 1, which never happens here.
 */
export function unverifiedFactorWarning(reference: LoadReference): string {
  const hypothesis = reference.factor.singleCableHypothesis;
  const lines = [
    `The ${reference.factor.factor}x cable factor for "${reference.movementName}" is UNVERIFIED (factorVerified: false).`,
    `It is inferred from the movement catalog (${reference.factor.factorBasis}: cable engagement reads "${reference.factor.cableEngagement}"); only Barbell Bench Press has been measured against a live trainer.`,
    `If this movement actually drives one cable at a time, the trainer will display roughly HALF the pounds requested -- a lighter session than prescribed, not a heavier one. Check the weight the trainer displays before lifting and adjust if it reads low.`,
  ];
  if (hypothesis) {
    lines.push(
      `Single-cable hypothesis (factor ${hypothesis.factor}, ${hypothesis.likelihood}): ${hypothesis.rationale}.`
    );
  }
  return lines.join(' ');
}
