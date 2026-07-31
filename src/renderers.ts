/**
 * The nine subcommand renderers. Ports usage.py's `cmd_*` functions.
 *
 * Every renderer RETURNS its text rather than printing it, so the same code serves the CLI,
 * the MCP server and the menubar UI. The CLI boundary in `io.ts` owns the writing.
 *
 * Two rules that decide byte-parity, and are easy to violate without noticing:
 *
 *  - **Cell formatting is transcribed, never re-derived.** Every `f"{x:>9,.2f}"` becomes
 *    `num(x, 9, 2, {grouping: true})`; there is no `toFixed` anywhere in this file, because
 *    both `toFixed` and `Intl.NumberFormat` are measurably not CPython's rounding.
 *  - **Summation order is load-bearing.** `reconcile` compares our per-project sum against
 *    ccusage's own grand total with a one-cent tolerance, and float addition is not
 *    associative, so totals are accumulated in the aggregator's insertion order.
 *
 * Product-name spans go through `render.prog` (plan section 9). A blanket
 * `s/usage/spendbar/` over rendered output would corrupt ordinary English like
 * "Per-project usage", so the substitution is per-span and explicit.
 */
import {
  aggProjects, crossCheck, reconcile,
  type DayRow, type ModelBreakdown, type ProjectAgg,
} from "./aggregate.js";
import { blocks as blocksRaw, dailyAll, instances } from "./ccusage.js";
import { aggCodex } from "./codex.js";
import { cleanName, modelFamily } from "./config.js";
import { UsageError } from "./errors.js";
import { pyRepr } from "./pyrepr.js";
import type { Ctx } from "./context.js";
import { iso, normDate, pyDateFromIsoFormat, toLocal, windowLabel } from "./dates.js";
import { fmt, money, num, padLeft, padRight, pct, pyFixed, pyLen, pyTruthy } from "./format.js";
import type { RenderContext } from "./main.js";
import { pyMaxStr, pyMinStr, pySorted } from "./pysort.js";
import { renderTable } from "./table.js";
import { scanTranscripts } from "./transcripts.js";

/** The parsed options a renderer reads. Populated by the parser; all optional. */
export interface RenderArgs {
  since?: string | null;
  until?: string | null;
  vs?: string | null;
  date?: string | null;
  day1?: string | null;
  day2?: string | null;
  metric?: "tokens" | "cost" | "both";
}

/** usage.py's `no_data`. One line, and the command still exits 0. */
export function noData(label: string): string {
  return `No usage found for ${label}.\n`;
}

/**
 * `sum(...)` over an aggregator's values, in insertion order.
 *
 * Spelled out rather than inlined so every renderer's total is accumulated the same way:
 * reordering these additions changes the last cent, and `reconcile`'s tolerance is what
 * turns that into a visible MISMATCH line rather than a rounding curiosity.
 */
function sumBy<T>(values: Iterable<T>, of: (v: T) => number): number {
  let total = 0;
  for (const v of values) total += of(v);
  return total;
}

/**
 * Python's `str.title()` for the family names — "fable" -> "Fable", "gpt" -> "Gpt".
 *
 * Only ever applied to the two hard-coded family lists below, which are lowercase ASCII, so
 * the full Unicode title-casing algorithm is not needed and is deliberately not implemented:
 * a general `.title()` differs between the two languages on non-ASCII input, and pretending
 * otherwise would be a divergence waiting for someone to add a family name with an accent.
 */
