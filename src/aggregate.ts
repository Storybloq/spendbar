/**
 * Claude-side aggregation. Ports usage.py's agg_projects, reconcile, cross_check, cnum.
 *
 * Summation order is load-bearing: reconcile() compares our per-project sum against
 * ccusage's own grand total with a one-cent tolerance, and float addition is not
 * associative. Python iterates dicts in insertion order, so every accumulator here is a
 * Map (a plain object would reorder canonical-integer keys — rejected upstream in json.ts,
 * but Map removes the hazard entirely).
 */
import { UsageError } from "./errors.js";
import { pyRepr } from "./pyrepr.js";
import { cleanName, modelFamily } from "./config.js";
import { money, pyFixed } from "./format.js";
import type { Ctx } from "./context.js";

export interface ProjectAgg {
  tokens: number;
  cost: number;
  byModel: Map<string, number>;
  byCost: Map<string, number>;
  first: string;
  last: string;
}

export interface DayRow {
  period: string;
  totalCost: number;
  totalTokens: number;
  modelBreakdowns: ModelBreakdown[];
}

export interface ModelBreakdown {
  modelName: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Validate a numeric ccusage field: a real finite non-negative number.
 * Booleans are excluded explicitly — in Python `bool` is an `int` subclass so JSON
 * true/false would otherwise pass silently; keeping the check here preserves the exact
 * error text and exit path (golden: codex_bad_cost).
 */
export function cnum(v: unknown, field: string): number {
  if (
    typeof v === "boolean" ||
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < 0
  ) {
    throw new UsageError(
      `unexpected ccusage codex output: ${field} = ${pyRepr(v)} (expected a finite non-negative number)`,
    );
  }
  return v;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function tokensOf(mb: Record<string, unknown>): number {
  return (
    num(mb.inputTokens) + num(mb.outputTokens) + num(mb.cacheCreationTokens) + num(mb.cacheReadTokens)
  );
}

/**
 * Per-project aggregation from a `--instances` payload.
 * Returns the aggregate plus ccusage's own grand total for reconciliation.
 */
export function aggProjects(
  ctx: Ctx,
  payload: unknown,
): { agg: Map<string, ProjectAgg>; grand: number } {
  const agg = new Map<string, ProjectAgg>();
  const root = (payload ?? {}) as Record<string, unknown>;
  const projects = (root.projects ?? {}) as Record<string, unknown>;

  for (const [raw, daysRaw] of Object.entries(projects)) {
    const proj = cleanName(raw, ctx);
    if (!Array.isArray(daysRaw)) continue;
    for (const dayRaw of daysRaw) {
      if (dayRaw === null || typeof dayRaw !== "object") continue;
      const day = dayRaw as Record<string, unknown>;
      let a = agg.get(proj);
      if (!a) {
        a = {
          tokens: 0,
          cost: 0,
          byModel: new Map(),
          byCost: new Map(),
          first: "9999-99-99",
          last: "0000-00-00",
        };
        agg.set(proj, a);
      }
      a.tokens += num(day.totalTokens);
      a.cost += num(day.totalCost);
      const date = typeof day.date === "string" ? day.date : "";
      // UNCONDITIONAL, matching `min`/`max` at usage.py:186-187. The `date &&` guard that
      // used to sit here silently skipped an empty date, so Python reported a first-seen of
      // "" where the port reported the next-earliest real date — both exiting 0, different
      // output (code review R6).
      //
      // This became reachable through T-006: R5 relaxed json.ts's `requireString` to accept
      // an empty string (ALLOWLIST 14 — Python renders such a row rather than failing), so
      // a payload the validator previously rejected now flows through to here. The guard
      // was masking a real divergence rather than preventing one.
      if (date < a.first) a.first = date;
      if (date > a.last) a.last = date;

      const mbs = Array.isArray(day.modelBreakdowns) ? day.modelBreakdowns : [];
      for (const mbRaw of mbs) {
        if (mbRaw === null || typeof mbRaw !== "object") continue;
        const mb = mbRaw as Record<string, unknown>;
        const fam = modelFamily(typeof mb.modelName === "string" ? mb.modelName : "");
        a.byModel.set(fam, (a.byModel.get(fam) ?? 0) + tokensOf(mb));
        a.byCost.set(fam, (a.byCost.get(fam) ?? 0) + num(mb.cost));
      }
    }
  }

  const totals = (root.totals ?? {}) as Record<string, unknown>;
  return { agg, grand: num(totals.totalCost) };
}

/**
 * Assert our per-project cost sum matches ccusage's own grand total.
 *
 * This proves the grouping conserves total cost; it does NOT prove the per-project or
 * per-model split is correct (ccusage's total is itself that same sum). One-cent
 * tolerance: the two sides sum the same values in different orders, so exact rounded-cent
 * equality can differ by float noise. A real gap (dropped project, corrupted total) is
 * dollars, not sub-cent.
 */
export function reconcile(projectSum: number, grand: number): string {
  const diff = projectSum - grand;
  const ok = Math.abs(diff) < 0.01;
  if (ok) return "[totals reconcile: OK]";
  return `[totals reconcile: MISMATCH ${money(projectSum)} vs ccusage ${money(grand)} (Δ $${signed2(diff)})]`;
}

/**
 * Codex sessions are attributed by START date (rollout filename); ccusage `codex daily`
 * buckets by real calendar day. This is NOT a conservation check like reconcile() — it is
 * an honest residual between two different date bases (multi-day sessions lump on their
 * start day, edge-crossing sessions count whole or not at all).
 */
export function crossCheck(sessSum: number, dailyTotal: number): string {
  const diff = sessSum - dailyTotal;
  return `[session-start ${money(sessSum)} vs codex daily ${money(dailyTotal)} (Δ $${signed2(diff)})]`;
}

/** Python `f"{diff:+.2f}"` — sign always shown, exact-binary half-even. */
function signed2(x: number): string {
  return pyFixed(x, 2, { sign: true });
}
