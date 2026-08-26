# Design: Strength Scores and Performed Activity Detail

## Recommendation

Ship T1 first as one client release and one MCP release. Ship T2 only after T1 is stable, because T2's arbitrary-ID discovery depends on strength-score history. Do not ship T3 as an MCP tool; defer a bounded, resumable export script until there is a concrete bulk-export use case.

This design never calls either capped list endpoint to claim complete history. “Complete” always names its scope: all IDs returned by the strength-score history enumeration for the requested time window, not an unqualified promise about every activity Tonal might store.


## 0. Corrections from live verification (authoritative — override §2 where they conflict)

Verified read-only after this design was written. Section 2 asserts every `TonalStrengthScore`
field is required "because the measured contract describes every current row with that shape."
That is **false for the `Overall` row**, which is synthesized and sparse:

| field | Upper / Core / Lower | `Overall` |
|---|---|---|
| `familyActivity` | `array[5]` / `array[2]` / `array[3]` | **absent from the response** |
| `bodyRegionDisplay` | `"Upper"` / `"Core"` / `"Lower"` | **`""`** (empty string) |
| `workoutActivityId` | real uuid | **`00000000-0000-...`** (zero uuid) |
| `updatedAt` | real timestamp | `0001-01-01...` (Go zero date) |

Required changes to §2:
1. `familyActivity?: unknown[]` — **optional**. Declaring it required is exactly the repo's
   recurring bug (`WorkoutSet.weightPercentage`).
2. `bodyRegionDisplay` stays `string` but presentation MUST fall back to `strengthBodyRegion`
   when it is empty, or the Overall row renders with a blank label.
3. `workoutActivityId` is present but **meaningless** on the Overall row. It must never be fed
   to `getWorkoutActivityById` without rejecting the all-zero uuid first.
4. `TonalStrengthBodyRegion`'s literals are wrong. Measured `strengthBodyRegion` values are
   `'Upper Body' | 'Core' | 'Lower Body' | 'Overall'` — note "Body" on upper and lower only.
   Keep the `| string` escape hatch.

`TonalStrengthScoreHistoryEntry` is **confirmed safe as all-required**: across all N rows,
every one of `id, userId, workoutActivityId, upper, lower, core, overall, activityTime` was
present, non-null, non-empty, with zero unexpected extra keys and zero malformed uuids. This
one is validated rather than assumed.

## 1. Client surface

### Public types used in signatures

```ts
export type TonalStrengthScoreHistoryLookback = number | 'all'
```

A numeric value is explicitly a count of calendar days. The string `'all'` means “derive a calendar-day lookback from this account's `TonalUserInfo.createdAt`.” It is not translated to a fixed magic number.

Decision: expose `days`, not the endpoint's misleading query name `limit`, because callers must not be able to reasonably read it as a row cap.

Decision: use an explicit `'all'` sentinel rather than a special number because `1200` or `100000` will eventually cease to mean all history.

Decision: default the facade to `'all'`, because history is a small response and a too-small default can silently return zero rows on an active account.

### Exact `TonalClient` additions

```ts
async getCurrentStrengthScores(): Promise<TonalStrengthScore[]>

async getStrengthScoreHistory(
  days: TonalStrengthScoreHistoryLookback = 'all'
): Promise<TonalStrengthScoreHistoryEntry[]>

async getWorkoutActivityById(
  activityId: string,
  useCache: boolean = true
): Promise<TonalWorkoutActivity>
```

`getCurrentStrengthScores()` obtains the cached/coalesced user info already used by the facade and delegates with `userInfo.id`.

For numeric `days`, `getStrengthScoreHistory` accepts only a positive safe integer and passes it through unchanged. It must not slice the returned array to that number. For `'all'`, it obtains `TonalUserInfo`, computes:

```ts
Math.max(
  1,
  Math.ceil((Date.now() - Date.parse(userInfo.createdAt)) / 86_400_000) + 2
)
```