function title(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** usage.py:416 — the Claude-only families the per-project columns show. */
const PROJ_FAMS = ["fable", "opus", "sonnet", "haiku"] as const;
/** The per-day families, which DO include gpt. */
const DAILY_FAMS = ["fable", "opus", "sonnet", "haiku", "gpt"] as const;

/** `dict.get(key, 0)` over a Map. */
const at = (m: Map<string, number>, k: string): number => m.get(k) ?? 0;

/** usage.py's `_projects_table`: one of the two per-project views over one aggregation. */
function projectsTable(
  agg: Map<string, ProjectAgg>,
  tot: number,
  metric: "tokens" | "cost",
): string {
  const fams = PROJ_FAMS;
  const hdr =
    metric === "tokens"
      ? `${padRight("Project", 22)} ${padLeft("Tokens", 15)} ` +
        fams.map((f) => padLeft(title(f), 13)).join(" ") +
        ` ${padLeft("Cost", 11)} ${padLeft("Fable$", 10)}`
      : `${padRight("Project", 22)} ${padLeft("Cost", 12)} ` +
        fams.map((f) => padLeft(`${title(f)}$`, 12)).join(" ");

  const csum = new Map<string, number>();
  const lines: string[] = [];
  for (const [p, v] of pySorted([...agg.entries()], { kind: "numeric", key: ([, x]) => -x.cost })) {
    // Accumulated inside the row loop, in sorted order, exactly as Python does — the column
    // total is a float sum and its order is part of the output.
    for (const f of fams) csum.set(f, at(csum, f) + at(v.byCost, f));
    if (metric === "tokens") {
      lines.push(
        `${padRight(p, 22)} ${padLeft(fmt(v.tokens), 15)} ` +
          fams.map((f) => padLeft(fmt(at(v.byModel, f)), 13)).join(" ") +
          ` ${padLeft(money(v.cost), 11)} ${padLeft(money(at(v.byCost, "fable")), 10)}`,
      );
    } else {
      lines.push(
        `${padRight(p, 22)} ${padLeft(money(v.cost), 12)} ` +
          fams.map((f) => padLeft(money(at(v.byCost, f)), 12)).join(" "),
      );
    }
  }

  const total =
    metric === "tokens"
      ? `${padRight("TOTAL", 22)} ${padLeft("", 15)} ` +
        fams.map(() => padLeft("", 13)).join(" ") +
        ` ${padLeft(money(tot), 11)} ${padLeft(money(at(csum, "fable")), 10)}`
      : `${padRight("TOTAL", 22)} ${padLeft(money(tot), 12)} ` +
        fams.map((f) => padLeft(money(at(csum, f)), 12)).join(" ");

  return renderTable(hdr, lines, { total });
}

export function cmdProjects(ctx: Ctx, args: RenderArgs): string {
  const sinceKey = normDate(args.since, ctx.deps);
  const untilKey = normDate(args.until, ctx.deps);
  const { agg, grand } = aggProjects(ctx, instances(ctx, sinceKey, untilKey));
  if (agg.size === 0) return noData(windowLabel(args.since, args.until, ctx.deps));

  const values = [...agg.values()];
  const tot = sumBy(values, (v) => v.cost);
  const metric = args.metric ?? "tokens";

  let out = `Per-project usage ${windowLabel(args.since, args.until, ctx.deps)}   ${reconcile(tot, grand)}\n\n`;
  if (metric === "tokens" || metric === "both") out += projectsTable(agg, tot, "tokens");
  if (metric === "both") out += "\n";
  if (metric === "cost" || metric === "both") out += projectsTable(agg, tot, "cost");

  // gpt/other spend is absent from the Claude-only columns; surfaced once, not per table.
  // Both thresholds are Python's: a relative 0.5% AND an absolute cent, so a rounding
  // artefact on a tiny window cannot produce the note.
  const shown = sumBy(values, (v) => sumBy(PROJ_FAMS, (f) => at(v.byCost, f)));
  const hidden = tot - shown;
  if (hidden > 0.005 * tot && hidden > 0.01) {
    out +=
      `\nnote: ${money(hidden)} (${num(pct(hidden, tot), 0, 0)}%) is gpt/other spend ` +
      `not shown in the model columns above.\n`;
  }
  return out;
}

/** usage.py's `_daily_table`. */
function dailyTable(rows: readonly DayRow[], metric: "tokens" | "cost"): string {
  const fams = DAILY_FAMS;
  const hdr =
    metric === "cost"
      ? `${padRight("Date", 12)} ${padLeft("Cost", 11)} ${padLeft("Tokens", 15)} | ` +
        fams.map((f) => padLeft(`${title(f)}$`, 9)).join(" ")
      : `${padRight("Date", 12)} ${padLeft("Tokens", 15)} | ` +
        fams.map((f) => padLeft(title(f), 15)).join(" ");

  const csum = new Map<string, number>();
  const tsum = new Map<string, number>();
  let totCost = 0;
  let totTok = 0;
  const lines: string[] = [];

  for (const r of rows) {
    const fc = new Map<string, number>();
    const ft = new Map<string, number>();
    for (const mb of r.modelBreakdowns) {
      const fam = modelFamily(mb.modelName);
      fc.set(fam, at(fc, fam) + mb.cost);
      csum.set(fam, at(csum, fam) + mb.cost);
      const tk = mb.inputTokens + mb.outputTokens + mb.cacheCreationTokens + mb.cacheReadTokens;
      ft.set(fam, at(ft, fam) + tk);
      tsum.set(fam, at(tsum, fam) + tk);
    }
    totCost += r.totalCost;
    totTok += r.totalTokens;
    lines.push(
      metric === "cost"
        ? `${padRight(r.period, 12)} ${padLeft(money(r.totalCost), 11)} ${padLeft(fmt(r.totalTokens), 15)} | ` +
          fams.map((f) => num(at(fc, f), 9, 2, { grouping: true })).join(" ")
        : `${padRight(r.period, 12)} ${padLeft(fmt(r.totalTokens), 15)} | ` +
          fams.map((f) => padLeft(fmt(at(ft, f)), 15)).join(" "),
    );
  }

  const total =
    metric === "cost"
      ? `${padRight("TOTAL", 12)} ${padLeft(money(totCost), 11)} ${padLeft("", 15)} | ` +
        fams.map((f) => num(at(csum, f), 9, 2, { grouping: true })).join(" ")
      : `${padRight("TOTAL", 12)} ${padLeft(fmt(totTok), 15)} | ` +
        fams.map((f) => padLeft(fmt(at(tsum, f)), 15)).join(" ");

  return renderTable(hdr, lines, { total });
}

export function cmdDaily(ctx: Ctx, args: RenderArgs): string {
  const sinceKey = normDate(args.since, ctx.deps);
  const untilKey = normDate(args.until, ctx.deps);
  // The GENERIC `daily`, not `claude daily`: this view includes Codex/GPT spend.
  const d = dailyAll(ctx, sinceKey, untilKey) as { daily?: DayRow[]; totals?: { totalCost?: number } };
  const rows = d.daily ?? [];
  if (rows.length === 0) return noData(windowLabel(args.since, args.until, ctx.deps));

  const metric = args.metric ?? "cost";
  const tot = sumBy(rows, (r) => r.totalCost);

  let out = `Per-day ${windowLabel(args.since, args.until, ctx.deps)}   ${reconcile(tot, d.totals?.totalCost ?? 0)}\n\n`;
  if (metric === "tokens" || metric === "both") out += dailyTable(rows, "tokens");
  if (metric === "both") out += "\n";
  if (metric === "cost" || metric === "both") out += dailyTable(rows, "cost");
  return out;
}

export function cmdShare(ctx: Ctx, args: RenderArgs): string {
  const { agg: agg1, grand: grand1 } = aggProjects(
    ctx,
    instances(ctx, normDate(args.since, ctx.deps), normDate(args.until, ctx.deps)),
  );
  const tot1 = sumBy(agg1.values(), (v) => v.cost);

  // `a.vs is not None` — an EMPTY --vs is a supplied value, so the two-window form is
  // selected by presence, not truthiness.
  const twowin = args.vs !== null && args.vs !== undefined;
  const agg2 = twowin
    ? aggProjects(ctx, instances(ctx, normDate(args.vs, ctx.deps), null))
    : { agg: new Map<string, ProjectAgg>(), grand: 0 };
  const tot2 = sumBy(agg2.agg.values(), (v) => v.cost);

  if (agg1.size === 0 && !(twowin && agg2.agg.size > 0)) {
    return noData(windowLabel(args.since, args.until, ctx.deps));
  }

  const costOf = (m: Map<string, ProjectAgg>, p: string): number => m.get(p)?.cost ?? 0;
  const projs = [...new Set([...agg1.keys(), ...(twowin ? agg2.agg.keys() : [])])];
  // usage.py:526 sorts a SET, so tied costs fall back to hash-based iteration order — Python
  // is nondeterministic here, not merely different from JS. The project name is appended as
  // an explicit tiebreak so this port has ONE defined order (plan section 12, ALLOWLIST 21).
  const order = pySorted(projs, {
    kind: "tuple",
    key: (p) => [-(twowin && agg2.agg.has(p) ? costOf(agg2.agg, p) : costOf(agg1, p)), p],
  });

  let line = `Project share  A=${windowLabel(args.since, args.until, ctx.deps)}`;
  if (twowin) line += `   B=(since ${args.vs})`;
  line += `   A:${reconcile(tot1, grand1)}`;
  if (twowin) line += `   B:${reconcile(tot2, agg2.grand)}`;

  const hdr = twowin
    ? `${padRight("Project", 22)} ${padLeft("A $", 11)} ${padLeft("A %", 7)} | ${padLeft("B $", 11)} ${padLeft("B %", 7)}`
    : `${padRight("Project", 22)} ${padLeft("Cost", 11)} ${padLeft("Share", 7)}`;

  const lines = order.map((p) => {
    const c1 = costOf(agg1, p);
    if (!twowin) return `${padRight(p, 22)} ${padLeft(money(c1), 11)} ${num(pct(c1, tot1), 6, 1)}%`;
    const c2 = costOf(agg2.agg, p);
    return (
      `${padRight(p, 22)} ${padLeft(money(c1), 11)} ${num(pct(c1, tot1), 6, 1)}% | ` +
      `${padLeft(money(c2), 11)} ${num(pct(c2, tot2), 6, 1)}%`
    );
  });

  const total = twowin
    ? `${padRight("TOTAL", 22)} ${padLeft(money(tot1), 11)} ${padLeft("100.0%", 7)} | ${padLeft(money(tot2), 11)} ${padLeft("100.0%", 7)}`
    : `${padRight("TOTAL", 22)} ${padLeft(money(tot1), 11)} ${padLeft("100.0%", 7)}`;

  return `${line}\n\n` + renderTable(hdr, lines, { total });
}

/**
 * A row of the `instances` payload, which is keyed by `date` — NOT `DayRow`, whose `period`
 * is the generic `daily` shape. The two payloads are different ccusage subcommands and
 * conflating them is how a renderer silently reads `undefined` for every row.
 */
interface InstanceDay {
  date: string;
  totalCost: number;
  totalTokens: number;
  modelBreakdowns: ModelBreakdown[];
}

interface ComparePair {
  c1: number;
  c2: number;
  f2: number;
  o2: number;
}

export function cmdCompare(ctx: Ctx, args: RenderArgs): string {
  const d1 = normDate(args.day1, ctx.deps) as string;
  const d2 = normDate(args.day2, ctx.deps) as string;
  const iso1 = `${d1.slice(0, 4)}-${d1.slice(4, 6)}-${d1.slice(6)}`;
  const iso2 = `${d2.slice(0, 4)}-${d2.slice(4, 6)}-${d2.slice(6)}`;

  // min/max over the two YYYYMMDD keys, so the window covers them whichever order they came
  // in. String comparison, therefore code-point ordering (ISS-012).
  const payload = instances(ctx, pyMinStr(d1, d2), pyMaxStr(d1, d2)) as {
    projects?: Record<string, InstanceDay[]>;
  };

  const by = new Map<string, ComparePair>();
  for (const [raw, days] of Object.entries(payload.projects ?? {})) {
    const p = cleanName(raw, ctx);
    for (const day of days) {
      if (day.date !== iso1 && day.date !== iso2) continue;
      let v = by.get(p);
      if (!v) {
        v = { c1: 0, c2: 0, f2: 0, o2: 0 };
        by.set(p, v);
      }
      // When --day1 and --day2 name the SAME day, Python's per-project dict has one key, so
      // both accumulators are the same slot and the totals double. Adding to `c1` and `c2`
      // separately would silently halve it, so the equal case writes to both.
      const isDay1 = day.date === iso1;
      if (isDay1) v.c1 += day.totalCost;
      if (day.date === iso2) v.c2 += day.totalCost;
      const suffix2 = isDay1 && iso1 === iso2 ? true : day.date === iso2;
      for (const mb of day.modelBreakdowns) {
        const fam = modelFamily(mb.modelName);
        if (!suffix2) continue;
        if (fam === "fable") v.f2 += mb.cost;
        else if (fam === "opus") v.o2 += mb.cost;
      }
    }
  }
  if (by.size === 0) return noData(`${iso1} / ${iso2}`);

  const t1 = sumBy(by.values(), (v) => v.c1);
  const t2 = sumBy(by.values(), (v) => v.c2);
  const mmdd = iso2.slice(5);

  const hdr =
    `${padRight("Project", 22)} ${padLeft(iso1, 11)} ${padLeft(iso2, 11)} ${padLeft("ΔCost", 10)} | ` +
    `${padLeft(`Fab$ ${mmdd}`, 9)} ${padLeft(`Opus$ ${mmdd}`, 10)}`;

  const lines = pySorted([...by.entries()], { kind: "numeric", key: ([, v]) => -v.c2 }).map(
    ([p, v]) =>
      `${padRight(p, 22)} ${padLeft(money(v.c1), 11)} ${padLeft(money(v.c2), 11)} ` +
      `${num(v.c2 - v.c1, 10, 2, { grouping: true, sign: true })} | ` +
      `${num(v.f2, 9, 2, { grouping: true })} ${num(v.o2, 10, 2, { grouping: true })}`,
  );

  const total =
    `${padRight("TOTAL", 22)} ${padLeft(money(t1), 11)} ${padLeft(money(t2), 11)} ` +
    `${num(t2 - t1, 10, 2, { grouping: true, sign: true })}`;

  return `Compare ${iso1} vs ${iso2}\n\n` + renderTable(hdr, lines, { total });
}

export function cmdBlocks(ctx: Ctx, args: RenderArgs): string {
  const payload = blocksRaw(ctx, normDate(args.since, ctx.deps));
  // `d.get("blocks", d)` — a payload with no "blocks" key is iterated as-is. ISS-002 leaves
  // this unvalidated; the port reproduces the fallback rather than tightening it, so a
  // malformed payload behaves exactly as it does today.
  // `d.get("blocks", d)` selects by key PRESENCE, then Python iterates whatever it got.
  // Reproducing that iteration matters (code review R1): a present `"blocks": null` is a
  // `TypeError: 'NoneType' object is not iterable` in the oracle, where coercing to `[]`
  // renders an empty table and exits 0. A dict, by contrast, iterates its KEYS — which are
  // strings, so usage.py's `isinstance(b, dict)` guard skips them all and the run succeeds.
  // Measured all four shapes; only null diverged.
  // usage.py:582 calls `d.get(...)` on the payload directly, so a payload that is not a dict
  // raises AttributeError BEFORE the header is printed — measured: exit 1 with ZERO bytes of
  // stdout for a top-level JSON array, where the port previously rendered a full table.
  // Found by probing the payload shape space during review rather than from the diff.
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new UsageError(`${pyRepr(payload)} object has no attribute 'get'`);
  }
  const rawPayload = payload as Record<string, unknown>;
  const selected = Object.hasOwn(rawPayload, "blocks") ? rawPayload.blocks : rawPayload;
  let blocks: unknown[];
  if (Array.isArray(selected)) blocks = selected;
  else if (typeof selected === "string") blocks = [...selected];
  else if (selected !== null && typeof selected === "object") blocks = Object.keys(selected);
  else throw new UsageError(`${pyRepr(selected)} object is not iterable`);

  const hdr =
    `${padRight("Start (local)", 20)} ${padRight("End (local)", 20)} ${padLeft("Dur", 6)} ` +
    `${padLeft("Cost", 10)} ${padLeft("$/hr", 9)} ${padLeft("active", 7)}`;

  const lines: string[] = [];
  for (const bRaw of blocks) {
    if (bRaw === null || typeof bRaw !== "object" || Array.isArray(bRaw)) continue;
    const b = bRaw as Record<string, unknown>;
    // Python truthiness: `isGap: {}` is FALSY, so the row is PROCESSED, not skipped.
    if (pyTruthy(b.isGap)) continue;
    const start = b.startTime as string | undefined;
    // `a or b` likewise falls through on any falsy `a`, including `""`.
    const end = (pyTruthy(b.actualEndTime) ? b.actualEndTime : b.endTime) as string | undefined;
    // `b.get("costUSD", b.get("totalCost", 0))` — the key's PRESENCE decides, so an explicit
    // costUSD of 0 wins over a totalCost, where a truthiness test would fall through.
    const cost = numberish("costUSD" in b ? b.costUSD : ("totalCost" in b ? b.totalCost : 0));
    const hrs = start && end ? (iso(end).getTime() - iso(start).getTime()) / 3_600_000 : 0;
    const rate = hrs ? cost / hrs : 0;
    lines.push(
      `${padRight(toLocal(start), 20)} ${padRight(toLocal(end), 20)} ${num(hrs, 5, 1)}h ` +
        `${padLeft(money(cost), 10)} ${num(rate, 8, 0, { grouping: true })} ${padLeft(pyStr(Object.hasOwn(b, "isActive") ? b.isActive : ""), 7)}`,
    );
  }

  let out =
    "Billing blocks (5h windows) — times shown in local tz\n\n" +
    renderTable(hdr, lines, { bottomRule: false });
  if (lines.length === 0) out += "(no billing blocks in this window)\n";
  return out;
}

