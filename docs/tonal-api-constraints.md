# Tonal API — measured constraints (authoritative, do not re-probe)

Every fact below was verified read-only against one real account on 2026-08-25, whose
lifetime workout count was in the low hundreds spanning roughly three years. Treat these as
given. **Do not make Tonal API calls** — you have no credentials and must not request them.

Base: `https://api.tonal.com/v6`. Undocumented private API, reverse-engineered.
Repo: `/Users/dlwiest/Dev/ts-tonal-client` (published `@dlwiest/ts-tonal-client@0.3.1`).
Consumer: `/Users/dlwiest/Dev/ts-tonal-mcp` (v0.3.0, 14 tools, pins `^0.3.1`).

## Existing client surface (already shipped, do not duplicate)

- `getUserWorkouts(offset, limit)` — workout **templates**, paginates via
  `x-paginate-offset` / `x-paginate-limit` **headers**. This is the repo's paging convention.
- `getRecentWorkouts` / activity summaries, `getMovements` (24h disk cache),
  `getMuscleReadiness`, `getUserStats`, `getCurrentStreak`, `getDailyMetrics(days)`,
  `getGoalMetrics`, `getTargetScores`, `getMetricScores(startWeek)`,
  `estimateWorkoutDuration(sets)`, `createWorkout`, `updateWorkout`, `deleteWorkout`.
- Nothing in the client exposes **performed** data (actual weight/reps lifted). Everything
  today is templates, summaries, or aggregates.

## NEW endpoints (all verified 200 with real data)

### 1. `GET /users/:id/strength-scores/current`
Tonal's headline Strength Score. Returns an **array of 4 rows**, one per region:

    { id, createdAt, updatedAt, userId, workoutActivityId,
      strengthBodyRegion, bodyRegionDisplay, score, current, familyActivity[] }

Regions observed: Upper Body, Core, Lower Body, Overall.
**Quirk:** the `Overall` row carries `updatedAt: "0001-01-01..."` (Go zero value). Never
render that date. Other rows have real timestamps.
This is NOT the goal-metrics "Functional Strength Score" — different, unrelated metric.

### 2. `GET /users/:id/strength-scores/history?limit=N`
Per-workout timeline. Row shape is clean and flat:

    { id, userId, workoutActivityId, upper, lower, core, overall, activityTime }

**`limit` IS A DAYS LOOKBACK, NOT A ROW COUNT.** This is the single most important fact here.
Verified by sweeping the parameter and comparing row counts against the activity timestamps
the endpoint itself returns: the returned set is exactly "activities within `limit` days of
today" (one off-by-one at a midnight boundary). Consequences that matter:
- Row count rises monotonically with `limit` and is unrelated to its magnitude — a `limit` of
  100 can legitimately return zero rows while 1000 returns hundreds.
- **Any `limit` smaller than the gap since the last activity returns an empty array**, not an
  error and not a "no results" signal. This is the trap.
- To cover an entire account, derive the day count from `TonalUserInfo.createdAt` rather than
  passing a large magic number.

`/current` is simply the newest history row — its values match that row exactly.

### 3. `GET /users/:id/workout-activities`  (LIST — effectively unusable)
Returns performed activity records including `workoutSetActivity[]`.
**Hard-capped at 50 rows and cannot page.** Confirmed ignored: `limit` (50/100/200/500/1000/
5000), `offset`, `page`, `skip`, `start`, `cursor`, `days`, `since`, `after`, `from`,
`startTime`, `startDate`, `beginTime`, `startWeek`, `sort`/`order`, AND the repo's own
`x-paginate-offset`/`x-paginate-limit` headers. Every combination returns the identical
50 rows: the **OLDEST** 50 (<oldest-window-start> .. <oldest-window-end>).

### 4. `GET /users/:id/workout-activities/:activityId`  (DETAIL — the good one)
Works for **any** activity id, including ids absent from the capped list. ~58KB per response
(observed 50–74KB). Top-level includes:

    id, userId, workoutId, workoutType, beginTime, endTime, totalDuration, activeDuration,
    restDuration, totalMovements, totalSets, totalReps, totalVolume, totalConcentricWork,
    percentCompleted, completed, workoutSetActivity[], contentCard, deviceId, timezone, ...

`workoutSetActivity[]` rows carry real performed load: `movementId`, `prescribedReps`,
`repetition`, `repetitionTotal`, `weightPercentage`, `baseWeight` (the actual weight in
pounds, including fractional values), `eccentricWeight`, `chainsWeight`, `blockNumber`,
`blockStart`, `sideNumber`, `setId`, `spotter`.

### 5. `GET /formatted/users/:id/workout-summaries/:activityId`
Exists in the fork; **no sample captured.** Treat as unknown. Do not type it.

### 6. `GET /users/:id/activity-summaries` (EXISTING, capped)
Also hard-capped at 50, ignores every query param and the paginate headers. Serves the
**NEWEST** 50 (<recent-window-start> .. <recent-window-end>) — a disjoint window from #3's oldest 50.

## THE ENUMERATION UNLOCK

