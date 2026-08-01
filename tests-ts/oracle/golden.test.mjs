/**
 * Replay every stored golden against the TypeScript CLI with NO Python anywhere.
 *
 * The Python-side golden check (`npm run test:goldens`) re-runs usage.py and diffs. This is the
 * other half: the same 45 goldens, the same fixture tree, the same ccusage responses — all of it
 * served from the committed artifacts in tests/oracle/ instead of from a live Python process.
 * It is what makes CI on a Python-free machine (and on the published package) possible.
 *
 * What this can and cannot say: it proves the TS CLI reproduces the recorded oracle output. It
 * does NOT re-derive that output from usage.py — only test:goldens does that, and it stays the
 * authority. If the artifacts were recorded wrong, this test agrees with them enthusiastically.
 * That is exactly why the artifacts have their own independent verifier (tests/oracle/verify.py)
 * and why conformance is asserted below rather than assumed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolvePolicy } from "../harness/policies.mjs";
import { assertConformance, materializeTree, TREE } from "./artifacts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const REPLAY = join(HERE, "replay.mjs");
const CLI_WRAPPER = resolve(REPO, "tests-ts/harness/cli-wrapper.mjs");
const GOLDENS = resolve(REPO, "tests/golden/goldens");
const CONTRACT = JSON.parse(readFileSync(resolve(REPO, "tests/harness/parity-env.json"), "utf8"));
const MANIFEST = JSON.parse(readFileSync(join(GOLDENS, "manifest.json"), "utf8"));
const CASES = new Map(
  JSON.parse(readFileSync(resolve(REPO, "tests/golden/cases.json"), "utf8")).cases.map((c) => [c.name, c]),
);

// Materialization and conformance run at MODULE LOAD, synchronously, before a single test is
// registered. Node's runner may execute test files independently and concurrently, so a
// conformance check living in a sibling file could not gate this one — "the other test will
// catch it" would be a claim about an ordering the runner does not promise. Throwing here
// fails the whole file, which is the only gate that actually holds.
const ROOT = mkdtempSync(join(tmpdir(), "spendbar-oracle-"));
let roots;
try {
  roots = materializeTree(ROOT);
  assertConformance(ROOT, roots);
} catch (err) {
  // Clean up before rethrowing. The `after` hook below is never registered if this throws, so
  // without this the tree leaks into TMPDIR on exactly the runs that fail — the ones most
  // likely to be repeated while debugging.
  rmSync(ROOT, { recursive: true, force: true });
  throw err;
}

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** The child environment, built from the contract rather than inherited. */
function childEnv(golden) {
  const env = { ...CONTRACT.pinned };
  for (const key of CONTRACT.passthrough) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = roots.home;
  env.USAGE_CONFIG = resolve(REPO, "tests/fixture-config.json");
  env.CCUSAGE_CMD = `${process.execPath} ${REPLAY}`;
  env.FAKE_MODE = golden.mode;
  if (golden.codex_fixture) env.CODEX_HOME = roots.codexHome;
  // extra_env LAST, matching tests/golden/capture.py. err_missing_binary deliberately points
  // CCUSAGE_CMD at something unspawnable, and that must still win here — otherwise the one
  // case that proves the missing-binary path would quietly start succeeding against the
  // replayer, which is the most dangerous direction for this particular override to fail in.
  return { ...env, ...golden.extra_env };
}

const goldens = readdirSync(GOLDENS)
  .filter((f) => f.endsWith(".json") && f !== "manifest.json")
  .sort()
  .map((f) => JSON.parse(readFileSync(join(GOLDENS, f), "utf8")));

