/**
 * ccusage JSON parsing with the input-validity guards from the T-003 plan review.
 *
 * Two JS-vs-Python semantics gaps are closed here by failing loud rather than diverging
 * silently. Both are declared sanctioned deltas in tests/golden/ALLOWLIST.md (entries 6-7),
 * so byte parity is contracted over *valid* ccusage output:
 *
 *  1. Canonical-integer object keys. `JSON.parse('{"2":a,"1":b}')` iterates 1,2 (JS orders
 *     integer-like keys numerically); Python preserves textual order. That changes float
 *     summation order — exactly what reconcile()'s tolerance exists to detect — and would
 *     be undetectable. Unreachable from real ccusage output (encoded paths always begin
 *     "-" because absolute paths start with "/"; model names always contain letters).
 *
 *  2. Integers above 2^53. Python ints are arbitrary precision; JSON.parse is binary64 and
 *     rounds silently. Validation happens HERE, before aggregation, and covers both
 *     providers — Claude's token fields never pass through cnum, so a cnum-only guard
 *     would miss them entirely (plan review R2-F2).
 */
import { UsageError } from "./errors.js";
import { pyRepr } from "./pyrepr.js";

const INTEGER_LIKE_KEY = /^(0|[1-9]\d*)$/;

/**
 * Schema enforcement (T-006).
 *
 * THE RULE, and it is narrower than it first looks (code review R2):
 *
 *     Validate only what the downstream would otherwise accept SILENTLY.
 *
 * Both halves matter. A field the consumer reads through `num()` (aggregate.ts:61) degrades
 * to 0 on a rename, producing a clean-looking table with wrong totals — that is the bug this
 * ticket exists to close, and those fields are required here. But a field the consumer reads
 * through `cnum()` (aggregate.ts:47) ALREADY fails loud on absence and on wrong types, and
 * its wording is BYTE-FROZEN (ALLOWLIST entry 2; golden `codex_bad_cost`). Re-checking such a
 * field here does not add safety: this module runs FIRST (ccusage.ts:100, before codex.ts
 * ever sees the payload), so it merely replaces the frozen message with its own and breaks
 * the golden. An earlier revision did exactly that.
 *
 * The one thing `cnum` cannot express is the safe-integer bound — it accepts 2^53+1, which
 * `JSON.parse` has already rounded (ALLOWLIST entry 7) — so that check stays everywhere.
 *
 * Collection presence is MEASURED against the pinned binary's empty output, not assumed:
 *
 *   claude daily --instances  -> {"daily": [], "totals": {…}}   <- `projects` ABSENT
 *   daily                     -> {"daily": [], "totals": {…}}
 *   codex session             -> {"sessions": [], "totals": {…}}
 *   codex daily               -> {"daily": [], "totals": {…}}
 *
 * `projects` is therefore optional (and is a MAP, not a list — treating it as an array would
 * reject every non-empty payload), tolerated absent only when the payload is genuinely empty.
 *
 * REQUIRED, EMPTY IS FINE: `modelBreakdowns` on Claude rows and `models` on Codex SESSIONS.
 * `aggregate.ts:116` falls back to `[]` and `codex.ts:162` falls back to "unclassified", so a
 * rename of either silently zeroes the per-model columns with no error. Measured safe against
 * both producers first: the pinned binary emits `modelBreakdowns` even without `--breakdown`,
 * and `models` on every codex row, as does tests/fake_ccusage.py in every FAKE_MODE. An empty
 * `[]`/`{}` stays valid, so there is deliberately NO "nonzero tokens implies a model
 * breakdown" invariant.
 *
 * NOT validated, because measured absent and/or genuinely unconsumed — requiring these would
 * turn a still-working payload into a hard failure, which is worse than the bug being fixed:
 *   - `totals.totalTokens` on the CLAUDE paths: aggregate.ts:128 returns only
 *     `num(totals.totalCost)`; usage.py:184/484 sum tokens from rows. (The CODEX totals ARE
 *     consumed, at codex.ts:145/200, and are guarded accordingly.)
 *   - Row-level `inputTokens`/`outputTokens`/`cacheCreationTokens`/`cacheReadTokens`: absent
 *     from the golden fixture and never read per row. Requiring them would break T-005.
 *   - `modelBreakdowns[].totalTokens`: the producer does not emit it at all — the four
 *     component counters are what `aggregate.ts:67` sums.
 *   - Every field of a `codex daily` ROW: codex.ts:457 destructures only `{ grand, grandTok }`
 *     and discards `rows` entirely, so nothing there is consumed.
 *   - `directory` on a codex session: optional AND nullable by design, see below.
 */