/** Python's `str(x)` for the values `isActive` can hold: a bool, or the "" default. */
function pyStr(v: unknown): string {
  if (v === true) return "True";
  if (v === false) return "False";
  // `b.get("isActive", "")` returns None for a present JSON null, and `str(None)` is "None".
  // `?? ""` would render it as the ABSENT case instead.
  if (v === null) return "None";
  return String(v);
}

/**
 * `blocks`'s cost field, with Python's arithmetic semantics.
 *
 * An ABSENT key legitimately yields 0 — that is `b.get("costUSD", b.get("totalCost", 0))`.
 * A present value is a different matter: usage.py goes straight on to divide it and format
 * it, so a string, null, list or dict raises `TypeError` there and the run dies. Returning 0
 * for those would be the worst available outcome — the port would render `$0.00` and exit 0
 * where the oracle exits 1, turning a loud failure into a plausible wrong number.
 *
 * `blocks` still has no schema validator (ISS-002) and T-004 does not add one; this only
 * keeps the CLI boundary from CHANGING what malformed data does (plan section 8.5). ALLOWLIST 23
 * records the two remaining deltas: the message text, and the fact that the port emits no
 * partial stdout before failing.
 *
 * Booleans are NOT rejected: Python's bool is an int, so `True / 2.0` is 0.5 rather than an
 * error, and rejecting it here would invent a failure the oracle does not have.
 */