The two list endpoints together reach only 100 distinct ids in total. **But**
`strength-scores/history?limit=<large>` returns **one row per completed activity, each with a distinct
`workoutActivityId`** — spanning the entire account history.
**The large majority of those ids are reachable by no other means.** All sampled ids resolve 200 on the
detail endpoint (#4).

**Therefore: enumerate ids from strength-score history, then fetch detail per id.**
Do NOT design any paging loop over #3 or #6. Paging is impossible; this is what the fork got
wrong and it silently returned 12% of the data while claiming completeness.

## Cost, caching, limits

- Full sweep: one request per activity, averaging ~58KB each, so tens of megabytes in total.
- No rate-limit headers are exposed on any response.
- 8 concurrent detail fetches → 8×200 in 890ms, no throttling. Higher concurrency untested.
  Assume nothing; use bounded concurrency and backoff.
- **Activity detail is immutable once a workout is complete**, so it is safely cacheable
  indefinitely. `CacheManager` already exists (XDG-based, `~/.cache/ts-tonal-client`,
  currently a 24h TTL for movements, created lazily — must stay lazy, an eager relative
  `.cache` mkdir was a prior production blocker when cwd was `/`).

## Known trap classes in this API (bitten us repeatedly)

1. **Parameters whose names lie.** `getMetricScores()` with no `startWeek` returns `{}` even
   on an account with years of history. `strength-scores/history?limit` is days, not rows.
   Never trust a param name; verify semantics before documenting.
2. **Types declared required that the API omits.** `WorkoutSet.weightPercentage` was declared
   required while real responses omit it; five sibling fields were later widened to nullable.
   Prefer optional for anything not observed on every sampled row.
3. **Non-idempotent retries.** POST/PUT/DELETE must not be retried on 5xx (already fixed).
4. Body-shape lies: `/user-workouts/estimate` needs a raw array, not `{ sets }` (fixed 0.3.1).
5. **Tool inventories the server cannot validate.** See the checklist below. Adding an MCP
   tool without updating all of them produces a tool that is callable but invisible, or
   named but unusable. This bit us three separate times on 2026-08-24/25.

## Hard rules for any implementation

- Additive only. Do not change any existing exported signature, type, or default —
  `ts-tonal-mcp` depends on them.
- Any MCP tool must **summarize**; a raw 58KB activity would obliterate the model's context.
- No mutating Tonal call is ever made in tests or examples.
- Tests use the repo's existing conventions: `jest` in ts-tonal-client, `node:test` +
  `tsx --test` in ts-tonal-mcp.
- **Type-honesty guards only work where tests are typechecked.** A fixture that omits an
  optional field is a guard only if something fails to compile when that field is made
  required. In `ts-tonal-client` that works via `ts-jest`, which typechecks at test time
  (note `tsc --noEmit` there covers only `src`/`examples`, so it does NOT catch it).
  In `ts-tonal-mcp` **neither gate covered tests** — `tsc --noEmit` excludes them because
  `rootDir` is `./src`, and `tsx --test` strips types via esbuild without checking. A
  deliberate `const x: number = 'string'` in a test file passed both. Fixed in commit
  `e4cde7f`: added `tsconfig.test.json` (extends base, `noEmit`, `rootDir: "."`, includes
  `src` + `tests`) and `typecheck` is now `tsc --noEmit && tsc -p tsconfig.test.json`.
  The 9 pre-existing test files were already type-clean, so this added no cleanup debt.
  **Any new MCP test asserting on a sparse API shape must be run under `npm run typecheck`,
  not just `npm test`, or the guard is inert.**

## MANDATORY checklist when adding or renaming an MCP tool

There are SIX places a tool name lives and **nothing in the build validates any of them.**
`registry.ts` is the only source of truth; the rest are hand-maintained and silently drift.
They split into two layers, and passing only one layer fails differently:

**Layer 1 — may the tool be called at all?**
1. `ts-tonal-mcp/src/tools/registry.ts` — imports + definition. Source of truth.
2. `hermes-tonal/config/mcp_servers.tonal.yaml` — read-only profile allowlist (raw names, no
   `mcp__tonal__` prefix). Read-only tools only.
3. `hermes-tonal/config/mcp_servers.tonal.full.yaml` — full profile allowlist (all tools).

Miss these and Hermes never exposes the tool, however good the server is.

**Layer 2 — does the agent know when and how to use it?**
4. `ts-tonal-mcp/README.md` — the `## Available Tools` table, plus any stated tool count.
5. `hermes-tonal/skills/health/tonal/SKILL.md` — the `mcp__tonal__*` inventory list, the
   read-only count sentence, AND the relevant `## Read workflows` / `## When to use Tonal`
   entry. Inventory membership alone is not enough.
6. `hermes-tonal/skills/health/tonal/references/*.md` — the runbook that actually drives the
   behavior. `workout-authoring.md` is loaded before create/update. A "when to use" line in
   SKILL.md pointing at a workflow no runbook describes is worse than silence, because it
   implies a procedure that does not exist.

**Verify mechanically, never by eye.** Cross-check every inventory against the built registry
and assert both directions — nothing missing, and no name that is not in the registry. Pattern
that works: load `dist/tools/registry.js`, compare against each file's parsed list, and when
checking SKILL.md for *guidance* coverage, strip the bare inventory list first so roster
membership does not count as coverage.

These edits are a **shared mutation boundary**: one integration owner does them serially after
handler names stabilize. Do not fan them out to parallel agents.