and delegates with that number of days. The two-day inclusion cushion covers the account-creation calendar day and the measured midnight-boundary ambiguity; over-fetching before account creation is harmless. An invalid or future `createdAt` fails loudly with `TonalClientError` and tells the caller to supply explicit `days`; it must not fall back to a small or magic lookback.

Decision: derive all-history from account creation because it remains correct as the account ages and makes `getStrengthScoreHistory()` an intentional all-history request.

Decision: do not accept a `Date`, because a days-based public parameter precisely matches the only verified server semantics without inventing timezone cutoff guarantees.

### Exact `UserService` additions

```ts
async getCurrentStrengthScores(
  userId: string
): Promise<TonalStrengthScore[]>

async getStrengthScoreHistory(
  userId: string,
  days: number
): Promise<TonalStrengthScoreHistoryEntry[]>

async getWorkoutActivityById(
  userId: string,
  activityId: string,
  useCache: boolean = true
): Promise<TonalWorkoutActivity>
```

The request mappings are exact:

```text
GET /users/{userId}/strength-scores/current
GET /users/{userId}/strength-scores/history?limit={days}
GET /users/{userId}/workout-activities/{activityId}
```

`UserService.getStrengthScoreHistory` repeats the positive-safe-integer validation as the transport boundary. Its argument is named `days`; `limit` appears only in URL construction and a comment documenting the verified mismatch.

`activityId` is trimmed, must be non-empty, and is encoded as one URL path segment. The canonical trimmed value is also used for caching.

`UserService` gains an optional `cacheDir` constructor argument and `TonalClient` passes through its existing `cacheDir`; omitting it preserves all existing construction behavior.

Decision: keep these endpoints in `UserService`, alongside the existing user-scoped activity summaries, rather than introduce a second service convention for `/users/{id}/...` routes.

## 2. Types

Add strength types to `src/types/users.ts` and performed-activity types to `src/types/workouts.ts`; the existing `src/types/index.ts` wildcard exports make them public without another export list.

### Strength scores

```ts
export type TonalStrengthBodyRegion =
  | 'Upper'
  | 'Core'
  | 'Lower'
  | 'Overall'
  | string

export interface TonalStrengthScore {
  id: string
  createdAt: string
  updatedAt: string
  userId: string
  workoutActivityId: string
  strengthBodyRegion: TonalStrengthBodyRegion
  bodyRegionDisplay: string
  score: number
  current: boolean
  familyActivity: unknown[]
}

export interface TonalStrengthScoreHistoryEntry {
  id: string
  userId: string
  workoutActivityId: string
  upper: number
  lower: number
  core: number
  overall: number
  activityTime: string
}
```

These fields are required because the measured contract describes every current row with that shape and the history shape as clean and flat. `familyActivity` is required as an array but its elements remain `unknown`; no element shape was measured.

Decision: preserve `updatedAt` in the transport type but prohibit presentation code from rendering it for the `Overall` row, whose value is the Go zero date.

Decision: do not invent an enum closed to future body regions; the repo already uses literal-plus-`string` unions for undocumented Tonal values.

### Performed activity detail

```ts
export interface TonalWorkoutSetActivity {
  movementId?: string | null
  prescribedReps?: number | null
  repetition?: number | null
  repetitionTotal?: number | null
  weightPercentage?: number | null
  baseWeight?: number | null
  eccentricWeight?: number | null
  chainsWeight?: number | null
  blockNumber?: number | null
  blockStart?: boolean | null
  sideNumber?: number | null
  setId?: string | null
  spotter?: boolean | null
}

export interface TonalWorkoutActivity {
  id: string
  userId?: string | null
  workoutId?: string | null
  workoutType?: string | null
  beginTime?: string | null
  endTime?: string | null
  totalDuration?: number | null
  activeDuration?: number | null
  restDuration?: number | null
  totalMovements?: number | null
  totalSets?: number | null
  totalReps?: number | null
  totalVolume?: number | null
  totalConcentricWork?: number | null
  percentCompleted?: number | null
  completed?: boolean | null
  workoutSetActivity?: TonalWorkoutSetActivity[] | null
  contentCard?: unknown
  deviceId?: string | null
  timezone?: string | null
}
```