function fail(msg: string): never {
  throw new UsageError(`unexpected ccusage output: ${msg}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Require the payload root to be an object with a well-formed `totals`. */
function requireRoot(d: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(d)) fail(`${what} payload is not an object`);
  if (!isPlainObject(own(d, "totals"))) fail(`${what} payload has no 'totals' object`);
  return d;
}

/**
 * Read a field the way Python reads a dict key: OWN properties only.
 *
 * Every helper below turns this value into a present/absent or well-typed/mistyped verdict,
 * and plain `row[field]` consults the prototype chain — so an inherited property could
 * satisfy a check for a key the payload does not actually contain. That is the same
 * divergence `pyGet` (codex.ts) was corrected for in R5, and leaving it here while fixing it
 * there is exactly the half-translation that comment warns about (code review R7).
 *
 * Reachability, stated honestly: `JSON.parse` never sets a `[[Prototype]]` (a `"__proto__"`
 * key becomes an ordinary own property), and none of the validated field names exist on
 * `Object.prototype`, so no ccusage payload can reach this. It is defence in depth against
 * in-process prototype pollution, not a live bug — but a module whose entire purpose is that
 * a missing key must never pass for a present one should not itself ask the wrong question.
 */
function own(row: Record<string, unknown>, field: string): unknown {
  return Object.hasOwn(row, field) ? row[field] : undefined;
}

/** Require a field to be a finite number. */
function requireNumber(row: Record<string, unknown>, field: string, where: string): number {
  const v = own(row, field);
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${where}.${field} = ${pyRepr(v)} (expected a number) — the ccusage schema may have changed`);
  }
  return v as number;
}

/**
 * Require a field to be a string. TYPE ONLY — an EMPTY string is valid.
 *
 * Rejecting `""` was over-reach (code review R5). Python indexes these directly
 * (`day["date"]` at usage.py:186-187/560-563, `mb["modelName"]` at 189/480/565/610), so an
 * empty value is not an error there at all: it produces a row keyed by "" and the table
 * renders. Refusing it would exit 1 where Python exits 0 — a divergence entry 14 does not
 * sanction, on a value the producer can legitimately emit (an unnamed or unresolved model).
 *
 * Nothing is lost. The guard exists to catch a RENAME or a type change, and both still fail:
 * a renamed key reads back `undefined`, which is not a string. `""` is neither missing nor
 * mistyped, so it was never evidence of the drift this check is looking for.
 */
function requireString(row: Record<string, unknown>, field: string, where: string): void {
  const v = own(row, field);
  if (typeof v !== "string") {
    fail(`${where}.${field} = ${pyRepr(v)} (expected a string) — the ccusage schema may have changed`);
  }
}

/** Require an array-valued collection that the producer always emits (may be empty). */
function requireArray(root: Record<string, unknown>, field: string, what: string): unknown[] {
  const v = own(root, field);
  if (!Array.isArray(v)) {
    fail(
      `${what} payload has no '${field}' array (got ${pyRepr(v)}) — the ccusage schema may have changed`,
    );
  }
  return v as unknown[];
}

/** Require a field to be a finite number AND an exactly-representable integer. */
function requireCount(row: Record<string, unknown>, field: string, where: string): number {
  const v = requireNumber(row, field, where);
  checkSafeInteger(v, `${where}.${field}`);
  return v;
}

/**
 * Require a field to merely BE THERE, without asserting its type.
 *
 * For values that reach `cnum`, the type check is already cnum's and its wording is
 * byte-frozen — re-checking it here would shadow that message (code review R2). But where
 * the call site is `cnum(pyGet(o, k, 0), …)`, an ABSENT OWN KEY never reaches cnum at all and
 * is silently zeroed, so presence alone is the additive guard. (A present-but-null value DOES
 * reach cnum and raises its frozen text — which is precisely why `pyGet` replaced `?? 0`
 * there, and why this check must test own-key presence rather than nullishness.)
 */
