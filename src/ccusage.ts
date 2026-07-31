/**
 * The ccusage process boundary.
 *
 * Hardened vs the Python original: executable + argv array with `shell:false` (a
 * CCUSAGE_CMD string is never handed to a shell), plus a timeout and output byte caps.
 * Those bounds are declared in tests/golden/ALLOWLIST.md entry 8 — they only fire where
 * Python would hang or exhaust memory, never on any golden case.
 *
 * The exit-code state machine is reproduced EXACTLY (plan review F4): Python errors only
 * when the exit code is nonzero AND stdout is blank. A nonzero exit that still produced
 * parseable JSON is a success path and must stay one.
 */
import { UsageError } from "./errors.js";
import type { Ctx } from "./context.js";
import { normDate } from "./dates.js";
import {
  validateCodexDaily,
  validateCodexSessions,
  validateDaily,
  validateInstances,
} from "./json.js";

export function runCcusage(ctx: Ctx, args: string[]): unknown {
  const { ccusageExe, ccusagePrefixArgs, runner } = ctx.deps;
  const fullArgs = [...ccusagePrefixArgs, ...args];
  // Frozen diagnostics quote the command the way Python's ' '.join(cmd) does.
  const cmdStr = [ccusageExe, ...fullArgs].join(" ");

  const res = runner(ccusageExe, fullArgs);

  if (res.spawnError) {
    // npx/node (or a custom CCUSAGE_CMD) not on PATH — clean exit, not a raw traceback.
    throw new UsageError(
      `'${ccusageExe}' not found. Install Node.js (node + npx), or set CCUSAGE_CMD to your ` +
        `ccusage command (e.g. CCUSAGE_CMD='ccusage'). See README Requirements.`,
    );
  }

  // Python: `if out.returncode != 0 and not out.stdout.strip()`. Both conditions required.
  if (res.status !== 0 && res.stdout.trim() === "") {
    const detail = res.stderr.trim() || String(res.status);
    throw new UsageError(`ccusage failed: ${detail}\ncmd: ${cmdStr}`);
  }

  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new UsageError(
      `could not parse ccusage output.\ncmd: ${cmdStr}\nstderr: ${res.stderr.slice(0, 400)}`,
    );
  }
}

/**
 * `ccusage claude daily --instances` -> per-project, per-day rows. Calendar-accurate.
 *
 * Do NOT swap this for `ccusage session --since`: that stamps a whole session on its
 * last-activity date, pulling earlier days' tokens across the window boundary.
 */
export function instances(
  ctx: Ctx,
  sinceKey: string | null = null,
  untilKey: string | null = null,
): unknown {
  const args = ["claude", "daily", "--instances", "--breakdown", "--json"];
  if (sinceKey) args.push("--since", sinceKey);
  if (untilKey) args.push("--until", untilKey);
  const d = runCcusage(ctx, args);
  validateInstances(d);
  return d;
}

/** Generic `ccusage daily` (all agents — includes Codex/GPT). */
export function dailyAll(
  ctx: Ctx,
  sinceKey: string | null = null,
  untilKey: string | null = null,
): unknown {
  const args = ["daily", "--breakdown", "--json"];
  if (sinceKey) args.push("--since", sinceKey);
  if (untilKey) args.push("--until", untilKey);
  const d = runCcusage(ctx, args);
  validateDaily(d);
  return d;
}

/** `ccusage blocks --json`. */
export function blocks(ctx: Ctx, sinceKey: string | null = null): unknown {
  const args = ["blocks", "--json"];
  if (sinceKey) args.push("--since", sinceKey);
  return runCcusage(ctx, args);
}

/** `ccusage codex session --json`. Validated for safe integers + key shape. */
export function codexSessionRaw(ctx: Ctx, sinceKey: string | null = null): unknown {
  const args = ["codex", "session", "--json"];
  // Deliberately never passes --until: see aggCodex.
  if (sinceKey) args.push("--since", sinceKey);
  const d = runCcusage(ctx, args);
  validateCodexSessions(d);
  return d;
}

/** `ccusage codex daily --json`. Validated for safe integers + key shape. */
export function codexDailyRaw(
  ctx: Ctx,
  sinceKey: string | null = null,
  untilKey: string | null = null,
): unknown {
  const args = ["codex", "daily", "--json"];
  if (sinceKey) args.push("--since", sinceKey);
  if (untilKey) args.push("--until", untilKey);
  const d = runCcusage(ctx, args);
  validateCodexDaily(d);
  return d;
}

/** Convenience for callers still holding raw user-supplied date strings. */
export function normalizeWindow(
  ctx: Ctx,
  since: string | null | undefined,
  until: string | null | undefined,
): { sinceKey: string | null; untilKey: string | null } {
  return {
    sinceKey: normDate(since, ctx.deps),
    untilKey: normDate(until, ctx.deps),
  };
}