Only `id` is required. The endpoint lookup establishes the response identity; the constraints do not establish that any other top-level field is present on every possible activity variant. Every nested set field is optional and nullable because timed, unilateral, mode-specific, or otherwise variant set rows can legitimately omit siblings, and this API has already violated required-field assumptions.

Decision: model omission and `null` separately from numeric zero so summaries never turn “not returned” into “0 lb” or “0 reps.”

Decision: type `contentCard` as `unknown` and omit unmeasured top-level fields rather than pretending a single 58 KB sample family is a stable schema.

Do not add a type or method for `GET /formatted/users/:id/workout-summaries/:activityId`. There is no captured sample, so even a permissive-looking interface would imply knowledge that does not exist.

Decision: an untyped endpoint is safer than a false public contract; revisit only after representative read-only samples exist.

## 3. Enumeration and detail

The client does not get a `getAllWorkoutActivities()` method. `getStrengthScoreHistory('all')` is the enumeration primitive, and callers map its `workoutActivityId` values before calling `getWorkoutActivityById`.

Decision: keep enumeration and retrieval as separate primitives because the API has no atomic “all details” operation, and a client method returning an array would make partial and complete results too easy to confuse.

The MCP discovery tool described below performs one strength-history request, sorts entries newest first by `activityTime`, and pages only its rendered output in memory. It never sends offset, page, cursor, or pagination headers to Tonal.

The honest all-history contract is:

> “All distinct activity IDs emitted by Tonal strength-score history from the account-creation-derived lookback through now.”

On the measured account this reached the complete history and all sampled IDs resolved, including the large majority that neither list endpoint exposes. It is still not an unqualified cross-account guarantee that every future activity class receives a strength-score-history row.

A future bulk caller must represent completion explicitly:

```ts
interface TonalActivitySweepManifest {
  enumerationSource: 'strength-score-history'
  requestedLookback: 'all' | { days: number }
  discoveredCount: number | null
  attemptedCount: number
  succeededCount: number
  failed: Array<{
    activityId: string
    activityTime?: string
    attempts: number
    statusCode?: number
    message: string
  }>
  status: 'running' | 'complete' | 'incomplete'
  complete: boolean
}
```

`complete` is derived and true only when enumeration succeeded, `attemptedCount === discoveredCount`, `succeededCount === discoveredCount`, and `failed.length === 0`. It means complete relative to the named enumeration source and lookback. A discovery failure sets `discoveredCount: null`, `status: 'incomplete'`, and `complete: false`. The runner writes an initial incomplete manifest before fetching and updates it atomically, so interruption cannot leave an absent failure marker next to a partial data set. It exits nonzero unless `complete` is true.

Decision: preserve successful records alongside per-ID failures instead of rejecting one aggregate promise, because a N-request operation must be resumable without erasing what succeeded.

## 4. Caching and concurrency

Caching belongs in `ts-tonal-client`, not the MCP layer. The same immutable detail can then be reused by MCP, scripts, and direct consumers, while transport knowledge about `completed` stays next to the endpoint.

Decision: cache at the lowest reusable read boundary; MCP-only caching would duplicate policy and give non-MCP callers no protection from repeated 58 KB requests.

Extend `CacheManager` additively:

```ts
async setPermanent<T>(key: string, data: T): Promise<void>
```

Internally, `CacheEntry.ttl` becomes `number | null`; `null` means no expiry. Existing `set`, its signature, its 24-hour default, and existing cache entries retain their behavior. Do not encode permanence with `Infinity` because JSON serializes it as `null` accidentally, and do not use `Number.MAX_SAFE_INTEGER` as an undocumented pseudo-contract.

`setPermanent` calls the existing private `ensureCacheDir()` only when writing. Constructing `UserService`, constructing `CacheManager`, and a cache miss must not create a directory. This preserves the required XDG path and lazy-creation behavior when the process working directory is `/`.

Cache policy for `getWorkoutActivityById`:

1. Key raw detail as `workout-activity-v1-{sha256(userId + "\0" + activityId)}` so untrusted path text cannot escape the cache directory.
2. With `useCache: true`, return a cached entry before making a request.
3. Cache permanently only when the fresh response has `completed === true`.
4. Do not cache `false`, `null`, or omitted `completed`; those records may still change.
5. `useCache: false` bypasses the read, performs a fresh GET, and replaces the permanent entry only if complete, matching the existing movement-cache refresh convention.
6. Cache reads and writes are best effort. Corruption or an unwritable cache must not hide a successful API response.

Decision: require the explicit `completed === true` check because immutability was established only after completion.

The single-detail client method does not add its own concurrency. A future sweep uses exactly 8 workers: eight concurrent requests were measured successfully, and higher concurrency is untested. This bound is fixed in the first implementation rather than exposed as a knob.

Existing `HttpClient` already gives GETs at most three attempts for timeouts and 5xx responses with 1-second and 2-second delays. The bulk runner adds a shared cooldown only for 429 responses: at most four retries per ID with full jitter in `[0, min(30 seconds, 1 second * 2^attempt)]`. With no rate-limit headers, it must not infer a quota. Exhaustion becomes a manifest failure; it never restarts the full enumeration and never loops indefinitely.

Decision: use bounded retries and bounded concurrency because the absence of rate-limit headers is absence of evidence, not permission for unbounded load.

## 5. MCP tool surface

Add three read-only tools. Each follows `goal-metrics.ts`: exported async handler, validation inside `try`, text `MCPResponse`, `handleToolError` in `catch`, registry definition as source of truth, and these exact annotations:

```ts
annotations: {
  readOnlyHint: true,
  destructiveHint: false,
}
```

### `get_strength_scores`

Description:

> Get Tonal's headline current Strength Score by body region and a compact per-activity trend. This is distinct from the weekly Functional Strength Score goal metric.

Input schema:

```ts
{
  type: 'object',
  properties: {
    days: {
      type: 'integer',
      minimum: 1,
      description: 'Calendar-day history lookback, not a workout or row count. Omit to query from account creation (all available strength-score history).',
    },
  },
  required: [],
}
```

The handler calls current and history concurrently after argument validation; the facade's existing user-info promise coalescing prevents duplicate user-info requests. Numeric `days` is passed to the client unchanged; omission passes `'all'`.

Output summary:

- Current Overall, Upper, Core, and Lower scores.
- Real update timestamps for non-Overall rows only. The Overall `updatedAt` is never rendered, even if it later looks parseable.
- Requested coverage, returned activity count, and earliest/latest `activityTime`.
- Oldest-to-newest change for each of the four numeric scores in the requested result.
- At most the 10 newest history points, explicitly labeled `showing 10 of N` when truncated.
- For an empty numeric window, say `0 scored activities in the requested N calendar days`; still render current scores and do not imply the account has no history.

Drop `id`, `userId`, `familyActivity`, and raw JSON. Activity IDs remain available through the discovery tool rather than bloating this report.

Decision: one combined tool matches T1's two-request user question (“what is my score and trend?”) and avoids two nearly identical tool-selection choices.

### `list_workout_activities`

Description:

> Enumerate performed activity IDs and dates from Strength Score history so a specific activity can be inspected. Tonal is queried once; paging parameters affect presentation only.

Input schema:

```ts
{
  type: 'object',
  properties: {
    days: {
      type: 'integer',
      minimum: 1,
      description: 'Calendar-day enumeration lookback, not a row count. Omit to query from account creation.',
    },
    startIndex: {
      type: 'integer',
      minimum: 0,
      default: 0,
      description: 'Number of newest-first enumeration rows to skip in the rendered result. This is local presentation paging, not a Tonal API offset.',
    },
    pageSize: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 20,
      description: 'Maximum rows to render from the already-fetched enumeration. This is not sent to Tonal.',
    },
  },
  required: [],
}
```

Output summary:

- Source label `strength-score-history` and the requested lookback.
- Discovered count and earliest/latest activity times before presentation slicing.
- `Showing startIndex..endIndex of N`, `Presentation truncated: yes/no`, and `nextStartIndex` only when another page exists.
- For each rendered row: `activityTime`, `workoutActivityId`, and Overall/Upper/Core/Lower scores.
- A standing caveat that completeness is relative to IDs emitted by strength-score history.

Drop strength-history row IDs and user IDs. Never loop on `startIndex`; each call makes one history request and one in-memory slice. If `startIndex >= N`, return an explicit empty page with no `nextStartIndex`.

Decision: use `startIndex`/`pageSize`, not `offset`/`limit`, to make the distinction between output paging and the server's misleading `limit` unmistakable.

### `get_workout_activity`

Description:

> Get a compact performed-load summary for one activity ID returned by `list_workout_activities`; the raw activity payload is intentionally never returned.

Input schema:

```ts
{
  type: 'object',
  properties: {
    activityId: {
      type: 'string',
      minLength: 1,
      description: 'Exact workoutActivityId returned by list_workout_activities.',
    },
  },
  required: ['activityId'],
}
```

Output summary:

- Activity ID, workout ID/type when returned, completion state, begin/end/timezone, and top-level movement/set/rep totals when returned.
- Top-level duration, volume, completion, and work values use their API field names and raw numeric values unless the endpoint's units are independently verified; missing fields say `not returned`, never zero.
- A movement-name lookup through cached `getMovements()`. If enrichment fails, preserve the successful detail report with movement IDs and an explicit `movement names unavailable` notice.
- Group set rows by `movementId` (or `unknown movement`), rendering set-row count, distinct blocks/sides, actual `baseWeight` range in pounds, and ranges/counts for prescribed reps, repetition counters, eccentric weight, chains weight, weight percentage, and spotter-enabled rows. Every aggregate includes coverage such as `baseWeight on 3/4 set rows`; absent values say `not returned`.
- A footer: `Summarized X set rows across Y movement groups; raw payload omitted.`

Drop `contentCard`, `deviceId`, set IDs, raw nested objects, unknown top-level fields, and raw JSON. Do not calculate per-movement volume or completed reps from `repetition`/`repetitionTotal`; their exact semantics were not established.

Decision: aggregate all set rows rather than return an arbitrary first-N subset, so output stays bounded without silently losing an exercise late in the payload.

### Existing `get_goal_metrics`

Do not change its handler, input schema, defaults, or output. Its weekly `Functional Strength Score` is a real, separate goal metric and removing it would be a breaking semantic change. Append one clarification to its registry/README description and the Hermes runbook: `Functional Strength Score is not Tonal's headline Strength Score; use get_strength_scores for the latter.`

Decision: disambiguate routing documentation rather than rewrite an accurate existing tool around an unrelated metric.

### Coupled inventory updates

A registry integration owner must update all of these in one serialized change after handler names stabilize:

1. `ts-tonal-mcp/src/tools/registry.ts`: imports and definitions for all three tools; this remains the source of truth.
2. `ts-tonal-mcp/README.md`: add all three table rows and update the stated inventory from 14 to 17 tools if a count is present.
3. `hermes-tonal/config/mcp_servers.tonal.yaml` and `mcp_servers.tonal.full.yaml`: include all three raw names. They are read-only and belong in both profiles.
4. `hermes-tonal/skills/health/tonal/SKILL.md`: add all three callable names, change read-only availability from 11 to 14, route headline-strength questions to `get_strength_scores`, route ID discovery before detail, and explain enumeration/presentation completeness.
5. Add `hermes-tonal/skills/health/tonal/references/strength-and-activity-history.md` and link it from `SKILL.md`. The runbook must say: never equate `days` with rows; never claim list pagination; inspect one detail at a time; treat omitted load fields as unknown; distinguish Functional Strength Score; and never describe a truncated presentation page or failed sweep as complete.

Decision: put behavior-critical caveats in the Hermes runbook as well as schemas because the runbooks drive agent tool choice and interpretation.

## 6. Tiering and sequencing

### Slice 1: T1 client, independently publishable

Files: client strength types, `UserService`, `TonalClient`, focused Jest tests, and client API documentation. No activity-detail dependency.

