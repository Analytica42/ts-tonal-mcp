import TonalClient from '@dlwiest/ts-tonal-client';
import type {
  TonalStrengthScore,
  TonalStrengthScoreHistoryEntry,
} from '@dlwiest/ts-tonal-client';
import { MCPResponse } from '../types/index.js';
import { handleToolError } from '../utils/error-handler.js';
import { validateOptionalPositiveInteger } from '../utils/validation.js';

const HISTORY_POINT_LIMIT = 10;
const CURRENT_REGION_ORDER = ['Overall', 'Upper Body', 'Core', 'Lower Body'];

function formatScore(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/\.0+$|(?<=\.\d)0+$/, '');
}

function formatChange(value: number): string {
  const formatted = formatScore(value);
  return value > 0 ? `+${formatted}` : formatted;
}

function sortCurrentScores(scores: TonalStrengthScore[]): TonalStrengthScore[] {
  return [...scores].sort((left, right) => {
    const leftIndex = CURRENT_REGION_ORDER.indexOf(left.strengthBodyRegion);
    const rightIndex = CURRENT_REGION_ORDER.indexOf(right.strengthBodyRegion);
    const leftRank = leftIndex === -1 ? CURRENT_REGION_ORDER.length : leftIndex;
    const rightRank = rightIndex === -1 ? CURRENT_REGION_ORDER.length : rightIndex;
    return leftRank - rightRank;
  });
}

function sortHistoryOldestFirst(
  history: TonalStrengthScoreHistoryEntry[]
): TonalStrengthScoreHistoryEntry[] {
  return [...history].sort(
    (left, right) => Date.parse(left.activityTime) - Date.parse(right.activityTime)
  );
}

export async function getStrengthScores(
  client: TonalClient,
  args?: Record<string, unknown>
): Promise<MCPResponse> {
  try {
    const days = validateOptionalPositiveInteger(args?.days, 'days');
    const lookback = days ?? 'all';

    const [currentScores, history] = await Promise.all([
      client.getCurrentStrengthScores(),
      client.getStrengthScoreHistory(lookback),
    ]);

    let report = `# Tonal Strength Score\n\n`;
    report += `## Current Scores\n`;

    for (const current of sortCurrentScores(currentScores)) {
      const label = current.bodyRegionDisplay || current.strengthBodyRegion;
      report += `- **${label}**: ${formatScore(current.score)}`;
      if (current.strengthBodyRegion !== 'Overall') {
        report += ` (updated ${current.updatedAt})`;
      }
      report += `\n`;
    }

    report += `\n## Requested Coverage\n`;
    if (days === undefined) {
      report += `- Requested: all available strength-score history from account creation\n`;
    } else {
      report += `- Requested: ${days} calendar days\n`;
    }
    report += `- Returned scored activities: ${history.length}\n`;

    if (history.length === 0) {
      if (days === undefined) {
        report += `- Tonal returned 0 scored activities for the all-history request.\n`;
      } else {
        report += `- 0 scored activities in the requested ${days} calendar days.\n`;
      }

      return {
        content: [{ type: 'text' as const, text: report }],
      };
    }

    const orderedHistory = sortHistoryOldestFirst(history);
    const oldest = orderedHistory[0];
    const newest = orderedHistory[orderedHistory.length - 1];

    report += `- Earliest activity: ${oldest.activityTime}\n`;
    report += `- Latest activity: ${newest.activityTime}\n\n`;
    report += `## Oldest-to-Newest Change\n`;
    report += `- **Overall**: ${formatChange(newest.overall - oldest.overall)}\n`;
    report += `- **Upper**: ${formatChange(newest.upper - oldest.upper)}\n`;
    report += `- **Core**: ${formatChange(newest.core - oldest.core)}\n`;
    report += `- **Lower**: ${formatChange(newest.lower - oldest.lower)}\n\n`;

    const displayedHistory = orderedHistory.slice(-HISTORY_POINT_LIMIT).reverse();
    const historyLabel = history.length > HISTORY_POINT_LIMIT
      ? `showing ${HISTORY_POINT_LIMIT} of ${history.length}`
      : `${history.length} points`;
    report += `## Recent History (${historyLabel})\n`;

    for (const point of displayedHistory) {
      report += `- ${point.activityTime}: Overall ${formatScore(point.overall)} | Upper ${formatScore(point.upper)} | Core ${formatScore(point.core)} | Lower ${formatScore(point.lower)}\n`;
    }

    return {
      content: [{ type: 'text' as const, text: report }],
    };
  } catch (error) {
    return handleToolError(error, 'get_strength_scores');
  }
}
