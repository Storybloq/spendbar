/**
 * Raw Claude Code transcript scanning — the one data source that does NOT come from
 * ccusage. usage.py:619 globs `~/.claude/projects/&#42;/&#42;.jsonl` directly and buckets the
 * `message.usage` records by local half-hour, which is why `hourly` carries the "est. from
 * raw logs; +-10-15%" disclaimer: it re-derives cost from token counts and a per-family
 * rate rather than reading a billed figure.
 *
 * Everything here is deliberately failure-tolerant in exactly the places usage.py is
 * (a bare `except: continue` around the JSON parse, missing keys defaulted to 0) and
 * deliberately NOT tolerant where usage.py isn't (`date.fromisoformat` raises before any
 * output — ALLOWLIST 19).
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import type { Ctx } from "./context.js";
import { iso } from "./dates.js";
import { modelFamily } from "./config.js";
import { pyTruthy } from "./format.js";
import { UsageError } from "./errors.js";
import { pyRepr } from "./pyrepr.js";

/** tokens, keyed by half-hour label ("09:00"/"09:30") then by model family. */
export type Buckets = Map<string, Map<string, number>>;

/**
 * `glob.glob(os.path.expanduser("~/.claude/projects/&#42;/&#42;.jsonl"))`.
 *
 * Python's `*` never matches a leading dot and never crosses a separator, and a non-final
 * `*` component only descends into directories — a FILE named `projects/foo` cannot supply
 * children. A missing tree yields `[]` rather than an error, which is the path the empty
 * fixture home takes.
 *
 * Order is `os.scandir` order in Python and `readdir` order here; neither is sorted. That
 * is safe for the totals (bucket sums commute) but see the dedupe note in `scanTranscripts`.
 */
export function transcriptFiles(home: string): string[] {
  const root = join(home, ".claude", "projects");
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return out; // no such tree — glob yields no matches, it does not raise
  }
  for (const d of dirs) {
    if (d.startsWith(".")) continue;
    const sub = join(root, d);
    let names: string[];
    try {
      if (!statSync(sub).isDirectory()) continue;
      names = readdirSync(sub);
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.startsWith(".") || !n.endsWith(".jsonl")) continue;
      out.push(join(sub, n));
    }
  }
  return out;
}

/**
 * Local calendar date of a file's mtime, as YYYY-MM-DD — `date.fromtimestamp(getmtime(p))`.
 *
 * Errors are NOT swallowed. usage.py's tolerance is around the per-line JSON parse (a bare
 * `except: continue`), not around reaching a file the glob already matched: `os.path.getmtime`
 * and `open` both raise straight out of `cmd_hourly`. Returning "no records" for an
 * unreadable transcript would produce a plausible but incomplete histogram (code review R1),
 * which is exactly the silent-divergence class this port exists to avoid.
 */