function numberish(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return 0;
  throw new UsageError(
    `unexpected ccusage blocks output: cost field is ${pyRepr(v)}, not a number`,
  );
}

/** Python's `f"session{'s' if n != 1 else ''}"`. */
const plural = (n: number): string => (n === 1 ? "" : "s");

export function cmdCodex(ctx: Ctx, args: RenderArgs): string {
  // Normalize the window ONCE so ccusage's filter and our start-date filter cannot disagree:
  // a relative -Nd re-normalized after local midnight would shift by a day.
  const sinceKey = normDate(args.since, ctx.deps);
  const untilKey = normDate(args.until, ctx.deps);
  const { agg, meta } = aggCodex(ctx, sinceKey, untilKey);
  const label = windowLabel(args.since, args.until, ctx.deps);

  if (agg.size === 0) {
    if (meta.windowed && meta.dailyCost > 0) {
      return (
        `No sessions started in ${label}, but ccusage codex ` +
        `daily reports ${money(meta.dailyCost)} of activity there — it all came from ` +
        `sessions that started earlier (windowed out by start date).\n`
      );
    }
    return noData(label);
  }

  const { tot, totTok } = meta;
  const head = meta.windowed
    ? `[window by session start date]   ${crossCheck(tot, meta.dailyCost)}`
    : `${reconcile(tot, meta.grandAll)}   ${crossCheck(tot, meta.dailyCost)}`;

  let out = `Codex per-project usage ${label}   ${head}\n`;
  let line = `cwd resolved: ${meta.resolved}/${meta.kept} sessions`;
  if (meta.unkN) {
    line += `; unknown: ${money(meta.unkCost)} (${meta.unkN} session${plural(meta.unkN)})`;
  }
  out += `${line}\n\n`;

  const hdr =
    `${padRight("Project", 22)} ${padLeft("Cost", 11)} ${padLeft("Tokens", 15)} ` +
    `${padLeft("Sess", 5)} ${padLeft("Share", 7)}`;
  const rows = pySorted([...agg.entries()], { kind: "numeric", key: ([, v]) => -v.cost }).map(
    ([p, v]) =>
      `${padRight(p, 22)} ${padLeft(money(v.cost), 11)} ${padLeft(fmt(v.tokens), 15)} ` +
      `${padLeft(String(v.sessions), 5)} ${num(pct(v.cost, tot), 6, 1)}%`,
  );
  const total =
    `${padRight("TOTAL", 22)} ${padLeft(money(tot), 11)} ${padLeft(fmt(totTok), 15)} ` +
    `${padLeft(String(sumBy(agg.values(), (v) => v.sessions)), 5)} ${padLeft("100.0%", 7)}`;
  out += renderTable(hdr, rows, { total });

  const mtok = meta.mtok;
  const modelSum = sumBy(mtok.values(), (t) => t);
  if (modelSum > totTok) {
    out +=
      `\nnote: per-model tokens (${fmt(modelSum)}) exceed the session total ` +
      `(${fmt(totTok)}) — model footer omitted.\n`;
  } else {
    // Python MUTATES mtok here, so the remainder becomes a real entry and participates in the
    // sort below. Truthiness, not presence: a zero remainder adds no row.
    if (totTok - modelSum) mtok.set("unclassified", totTok - modelSum);
    if (mtok.size > 0) {
      const parts = pySorted([...mtok.entries()], { kind: "numeric", key: ([, t]) => -t }).map(
        ([m2, t]) => `${m2}=${fmt(t)}`,
      );
      out += `\nmodel tokens: ${parts.join("  ")}\n`;
    }
  }

  if (totTok !== meta.dailyTok) {
    out += `note: token sum ${fmt(totTok)} differs from codex daily total ${fmt(meta.dailyTok)}.\n`;
  }
  if (meta.undatedN) {
    out +=
      `note: ${money(meta.undatedCost)} from ${meta.undatedN} session(s) with an unparseable ` +
      `rollout filename could not be date-windowed and were excluded.\n`;
  }
  if (meta.windowed) {
    out +=
      "Δ vs codex daily is the date-basis residual: multi-day sessions lump on their start " +
      "day, sessions crossing the window edge count whole (tail) or not at all (head).\n";
  }
  return out;
}

