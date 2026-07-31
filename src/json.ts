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

/** Fields that must hold safe integers, per provider payload shape. */
const CLAUDE_TOKEN_FIELDS = [
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
] as const;

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

/** Validate a Claude `--instances` payload in place. */
export function validateInstances(d: unknown): void {
  if (d === null || typeof d !== "object") return;
  const root = d as Record<string, unknown>;
  const projects = root.projects;
  if (projects && typeof projects === "object" && !Array.isArray(projects)) {
    rejectIntegerLikeKeys(projects, "projects");
    for (const [proj, days] of Object.entries(projects as Record<string, unknown>)) {
      if (!Array.isArray(days)) continue;
      for (const day of days) {
        if (day === null || typeof day !== "object") continue;
        const dr = day as Record<string, unknown>;
        checkSafeInteger(dr.totalTokens, `projects.${proj}.totalTokens`);
        const mbs = dr.modelBreakdowns;
        if (!Array.isArray(mbs)) continue;
        for (const mb of mbs) {
          if (mb === null || typeof mb !== "object") continue;
          const m = mb as Record<string, unknown>;
          for (const f of CLAUDE_TOKEN_FIELDS) {
            checkSafeInteger(m[f], `projects.${proj}.modelBreakdowns.${f}`);
          }
        }
      }
    }
  }
  const totals = root.totals;
  if (totals && typeof totals === "object") {
    checkSafeInteger((totals as Record<string, unknown>).totalTokens, "totals.totalTokens");
  }
}

/** Validate a generic `daily` payload (shares the Claude token field shape). */
export function validateDaily(d: unknown): void {
  if (d === null || typeof d !== "object") return;
  const rows = (d as Record<string, unknown>).daily;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      checkSafeInteger(r.totalTokens, "daily.totalTokens");
      const mbs = r.modelBreakdowns;
      if (!Array.isArray(mbs)) continue;
      for (const mb of mbs) {
        if (mb === null || typeof mb !== "object") continue;
        const m = mb as Record<string, unknown>;
        for (const f of CLAUDE_TOKEN_FIELDS) checkSafeInteger(m[f], `daily.modelBreakdowns.${f}`);
      }
    }
  }
  const totals = (d as Record<string, unknown>).totals;
  if (totals && typeof totals === "object") {
    checkSafeInteger((totals as Record<string, unknown>).totalTokens, "totals.totalTokens");
  }
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
  if (d === null || typeof d !== "object") return;
  const rows = (d as Record<string, unknown>).daily;
  if (Array.isArray(rows)) {
    rows.forEach((row, i) => {
      if (row === null || typeof row !== "object") return;
      const r = row as Record<string, unknown>;
      checkSafeInteger(r.totalTokens, `codex daily[${i}].totalTokens`);
      const models = r.models;
      if (models && typeof models === "object" && !Array.isArray(models)) {
        rejectIntegerLikeKeys(models, `codex daily[${i}].models`);
        for (const [name, m] of Object.entries(models as Record<string, unknown>)) {
          if (m === null || typeof m !== "object") continue;
          checkSafeInteger(
            (m as Record<string, unknown>).totalTokens,
            `codex daily[${i}].models.${name}.totalTokens`,
          );
        }
      }
    });
  }
  const totals = (d as Record<string, unknown>).totals;
  if (totals && typeof totals === "object") {
    checkSafeInteger(
      (totals as Record<string, unknown>).totalTokens,
      "codex daily totals.totalTokens",
    );
  }
}

/** Validate a `codex session` payload. */
export function validateCodexSessions(d: unknown): void {
  if (d === null || typeof d !== "object") return;
  const sessions = (d as Record<string, unknown>).sessions;
  if (Array.isArray(sessions)) {
    sessions.forEach((s, i) => {
      if (s === null || typeof s !== "object") return;
      const r = s as Record<string, unknown>;
      checkSafeInteger(r.totalTokens, `sessions[${i}].totalTokens`);
      const models = r.models;
      if (models && typeof models === "object" && !Array.isArray(models)) {
        rejectIntegerLikeKeys(models, `sessions[${i}].models`);
        for (const [name, m] of Object.entries(models as Record<string, unknown>)) {
          if (m === null || typeof m !== "object") continue;
          checkSafeInteger(
            (m as Record<string, unknown>).totalTokens,
            `sessions[${i}].models.${name}.totalTokens`,
          );
        }
      }
    });
  }
  const totals = (d as Record<string, unknown>).totals;
  if (totals && typeof totals === "object") {
    checkSafeInteger((totals as Record<string, unknown>).totalTokens, "totals.totalTokens");
  }
}
