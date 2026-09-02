import TonalClient from '@dlwiest/ts-tonal-client';
import type { TonalStrengthScoreHistoryEntry } from '@dlwiest/ts-tonal-client';
import { MCPResponse } from '../types/index.js';
import { handleToolError, TonalMCPError } from '../utils/error-handler.js';
import { validateOptionalPositiveInteger } from '../utils/validation.js';

const DEFAULT_START_INDEX = 0;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function validateOptionalIntegerInRange(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum?: number
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    const range = maximum === undefined
      ? `an integer greater than or equal to ${minimum}`
      : `an integer from ${minimum} to ${maximum}`;
    throw new TonalMCPError(
      `${fieldName} must be ${range}`,
      'VALIDATION_ERROR',
      400
    );
  }

  return value;
}

function formatScore(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/\.0+$|(?<=\.\d)0+$/, '');
}

function sortNewestFirst(
  history: TonalStrengthScoreHistoryEntry[]
): TonalStrengthScoreHistoryEntry[] {
  return [...history].sort(
    (left, right) => Date.parse(right.activityTime) - Date.parse(left.activityTime)
  );
}

export async function listWorkoutActivities(
  client: TonalClient,
  args?: Record<string, unknown>
): Promise<MCPResponse> {
  try {
    const days = validateOptionalPositiveInteger(args?.days, 'days');
    const startIndex = validateOptionalIntegerInRange(
      args?.startIndex,
      'startIndex',
      0
    ) ?? DEFAULT_START_INDEX;
    const pageSize = validateOptionalIntegerInRange(
      args?.pageSize,
      'pageSize',
      1,
      MAX_PAGE_SIZE
    ) ?? DEFAULT_PAGE_SIZE;
    const lookback = days ?? 'all';

    const history = await client.getStrengthScoreHistory(lookback);
    const orderedHistory = sortNewestFirst(history);
    const discoveredCount = orderedHistory.length;
    const displayedHistory = orderedHistory.slice(startIndex, startIndex + pageSize);
    const hasNextPage = startIndex + displayedHistory.length < discoveredCount;
    const presentationTruncated = displayedHistory.length < discoveredCount;

    let report = '# Workout Activity Enumeration\n\n';
    report += '- Source: strength-score-history\n';
    report += days === undefined
      ? '- Requested lookback: all available strength-score history from account creation\n'
      : `- Requested lookback: ${days} calendar days\n`;
    report += `- Discovered activities: ${discoveredCount}\n`;

    if (discoveredCount === 0) {
      report += '- Earliest activity: none\n';
      report += '- Latest activity: none\n';
    } else {
      report += `- Earliest activity: ${orderedHistory[discoveredCount - 1].activityTime}\n`;
      report += `- Latest activity: ${orderedHistory[0].activityTime}\n`;
    }

    if (displayedHistory.length === 0) {
      report += `- Showing: empty page at startIndex ${startIndex} of ${discoveredCount}\n`;
    } else {
      const endIndex = startIndex + displayedHistory.length - 1;
      report += `- Showing ${startIndex}..${endIndex} of ${discoveredCount}\n`;
    }
    report += `- Presentation truncated: ${presentationTruncated ? 'yes' : 'no'}\n`;
    if (hasNextPage) {
      report += `- nextStartIndex: ${startIndex + displayedHistory.length}\n`;
    }

    report += '\n## Activities\n';
    if (displayedHistory.length === 0) {
      report += 'No activity rows in this presentation page.\n';
    } else {
      for (const activity of displayedHistory) {
        report += `- ${activity.activityTime} | workoutActivityId ${activity.workoutActivityId} | Overall ${formatScore(activity.overall)} | Upper ${formatScore(activity.upper)} | Core ${formatScore(activity.core)} | Lower ${formatScore(activity.lower)}\n`;
      }
    }

    report += '\nCaveat: completeness is relative to activity IDs emitted by Tonal strength-score history for the requested lookback.\n';

    return {
      content: [{ type: 'text' as const, text: report }],
    };
  } catch (error) {
    return handleToolError(error, 'list_workout_activities');
  }
}
