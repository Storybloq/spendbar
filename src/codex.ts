/**
 * Codex per-project attribution — the security-critical module.
 *
 * ccusage cannot tag Codex sessions by project (its `directory` field is the *date*
 * directory, not the cwd), so we resolve each session to the directory it STARTED in by
 * reading the `session_meta` record at the head of its rollout log, and window by that
 * session's START date (from the rollout filename) rather than ccusage's last-activity
 * stamp.
 *
 * Because that means opening files whose names come from ccusage output, every path is
 * validated before any open:
 *   - basename-only + anchored filename regex (a `../../etc/passwd` sessionFile is refused)
 *   - realpath must stay under a Codex session root (a symlink escaping CODEX_HOME is refused)
 *   - only `type === "session_meta"` records are trusted (a cwd on any other record is a decoy)
 *   - the head scan is bounded in BYTES as well as lines (one JSONL line is otherwise
 *     unbounded and can exhaust memory before a 5-line limit applies)
 */
import { openSync, readSync, closeSync, realpathSync } from "node:fs";
import { basename, join, sep, dirname } from "node:path";
import type { Ctx } from "./context.js";
import { cnum } from "./aggregate.js";
import { cleanName, encodePath } from "./config.js";
import { codexDailyRaw, codexSessionRaw } from "./ccusage.js";
import { inWindow } from "./dates.js";
import { UsageError } from "./errors.js";
import { pyRepr } from "./pyrepr.js";
import { ND_RANGES } from "./unicode-tables.js";
import { pySlice } from "./format.js";

/**
 * `\d` as CPython's `re` sees it (ISS-016).
 *
 * These three patterns are transcribed from usage.py:200-202 and :320, which compile
 * `\d` from a Python string — so it is category Nd, not ASCII. JS `\d` is ASCII-only in
 * every mode, which makes the port STRICTER than the oracle: a path or filename carrying
 * e.g. Arabic-Indic digits matches in Python and not here, and the consequences are on the
 * success path — a session drops into the excluded/undated bucket, changing totals and the
 * frozen coverage line, or a scratchpad cwd renders as a full encoded-path row.
 *
 * Built from ND_RANGES rather than JS's `\p{Nd}`, for the reason src/dates.ts:37-40 records:
 * V8 ships a newer Unicode database than the reference CPython (measured 760 Nd code points
 * vs 660), so `\p{Nd}` would accept 100 code points Python rejects as unassigned. Derived
 * from the table at load rather than written out, so it cannot drift from the table it
 * claims to mirror. The `u` flag is required for the `\u{...}` escapes.
 */
const ND = ND_RANGES.map(([lo, hi]) =>
  lo === hi ? `\\u{${lo.toString(16)}}` : `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`,
).join("");

/**
 * Rollout filenames embed the session's start timestamp + a UUID:
 *   rollout-2026-01-01T10-00-00-019c0000-0000-7000-8000-000000000001
 *
 * The UUID above is synthetic (UUIDv7 shape, random bits zeroed) and matches the fixture
 * convention. A real rollout name identifies a real session on someone's machine, so it
 * does not belong in source that ships — see the tarball content scan in
 * tests-ts/contract/packaging.contract.mjs.
 */
