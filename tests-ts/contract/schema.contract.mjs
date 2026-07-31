/**
 * Real-binary schema contract. This is the gate that makes a ccusage version bump safe.
 *
 * It runs the ACTUAL pinned binary against hand-built deterministic history, so it is NOT
 * skippable on a supported platform and does not depend on the developer having usage data.
 * Every case asserts a nonempty row count BEFORE checking schema — a contract test that
 * passes vacuously on an empty read is worse than no test at all.
 *
 * What it pins is the set of facts the port silently depends on, each of which would
 * otherwise degrade to zeros via `num()` rather than failing:
 *   - `claude daily --instances` rows use `date`; generic `daily` rows use `period`
 *   - codex uses `costUSD` where claude uses `totalCost`
 *   - `codex session.directory` is a DATE directory, not a cwd — the whole reason codexCwd exists
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";

import { resolveBundledCcusage, PINNED_CCUSAGE_VERSION } from "../../dist/resolve-ccusage.js";
import { DATE_DIR_RE, ROLLOUT_RE } from "../../dist/codex.js";
import {
  validateInstances,
  validateDaily,
  validateCodexSessions,
  validateCodexDaily,
} from "../../dist/json.js";
import {
  makeClaudeHome,
  makeCodexHome,
  hermeticEnv,
  cleanupFixtures,
  CLAUDE_EXPECTED_TOTAL,
  CLAUDE_MODEL,
  CODEX_TOTAL_TOKENS,
  CODEX_MODEL,
  CODEX_CWD,
} from "./fixtures.mjs";

const { exe, prefixArgs } = resolveBundledCcusage();

// Registered BEFORE anything is created. The fixture module tracks each directory as it is
// made, so an exception partway through setup — makeCodexHome throwing after makeClaudeHome
// succeeded — still leaves a hook that removes what already exists. Registering afterwards
// meant a failed setup leaked every directory created up to that point (code review R5).
// Removes the XDG scratch dirs too, which the old per-home rmSync pair silently left behind
// on every run (code review R1).
process.on("exit", cleanupFixtures);

const claudeHome = makeClaudeHome();
const codexHome = makeCodexHome();
const env = hermeticEnv(claudeHome, codexHome);

function ccusage(...args) {
  const res = spawnSync(exe, [...prefixArgs, ...args, "--offline"], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  assert.equal(res.status, 0, `ccusage ${args.join(" ")} failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test("the pinned version is what actually runs", () => {
  const res = spawnSync(exe, [...prefixArgs, "--version"], { encoding: "utf8", env });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), `ccusage ${PINNED_CCUSAGE_VERSION}`);
});

test("claude daily --instances: rows keyed by 'date', cost by 'totalCost'", () => {
  const d = ccusage("claude", "daily", "--instances", "--breakdown", "--json");
  const projects = Object.keys(d.projects ?? {});
  assert.equal(projects.length, 1, "fixture must produce exactly one project");
  const rows = d.projects[projects[0]];
  assert.ok(rows.length >= 1, "fixture must produce at least one row");

  const row = rows[0];
  assert.ok("date" in row, "instances rows must carry 'date'");
  assert.ok(!("period" in row), "instances rows must NOT carry 'period' — that is generic daily");
  assert.equal(typeof row.totalCost, "number");
  assert.equal(row.totalTokens, CLAUDE_EXPECTED_TOTAL);
  // totalTokens is the sum of the four components, not an independent counter.
  assert.equal(
    row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
    row.totalTokens,
  );
  assert.equal(row.modelBreakdowns[0].modelName, CLAUDE_MODEL);
  assert.equal(typeof row.modelBreakdowns[0].cost, "number");
  validateInstances(d);
});

test("generic daily: rows keyed by 'period', NOT 'date'", () => {
  const d = ccusage("daily", "--breakdown", "--json");
  assert.ok(Array.isArray(d.daily) && d.daily.length >= 1, "fixture must produce a daily row");
  const row = d.daily[0];
  assert.ok("period" in row, "generic daily rows must carry 'period'");
  assert.ok(!("date" in row), "generic daily rows must NOT carry 'date' — that is --instances");
  assert.equal(typeof row.totalCost, "number");
  validateDaily(d);
});

test("codex session: 'directory' is a DATE dir, not a cwd", () => {
  const d = ccusage("codex", "session", "--json");
  assert.ok(Array.isArray(d.sessions) && d.sessions.length === 1, "fixture must produce one session");
  const s = d.sessions[0];

  assert.match(s.sessionFile, ROLLOUT_RE, "sessionFile must be the bare rollout stem");
  // The load-bearing assertion: if ccusage ever put a real path here, codexCwd's entire
  // rollout-log resolution would be redundant AND the port's attribution would change.
  assert.match(s.directory, DATE_DIR_RE, "directory must be YYYY/MM/DD");
  assert.notEqual(s.directory, CODEX_CWD);
  assert.ok(!s.directory.startsWith("/"), "directory must not be an absolute path");

  assert.equal(typeof s.costUSD, "number", "codex uses costUSD, not totalCost");
  assert.ok(!("totalCost" in s));
  assert.equal(s.totalTokens, CODEX_TOTAL_TOKENS);
  assert.deepEqual(Object.keys(s.models), [CODEX_MODEL]);
  assert.equal(typeof s.models[CODEX_MODEL].totalTokens, "number");
  // reasoningOutputTokens is a SUBSET of outputTokens, not an extra term.
  assert.ok(s.reasoningOutputTokens <= s.outputTokens);
  assert.equal(
    s.inputTokens + s.outputTokens + s.cacheCreationTokens + s.cacheReadTokens,
    s.totalTokens,
  );

  // One-cent tolerance, not exact float equality: summation order is not a documented
  // producer guarantee.
  const summed = d.sessions.reduce((n, x) => n + x.costUSD, 0);
  assert.ok(Math.abs(summed - d.totals.costUSD) < 0.01, `${summed} vs ${d.totals.costUSD}`);
  validateCodexSessions(d);
});

test("codex daily: 'date' + 'costUSD'", () => {
  const d = ccusage("codex", "daily", "--json");
  assert.ok(Array.isArray(d.daily) && d.daily.length >= 1, "fixture must produce a codex daily row");
  const row = d.daily[0];
  assert.ok("date" in row, "codex daily rows carry 'date'");
  assert.equal(typeof row.costUSD, "number");
  assert.ok(!("totalCost" in row));
  assert.equal(typeof d.totals.costUSD, "number");
  validateCodexDaily(d);
});

test("an empty history still yields the shapes the validators expect", () => {
  // The directories must EXIST but be empty: ccusage exits non-zero with a CliError when
  // CLAUDE_CONFIG_DIR has no 'projects/' at all, which is a different case from "no data".
  const emptyClaude = makeClaudeHome();
  rmSync(`${emptyClaude}/.claude/projects`, { recursive: true, force: true });
  mkdirSync(`${emptyClaude}/.claude/projects`, { recursive: true });
  const emptyCodex = makeCodexHome();
  rmSync(`${emptyCodex}/sessions`, { recursive: true, force: true });
  mkdirSync(`${emptyCodex}/sessions`, { recursive: true });
  const e = hermeticEnv(emptyClaude, emptyCodex);
  const run = (...args) => {
    const res = spawnSync(exe, [...prefixArgs, ...args, "--offline"], { encoding: "utf8", env: e });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  // `sessions` and `daily` are always emitted; `projects` is omitted entirely.
  const cs = run("codex", "session", "--json");
  assert.deepEqual(cs.sessions, []);
  validateCodexSessions(cs);
  const cd = run("codex", "daily", "--json");
  assert.deepEqual(cd.daily, []);
  validateCodexDaily(cd);
  const inst = run("claude", "daily", "--instances", "--json");
  assert.equal(inst.projects, undefined, "instances omits 'projects' entirely when empty");
  validateInstances(inst);
  // Cleanup is the module-level exit hook — these homes are tracked by the fixture module.
});

// Pins the collections that code review R1 made REQUIRED. If ccusage ever stops emitting
// one, this fails here rather than degrading to zeroed per-model columns in production.
test("the producer always emits the collections the validators now require", () => {
  const inst = ccusage("claude", "daily", "--instances", "--breakdown", "--json");
  const instRow = Object.values(inst.projects)[0][0];
  assert.ok(Array.isArray(instRow.modelBreakdowns), "instances rows must carry modelBreakdowns");

  // ...and it is emitted even WITHOUT --breakdown, which is why requiring it is safe.
  const bare = ccusage("claude", "daily", "--instances", "--json");
  assert.ok(Array.isArray(Object.values(bare.projects)[0][0].modelBreakdowns));

  const mb = instRow.modelBreakdowns[0];
  for (const f of ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"]) {
    assert.equal(typeof mb[f], "number", `breakdown entries must carry ${f}`);
  }
  // The producer does NOT put totalTokens on a breakdown entry — requiring it would reject
  // every real payload, so the validator deliberately does not.
  assert.equal(mb.totalTokens, undefined, "breakdown entries must NOT carry totalTokens");

  assert.ok(Array.isArray(ccusage("daily", "--breakdown", "--json").daily[0].modelBreakdowns));

  const s = ccusage("codex", "session", "--json").sessions[0];
  assert.equal(typeof s.models, "object", "codex sessions must carry a models map");
  assert.ok(s.models !== null && !Array.isArray(s.models));
  const cd = ccusage("codex", "daily", "--json").daily[0];
  // `typeof` alone is satisfied by null and by an array, so it would stay green if the
  // producer stopped emitting a map at all — the one thing this line claims to measure
  // (code review R5). Matches the session assertion above.
  assert.equal(typeof cd.models, "object", "codex daily rows must carry a models map");
  assert.ok(cd.models !== null && !Array.isArray(cd.models), "…and it must be a MAP");
  assert.deepEqual(Object.keys(cd.models), [CODEX_MODEL]);

  // Every totals object must carry totalTokens — the counter that used to slip through
  // unrequired because checkSafeInteger returns early for non-numbers.
  for (const d of [inst, ccusage("daily", "--json"), ccusage("codex", "session", "--json")]) {
    assert.equal(typeof d.totals.totalTokens, "number");
  }
});