Deliver `@dlwiest/ts-tonal-client@0.4.0` if T1 ships alone.

### Slice 2: T1 MCP, depends only on Slice 1

Implement `get_strength_scores`, focused `node:test` tests, one registry edit, README entry, both Hermes allowlists, `SKILL.md`, and the new runbook's strength section. Update the MCP dependency to `^0.4.0`; if T1 ships alone, release MCP `0.4.0`.

This is the recommended first production milestone.

### Slice 3: T2 client detail/cache, independently publishable after or beside T1

Implement performed-detail types, `CacheManager.setPermanent`, cached `UserService` detail, facade method, and focused Jest tests. It shares `src/client.ts` and `src/services/user-service.ts` with Slice 1, so two agents may prepare disjoint logic but one owner must serialize those file edits and resolve import ordering. If released after T1, publish client `0.5.0`.

### Slice 4: T2 MCP discovery and detail, depends on Slices 1 and 3

`list_workout_activities` depends on strength history; `get_workout_activity` depends on detail/cache. Their handler files and tests can be implemented in parallel. Their imports/definitions in `registry.ts`, README table, both YAML allowlists, `SKILL.md`, and shared runbook must be integrated serially by one owner after both handlers are stable. If released after T1, update the dependency to `^0.5.0` and publish MCP `0.5.0`.

### Slice 5: T3 export script, deferred

If a real bulk-export requirement appears, build it after Slices 1 and 3 as a separate CLI/script with the manifest, fixed concurrency, backoff, resume, and nonzero incomplete exit contract above. It has no MCP registry or Hermes inventory edits.

Decision: serialize shared registry/inventory edits; parallelizing tiny shared arrays and tables creates conflict risk without shortening the critical path.

Decision: publish client capability before MCP consumption so the MCP never depends on an unpublished local shape.

If T1 and T2 are intentionally released together, use one client `0.4.0` and one MCP `0.4.0`; do not publish placeholder intermediate versions. The per-slice dependency graph remains the same.

## 7. Test plan

All HTTP tests use mocked `HttpClient.request`; all MCP tests use the existing partial fake-`TonalClient` seam. No test or example calls Tonal, and no mutating endpoint appears in fixtures.

### Slice 1 tests (`jest`)

- Current scores call exactly `/users/u1/strength-scores/current` and return all four rows unchanged.
- `getStrengthScoreHistory(userId, 200)` calls exactly `/users/u1/strength-scores/history?limit=200`.
- The mock returns 75 rows for `days = 50`; the method must return all 75. This specifically catches an implementation that mistakes days for a row limit and slices to 50.
- Zero, negative, fractional, `NaN`, infinity, and unsafe integer days fail before HTTP.
- Facade `'all'` under a fixed clock derives the expected account-age days plus two, proving it does not contain `1200` or `100000`.
- Invalid account `createdAt` fails loudly; it does not make a narrow request.
- A compile-checked fixture supplies every required strength field. A separate history fixture confirms its flat required contract.

### Slice 2 tests (`node:test` via the existing `tsx --test` convention)

- Current output renders all four scores and never contains the Overall zero date.
- `days: 200` is passed as 200 to the client and is described as calendar-day coverage.
- Empty history still renders current scores and explicitly reports zero rows for the requested day window.
- More than 10 rows renders exactly 10 trend points and `showing 10 of N`.
- Registry schema asserts integer/minimum semantics and read-only/non-destructive annotations.
- Existing `get_goal_metrics` tests remain unchanged; add an inventory-description assertion that distinguishes Functional Strength Score from headline Strength Score.

### Slice 3 tests (`jest`)