describe("python-free golden replay", () => {
  test("the artifact set and the goldens describe the same environment", () => {
    // env.mjs's assertEnvironmentContract spawns python3 to verify the interpreter, which is
    // exactly what cannot happen here. The interpreter identity is test:goldens' business; what
    // this file needs is the weaker, Python-free half — that the pinned block the goldens were
    // captured under still matches the contract the child below is built from.
    assert.deepEqual(
      MANIFEST.env,
      CONTRACT.pinned,
      "goldens/manifest.json and parity-env.json disagree about the pinned environment, so " +
        "the goldens were captured under different conditions than this replay constructs.",
    );
    assert.deepEqual(MANIFEST.envPassthrough, CONTRACT.passthrough);
  });

  test("the replayed corpus is exactly the registry's storedGolden set", () => {
    // Checked against cases.json, which T-005 made canonical — NOT against manifest.json.
    // manifest.json is generated by the same capture run that writes the goldens, so a golden
    // deleted and its caseCount decremented agree with each other perfectly; the comparison
    // would be a generated artifact confirming a generated artifact. The registry is the
    // independent statement of which cases are supposed to have goldens.
    const expected = [...CASES.values()].filter((c) => c.storedGolden).map((c) => c.name).sort();
    const loaded = goldens.map((g) => g.name).sort();

    assert.ok(expected.length > 0, "cases.json declares no storedGolden cases");
    assert.equal(
      new Set(loaded).size,
      loaded.length,
      `two goldens share a name: ${loaded.filter((n, i) => loaded.indexOf(n) !== i)}. A duplicate ` +
        "would let one case stand in for another and keep the count right.",
    );
    assert.deepEqual(
      loaded,
      expected,
      "the goldens on disk are not exactly the cases cases.json marks storedGolden",
    );
    // Kept as a third opinion, but no longer the only one.
    assert.equal(goldens.length, MANIFEST.caseCount);
  });

  test("each golden's recorded metadata matches its registry case", () => {
    // The registry defines the case; the golden is a recording OF it. If they disagree, the
    // replay below would run one thing and compare it against a recording of another — and
    // every field here changes what the subject is asked to do.
    for (const g of goldens) {
      const c = CASES.get(g.name);
      assert.ok(c, `${g.name} has a golden but no registry entry`);
      assert.deepEqual(g.argv, c.argv, `${g.name}: argv`);
      assert.equal(g.mode, c.mode, `${g.name}: mode`);
      assert.equal(g.codex_fixture, c.codexFixture, `${g.name}: codexFixture`);
      assert.deepEqual(g.extra_env, c.extraEnv, `${g.name}: extraEnv`);
      assert.equal(g.capture_anchor, c.captureAnchor, `${g.name}: captureAnchor`);
      assert.equal(g.exit, c.expectExit, `${g.name}: expectExit`);
    }
  });

  for (const g of goldens) {
    test(`${g.name} replays against the stored golden with no Python`, () => {
      const c = CASES.get(g.name);
      assert.ok(c, `${g.name} has a stored golden but no entry in cases.json`);

      // No `encoding`, so both sides stay Buffers. Two different byte sequences can decode to
      // the same JS string (invalid UTF-8 collapses to U+FFFD), so a string comparison would
      // report parity for output that is not in fact identical.
      const res = spawnSync(
        process.execPath,
        [CLI_WRAPPER, "--anchor", g.capture_anchor, "--", ...g.argv],
        { env: childEnv(g) },
      );

      // A replayer miss exits 97 and means the artifact set does not cover a call this case
      // makes. Diagnosed separately from an output mismatch because the causes and the fixes
      // are completely different — one is a recording gap, the other is a port bug.
      assert.notEqual(
        res.status,
        97,
        `${g.name}: the replayer had no artifact for a call this case made.\n${res.stderr}`,
      );

      const py = {
        stdout: Buffer.from(g.stdout, "utf8"),
        stderr: Buffer.from(g.stderr, "utf8"),
        termination: { kind: "exit", status: g.exit },
      };
      const ts = {
        stdout: res.stdout,
        stderr: res.stderr,
        termination:
          res.signal === null
            ? { kind: "exit", status: res.status }
            : { kind: "signal", signal: res.signal },
      };

      // Through the SAME policy registry the live parity harness uses, not a fresh equality
      // check. 21 of these cases carry a sanctioned divergence (help text, ts-only
      // diagnostics, partial-python-stdout); comparing raw bytes here would re-litigate every
      // one of them against an allowlist that already settled them, and would tempt a second,
      // laxer copy of the rules to grow in this file.
      resolvePolicy(c.comparisonPolicy).differential(py, ts, c);
    });
  }

  test("the tree really is materialized from the artifacts, not from a live build", () => {
    // Guards the premise of this whole file. If ROOT happened to be populated some other way,
    // every test above would still pass while proving nothing about the artifacts.
    const files = TREE.entries.filter((e) => e.kind === "file");
    assert.ok(files.length > 0, "the manifest describes no files");
    for (const e of files) {
      assert.ok(
        readFileSync(join(roots[e.root], e.path)).length > 0 || e.contentBase64 === "",
        `${e.root}/${e.path} is empty on disk but the manifest carries content`,
      );
    }
  });
});
