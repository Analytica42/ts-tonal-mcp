import TonalClient from '@dlwiest/ts-tonal-client';
import type {
  TonalGoalMetric,
  TonalMetricScore,
  TonalTargetScore,
} from '@dlwiest/ts-tonal-client';
import { MCPResponse } from '../types/index.js';
import { handleToolError } from '../utils/error-handler.js';
import { validateOptionalString } from '../utils/validation.js';
import { currentTonalWeekNumber } from '../utils/tonal-week.js';

const TREND_WEEKS = 4;

interface ReportedWeek {
  weekNumber: number;
  isRealCurrentWeek: boolean;
}

/**
 * Resolves the ceiling week -- the newest week that may be presented as current or as
 * history. Weeks above it are treated as not-yet-happened.
 *
 * When today's week is known it IS the ceiling. When it is not (getDailyMetrics failed), the
 * newest week carrying an actual score becomes the ceiling: Tonal records an actual only for
 * a week that has already happened, so anything above it may be a pre-populated future
 * target. Only when the metric has no actuals at all does the newest week present become the
 * ceiling, because nothing better is available.
 */
function resolveCeilingWeek(
  weekNumbersDesc: number[],
  scores: TonalMetricScore[],
  realCurrentWeekNumber: number | undefined
): number {
  if (realCurrentWeekNumber !== undefined) {
    return realCurrentWeekNumber;
  }

  let newestScoredWeek: number | undefined;
  for (const score of scores) {
    if (newestScoredWeek === undefined || score.weekNumber > newestScoredWeek) {
      newestScoredWeek = score.weekNumber;
    }
  }

  return newestScoredWeek ?? weekNumbersDesc[0];
}

/**
 * Chooses which week to report as the headline, given the ceiling.
 *
 * Reports the ceiling week itself when Tonal has an entry for it, otherwise the newest week
 * at or below it -- never a week above it, which would be a future target masquerading as
 * "this week." Returns whether the choice is the true current week so the caller can label
 * "current week" and "most recent available" differently instead of implying "this week"
 * either way.
 */
function selectReportedWeek(
  weekNumbersDesc: number[],
  ceilingWeek: number,
  realCurrentWeekNumber: number | undefined
): ReportedWeek {
  const isCeilingToday = ceilingWeek === realCurrentWeekNumber;

  if (weekNumbersDesc.includes(ceilingWeek)) {
    return { weekNumber: ceilingWeek, isRealCurrentWeek: isCeilingToday };
  }

  const atOrBelow = weekNumbersDesc.filter(week => week <= ceilingWeek);
  if (atOrBelow.length > 0) {
    return { weekNumber: atOrBelow[0], isRealCurrentWeek: false };
  }

  // Only weeks above the ceiling exist (Tonal pre-populated targets with no history yet).
  // Report the ceiling and let it show as having no data -- the honest answer.
  return { weekNumber: ceilingWeek, isRealCurrentWeek: isCeilingToday };
}

