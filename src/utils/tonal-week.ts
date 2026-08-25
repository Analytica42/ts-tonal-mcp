import type TonalClient from '@dlwiest/ts-tonal-client';

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Computes an ISO 8601 week number (Monday-start; week 1 is the week containing the year's
 * first Thursday) for a "YYYY-MM-DD" date string, encoded the way Tonal's own
 * TonalTargetScore/TonalMetricScore `weekNumber` fields are: YYYYWW (2026 week 34 -> 202634).
 *
 * CAVEAT -- the ISO part is INFERRED, not confirmed. What is confirmed live is only that
 * 2026-08-17 (a Monday) is weekNumber 202634 and 2026-08-24 is 202635. Both conventions
 * label those two Mondays identically, so those observations cannot distinguish them. ISO
 * and the US convention (Sunday-start, week 1 contains Jan 1) disagree on every SUNDAY --
 * 2026-08-23 is ISO 202634 but US 202635 -- and again at year boundaries, where 2025 has 52
 * ISO weeks against 53 US weeks, so a real `202553` from Tonal would falsify the ISO
 * reading. The account this was built against carries only 202627-202635, none of which
 * settles it. A single Sunday's bucketing would.
 *
 * Consequence if the inference is wrong: this returns a week number Tonal has no entry for,
 * which callers treat as "current week has no data yet" and fall back to the most recent
 * available week -- degraded labeling, not wrong numbers.
 */
export function isoWeekNumber(dateString: string): number {
  const [year, month, day] = dateString.split('-').map(Number);

  // Throw rather than let NaN propagate. TonalDailyMetrics.date is typed only as `string`,
  // and sibling date fields in this API are full timestamps, so a format change is possible.
  // NaN would sail past currentTonalWeekNumber's catch and be reported as an authoritative
  // "Current Week (NaN)" with every value blank; throwing routes it to the honest
  // could-not-determine fallback instead.
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Expected a "YYYY-MM-DD" date string, received ${JSON.stringify(dateString)}`);
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  // Move to the Thursday of this ISO week; the ISO week-year is that Thursday's year.
  const isoDayNum = (date.getUTCDay() + 6) % 7; // Monday=0 .. Sunday=6
  date.setUTCDate(date.getUTCDate() - isoDayNum + 3);
  const isoYear = date.getUTCFullYear();

  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);

  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / MS_PER_WEEK);
  return isoYear * 100 + week;
}

/**
 * Determines the current Tonal week number (YYYYWW) by asking Tonal what "today" is via
 * getDailyMetrics(1) rather than reading the MCP server process's clock, which may run in a
 * different timezone than the account. Verified live: getDailyMetrics(1) returns exactly one
 * row for today, and the series is dense day-by-day, so [0] is today rather than the most
 * recent day that happens to have activity.
 *
 * Returns undefined instead of throwing when this can't be determined, so callers can fall
 * back to clearly-labeled behavior rather than silently guessing.
 */
export async function currentTonalWeekNumber(client: TonalClient): Promise<number | undefined> {
  try {
    const [today] = await client.getDailyMetrics(1);
    if (!today?.date) {
      return undefined;
    }
    return isoWeekNumber(today.date);
  } catch {
    return undefined;
  }
}
