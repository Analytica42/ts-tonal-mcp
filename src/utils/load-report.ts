import {
  CALIBRATED_PERCENTAGE_CEILING,
  factorBasisStatement,
  type LoadReference,
  type WeightConversion,
  unverifiedFactorWarning,
} from './load-calibration.js';
import type { SetWeightConversion } from './workout-conversion.js';

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function describeAge(reference: LoadReference): string {
  const { ageDays, performedAt } = reference.referenceSet;
  if (Number.isNaN(ageDays)) {
    return `performed ${performedAt} (age unknown: unparseable timestamp)`;
  }
  const label = ageDays === 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`;
  return `performed ${performedAt} (${label})`;
}

/**
 * The percentage at which the displayed load equals one one-rep max.
 *
 * Factor-dependent: the conversion denominator is factor x oneRepMax, so 1x oneRepMax is
 * 50% at factor 2 and 100% at factor 1. Hardcoding 50 would misreport every single-cable
 * movement.
 */
function oneRepMaxPercentage(reference: LoadReference): number {
  return Math.round((100 / reference.factor.factor) * 100) / 100;
}

/** Flags that must travel with a conversion result, in prose. */
function conversionFlags(conversion: WeightConversion, reference: LoadReference): string[] {
  const flags: string[] = [];
  if (conversion.exceedsCalibratedRange) {
    const oneRepMaxPct = oneRepMaxPercentage(reference);
    const multiple = Math.round((conversion.weightPercentage / oneRepMaxPct) * 100) / 100;
    flags.push(
      `weightPercentage ${conversion.weightPercentage} EXCEEDS the ${CALIBRATED_PERCENTAGE_CEILING}% calibration ceiling. At factor ${reference.factor.factor} one one-rep max is ${oneRepMaxPct}%, so this is about ${multiple}x oneRepMax. Values above ${CALIBRATED_PERCENTAGE_CEILING} do round-trip, but confirm the load is intended.`
    );
  }
  if (conversion.roundedToZero) {
    flags.push(
      `requested ${conversion.targetPounds} lb rounded down to weightPercentage 0, i.e. no added resistance. One percentage point is coarser than the target.`
    );
  }
  if (conversion.singleCableDisplayPounds !== undefined) {
    flags.push(
      `if the single-cable hypothesis holds for this movement, the trainer would instead display about ${conversion.singleCableDisplayPounds} lb.`
    );
  }
  return flags;
}

/** One line per conversion: what was asked, what gets sent, what the trainer should show. */
export function formatConversionLine(conversion: WeightConversion): string {
  return `requested ${conversion.targetPounds} lb -> send weightPercentage ${conversion.weightPercentage} -> trainer should show ${conversion.achievablePounds} lb (delta ${signed(conversion.deltaPounds)} lb)`;
}

/** Full report for get_load_reference. */
export function formatLoadReferenceReport(reference: LoadReference): string {
  const { factor, referenceSet } = reference;
  let report = `# Load Reference: ${reference.movementName}\n\n`;

  report += `## Conversion\n`;
  report += `- One-rep max (oneRepMax): ${reference.oneRepMax} lb\n`;
  report += `- Cable factor: ${factor.factor}x\n`;
  report += `- Factor verified: ${factor.factorVerified ? 'yes' : 'NO'}\n`;
  report += `- Factor basis: ${factor.factorBasis}\n`;
  report += `- Cable engagement: ${factor.cableEngagement}\n`;
  report += `- Conversion denominator (factor x oneRepMax): ${reference.denominatorPounds} lb at weightPercentage 100\n`;
  report += `- Granularity: ${Math.round(reference.poundsPerPercentagePoint * 1000) / 1000} lb per percentage point\n`;
  report += `- Formula: weightPercentage = round(target_lb / ${reference.denominatorPounds} x 100)\n`;

  report += `- Verification basis: ${factorBasisStatement(factor)}\n`;

  report += `\n## Reference Set\n`;
  report += `- Source activity: ${referenceSet.activityId}\n`;
  report += `- When: ${describeAge(reference)}\n`;
  report += `- Base weight (baseWeight, dialled in on the machine): ${referenceSet.baseWeight ?? 'not reported'} lb\n`;
  report += `- Average weight (avgWeight, force-averaged over the range of motion): ${referenceSet.avgWeight ?? 'not reported'} lb\n`;
  report += `- Reps (repCount): ${referenceSet.repCount ?? 'not reported'}\n`;
  report += `- Weight percentage Tonal recorded: ${referenceSet.weightPercentage ?? 'not reported'}\n`;
  report += referenceSet.impliedPercentage === null
    ? `- Implied percentage of that load: not computable (no usable load on the reference set)\n`
    : `- Implied percentage of that load: ${referenceSet.impliedPercentage}% (from ${referenceSet.impliedPercentageBasis}; a self-check -- at factor ${factor.factor} one one-rep max is ${oneRepMaxPercentage(reference)}%, so a value above that means the working load exceeded a one-rep max and the factor is suspect)\n`;
  report += `- Activities scanned to find it: ${reference.activitiesScanned}\n`;
  report += `- Staleness matters: Tonal recomputes oneRepMax from the most recent set, so an old reference converts against an old strength level.\n`;

  if (!factor.factorVerified) {
    report += `\n## ⚠️ Unverified Cable Factor\n${unverifiedFactorWarning(reference)}\n`;
  }

  return report;
}