function requirePresent(row: Record<string, unknown>, field: string, where: string): void {
  if (own(row, field) === undefined) {
    fail(`${where}.${field} is missing — the ccusage schema may have changed`);
  }
}

/**
 * Range-check whichever token counters are present, WITHOUT asserting type.
 *
 * Type errors on these belong to cnum (codex) or are harmless via num() (Claude rows, which
 * do not consume them at all). The safe-integer bound is the part neither provides.
 */
function checkCounters(row: Record<string, unknown>, where: string): void {
  for (const f of CLAUDE_TOKEN_FIELDS) {
    const v = own(row, f);
    if (v !== undefined) checkSafeInteger(v, `${where}.${f}`);
  }
}

/** Fields that must hold safe integers, per provider payload shape. */
const CLAUDE_TOKEN_FIELDS = [
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
] as const;

/**
 * Counters REQUIRED on every model-breakdown entry — the four `aggregate.ts:67` sums.
 * `totalTokens` is deliberately absent: the producer does not emit it on a breakdown entry.
 */
const BREAKDOWN_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
] as const;

/**
 * Claude totals. ONLY `totalCost` is consumed: `aggregate.ts:128` returns
 * `grand: num(totals.totalCost)` and never reads `totals.totalTokens` — `usage.py:184` and
 * `usage.py:484` agree, summing tokens from the rows instead. (The Codex side genuinely
 * does consume `totals.totalTokens`, at codex.ts:145/200, which is why it is guarded there
 * and not here.)
 *
 * So `totalTokens` is deliberately NOT required (code review R2). Requiring a field nothing
 * reads turns a still-working payload into a hard failure — the outcome this ticket exists
 * to avoid. It is range-checked when present, and required only in the absent-collection
 * branch, where it genuinely decides the result.
 */
function requireClaudeTotals(root: Record<string, unknown>, where: string): number {
  const totals = own(root, "totals") as Record<string, unknown>;
  const cost = requireNumber(totals, "totalCost", where);
  checkSafeInteger(own(totals, "totalTokens"), `${where}.totalTokens`);
  return cost;
}

/**
 * Guard for a collection the producer omits when there is genuinely nothing.
 *
 * Gating on cost ALONE was wrong: cost is zero for an unpriced or offline-resolved model
 * while tokens are positive, so a rename could still be waved through as "empty" and the
 * usage silently discarded. Absence is legitimate only when BOTH counters are zero.
 *
 * `totalTokens` IS required here — unlike on the normal path, it is load-bearing for this
 * decision, and it is measured present in every empty payload from both the pinned binary
 * and tests/fake_ccusage.py.
 */
function requireGenuinelyEmpty(
  root: Record<string, unknown>,
  cost: number,
  field: string,
  what: string,
): void {
  const totals = own(root, "totals") as Record<string, unknown>;
  const tokens = requireCount(totals, "totalTokens", `${what} totals`);
  if (cost !== 0 || tokens !== 0) {
    fail(
      `${what} payload has non-zero totals (cost ${pyRepr(cost)}, tokens ${pyRepr(tokens)}) ` +
        `but no '${field}' — the ccusage schema may have changed`,
    );
  }
}

/**
 * Validate a `modelBreakdowns` list. REQUIRED on every real row (empty is fine) — see the
 * module note: absence degrades to zeroed per-model columns rather than an error.
 */