export function cmdCombined(ctx: Ctx, args: RenderArgs): string {
  // Normalized once, then the SAME keys feed both aggregators.
  const sinceKey = normDate(args.since, ctx.deps);
  const untilKey = normDate(args.until, ctx.deps);
  const { agg: aggC, grand: claudeGrand } = aggProjects(ctx, instances(ctx, sinceKey, untilKey));
  const { agg: aggX, meta } = aggCodex(ctx, sinceKey, untilKey);
  if (aggC.size === 0 && aggX.size === 0) {
    return noData(windowLabel(args.since, args.until, ctx.deps));
  }

  // Keys align because both sides go through cleanName.
  const claude = new Map([...aggC].map(([p, v]) => [p, v.cost]));
  const codex = new Map([...aggX].map(([p, v]) => [p, v.cost]));
  const totC = sumBy(claude.values(), (c) => c);
  const totX = sumBy(codex.values(), (c) => c);
  const tot = totC + totX;

  // usage.py:684 sorts over a SET, so ties fall back to hash order — nondeterministic in
  // Python itself. Project name is the explicit tiebreak (plan section 12, ALLOWLIST 21).
  const rowsData = pySorted(
    [...new Set([...claude.keys(), ...codex.keys()])].map(
      (p) => [p, claude.get(p) ?? 0, codex.get(p) ?? 0] as const,
    ),
    { kind: "tuple", key: (r) => [-(r[1] + r[2]), r[0]] },
  );

  let out = `Combined per-project usage ${windowLabel(args.since, args.until, ctx.deps)}\n`;
  out += `Claude: ${reconcile(totC, claudeGrand)}    Codex: ${crossCheck(totX, meta.dailyCost)}\n`;
  out +=
    "caveat: Claude buckets by calendar day, Codex by session start date — Total is " +
    "approximate at window edges and for multi-day sessions.\n";
  if (meta.unkN) {
    out +=
      `note: ${money(meta.unkCost)} of Codex is unattributed (${meta.unkN} ` +
      `session${plural(meta.unkN)} with no resolvable log).\n`;
  }
  if (meta.undatedN) {
    out +=
      `note: ${money(meta.undatedCost)} of Codex from ${meta.undatedN} undated ` +
      `session(s) was excluded from the window.\n`;
  }
  out += "\n";

  const hdr =
    `${padRight("Project", 22)} ${padLeft("Claude$", 12)} ${padLeft("Codex$", 12)} ` +
    `${padLeft("Total$", 12)} ${padLeft("Share", 7)}`;
  const rows = rowsData.map(
    ([p, c, x]) =>
      `${padRight(p, 22)} ${padLeft(money(c), 12)} ${padLeft(money(x), 12)} ` +
      `${padLeft(money(c + x), 12)} ${num(pct(c + x, tot), 6, 1)}%`,
  );
  const total =
    `${padRight("TOTAL", 22)} ${padLeft(money(totC), 12)} ${padLeft(money(totX), 12)} ` +
    `${padLeft(money(tot), 12)} ${padLeft("100.0%", 7)}`;

  return out + renderTable(hdr, rows, { total });
}

