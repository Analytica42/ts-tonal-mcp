import type TonalClient from '@dlwiest/ts-tonal-client';
import type {
  TonalActivitySummary,
  TonalMovement,
  TonalWorkoutActivity,
  TonalWorkoutSetActivity,
} from '@dlwiest/ts-tonal-client';
import { TonalMCPError } from './error-handler.js';
import {
  NON_LIFT_MOVEMENT_NAMES,
  type LoadReference,
  type ReferenceLoadBasis,
  resolveLoadFactor,
} from './load-calibration.js';
import { collectPoundPrescribedMovementNames } from './workout-conversion.js';

/** Activities fetched per lookup before giving up on finding the movement. */
export const DEFAULT_LOOKBACK_ACTIVITIES = 10;
/** Hard ceiling on the lookback, since each activity is a separate API round trip. */
export const MAX_LOOKBACK_ACTIVITIES = 40;
/** How long a resolved reference stays usable in-process. */
export const LOAD_REFERENCE_CACHE_TTL_MS = 5 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Process-local caches. Converting eight exercises would otherwise re-scan the same ten
// activities eight times; the activity-detail cache also makes a miss cheap to repeat.
const referenceCache = new Map<string, CacheEntry<LoadReference>>();
const activityDetailCache = new Map<string, CacheEntry<TonalWorkoutActivity>>();
let activitySummariesCache: CacheEntry<TonalActivitySummary[]> | null = null;

/** Drops every cached reference, activity detail and summary list. For tests and long-lived processes. */
export function clearLoadReferenceCache(): void {
  referenceCache.clear();
  activityDetailCache.clear();
  activitySummariesCache = null;
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string, now: number): T | undefined {
  const entry = cache.get(key);
  if (entry === undefined) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

export function validateLookbackActivities(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_LOOKBACK_ACTIVITIES;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_LOOKBACK_ACTIVITIES
  ) {
    throw new TonalMCPError(
      `lookbackActivities must be an integer from 1 to ${MAX_LOOKBACK_ACTIVITIES}`,
      'VALIDATION_ERROR',
      400
    );
  }
  return value;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A set is usable as a reference only if it carries both a real one-rep max and a real
 * load. Non-lifts slip through otherwise: the "Rest" pseudo-movement reports oneRepMax 5.0,
 * and unloaded sets report avgWeight 0.
 */
function isUsableReferenceSet(set: TonalWorkoutSetActivity): boolean {
  const oneRepMax = finiteNumberOrNull(set.oneRepMax);
  if (oneRepMax === null || oneRepMax <= 0) {
    return false;
  }
  const baseWeight = finiteNumberOrNull(set.baseWeight);
  const avgWeight = finiteNumberOrNull(set.avgWeight);
  return (baseWeight !== null && baseWeight > 0) || (avgWeight !== null && avgWeight > 0);
}

function setTimestamp(set: TonalWorkoutSetActivity, fallback: string): number {
  const parsed = set.beginTime === undefined ? NaN : Date.parse(set.beginTime);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }
  const fallbackParsed = Date.parse(fallback);
  return Number.isNaN(fallbackParsed) ? 0 : fallbackParsed;
}

/** Latest qualifying set in one activity: newest timestamp, then sortOrder, then array order. */
function pickLatestSet(
  sets: TonalWorkoutSetActivity[],
  activityBeginTime: string
): TonalWorkoutSetActivity | undefined {
  let best: TonalWorkoutSetActivity | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  let bestSortOrder = Number.NEGATIVE_INFINITY;

  sets.forEach((set) => {
    const time = setTimestamp(set, activityBeginTime);
    const sortOrder = finiteNumberOrNull(set.sortOrder) ?? Number.NEGATIVE_INFINITY;
    if (
      best === undefined ||
      time > bestTime ||
      (time === bestTime && sortOrder >= bestSortOrder)
    ) {
      best = set;
      bestTime = time;
      bestSortOrder = sortOrder;
    }
  });

  return best;
}

function findMovementByName(
  movements: TonalMovement[],
  movementName: string
): TonalMovement {
  const normalized = movementName.trim().toLowerCase();
  const movement = movements.find((candidate) => candidate.name.toLowerCase() === normalized);
  if (!movement) {
    throw new TonalMCPError(
      `Movement "${movementName}" not found in the Tonal catalog. Use search_movements to find the exact name.`,
      'MOVEMENT_NOT_FOUND',
      404
    );
  }
  if (NON_LIFT_MOVEMENT_NAMES.has(normalized)) {
    throw new TonalMCPError(
      `"${movement.name}" is a non-lift pseudo-movement and carries no real load; it cannot be prescribed in pounds.`,
      'NON_LIFT_MOVEMENT',
      400
    );
  }
  return movement;
}

async function getActivitySummariesCached(
  client: TonalClient,
  now: number
): Promise<TonalActivitySummary[]> {
  if (activitySummariesCache !== null && activitySummariesCache.expiresAt > now) {
    return activitySummariesCache.value;
  }
  const summaries = await client.getActivitySummaries();
  // getActivitySummaries is observed newest-first, but sort explicitly rather than trust it:
  // a reference taken from the wrong end of history is silently wrong.
  const ordered = summaries
    .filter((summary) => summary.deletedAt === null || summary.deletedAt === undefined)
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  activitySummariesCache = { value: ordered, expiresAt: now + LOAD_REFERENCE_CACHE_TTL_MS };
  return ordered;
}