export const ROLLOUT_RE = new RegExp(
  `^rollout-[${ND}]{4}-[${ND}]{2}-[${ND}]{2}T[${ND}-]+` +
    `-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
  "u",
);
export const DATE_DIR_RE = new RegExp(`^[${ND}]{4}/[${ND}]{2}/[${ND}]{2}$`, "u");
/**
 * Claude Code agent scratchpads live under /tmp/claude-<uid>/…; each unique scratchpad
 * would render as a giant encoded-path row, so collapse just that pattern. Other
 * tmp-rooted cwds keep full attribution — a repo can legitimately live there.
 *
 * The only one of the three reachable in practice: a cwd read from a rollout log is real
 * user input, where the other two are codex-generated and ASCII by construction.
 */
export const SCRATCHPAD_RE = new RegExp(`^(/private)?/tmp/claude-[${ND}]+/`, "u");

export const CODEX_UNKNOWN = "unknown (no session log)";

/** Head-scan bounds (ALLOWLIST entry 8). */
const MAX_HEAD_LINES = 5;
const MAX_LINE_BYTES = 1 << 20; // 1 MiB
const MAX_HEAD_BYTES = 4 << 20; // 4 MiB

export interface CodexSessionRow {
  file: string;
  dir: string | null;
  cost: number;
  tokens: number;
  models: Map<string, number>;
}

export interface CodexAgg {
  cost: number;
  tokens: number;
  sessions: number;
}

export interface CodexMeta {
  resolved: number;
  nSeen: number;
  kept: number;
  unkCost: number;
  unkN: number;
  undatedCost: number;
  undatedN: number;
  mtok: Map<string, number>;
  tot: number;
  totTok: number;
  grandAll: number;
  grandTokAll: number;
  dailyCost: number;
  dailyTok: number;
  windowed: boolean;
}

/**
 * 'YYYYMMDD' start date embedded in a rollout filename, or null if it doesn't match.
 * The filename timestamp is the session's START, so windowing on it avoids ccusage's
 * last-activity bleed. null -> the session can't be placed in a window.
 */
export function codexStartDate(sessionFile: unknown): string | null {
  if (typeof sessionFile === "string" && ROLLOUT_RE.test(sessionFile)) {
    // usage.py:209 is `session_file[8:18]` — code points. Positional, and ROLLOUT_RE now
    // admits any Unicode Nd (ISS-016), so a UTF-16 slice here cuts an astral digit in half
    // and yields a key with a lone surrogate in it. That key decides the session's window.
    return pySlice(sessionFile, 8, 18).replace(/-/g, "");
  }
  return null;
}

/**
 * Python's os.path.realpath returns a normalized path for a non-existent input; Node's
 * realpathSync throws ENOENT. A missing archived_sessions dir is the COMMON case, and an
 * unguarded throw would disable resolution entirely (plan review F5). Resolve the longest
 * existing prefix and re-append the remainder.
 */
export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    const base = basename(p);
    return join(safeRealpath(parent), base);
  }
}

/**
 * Python's `dict.get(key, default)` — the default applies ONLY when the key is ABSENT.
 *
 * `??` is NOT a faithful translation: it conflates `null` with absent. Python returns `None`
 * for a present-but-null key, which reaches `cnum` and exits 1 with the byte-frozen message;
 * `x ?? 0` silently substitutes 0 instead, producing a clean table with wrong per-model
 * tokens and a wrong cross-check total (code review R4 — the only 3 of 241 differential
 * mutations where Python errored and the port returned clean zeros).
 *
 * The fix belongs HERE rather than in the schema validator: making the validator reject
 * `null` would fire before codex.ts and REPLACE cnum's frozen wording, which is exactly the
 * shadowing bug rounds 2 and 3 caught.
 */
export function pyGet(o: Record<string, unknown>, key: string, dflt: unknown): unknown {
  // `Object.hasOwn`, not `key in o`: `in` walks the prototype chain, so an inherited
  // `totalTokens`/`costUSD` would be returned in place of the default. Python's `dict.get`
  // consults only the dict's own keys, and this helper exists precisely to be faithful to
  // it — half a translation is worse than none (code review R5).
  return Object.hasOwn(o, key) ? o[key] : dflt;
}

/** Normalized `codex session` rows plus ccusage's own grand totals. */
export function codexSessions(
  ctx: Ctx,
  sinceKey: string | null = null,
): { rows: CodexSessionRow[]; grand: number; grandTok: number } {
  const d = codexSessionRaw(ctx, sinceKey);
  if (d === null || typeof d !== "object" || !Array.isArray((d as Record<string, unknown>).sessions)) {
    throw new UsageError("unexpected ccusage codex output: missing 'sessions' list");
  }
  const root = d as Record<string, unknown>;
  const totalsRaw = root.totals;
  const totals =
    totalsRaw !== null && typeof totalsRaw === "object" ? (totalsRaw as Record<string, unknown>) : {};
  const grand = cnum(totals.costUSD, "totals.costUSD");
  const grandTok = cnum(totals.totalTokens, "totals.totalTokens");

  const rows: CodexSessionRow[] = [];
  const sessions = root.sessions as unknown[];
  sessions.forEach((rRaw, i) => {
    if (rRaw === null || typeof rRaw !== "object" || Array.isArray(rRaw)) {
      throw new UsageError(`unexpected ccusage codex output: sessions[${i}] is not an object`);
    }
    const r = rRaw as Record<string, unknown>;
    const sf = r.sessionFile;
    if (typeof sf !== "string") {
      throw new UsageError(
        `unexpected ccusage codex output: sessions[${i}].sessionFile = ${pyRepr(sf)}`,
      );
    }
    const mtok = new Map<string, number>();
    const models = r.models;
    if (models !== null && typeof models === "object" && !Array.isArray(models)) {
      for (const [mname, mRaw] of Object.entries(models as Record<string, unknown>)) {
        if (mRaw !== null && typeof mRaw === "object" && !Array.isArray(mRaw)) {
          const m = mRaw as Record<string, unknown>;
          mtok.set(
            mname,
            cnum(pyGet(m, "totalTokens", 0), `sessions[${i}].models.${mname}.totalTokens`),
          );
        }
      }
    }
    rows.push({
      file: sf,
      dir: typeof r.directory === "string" ? r.directory : null,
      cost: cnum(r.costUSD, `sessions[${i}].costUSD`),
      tokens: cnum(r.totalTokens, `sessions[${i}].totalTokens`),
      models: mtok,
    });
  });
  return { rows, grand, grandTok };
}

/**
 * Calendar-accurate per-day Codex totals (no per-project breakdown) — the honest anchor
 * for the session cross-check. Note the codex naming (totals.costUSD/totalTokens), unlike
 * generic `daily`'s totalCost.
 */
export function codexDaily(
  ctx: Ctx,
  sinceKey: string | null = null,
  untilKey: string | null = null,
): { rows: unknown[]; grand: number; grandTok: number } {
  const d = codexDailyRaw(ctx, sinceKey, untilKey);
  const isObj = d !== null && typeof d === "object";
  const totalsRaw = isObj ? (d as Record<string, unknown>).totals : undefined;
  const totals =
    totalsRaw !== null && typeof totalsRaw === "object" ? (totalsRaw as Record<string, unknown>) : {};
  const grand = cnum(pyGet(totals, "costUSD", 0.0), "codex daily totals.costUSD");
  const grandTok = cnum(pyGet(totals, "totalTokens", 0), "codex daily totals.totalTokens");
  const rowsRaw = isObj ? (d as Record<string, unknown>).daily : [];
  return { rows: Array.isArray(rowsRaw) ? rowsRaw : [], grand, grandTok };
}

/**
 * Python's text mode is strict UTF-8: malformed bytes raise UnicodeDecodeError, which is a
 * ValueError — NOT caught by codex_cwd's `except OSError` — so Python exits non-zero.
 * `Buffer.toString("utf8")` instead substitutes U+FFFD, which would let a malformed file
 * yield a *corrupted but trusted* cwd (code review R2). Fail loud instead.
 *
 * `ignoreBOM: true` means "do not strip a leading BOM", matching Python's utf-8 codec —
 * stripping it would make a BOM-prefixed line parse here and fail there.
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeStrict(bytes: Buffer, path: string): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    throw new UsageError(`could not decode ${path}: not valid UTF-8`);
  }
}

/**
 * Locate the next line terminator, honouring Python's universal newlines (\n, \r\n and a
 * lone \r all end a line). Returns null when the buffer ends on a bare \r and more input
 * could still arrive — the following byte decides whether it was \r or \r\n.
 */
function nextEol(buf: Buffer, atEof: boolean): { end: number; consumed: number } | null {
  const nl = buf.indexOf(0x0a);
  const cr = buf.indexOf(0x0d);
  if (nl === -1 && cr === -1) return null;
  if (cr === -1 || (nl !== -1 && nl < cr)) return { end: nl, consumed: nl + 1 };
  if (cr + 1 < buf.length) {
    return { end: cr, consumed: buf[cr + 1] === 0x0a ? cr + 2 : cr + 1 };
  }
  return atEof ? { end: cr, consumed: cr + 1 } : null;
}

/**
 * Yield up to MAX_HEAD_LINES lines from a file, bounded in BYTES, one at a time.
 *
 * Streaming rather than batching is load-bearing for parity (code review R2): usage.py
 * parses each line as it reads it and RETURNS on the first session_meta, so a valid line 1
 * resolves the session even when line 3 is enormous. Collecting all five lines first and
 * then failing the whole set on a later line's bound would mark that session unresolved.
 * The bounds now only ever stop the *search*; they can't retract an answer already found.
 *
 * Operating on Buffers is likewise load-bearing: decoding each 64 KiB chunk independently
 * corrupts any multibyte character straddling the boundary (code review R1), and a string's
 * `.length` counts UTF-16 code units, not the bytes these caps are declared in.
 *
 * Ends the scan (rather than throwing) on: open/read failure — Python's `except OSError` —
 * any single line over MAX_LINE_BYTES, or input past MAX_HEAD_BYTES.
 */
function* headLines(path: string): Generator<string> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return; // Python: except OSError -> try the next candidate
  }
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let pending: Buffer = Buffer.alloc(0);
    let totalBytes = 0;
    let emitted = 0;
    let atEof = false;

    for (;;) {
      // Drain every complete line currently buffered before reading more.
      for (;;) {
        if (emitted >= MAX_HEAD_LINES) return;
        const eol = nextEol(pending, atEof);
        if (eol === null) break;
        if (eol.end > MAX_LINE_BYTES) return; // oversized, even though terminated
        yield decodeStrict(pending.subarray(0, eol.end), path);
        emitted += 1;
        pending = pending.subarray(eol.consumed);
      }
      if (atEof) break;
      // A trailing CR is an UNRESOLVED terminator, not payload — the next byte decides
      // \r vs \r\n. Counting it here rejected a line of exactly MAX_LINE_BYTES that
      // happened to be followed by CR at a chunk boundary (code review R3).
      const payload = pending.length - (pending[pending.length - 1] === 0x0d ? 1 : 0);
      if (payload > MAX_LINE_BYTES) return; // unterminated and already oversized

      const budget = MAX_HEAD_BYTES - totalBytes;
      let n: number;
      if (budget <= 0) {
        // At the cap, "EOF exactly here" and "more input behind it" are different: the
        // former must still yield the pending final line, as Python would (code review R3).
        try {
          const probe = Buffer.allocUnsafe(1);
          if (readSync(fd, probe, 0, 1, null) > 0) return; // input continues past the cap
        } catch {
          return;
        }
        atEof = true;
        continue;
      }
      try {
        n = readSync(fd, chunk, 0, Math.min(chunk.length, budget), null);
      } catch {
        return; // Python: except OSError
      }
      if (n <= 0) {
        atEof = true;
        continue; // re-drain so a trailing bare \r terminates its line
      }
      totalBytes += n;
      pending =
        pending.length === 0
          ? Buffer.from(chunk.subarray(0, n))
          : Buffer.concat([pending, chunk.subarray(0, n)]);
    }

    // EOF with a trailing unterminated line: keep it only if it fits the per-line cap.
    if (emitted < MAX_HEAD_LINES && pending.length > 0 && pending.length <= MAX_LINE_BYTES) {
      yield decodeStrict(pending, path);
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resolve a rollout log to the project cwd it STARTED in.
 *
 * Candidates: the dated sessions dir (from ccusage's `directory` field, else the date
 * embedded in the filename), then the flat archived_sessions dir. Every path is validated
 * (basename-only + strict filename format, realpath must stay under a Codex session root)
 * so malformed ccusage output can't read outside CODEX_HOME. Returns null when
 * unresolvable — callers bucket that as unknown.
 */
export function codexCwd(ctx: Ctx, sessionFile: string, dateDir: string | null): string | null {
  if (sessionFile !== basename(sessionFile) || !ROLLOUT_RE.test(sessionFile)) {
    return null;
  }
  // Each root resolves independently: a missing archived_sessions must not disable
  // resolution under sessions, and vice versa.
  const roots = [
    safeRealpath(join(ctx.deps.codexHome, "sessions")),
    safeRealpath(join(ctx.deps.codexHome, "archived_sessions")),
  ];
  const cands: string[] = [];
  if (dateDir && DATE_DIR_RE.test(dateDir)) {
    cands.push(join(roots[0], dateDir, sessionFile + ".jsonl"));
  }
  // usage.py:289 slices the same three fields by code point; see codexStartDate.
  const y = pySlice(sessionFile, 8, 12);
  const m = pySlice(sessionFile, 13, 15);
  const dd = pySlice(sessionFile, 16, 18);
  cands.push(join(roots[0], y, m, dd, sessionFile + ".jsonl"));
  cands.push(join(roots[1], sessionFile + ".jsonl"));

  for (const path of cands) {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      continue; // non-existent candidate — same as Python's non-match
    }
    if (!roots.some((rt) => real.startsWith(rt + sep))) continue;

    // Streamed: each line is parsed as it arrives and the first session_meta wins, exactly
    // as usage.py's `for _ in range(5): line = fh.readline()` loop does.
    for (const line of headLines(real)) {
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
      const rec = e as Record<string, unknown>;
      // Only session_meta is trusted; a cwd on any other record type is a decoy.
      if (rec.type !== "session_meta") continue;
      const payload = rec.payload;
      const cwd =
        payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).cwd
          : null;
      if (typeof cwd === "string" && cwd) return cwd;
    }
  }
  return null;
}

/** Map a resolved cwd to a display project name. */
export function codexProject(ctx: Ctx, cwd: string): string {
  if (SCRATCHPAD_RE.test(cwd)) return "(agent scratchpads)";
  return cleanName(encodePath(cwd), ctx);
}

/**
 * Per-project Codex aggregation windowed by SESSION START DATE (rollout filename), not
 * ccusage's last-activity stamp — this removes the head-of-window bleed.
 */
export function aggCodex(
  ctx: Ctx,
  sinceKey: string | null = null,
  untilKey: string | null = null,
): { agg: Map<string, CodexAgg>; meta: CodexMeta } {
  const windowed = Boolean(sinceKey || untilKey);
  // Never pass --until to ccusage: last-activity >= since is a safe superset of
  // started-in-window, and a ccusage --until would wrongly drop sessions that started
  // in-window but ran past it. The real windowing happens locally off the start date.
  const { rows, grand: grandAll, grandTok: grandTokAll } = codexSessions(ctx, sinceKey);

  const agg = new Map<string, CodexAgg>();
  const mtok = new Map<string, number>();
  let resolved = 0;
  let kept = 0;
  let unkN = 0;
  let undatedN = 0;
  let unkCost = 0;
  let undatedCost = 0;

  for (const r of rows) {
    if (windowed) {
      const start = codexStartDate(r.file);
      if (start === null) {
        undatedCost += r.cost;
        undatedN += 1;
        continue;
      }
      if (!inWindow(start, sinceKey, untilKey)) continue;
    }
    kept += 1;
    const cwd = codexCwd(ctx, r.file, r.dir);
    let p: string;
    if (cwd) {
      resolved += 1;
      p = codexProject(ctx, cwd);
    } else {
      p = CODEX_UNKNOWN;
      unkCost += r.cost;
      unkN += 1;
    }
    let a = agg.get(p);
    if (!a) {
      a = { cost: 0, tokens: 0, sessions: 0 };
      agg.set(p, a);
    }
    a.cost += r.cost;
    a.tokens += r.tokens;
    a.sessions += 1;
    for (const [mname, t] of r.models) {
      mtok.set(mname, (mtok.get(mname) ?? 0) + t);
    }
  }

  const { grand: dailyCost, grandTok: dailyTok } = codexDaily(ctx, sinceKey, untilKey);

  let tot = 0;
  let totTok = 0;
  for (const v of agg.values()) {
    tot += v.cost;
    totTok += v.tokens;
  }

  return {
    agg,
    meta: {
      resolved,
      nSeen: rows.length,
      kept,
      unkCost,
      unkN,
      undatedCost,
      undatedN,
      mtok,
      tot,
      totTok,
      grandAll,
      grandTokAll,
      dailyCost,
      dailyTok,
      windowed,
    },
  };
}