export function cmdAlltime(ctx: Ctx, render: RenderContext): string {
  const { agg, grand } = aggProjects(ctx, instances(ctx, null, null));
  if (agg.size === 0) return noData("all time");

  const values = [...agg.values()];
  const tot = sumBy(values, (v) => v.cost);

  // `min`/`max` over strings: code-point ordering, not UTF-16 (ISS-012). These are the two
  // call sites at usage.py:186-187's sibling, and dates arrive as whatever the payload held.
  const first = values.map((v) => v.first).reduce(pyMinStr);
  const last = values.map((v) => v.last).reduce(pyMaxStr);

  const head =
    `All-time per-project cost   range ${first} -> ${last}\n` +
    // The one product-name span in this renderer (plan section 9, source 2).
    `${reconcile(tot, grand)}   (Claude Code only — Codex/GPT excluded; see '${render.prog} codex')\n` +
    // The Python f-string ends in "\n" and `print` adds another: two newlines, not one.
    `\n`;

  const hdr =
    `${padRight("Project", 22)} ${padLeft("First", 11)} ${padLeft("Last", 11)} ` +
    `${padLeft("Cost", 12)} ${padLeft("Share", 7)}`;

  const rows = pySorted([...agg.entries()], { kind: "numeric", key: ([, v]) => -v.cost }).map(
    ([p, v]) =>
      `${padRight(p, 22)} ${padLeft(v.first, 11)} ${padLeft(v.last, 11)} ` +
      `${padLeft(money(v.cost), 12)} ${num(pct(v.cost, tot), 6, 1)}%`,
  );

  const total =
    `${padRight("TOTAL", 22)} ${padLeft("", 11)} ${padLeft("", 11)} ` +
    `${padLeft(money(tot), 12)} ${padLeft("100.0%", 7)}`;

  return head + renderTable(hdr, rows, { total });
}

