/**
 * Date handling. Ports usage.py's norm_date, in_window, window_label, iso, to_local.
 *
 * Windowing discipline (plan hazard 2): `normDate` is applied ONCE at the CLI boundary and
 * the resulting YYYYMMDD keys are threaded down. Re-normalizing a relative `-Nd` inside an
 * aggregator across local midnight would shift one window by a day.
 */
import { UsageError, ValueError } from "./errors.js";
import { pyRepr } from "./pyrepr.js";
import { isDecimalDigit, decimalValue } from "./unicode-tables.js";
import type { RuntimeDeps } from "./context.js";

/**
 * Accept YYYYMMDD, YYYY-MM-DD, or relative -Nd. Return YYYYMMDD.
 * Mirrors Python: only the digit check is validated; other shapes pass through with
 * dashes stripped (ccusage does its own validation).
 */
export function normDate(s: string | null | undefined, deps: RuntimeDeps): string | null {
  if (s === null || s === undefined) return null;
  if (s.startsWith("-") && s.endsWith("d")) {
    const core = s.slice(1, -1);
    if (!isDigits(core)) {
      // usage.py:106 interpolates with `!r`, so the quoting is repr's, not a literal "'".
      // A value containing a quote/backslash/control char must render exactly as Python's.
      throw new UsageError(`bad relative date ${pyRepr(s)}: expected -Nd, e.g. -3d or -30d`);
    }
    return shiftDays(deps.today(), -parseDigits(core));
  }
  return s.replace(/-/g, "");
}

/**
 * Python accepts any Unicode decimal digit here: `"-١d"` passes `str.isdigit()` and
 * `int("١")` is 1, so Python shifts by one day where an ASCII-only test would error out —
 * a divergence on a SUCCESS path (code review R2).
 *
 * The digit set comes from a table pinned to the reference CPython, NOT from JS's own
 * `\p{Nd}`: V8 ships a newer Unicode database (measured: 760 Nd code points vs CPython
 * 3.11.6's 660), so the native class would accept 100 code points Python rejects as
 * unassigned (code review R3). See src/unicode-tables.ts.
 *
 * (`str.isdigit()` is slightly wider than `int()` — it also admits e.g. superscript "²",
 * for which Python's own `int()` then raises; ALLOWLIST entry 11 covers that sliver.)
 */
function isDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) {
    if (!isDecimalDigit(ch.codePointAt(0)!)) return false;
  }
  return true;
}

/** Python `int(core)` for an all-decimal-digit string. */
function parseDigits(s: string): number {
  let n = 0;
  for (const ch of s) {
    n = n * 10 + decimalValue(ch.codePointAt(0)!);
  }
  return n;
}

/** Shift a YYYYMMDD key by N days using local-calendar arithmetic. */
function shiftDays(yyyymmdd: string, days: number): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  // datetime.date spans years 1..9999 and raises OverflowError outside it. JS Date's range
  // is far wider, so without this check `-1000000d` would happily produce a negative year
  // where Python exits non-zero (code review R3).
  const yy = dt.getFullYear();
  if (Number.isNaN(dt.getTime()) || yy < 1 || yy > 9999) {
    throw new UsageError(`bad relative date: ${-days} days is out of range`);
  }
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  // strftime("%Y") is zero-padded to four digits; keep the key fixed-width so the
  // string comparisons in inWindow() stay chronological.
  return `${String(yy).padStart(4, "0")}${mm}${dd}`;
}

/** Chronological membership on fixed-width YYYYMMDD strings (--until inclusive). */
export function inWindow(day: string, sinceKey: string | null, untilKey: string | null): boolean {
  if (sinceKey && day < sinceKey) return false;
  if (untilKey && day > untilKey) return false;
  return true;
}

/** Parse an ISO timestamp, tolerating a trailing Z. */
export function iso(ts: string): Date {
  return new Date(ts.replace("Z", "+00:00"));
}