function buildMetricSection(
  metric: TonalGoalMetric,
  targets: TonalTargetScore[],
  scores: TonalMetricScore[],
  realCurrentWeekNumber: number | undefined
): string {
  let section = `## ${metric.name}\n`;
  if (metric.description) {
    section += `${metric.description}\n\n`;
  }

  const weekNumbersDesc = Array.from(
    new Set([...targets.map(t => t.weekNumber), ...scores.map(s => s.weekNumber)])
  ).sort((a, b) => b - a);

  if (weekNumbersDesc.length === 0) {
    section += `_No score data available for this metric._\n\n`;
    return section;
  }

  // Tonal serves weekly targets regardless of activity but only records an actual once you
  // train, so an inactive account yields targets with no scores at all. Say that once here,
  // otherwise every Actual line reads "N/A" and the report looks broken rather than empty.
  if (scores.length === 0) {
    section += `_No actual scores recorded yet — targets below, but no completed activity for this metric._\n\n`;
  }

  const ceilingWeek = resolveCeilingWeek(weekNumbersDesc, scores, realCurrentWeekNumber);
  const { weekNumber, isRealCurrentWeek } = selectReportedWeek(
    weekNumbersDesc,
    ceilingWeek,
    realCurrentWeekNumber
  );
  const target = targets.find(t => t.weekNumber === weekNumber);
  const score = scores.find(s => s.weekNumber === weekNumber);

  if (isRealCurrentWeek) {
    section += `**Current Week (${weekNumber})**\n`;
  } else if (realCurrentWeekNumber !== undefined) {
    section += `**Most Recent Available Week (${weekNumber})** — current week (${realCurrentWeekNumber}) has no data yet\n`;
  } else {
    section += `**Most Recent Available Week (${weekNumber})** — today's current week could not be determined\n`;
  }

  section += `- Actual: ${score ? score.score.toFixed(2) : 'N/A'}\n`;
  section += `- Target: ${target ? target.target.toFixed(2) : 'N/A'}\n`;
  if (target) {
    section += `- Range: ${target.lowRange.toFixed(2)} - ${target.highRange.toFixed(2)}\n`;
  }
  section += `\n`;

  // Cap the trend at the ceiling so a pre-populated future target cannot appear as if it
  // were already history -- including when today's week is unknown.
  const trendWeeks = weekNumbersDesc.filter(week => week <= ceilingWeek).slice(0, TREND_WEEKS);

  if (trendWeeks.length === 0) {
    section += `_No historical weeks available yet._\n\n`;
    return section;
  }

  section += `**Last ${trendWeeks.length} Recorded Week${trendWeeks.length === 1 ? '' : 's'}**\n`;
  for (const week of trendWeeks) {
    const trendTarget = targets.find(t => t.weekNumber === week);
    const trendScore = scores.find(s => s.weekNumber === week);
    const scoreText = trendScore ? trendScore.score.toFixed(2) : 'N/A';
    const targetText = trendTarget ? trendTarget.target.toFixed(2) : 'N/A';
    const rangeText = trendTarget
      ? ` (range ${trendTarget.lowRange.toFixed(2)}-${trendTarget.highRange.toFixed(2)})`
      : '';
    section += `- Week ${week}: ${scoreText} / target ${targetText}${rangeText}\n`;
  }
  section += `\n`;

  return section;
}

export async function getGoalMetrics(
  client: TonalClient,
  args?: Record<string, unknown>
): Promise<MCPResponse> {
  try {
    const filter = validateOptionalString(args?.filter, 'filter');

    const goalMetrics = await client.getGoalMetrics();

    // Match on name only. Descriptions cross-reference each other -- Tonal's "Endurance Sets"
    // and "Power Reps" blurbs both discuss strength -- so matching descriptions makes a
    // filter like "strength" quietly return metrics the caller did not ask for.
    const needle = filter?.trim().toLowerCase();
    const selected = needle
      ? goalMetrics.filter(metric => metric.name.toLowerCase().includes(needle))
      : goalMetrics;

    if (goalMetrics.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `# 🎯 Goal Metrics\n\nTonal returned no goal metrics for this account.`,
          },
        ],
      };
    }

    if (selected.length === 0) {
      const available = goalMetrics.map(metric => metric.name).join(', ');
      return {
        content: [
          {
            type: 'text' as const,
            text: `# 🎯 Goal Metrics\n\nNo goal metric name matched ${JSON.stringify(needle)}.\n\nAvailable: ${available}`,
          },
        ],
      };
    }

    const [targetScores, metricScores, realCurrentWeekNumber] = await Promise.all([
      client.getTargetScores(),
      client.getMetricScores(),
      currentTonalWeekNumber(client),
    ]);

    let report = `# 🎯 Goal Metrics\n\n`;
    if (needle) {
      report += `_Filtered to names matching ${JSON.stringify(needle)} (${selected.length} of ${goalMetrics.length})._\n\n`;
    }

    for (const metric of selected) {
      report += buildMetricSection(
        metric,
        targetScores[metric.id] ?? [],
        metricScores[metric.id] ?? [],
        realCurrentWeekNumber
      );
    }

    return {
      content: [{ type: 'text' as const, text: report }],
    };
  } catch (error) {
    return handleToolError(error, 'get_goal_metrics');
  }
}