function validateModelBreakdowns(mbs: unknown, where: string): void {
  if (!Array.isArray(mbs)) {
    fail(`${where}.modelBreakdowns is ${pyRepr(mbs)} (expected an array) — the ccusage schema may have changed`);
  }
  for (const mb of mbs) {
    if (!isPlainObject(mb)) fail(`${where}.modelBreakdowns contains a non-object entry`);
    const at = `${where}.modelBreakdowns`;
    requireString(mb, "modelName", at);
    requireNumber(mb, "cost", at);
    for (const f of BREAKDOWN_TOKEN_FIELDS) requireCount(mb, f, at);
    // `totalTokens` is deliberately NOT required here (the producer never emits it on a
    // breakdown entry), but ALLOWLIST 7 says the safe-integer bound applies to *any*
    // integral field — so range-check it if it does turn up. Swapping CLAUDE_TOKEN_FIELDS
    // for BREAKDOWN_TOKEN_FIELDS silently dropped this one field from the sweep, narrowing
    // entry 7 without recording it (code review R8).
    checkSafeInteger(own(mb, "totalTokens"), `${at}.totalTokens`);
  }
}

function rejectIntegerLikeKeys(obj: unknown, where: string): void {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (INTEGER_LIKE_KEY.test(key)) {
      throw new UsageError(
        `unexpected ccusage output: ${where} has a canonical-integer key ${pyRepr(key)}; ` +
          `such keys reorder under JSON parsing and would change aggregation order`,
      );
    }
  }
}

function checkSafeInteger(v: unknown, field: string): void {
  if (typeof v !== "number") return; // shape errors are reported by cnum / callers
  if (!Number.isFinite(v)) return;
  if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
    throw new UsageError(
      `unexpected ccusage output: ${field} = ${pyRepr(v)} exceeds the safe integer range ` +
        `(2^53-1); values this large cannot be represented exactly`,
    );
  }
}

/**
 * Validate a Claude `--instances` payload.
 *
 * `projects` is OPTIONAL — the pinned binary omits it entirely on an empty result — but when
 * present it is a MAP from encoded project name to an array of day rows, never a list.
 * Rows use `date` (NOT `period`, which is the generic `daily` spelling) and `totalCost`.
 */
export function validateInstances(d: unknown): void {
  const root = requireRoot(d, "instances");
  const cost = requireClaudeTotals(root, "totals");

  const projects = own(root, "projects");
  if (projects === undefined) {
    // Absent is only legitimate when there is genuinely nothing — any positive counter with
    // no projects is the silent-rename signature.
    requireGenuinelyEmpty(root, cost, "projects", "instances");
    return;
  }
  if (!isPlainObject(projects)) {
    fail(`'projects' is ${pyRepr(projects)} (expected an object keyed by project)`);
  }
  rejectIntegerLikeKeys(projects, "projects");

  for (const [proj, days] of Object.entries(projects)) {
    if (!Array.isArray(days)) {
      fail(`projects.${proj} is ${pyRepr(days)} (expected an array of day rows)`);
    }
    for (const day of days) {
      if (!isPlainObject(day)) fail(`projects.${proj} contains a non-object row`);
      const where = `projects.${proj}`;
      requireString(day, "date", where); // NOT 'period' — that is generic daily's spelling
      requireNumber(day, "totalCost", where);
      requireCount(day, "totalTokens", where);
      checkCounters(day, where); // the four row-level counters are optional — see the note
      validateModelBreakdowns(own(day, "modelBreakdowns"), where);
    }
  }
}

/**
 * Validate a generic `daily` payload.
 *
 * `daily` is REQUIRED — the pinned binary always emits it, empty array included. Rows use
 * **`period`**, not `date`: that asymmetry with `--instances` is the trap this ticket exists
 * to pin, so it is asserted in both directions.
 */
export function validateDaily(d: unknown): void {
  const root = requireRoot(d, "daily");
  const cost = requireClaudeTotals(root, "totals");

  // The pinned binary always emits `daily` (as `[]` when empty), but the golden fixture
  // omits it entirely on empty — a shape the current producer no longer generates, yet one
  // usage.py tolerates via .get("daily", []). Accept both: absent is legitimate ONLY when
  // BOTH totals are zero, so a rename with real data behind it is still caught. This
  // tolerance is recorded as its own sanctioned shape in ALLOWLIST entry 14.
  if (own(root, "daily") === undefined) {
    requireGenuinelyEmpty(root, cost, "daily", "daily");
    return;
  }
  const rows = requireArray(root, "daily", "daily");
  rows.forEach((row, i) => {
    if (!isPlainObject(row)) fail(`daily[${i}] is not an object`);
    const where = `daily[${i}]`;
    requireString(row, "period", where); // NOT 'date' — that is --instances' spelling
    requireNumber(row, "totalCost", where);
    requireCount(row, "totalTokens", where);
    checkCounters(row, where); // the four row-level counters are optional — see the note
    validateModelBreakdowns(own(row, "modelBreakdowns"), where);
  });
}