/** Report for convert_target_weight over one or more targets. */
export function formatConvertTargetWeightReport(
  reference: LoadReference,
  conversions: WeightConversion[]
): string {
  let report = `# Converted Target Load: ${reference.movementName}\n\n`;
  report += `- One-rep max: ${reference.oneRepMax} lb | factor ${reference.factor.factor}x | denominator ${reference.denominatorPounds} lb\n`;
  report += `- factorVerified: ${reference.factor.factorVerified} (${reference.factor.factorBasis})\n`;
  report += `- Verification basis: ${factorBasisStatement(reference.factor)}\n`;
  report += `- Reference set ${describeAge(reference)}\n`;
  report += `- Granularity: ${Math.round(reference.poundsPerPercentagePoint * 1000) / 1000} lb per percentage point\n`;

  report += `\n## Conversions\n`;
  conversions.forEach((conversion) => {
    report += `- ${formatConversionLine(conversion)}\n`;
    conversionFlags(conversion, reference).forEach((flag) => {
      report += `  - Note: ${flag}\n`;
    });
  });

  if (!reference.factor.factorVerified) {
    report += `\n## ⚠️ Unverified Cable Factor\n${unverifiedFactorWarning(reference)}\n`;
  }

  return report;
}

/**
 * Section appended to every create/update/estimate report that converted pounds.
 *
 * Silent conversion is unacceptable on the write path: the caller must be able to see the
 * pounds requested, the percentage actually written, and the pounds that implies.
 */
export function formatWriteConversionSection(conversions: SetWeightConversion[]): string {
  if (conversions.length === 0) {
    return '';
  }

  let section = `\n## Pound-Based Load Conversion\n\n`;
  section += `Tonal stores load only as an integer weightPercentage, so ${conversions.length} set${conversions.length === 1 ? '' : 's'} ${conversions.length === 1 ? 'was' : 'were'} converted. What was written:\n\n`;

  conversions.forEach((record) => {
    const scope = record.source === 'exercise' ? ' (from the exercise-level weightLb)' : '';
    section += `- **${record.movementName}** block ${record.blockNumber}, set ${record.setNumber}${scope}: ${formatConversionLine(record.conversion)}\n`;
    conversionFlags(record.conversion, record.reference).forEach((flag) => {
      section += `  - Note: ${flag}\n`;
    });
  });

  // One reference line per movement, so staleness of the 1RM is visible without repetition.
  const referencesByMovement = new Map<string, LoadReference>();
  conversions.forEach((record) => {
    if (!referencesByMovement.has(record.reference.movementId)) {
      referencesByMovement.set(record.reference.movementId, record.reference);
    }
  });

  section += `\n### Conversion basis\n`;
  referencesByMovement.forEach((reference) => {
    section += `- ${reference.movementName}: oneRepMax ${reference.oneRepMax} lb x factor ${reference.factor.factor} = ${reference.denominatorPounds} lb at 100%; reference set ${describeAge(reference)}\n`;
    section += `  - ${factorBasisStatement(reference.factor)}\n`;
  });

  const unverified = Array.from(referencesByMovement.values()).filter(
    (reference) => !reference.factor.factorVerified
  );
  if (unverified.length > 0) {
    section += `\n### ⚠️ Unverified Cable Factor — Check The Trainer Before Lifting\n\n`;
    section += `${unverified.length} movement${unverified.length === 1 ? '' : 's'} in this workout had load prescribed in pounds against an UNVERIFIED cable factor.\n\n`;
    unverified.forEach((reference) => {
      section += `- ${unverifiedFactorWarning(reference)}\n`;
    });
  }

  return section;
}