async function getActivityDetailCached(
  client: TonalClient,
  activityId: string,
  now: number
): Promise<TonalWorkoutActivity> {
  const cached = readCache(activityDetailCache, activityId, now);
  if (cached !== undefined) {
    return cached;
  }
  const detail = await client.getWorkoutActivityById(activityId);
  activityDetailCache.set(activityId, {
    value: detail,
    expiresAt: now + LOAD_REFERENCE_CACHE_TTL_MS,
  });
  return detail;
}

export interface ResolveLoadReferenceOptions {
  lookbackActivities?: number;
}

/**
 * Resolves the pound-conversion reference for one movement from its most recent performed set.
 *
 * Scans recent activities newest-first and stops at the first activity containing a usable
 * set, so the common case costs one activity fetch. Results are cached in-process for
 * LOAD_REFERENCE_CACHE_TTL_MS.
 *
 * @throws TonalMCPError when the movement is unknown, is a non-lift, carries no cable load,
 *   has no resolvable cable factor, or has no performed-set history inside the lookback
 *   window. Never substitutes a default one-rep max or a default cable factor: either guess
 *   would silently mis-prescribe load.
 */
export async function resolveLoadReference(
  client: TonalClient,
  movementName: string,
  options: ResolveLoadReferenceOptions = {}
): Promise<LoadReference> {
  const lookbackActivities = validateLookbackActivities(options.lookbackActivities);
  const now = Date.now();

  const movements = await client.getMovements();
  const movement = findMovementByName(movements, movementName);
  // Resolved before the scan: a movement with no cable load, or no cable attribute, is
  // unconvertible on its own terms, so it must not cost ten activity fetches to find out.
  const factor = resolveLoadFactor(movement);

  const cacheKey = `${movement.id}:${lookbackActivities}`;
  const cached = readCache(referenceCache, cacheKey, now);
  if (cached !== undefined) {
    return cached;
  }

  const summaries = await getActivitySummariesCached(client, now);
  const window = summaries.slice(0, lookbackActivities);

  let activitiesScanned = 0;
  for (const summary of window) {
    const detail = await getActivityDetailCached(client, summary.id, now);
    activitiesScanned += 1;

    const candidates = (detail.workoutSetActivity ?? []).filter(
      (set) => set.movementId === movement.id && isUsableReferenceSet(set)
    );
    const latest = pickLatestSet(candidates, detail.beginTime);
    if (latest === undefined) {
      continue;
    }

    const oneRepMax = finiteNumberOrNull(latest.oneRepMax) as number;
    const denominatorPounds = factor.factor * oneRepMax;
    const baseWeight = finiteNumberOrNull(latest.baseWeight);
    const avgWeight = finiteNumberOrNull(latest.avgWeight);

    // baseWeight is the load dialled in on the machine; avgWeight is force averaged over the
    // range of motion and reads low, so it is only a labelled fallback.
    let impliedBasis: ReferenceLoadBasis | null = null;
    let impliedLoad: number | null = null;
    if (baseWeight !== null && baseWeight > 0) {
      impliedBasis = 'baseWeight';
      impliedLoad = baseWeight;
    } else if (avgWeight !== null && avgWeight > 0) {
      impliedBasis = 'avgWeight';
      impliedLoad = avgWeight;
    }

    const performedAtRaw = latest.beginTime ?? detail.beginTime;
    const performedAtMs = Date.parse(performedAtRaw);
    const reference: LoadReference = {
      movementId: movement.id,
      movementName: movement.name,
      oneRepMax,
      denominatorPounds,
      poundsPerPercentagePoint: denominatorPounds / 100,
      factor,
      referenceSet: {
        activityId: detail.id,
        performedAt: performedAtRaw,
        ageDays: Number.isNaN(performedAtMs)
          ? Number.NaN
          : Math.floor((now - performedAtMs) / MS_PER_DAY),
        baseWeight,
        avgWeight,
        repCount: finiteNumberOrNull(latest.repCount),
        weightPercentage: finiteNumberOrNull(latest.weightPercentage),
        impliedPercentage:
          impliedLoad === null
            ? null
            : Math.round((impliedLoad / denominatorPounds) * 10000) / 100,
        impliedPercentageBasis: impliedBasis,
      },
      activitiesScanned,
      resolvedAt: now,
    };

    referenceCache.set(cacheKey, {
      value: reference,
      expiresAt: now + LOAD_REFERENCE_CACHE_TTL_MS,
    });
    return reference;
  }

  throw new TonalMCPError(
    `No recent set found for "${movement.name}"; cannot convert pounds. Scanned ${activitiesScanned} of the ${lookbackActivities} most recent activities and found no performed set with a real load, so there is no oneRepMax to convert against. Raise lookbackActivities (ceiling ${MAX_LOOKBACK_ACTIVITIES}), perform the movement once on the trainer, or prescribe this movement with weight (percentage) instead of weightLb. For a movement that carries no load at all, use weight: 0.`,
    'NO_LOAD_REFERENCE',
    404
  );
}

/**
 * Resolves a reference for every movement in the exercise list that prescribes load in
 * pounds, keyed by movement ID so a caller's spelling cannot mis-key the lookup.
 *
 * Called before any mutation: an unresolvable reference must fail the whole request rather
 * than write a partially converted workout.
 */
export async function resolveLoadReferencesForExercises(
  client: TonalClient,
  exercises: unknown,
  options: ResolveLoadReferenceOptions = {}
): Promise<Map<string, LoadReference>> {
  const movementNames = collectPoundPrescribedMovementNames(exercises);
  const references = new Map<string, LoadReference>();

  for (const movementName of movementNames) {
    const reference = await resolveLoadReference(client, movementName, options);
    references.set(reference.movementId, reference);
  }

  return references;
}
