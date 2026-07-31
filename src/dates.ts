/**
 * Date handling. Ports usage.py's norm_date, in_window, window_label, iso, to_local.
 *
 * Windowing discipline (plan hazard 2): `normDate` is applied ONCE at the CLI boundary and
 * the resulting YYYYMMDD keys are threaded down. Re-normalizing a relative `-Nd` inside an
 * aggregator across local midnight would shift one window by a day.
 */
import { UsageError } from "./errors.js";
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