- Detail calls exactly one encoded by-ID endpoint and returns its body.
- A completed response is persisted; a second call and a fresh service instance with the same temp cache directory make no HTTP request.
- An incomplete, null-completion, or omitted-completion response is not cached and is fetched again.
- `useCache: false` bypasses a complete cached value and refreshes it.
- No cache directory exists after construction or a miss; it appears only after the first successful completed write. This catches the prior eager-directory production failure.
- Corrupt cache JSON and cache-write failure do not hide a successful API response.
- Cache keys for IDs containing path punctuation cannot escape the configured temp directory.
- A compile-checked `TonalWorkoutActivity` fixture omits `weightPercentage`, `baseWeight`, five sibling set fields, and optional top-level totals. If any of those fields is made required, the Jest/TypeScript test compilation fails. This is the direct guard against over-strict response types.

### Slice 4 tests (`node:test`)

- Enumeration with `days: 365`, `pageSize: 10`, and 63 mocked rows (an arbitrary fixture count) calls client history with 365, renders 10, reports `10 of 63`, and emits `nextStartIndex: 10`. This independently catches days-versus-rows confusion in the MCP layer.
- `startIndex >= discoveredCount` returns an explicit empty page and no next index; the handler makes exactly one history call, catching plausible pagination-loop/infinite-loop designs.
- The list output names `strength-score-history` coverage and presentation truncation separately.
- A synthetic activity includes a multi-kilobyte sentinel in `contentCard`; the detail report must not contain the sentinel or raw JSON.
- Movement aggregation includes every movement group even when it appears late in the set array.
- A set fixture omitting weight/repetition siblings does not throw and says `not returned`/reports reduced coverage rather than zero.
- Movement-catalog lookup failure still returns the detail summary by IDs with an explicit enrichment warning.
- Registry tests assert all three names, exact required fields, integer bounds/defaults, and annotations.
- Documentation review/tests confirm both YAML profiles contain all three raw names and the skill's read-only count is 14.

### Slice 5 tests (only if T3 is approved)

- Given three enumerated IDs where one detail fetch exhausts retries, the manifest has `discoveredCount: 3`, `succeededCount: 2`, the failed ID/error, `status: 'incomplete'`, `complete: false`, and a nonzero exit. This is the required test that catches partial sweeps reported as complete.
- All three successes produce `status: 'complete'`, `complete: true`, and exit zero.
- Discovery failure leaves `discoveredCount: null` and can never produce `complete: true`.
- A simulated interruption leaves an atomically readable `running`/incomplete manifest; resume preserves successes and retries only missing/failed IDs.
- Instrumented fake requests never exceed eight concurrent operations, and retry exhaustion terminates after the documented bound.

Decision: test completeness as observable manifest/output behavior, not as an internal counter implementation.

## 8. What not to build

1. **No pagination over `/users/:id/workout-activities` or `/users/:id/activity-summaries`.** Both are hard-capped, ignore every tested paging mechanism, and expose disjoint 50-row windows. A loop would be wrong and can be infinite.
2. **No client `getAllWorkoutActivities(): Promise<TonalWorkoutActivity[]>`.** It cannot expose failures without changing the return contract, encourages a 24 MB surprise, and makes source-relative completeness invisible.
3. **No MCP full-history detail sweep.** Roughly N requests and 24 MB is disproportionate for an interactive model call; the raw data must not enter model context, and MCP timeouts/retries make partial completion hard to communicate safely.
4. **No T3 script in the initial release.** Caching plus one-at-a-time detail serves the concrete interactive use case. Build the script only when someone needs a durable export and accepts its load, disk, and incomplete-manifest contract.
5. **No `/formatted/...` method or type.** There is no response sample.
6. **No raw activity JSON option, debug flag, resource, or attachment in MCP.** A flag would eventually be selected by a model and defeat the context-safety requirement.
7. **No arbitrary concurrency setting above eight.** Higher concurrency is unmeasured and no rate-limit headers exist.
8. **No permanent caching of incomplete activities.** Their immutability is unproven.
9. **No replacement or renaming of `get_goal_metrics`.** Functional Strength Score remains a separate valid weekly metric; only its documentation is clarified.
10. **No fixed “all history” day constant.** Account-age derivation prevents silent truncation as time passes.

Decision: T3 is not worth shipping now because it adds the highest request volume, operational risk, and completion-state complexity while T1 plus cached T2 already answer the high-value interactive questions honestly.
