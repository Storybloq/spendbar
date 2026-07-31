/**
 * Deterministic history fixtures for the real-binary contract tests.
 *
 * EVERY value here is hand-written. Nothing is copied from a real Claude transcript or Codex
 * rollout — those can carry prompts, source code, tool arguments, environment data,
 * credentials, account identifiers and third-party content, none of which belongs in a
 * public repo or an npm tarball. Real records were used only locally, and only to discover
 * which keys the producer requires; the shapes below are the reduced result.
 *
 * This claim was once FALSE and is worth stating loudly for that reason: the codex session id
 * was a genuine rollout UUID from the author's machine, and it sat directly under this
 * paragraph for five review rounds (code review R6). If you add a value here, fabricate it.
 * Identifiers must follow the all-zero-random-bits convention below so that a copied one is
 * visible on sight.
 *
 * Derived against ccusage 20.0.19:
 *  - Claude: an `assistant` record needs `timestamp` and `message.{id,model,usage}`. Nothing
 *    else is required — no requestId, sessionId, cwd, version or content.
 *  - Codex: `session_meta` (for cwd) plus an `event_msg`/`token_count` carrying
 *    `info.total_token_usage`. `turn_context.payload.model` names the model; without it
 *    ccusage attributes the tokens to a default `gpt-5`.
 *  - `--offline` is REQUIRED, not merely nice: without it the rows are dropped when pricing
 *    cannot be resolved, which is what made an earlier synthetic fixture silently yield zero.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Token counts chosen to be distinctive and to satisfy total == sum of the four parts. */
export const CLAUDE_USAGE = {
  input_tokens: 100,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 300,
  output_tokens: 50,
};
export const CLAUDE_EXPECTED_TOTAL = 650;
export const CLAUDE_MODEL = "claude-opus-4-8";
export const CLAUDE_PROJECT_DIR = "-tmp-spendbar-contract-alpha";

/**
 * Codex nests its counters: `cached_input_tokens` is a SUBSET of `input_tokens` (ccusage
 * reports `inputTokens = input - cached` and `cacheReadTokens = cached`), exactly as
 * `reasoning_output_tokens` is a subset of `output_tokens`. A fixture with cached > input is
 * not merely unrealistic, it produces a different total — so these numbers are nested
 * correctly: 1000 in (400 of it cached) + 50 out = 600 + 400 + 50 = 1050.
 */
export const CODEX_TOTAL_TOKENS = 1050;
export const CODEX_MODEL = "gpt-5.6-sol";
export const CODEX_CWD = "/tmp/spendbar-contract/beta";
/**
 * Synthetic UUIDv7, matching the convention tests/fake_ccusage.py already uses
 * (`019c0000-0000-7000-8000-{n:012x}`): a real timestamp prefix so the id is well-formed,
 * then all-zero random bits so it is unmistakably fabricated.
 *
 * The first 48 bits are the UUIDv7 timestamp and decode to exactly 2026-07-10T10:00:00.000Z
 * — the same instant this fixture's records declare. That self-consistency is the point: the
 * previous value's embedded timestamp said 03:53:12Z while every record around it said
 * 10:00:00Z, and that mismatch is what exposed it as copied from a real rollout on the
 * author's machine rather than written by hand (code review R6). It has been replaced.
 */
export const CODEX_ROLLOUT = "rollout-2026-07-10T10-00-00-019f4b78-4100-7000-8000-000000000001";

const jsonl = (recs) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Build a temp HOME containing exactly one Claude project with one assistant turn. */
export function makeClaudeHome() {
  const home = track(mkdtempSync(join(tmpdir(), "spendbar-claude-")));
  const dir = join(home, ".claude", "projects", CLAUDE_PROJECT_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "11111111-2222-4333-8444-555555555555.jsonl"),
    jsonl([
      {
        type: "assistant",
        timestamp: "2026-07-10T10:00:00.000Z",
        message: { id: "msg_contract_01", model: CLAUDE_MODEL, usage: CLAUDE_USAGE },
      },
    ]),
  );
  return home;
}

/** Build a temp CODEX_HOME containing exactly one rollout with one token_count record. */
export function makeCodexHome() {
  const root = track(mkdtempSync(join(tmpdir(), "spendbar-codex-")));
  const dir = join(root, "sessions", "2026", "07", "10");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${CODEX_ROLLOUT}.jsonl`),
    jsonl([
      {
        timestamp: "2026-07-10T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019f4b78-4100-7000-8000-000000000001", // same synthetic id as CODEX_ROLLOUT
          timestamp: "2026-07-10T10:00:00.000Z",
          cwd: CODEX_CWD,
        },
      },
      {
        timestamp: "2026-07-10T10:00:01.000Z",
        type: "turn_context",
        payload: { cwd: CODEX_CWD, model: CODEX_MODEL },
      },
      {
        timestamp: "2026-07-10T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400, // subset of input_tokens — see the note above
              output_tokens: 50,
              reasoning_output_tokens: 10, // subset of output_tokens
              total_tokens: CODEX_TOTAL_TOKENS,
            },
            model_context_window: 272000,
          },
        },
      },
    ]),
  );
  return root;
}

/**
 * Every temp directory this module creates, so callers can remove all of them.
 *
 * `hermeticEnv` used to mkdtemp an XDG scratch dir and return only the environment, leaving
 * the caller no handle on it — so it leaked on every run, passing or failing (code review
 * R1). Tracking them centrally also means a test cannot clean up the homes and silently
 * forget the scratch.
 */
const CREATED = [];

function track(dir) {
  CREATED.push(dir);
  return dir;
}

/** Remove every temp directory created by this module. Safe to call more than once. */
export function cleanupFixtures() {
  while (CREATED.length > 0) {
    rmSync(CREATED.pop(), { recursive: true, force: true });
  }
}

/**
 * An allowlisted environment. `--offline` alone is not isolation: inherited XDG_* and
 * provider variables can redirect the binary at the developer's own data, making the run
 * machine-dependent and leaking local paths into failures.
 */
export function hermeticEnv(claudeHome, codexHome) {
  const scratch = track(mkdtempSync(join(tmpdir(), "spendbar-xdg-")));
  return {
    PATH: process.env.PATH,
    HOME: claudeHome,
    CLAUDE_CONFIG_DIR: join(claudeHome, ".claude"),
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_CACHE_HOME: join(scratch, "cache"),
    XDG_DATA_HOME: join(scratch, "data"),
  };
}