function mtimeLocalDate(path: string): string {
  const ms = statSync(path).mtimeMs;
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/**
 * One `usage` token field, with Python's arithmetic semantics.
 *
 * An ABSENT key is 0 — that is `u.get(k, 0)`. A PRESENT non-number is not: usage.py adds the
 * four fields together straight away, so a string or a list raises TypeError there. Returning
 * 0 would silently drop the record from the histogram instead (code review R1), which is the
 * same silent-divergence class as `numberish` in the blocks renderer.
 *
 * Booleans stay accepted, because Python's bool IS an int and `True + 1` is 2.
 */
function numField(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return 0;
  throw new UsageError(
    `unexpected transcript usage field: ${k} is ${pyRepr(v)}, not a number`,
  );
}

/**
 * Bucket every usage record for `date` (YYYY-MM-DD, local) by half hour and model family.
 *
 * Dedupe is by `(requestId, message.id)` "like ccusage does, so a usage record repeated
 * across resumed sessions isn't double-counted" (usage.py:614). When BOTH are absent the
 * pair is `(None, None)` and dedupe is skipped entirely rather than collapsing every
 * anonymous record onto one key.
 *
 * Known nondeterminism, present in usage.py too: when the same key appears in two files
 * with different timestamps or models, which record survives depends on directory order.
 * Filed as an issue rather than "fixed" here — diverging from the oracle would break parity.
 */
export function scanTranscripts(ctx: Ctx, date: string, targetIso: string): Buckets {
  const buckets: Buckets = new Map();
  const seen = new Set<string>();

  for (const path of transcriptFiles(ctx.deps.home)) {
    // `date.fromtimestamp(getmtime(path)) < target` — a file untouched since before the
    // target day cannot hold records for it. Comparing YYYY-MM-DD lexically is the same
    // ordering as comparing the dates.
    // Against `targetIso`, the RESOLVED date, not the raw `--date` string: usage.py compares
    // against `date.fromisoformat(date)` here but matches records against the raw string
    // below. The two differ for a week date — `2026-W01-1` resolves to 2025-12-29 — so
    // reusing one value for both would filter on the wrong day.
    if (mtimeLocalDate(path) < targetIso) continue;

    for (const line of readLines(path)) {
      // usage.py's fast path is a SUBSTRING test on the raw line, not a parse — a line
      // that merely contains the characters `"usage"` anywhere still gets parsed.
      if (!line.includes('"usage"')) continue;
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // bare `except: continue`
      }
      if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
      const rec = e as Record<string, unknown>;

      const ts = rec.timestamp;
      // `e.get("message") or {}` — falsy collapses to an empty dict.
      const msgRaw = rec.message;
      const msg =
        msgRaw !== null && typeof msgRaw === "object" && !Array.isArray(msgRaw)
          ? (msgRaw as Record<string, unknown>)
          : {};
      const u = msg.usage;
      // `if not ts or not u: continue` is a PYTHON truthiness test, so an empty `usage: {}`
      // is skipped just like a missing one. `u` non-object is left to the field reads below,
      // which default to 0 exactly as `.get(k, 0)` would.
      if (!ts || typeof ts !== "string" || !pyTruthy(u)) continue;
      if (typeof u !== "object" || Array.isArray(u)) continue;

      // `.get()` returns None for an ABSENT key and for a present JSON `null` alike, so a
      // record carrying `"requestId": null` still compares equal to `(None, None)` and skips
      // dedupe. Coalescing only `undefined` would wrongly dedupe every such record together.
      const reqId = rec.requestId ?? null;
      const msgId = msg.id ?? null;
      if (reqId !== null || msgId !== null) {
        const key = JSON.stringify([reqId, msgId]);
        if (seen.has(key)) continue;
        seen.add(key);
      }

      const dt = iso(ts);
      if (Number.isNaN(dt.getTime())) continue;
      const y = dt.getFullYear();
      const mo = String(dt.getMonth() + 1).padStart(2, "0");
      const da = String(dt.getDate()).padStart(2, "0");
      if (`${y}-${mo}-${da}` !== date) continue;

      const usage = u as Record<string, unknown>;
      const fam = modelFamily(typeof msg.model === "string" ? msg.model : null);
      const tok =
        numField(usage, "input_tokens") +
        numField(usage, "output_tokens") +
        numField(usage, "cache_creation_input_tokens") +
        numField(usage, "cache_read_input_tokens");

      const b = `${String(dt.getHours()).padStart(2, "0")}:${dt.getMinutes() < 30 ? "00" : "30"}`;
      let fams = buckets.get(b);
      if (fams === undefined) {
        fams = new Map();
        buckets.set(b, fams);
      }
      fams.set(fam, (fams.get(fam) ?? 0) + tok);
    }
  }
  return buckets;
}

/**
 * Python's `for line in fh`: yields each \n-terminated line, with no trailing empty line for
 * a file that ends in a newline.
 *
 * Read in bounded chunks rather than via `readFileSync`. A real Claude transcript is a
 * long-lived append-only log and can reach tens of megabytes; slurping it would hold the
 * whole file as a UTF-16 string PLUS the split array PLUS every per-line substring at once,
 * where the oracle holds one line (code review R1). `hourly` also opens every matched
 * transcript in turn, so the peak is per-file, not amortised.
 *
 * A generator keeps the renderer's synchronous API. The decoder is incremental so a multi-byte
 * character split across a chunk boundary is not corrupted into U+FFFD.
 */
export function* readLines(path: string): Generator<string> {
  const CHUNK = 1 << 16;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      pending += decoder.write(buf.subarray(0, n));
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        yield pending.slice(0, nl);
        pending = pending.slice(nl + 1);
      }
    }
    pending += decoder.end();
    // A final line with no trailing newline is still a line; an empty remainder is not.
    if (pending !== "") yield pending;
  } finally {
    closeSync(fd);
  }
}