/** Local-time "YYYY-MM-DD HH:MM" for a timestamp, or "" when absent. */
export function toLocal(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = iso(ts);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

/** Human window label. Relative inputs render as `-3d (=20260728)`. */
export function windowLabel(
  since: string | null | undefined,
  until: string | null | undefined,
  deps: RuntimeDeps,
): string {
  const show = (s: string): string =>
    s.startsWith("-") && s.endsWith("d") ? `${s} (=${normDate(s, deps)})` : s;
  if (!since && !until) return "(all time)";
  if (since && !until) return `(since ${show(since)})`;
  return `(${since ? show(since) : "start"} -> ${show(until as string)})`;
}

/**
 * `datetime.date.fromisoformat(s)` as of the reference CPython, returning the resolved
 * calendar date as `YYYY-MM-DD`, or throwing for anything it rejects.
 *
 * Only `cmd_hourly` reaches this — usage.py:600 takes `--date` verbatim and usage.py:618
 * hands it straight here, so a reject is an UNCAUGHT ValueError: traceback, exit 1, no
 * stdout (ALLOWLIST 19). Every other date-taking command routes through `norm_date` first.
 *
 * The accepted grammar was MEASURED against the reference interpreter, not assumed:
 * `YYYY-MM-DD`, `YYYYMMDD`, and ISO week dates `YYYY-Www-D` / `YYYYWwwD`. It does NOT
 * accept ordinal dates (`2026-001`), unpadded fields (`2026-1-1`), a time component,
 * surrounding whitespace, a leading `+`, or non-ASCII digits — all of which are the
 * plausible-looking near-misses that a hand-written regex tends to let through.
 */
export function pyDateFromIsoFormat(s: string): string {
  const bad = (): never => {
    throw new ValueError(`Invalid isoformat string: ${pyRepr(s)}`);
  };
  const digits = (t: string): boolean => /^[0-9]+$/.test(t);

  let y: number, mo: number, da: number;
  // The weekday is OPTIONAL and defaults to Monday: `2026W01` and `2026-W01` both resolve to
  // 2025-12-29. The compact seven-character form is the reachable one — `2026-W01` is eight
  // characters, so usage.py:601's len==8 rewrite mangles it to `2026-W0-1` before this is
  // ever called, and the oracle rejects it. Measured both ways; only `2026W01` gets here.
  const dashedWeek = /^(\d{4})-W(\d{2})(?:-(\d))?$/.exec(s);
  const compactWeek = /^(\d{4})W(\d{2})(\d)?$/.exec(s);
  const week = dashedWeek ?? compactWeek;
  if (week) {
    y = Number(week[1]);
    const w = Number(week[2]);
    const d = week[3] === undefined ? 1 : Number(week[3]);
    if (y < 1 || y > 9999 || w < 1 || w > isoWeeksInYear(y) || d < 1 || d > 7) {
      throw new ValueError(`Invalid isoformat string: ${pyRepr(s)}`);
    }
    // ISO week 1 contains Jan 4th; day 1 is Monday.
    //
    // `setUTCFullYear` is not redundant: `Date.UTC` maps years 0..99 to 1900..1999, so
    // `0001-W01-1` would otherwise resolve against 1901 and return a 1901 date. The oracle
    // returns 0001-01-01.
    const jan4 = new Date(Date.UTC(y, 0, 4));
    jan4.setUTCFullYear(y);
    const jan4Dow = ((jan4.getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
    const dt = new Date(jan4.getTime() + ((w - 1) * 7 + (d - jan4Dow)) * 86_400_000);
    const ry = dt.getUTCFullYear();
    // A week date near either boundary can resolve OUTSIDE datetime.date's range — the
    // oracle raises `year 10000 is out of range` for 9999-W52-7 rather than wrapping.
    if (ry < 1 || ry > 9999) throw new ValueError(`year ${ry} is out of range`);
    return `${String(ry).padStart(4, "0")}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  }

  if (s.length === 10 && s[4] === "-" && s[7] === "-") {
    const [a, b, c] = [s.slice(0, 4), s.slice(5, 7), s.slice(8, 10)];
    if (!digits(a) || !digits(b) || !digits(c)) bad();
    [y, mo, da] = [Number(a), Number(b), Number(c)];
  } else if (s.length === 8 && digits(s)) {
    [y, mo, da] = [Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8))];
  } else {
    return bad();
  }

  // The oracle distinguishes these two from the parse failure above, and from each other.
  if (mo < 1 || mo > 12) throw new ValueError("month must be in 1..12");
  if (da < 1 || da > daysInMonth(y, mo)) throw new ValueError("day is out of range for month");
  if (y < 1) throw new ValueError(`year ${y} is out of range`);
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** 53 iff Jan 1 is a Thursday, or it is a leap year starting on a Wednesday. */
function isoWeeksInYear(y: number): number {
  const dow = (yy: number): number => ((new Date(Date.UTC(yy, 0, 1)).getUTCDay() + 6) % 7) + 1;
  return dow(y) === 4 || (isLeap(y) && dow(y) === 3) ? 53 : 52;
}