/**
 * usage.py `cmd_hourly` — the half-hour burst finder.
 *
 * The one renderer whose numbers are ESTIMATED rather than reported: ccusage supplies a
 * per-family effective $/token for the day, the raw transcripts supply per-half-hour token
 * counts, and the product of the two is the histogram. Hence the "+-10-15%" disclaimer and
 * the reconciliation against ccusage's own figure in the total row.
 *
 * Two ordering subtleties are load-bearing for byte parity, both float-addition order:
 * the per-bucket cost sums the inner family map in INSERTION order, and `fam_cost.values()`
 * likewise. Sorting either would change the last decimal place on some inputs.
 */
export function cmdHourly(ctx: Ctx, args: RenderArgs): string {
  let date = args.date || todayIso(ctx);
  // `len(date) == 8` is a CODE POINT count, so this fires on 8 astral characters too and
  // then fails the ISO parse below, exactly as the oracle does.
  if (pyLen(date) === 8) {
    const cps = [...date];
    date = `${cps.slice(0, 4).join("")}-${cps.slice(4, 6).join("")}-${cps.slice(6).join("")}`;
  }
  const key = date.replace(/-/g, "");

  // Effective $/token per family for that day, from ccusage.
  const payload = (instances(ctx, key, key) ?? {}) as { projects?: Record<string, InstanceDay[]> };
  const famCost = new Map<string, number>();
  const famTok = new Map<string, number>();
  for (const days of Object.values(payload.projects ?? {})) {
    for (const day of days) {
      if (day.date !== date) continue;
      for (const mb of day.modelBreakdowns) {
        const fam = modelFamily(mb.modelName);
        famCost.set(fam, (famCost.get(fam) ?? 0) + mb.cost);
        famTok.set(
          fam,
          (famTok.get(fam) ?? 0) +
            mb.inputTokens + mb.outputTokens + mb.cacheCreationTokens + mb.cacheReadTokens,
        );
      }
    }
  }
  const rate = new Map<string, number>();
  for (const [f, c] of famCost) {
    const t = famTok.get(f) ?? 0;
    if (t) rate.set(f, c / t); // `if fam_tok[f]` — a zero-token family has no defined rate
  }

  // usage.py:618. Uncaught in the oracle, so it must happen before ANY output (ALLOWLIST 19).
  const targetIso = pyDateFromIsoFormat(date);
  const buckets = scanTranscripts(ctx, date, targetIso);

  let out = `Half-hour cost histogram for ${date} (est. from raw logs; ±10-15%)\n`;
  if (buckets.size === 0) {
    const ccu = sumBy([...famCost.values()], (v) => v);
    out += `No raw session logs found on disk for ${date}`;
    out += ccu
      ? ` (ccusage reports ${money(ccu)} that day — logs may have been rotated).\n`
      : ".\n";
    return out;
  }

  const rates = pySorted([...rate.entries()], { kind: "string", key: ([f]) => f });
  out += `effective $/Mtok: ${rates.map(([f, r]) => `${f}=${pyFixed(r * 1e6, 2)}`).join("  ")}\n\n`;

  const hdr =
    `${padLeft("Local", 7)} ${padLeft("est $", 8)}  ` +
    `${padLeft("fable tok", 13)} ${padLeft("opus tok", 13)}  burst`;
  const lines: string[] = [];
  let tot = 0;
  for (const b of pySorted([...buckets.keys()], { kind: "string", key: (k) => k })) {
    const fams = buckets.get(b) as Map<string, number>;
    let c = 0;
    for (const [f, t] of fams) c += t * (rate.get(f) ?? 0);
    tot += c;
    lines.push(
      `${padLeft(b, 7)} ${num(c, 8, 2, { grouping: true })}  ` +
        `${padLeft(fmt(fams.get("fable") ?? 0), 13)} ${padLeft(fmt(fams.get("opus") ?? 0), 13)}  ` +
        "#".repeat(Math.max(0, Math.trunc(c / 10))),
    );
  }
  const grand = sumBy([...famCost.values()], (v) => v);
  const total = `est total ${money(tot)}  (ccusage says ${money(grand)} for ${date})`;
  return out + renderTable(hdr, lines, { total });
}

/** `datetime.date.today().strftime("%Y-%m-%d")`, from the injected clock. */
function todayIso(ctx: Ctx): string {
  const t = ctx.deps.today(); // YYYYMMDD
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}