/**
 * Validate a `codex daily` payload.
 *
 * codexDaily() feeds totals.totalTokens straight to cnum, and cnum only rejects negative /
 * non-finite / non-number — an integer at or above 2^53 has ALREADY been rounded by
 * JSON.parse by then and sails through, silently corrupting the cross-check token total
 * (code review R1). Coverage now matches the sessions payload on both providers.
 */
export function validateCodexDaily(d: unknown): void {
  const root = requireRoot(d, "codex daily");
  const totals = own(root, "totals") as Record<string, unknown>;

  // These DO carry defaults — `cnum(pyGet(totals, k, 0), …)` at codex.ts:199-200 — so an
  // ABSENT OWN KEY really is silently zeroed and requiring presence is additive. A
  // present-but-null value is NOT: `pyGet` hands it to cnum, which raises its byte-frozen
  // text, so nullishness is deliberately not what is tested. Wrong TYPES are likewise
  // already cnum's and are not re-checked here.
  requirePresent(totals, "costUSD", "codex daily totals");
  requirePresent(totals, "totalTokens", "codex daily totals");
  checkSafeInteger(own(totals, "totalTokens"), "codex daily totals.totalTokens");

  // codexDaily() discards `rows` entirely — codex.ts:457 destructures only { grand, grandTok } —
  // so nothing here is consumed. Validating it can only produce false positives, never
  // catch a real defect. The safe-integer sweep is kept because it predates T-006
  // (ALLOWLIST 7) and cannot reject a value JSON.parse could represent faithfully.
  const rows = own(root, "daily");
  if (!Array.isArray(rows)) return;
  rows.forEach((row, i) => {
    if (!isPlainObject(row)) return;
    const where = `codex daily[${i}]`;
    // `checkCounters` alone — it iterates CLAUDE_TOKEN_FIELDS, whose FIRST entry is
    // `totalTokens`, and emits the identical `${where}.totalTokens` path. The explicit
    // `checkSafeInteger(row.totalTokens, …)` that used to sit here was therefore fully
    // subsumed: deleting it changed no behaviour and no message, which is exactly why it
    // survived mutation against both suites while appearing to be a load-bearing guard
    // (code review R7). Same subsumption R4 found in checkCodexModels' null branch.
    checkCounters(row, where);
    checkCodexModels(own(row, "models"), where, false);
  });
}

/**
 * Codex `models` map, shared by session and daily rows.
 *
 * On a SESSION this map is consumed and its absence is silent: `codex.ts:162` treats a
 * non-object `models` as "no models" and every token lands in `unclassified` with no error,
 * so presence is required there. On a DAILY row nothing is consumed at all, so `required`
 * is false and this only sanity-checks what is present.
 *
 * An EMPTY map is always valid — that is the unclassified-token bucket the fixtures use.
 *
 * Per-model `totalTokens` goes through `cnum(pyGet(m, "totalTokens", 0), …)` (codex.ts:168),
 * so an ABSENT OWN KEY is silently zeroed (additive to require) while a wrong type — and,
 * since R5, an explicit `null` — already raises cnum's byte-frozen text (which must not be
 * shadowed). Hence own-key-presence only, plus the safe-integer bound cnum lacks.
 */
function checkCodexModels(models: unknown, where: string, required: boolean): void {
  // One branch, not two: `undefined` and `null` both already fail `isPlainObject`, so the
  // separate null-check was fully subsumed and emitted the identical message (R4).
  if (!isPlainObject(models)) {
    if (required) {
      fail(`${where}.models is ${pyRepr(models)} (expected an object) — the ccusage schema may have changed`);
    }
    return;
  }
  rejectIntegerLikeKeys(models, `${where}.models`);
  for (const [name, m] of Object.entries(models)) {
    if (!isPlainObject(m)) continue; // codex.ts:164 skips these; cnum never sees them
    // Presence is required only where the map is CONSUMED. On a codex daily row nothing is
    // read at all (codex.ts:457 discards `rows`), so demanding `totalTokens` there validates
    // dead data and can only ever produce a false positive — the exact thing the surrounding
    // rule forbids. It ran unconditionally until code review R5.
    if (required) requirePresent(m, "totalTokens", `${where}.models.${name}`);
    checkSafeInteger(own(m, "totalTokens"), `${where}.models.${name}.totalTokens`);
  }
}

