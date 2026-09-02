import TonalClient from '@dlwiest/ts-tonal-client';
import type { TonalFormattedWorkoutSummary } from '@dlwiest/ts-tonal-client';
import { MCPResponse } from '../types/index.js';
import { handleToolError } from '../utils/error-handler.js';
import { validateRequiredString } from '../utils/validation.js';

interface FormattedMovementSet {
  movementName?: string | null;
  blockNumber?: number | null;
  setGroup?: number | null;
  totalVolume?: number | null;
  totalOnMachineVolume?: number | null;
  sets?: unknown[] | null;
}

// The 0.6.0 runtime returns these fields, but its published declarations omit them.
// Omit avoids conflicts with pending declarations; remove this overlay after a client
// release publishes the fields.
type CompleteFormattedWorkoutSummary = Omit<
  TonalFormattedWorkoutSummary,
  'coachName' | 'timeUnderTension' | 'movementSets'
> & {
  coachName?: string | null;
  timeUnderTension?: number | null;
  movementSets?: FormattedMovementSet[] | null;
};

function formatMetric(
  value: number | null | undefined,
  unit?: string
): string {
  if (value === undefined || value === null) {
    return 'not reported';
  }

  return unit ? `${value} ${unit}` : String(value);
}

export async function getWorkoutActivityDetails(
  client: TonalClient,
  args?: Record<string, unknown>
): Promise<MCPResponse> {
  try {
    const activityId = validateRequiredString(args?.activityId, 'activityId');
    const detail = await client.getWorkoutActivityById(activityId);
    const movements = await client.getMovements().catch(() => []);
    const movementNames = new Map(
      movements.map(movement => [movement.id, movement.name])
    );

    let report = '# Workout Activity Details\n\n';
    report += `- Activity ID: ${detail.id}\n`;
    report += `- Began: ${detail.beginTime}\n`;
    report += `- Ended: ${detail.endTime ?? 'not reported'}\n`;
    report += `- Wall-clock session duration (totalDuration): ${formatMetric(detail.totalDuration, 'seconds')}\n`;
    report += `- Time under tension (activeDuration): ${formatMetric(detail.activeDuration, 'seconds')}\n`;
    report += `- Total sets: ${detail.totalSets}\n`;
    report += `- Total reps: ${detail.totalReps}\n`;
    report += `- Total volume: ${formatMetric(detail.totalVolume, 'lb')}\n`;

    report += '\n## Performed Sets\n';
    if (detail.workoutSetActivity.length === 0) {
      report += 'No performed sets were returned for this activity.\n';
    } else {
      detail.workoutSetActivity.forEach((set, index) => {
        const movementName = movementNames.get(set.movementId)
          ?? 'Unknown movement (catalog entry unavailable)';
        report += `\n### Set ${index + 1}: ${movementName}\n`;
        report += `- Set group (setGroup): ${formatMetric(set.setGroup)}\n`;
        report += `- Block number (blockNumber): ${formatMetric(set.blockNumber)}\n`;
        report += `- Reps (repCount): ${formatMetric(set.repCount)}\n`;
        report += `- Average weight (avgWeight): ${formatMetric(set.avgWeight, 'lb')}\n`;
        report += `- One-rep max (oneRepMax): ${formatMetric(set.oneRepMax, 'lb')}\n`;
        report += `- On-machine volume (totalOnMachineVolume): ${formatMetric(set.totalOnMachineVolume, 'lb')}\n`;
        report += `- Range of motion (romLengthIn): ${formatMetric(set.romLengthIn, 'in')}\n`;
      });
    }

    return {
      content: [{ type: 'text' as const, text: report }],
    };
  } catch (error) {
    return handleToolError(error, 'get_workout_activity_details');
  }
}

export async function getWorkoutSummary(
  client: TonalClient,
  args?: Record<string, unknown>
): Promise<MCPResponse> {
  try {
    const activityId = validateRequiredString(args?.activityId, 'activityId');
    const summary = await client.getFormattedWorkoutSummary(activityId) as CompleteFormattedWorkoutSummary;

    let report = '# Workout Summary\n\n';
    report += `- Name: ${summary.name}\n`;
    report += `- Coach: ${summary.coachName ?? 'not reported'}\n`;
    report += `- Target area: ${summary.targetArea}\n`;
    report += `- In program (isInProgram): ${summary.isInProgram ? 'yes' : 'no'}\n`;
    report += `- Guided workout (isGuidedWorkout): ${summary.isGuidedWorkout ? 'yes' : 'no'}\n`;
    report += `- Wall-clock session duration (duration): ${formatMetric(summary.duration, 'seconds')}\n`;
    report += `- Time under tension (timeUnderTension): ${formatMetric(summary.timeUnderTension, 'seconds')}\n`;

    const movementSets = summary.movementSets ?? [];
    report += '\n## Movement Breakdown\n';
    if (movementSets.length === 0) {
      report += 'No movement breakdown was returned for this workout.\n';
    } else {
      movementSets.forEach((movement, index) => {
        report += `\n### ${index + 1}. ${movement.movementName ?? 'Unknown movement'}\n`;
        report += `- Block number (blockNumber): ${formatMetric(movement.blockNumber)}\n`;
        report += `- Set group (setGroup): ${formatMetric(movement.setGroup)}\n`;
        report += `- Total volume (totalVolume): ${formatMetric(movement.totalVolume, 'lb')}\n`;
        report += `- On-machine volume (totalOnMachineVolume): ${formatMetric(movement.totalOnMachineVolume, 'lb')}\n`;
        report += `- Performed set entries: ${movement.sets?.length ?? 'not reported'}\n`;
      });
    }

    return {
      content: [{ type: 'text' as const, text: report }],
    };
  } catch (error) {
    return handleToolError(error, 'get_workout_summary');
  }
}