/**
 * Validate a `codex session` payload.
 *
 * Deliberately THIN, and that is the point (code review R2). Everything this reads flows
 * into `cnum` (codex.ts:144-145, 176-177) or into codex.ts's own `sessionFile` guard, all of
 * which already fail loud on absence AND wrong type with text that is BYTE-FROZEN
 * (ALLOWLIST entry 2; golden `codex_bad_cost`). An earlier version re-checked those fields
 * here, which ran FIRST (ccusage.ts:100, before codex.ts ever sees the payload) and replaced
 * the frozen message with this module's wording — breaking a stored golden. So the rule is:
 *
 *   validate only what the downstream would otherwise accept SILENTLY.
 *
 * What survives is exactly what cnum cannot express: the safe-integer bound (cnum accepts
 * 2^53+1, already rounded by JSON.parse — ALLOWLIST 7), the `models` map whose absence is
 * silently bucketed as unclassified, and `directory`'s type, which codex.ts quietly coerces
 * to null.
 *
 * `directory` is OPTIONAL AND NULLABLE: it holds a DATE directory (`'2026/07/09'`), not a
 * cwd, and the fixtures include a session with `directory: None` that exercises codex.ts's
 * filename-date fallback. Requiring it would break parity rather than detect drift.
 */
export function validateCodexSessions(d: unknown): void {
  // Deliberately NO requireRoot (code review R3). Both shapes it would reject are already
  // frozen on this path:
  //   - a non-object root      -> codex.ts:138 / usage.py:237 raise "missing 'sessions' list"
  //   - absent/malformed totals -> usage.py:239 substitutes {}, then usage.py:240 calls
  //     cnum(totals.get("costUSD")) -> "totals.costUSD = None (expected a finite
  //     non-negative number)". codex.ts:141-145 mirrors this exactly, with NO `??` fallback.
  // Asserting the root shape here would replace both messages — the same shadowing bug R2
  // caught, surviving in the one place it had not been stripped. (validateCodexDaily DOES
  // keep requireRoot, and correctly so: usage.py:270-271 reads those totals as
  // `totals.get(k, 0)` and codex.ts:199-200 mirrors it with `pyGet(totals, k, 0)`, so a
  // malformed root silently yields zeros there and the guard is genuinely additive.)
  if (!isPlainObject(d)) return;
  const root = d;
  // The safe-integer bound is the one thing cnum cannot express (ALLOWLIST 7).
  const sessionTotals = own(root, "totals");
  if (isPlainObject(sessionTotals)) {
    checkSafeInteger(own(sessionTotals, "totalTokens"), "totals.totalTokens");
  }

  // codex.ts:138 raises its own frozen "missing 'sessions' list"; do not shadow it.
  const sessions = own(root, "sessions");
  if (!Array.isArray(sessions)) return;
  sessions.forEach((s, i) => {
    if (!isPlainObject(s)) return; // codex.ts:151 has its own message for this
    const where = `sessions[${i}]`;
    // See the note on the codex-daily path: `checkCounters` covers `totalTokens` itself,
    // with the same message, so the explicit line here was redundant too (code review R7).
    checkCounters(s, where);

    // Optional AND nullable — see the note above. codex.ts coerces any non-string to null
    // without complaint, so this rejection is genuinely additive. Read through `own()` like
    // every other field: this was the single site the R7 sweep missed (code review R8).
    const directory = own(s, "directory");
    if (directory !== undefined && directory !== null && typeof directory !== "string") {
      fail(`${where}.directory = ${pyRepr(directory)} (expected a string, null, or absent)`);
    }
    checkCodexModels(own(s, "models"), where, true);
  });
}
