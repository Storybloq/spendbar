/**
 * Tied-cost ordering in `share` and `combined` (plan section 12, ALLOWLIST 24).
 *
 * usage.py:526 and usage.py:684 both sort a Python **set**. `sorted` is stable, so tied keys
 * fall back to set iteration order, which is hash-based — measured across PYTHONHASHSEED
 * 0/1/2/12345/99, the same three tied projects come out in three different orders. Python is
 * therefore nondeterministic here, not merely different from JavaScript.
 *
 * That is why these are NOT parity cases. A differential against an oracle with no defined
 * answer would either pin an accident of hash seed 0 or fail at random; byte-parity is
 * UNDEFINED for ties rather than violated. What the port owes instead is a defined order, so
 * this asserts the specified tiebreak — primary key, then project name — and, just as
 * importantly, that the order does not depend on the order the payload happened to arrive in.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER = join(REPO, "tests-ts", "harness", "cli-wrapper.mjs");
const FIXTURES = join(REPO, "tests", "harness", "fixtures.py");
const FAKE = join(REPO, "tests", "fake_ccusage.py");

let fixture;

before(() => {
  const r = spawnSync("python3", [FIXTURES, "--build"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  fixture = JSON.parse(r.stdout);
});

after(() => {
  if (!fixture) return;
  for (const d of [fixture.home, fixture.codexHome, fixture.codexOutside]) {
    rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Rows as {name, key}, top to bottom, where `key` is the column the command sorts by.
 *
 * `share` sorts by its single Cost column; `combined` sorts by Total$, the THIRD money
 * column, because a project's Claude and Codex spend are added before ordering. Reading the
 * key out of the rendered table rather than recomputing it keeps this test honest about what
 * was actually printed.
 */
function rows(cmd, keyColumn) {
  const text = runCli(cmd);
  const out = [];
  for (const line of text.split("\n")) {
    // Data rows only: a padded 22-column name, then money columns. Skips the header, the
    // rules, the TOTAL row and the prose above the table.
    const m = /^(.{22}) +((?:\$[\d,.-]+ *)+)/.exec(line);
    if (!m || m[1].startsWith("TOTAL") || m[1].trim() === "Project") continue;
    const money = m[2].trim().split(/\s+/).map((v) => Number(v.replace(/[$,]/g, "")));
    if (money.length <= keyColumn) continue;
    out.push({ name: m[1].trim(), key: money[keyColumn] });
  }
  assert.ok(out.length >= 3, `expected several rows from ${cmd}, got ${out.length}`);
  return out;
}

/** Run the CLI against the tied fixture and return the project column, top to bottom. */
function runCli(cmd, extraEnv = {}) {
  const r = spawnSync(process.execPath, [WRAPPER, "--anchor", "2026-07-15", "--", cmd], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      TZ: "America/Vancouver",
      LC_ALL: "C.UTF-8",
      LANG: "C.UTF-8",
      HOME: fixture.home,
      CODEX_HOME: fixture.codexHome,
      CCUSAGE_CMD: `python3 ${FAKE}`,
      FAKE_MODE: "tied",
      USAGE_CONFIG: join(REPO, "tests", "fixture-config.json"),
      ...extraEnv,
    },
  });
  assert.equal(r.status, 0, `${cmd} exited ${r.status}\n${r.stderr}`);
  return r.stdout;
}

/** CPython's string ordering: by CODE POINT, so "Beta Product" precedes "mike". */
function codePointLess(a, b) {
  const A = [...a];
  const B = [...b];
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const x = A[i].codePointAt(0);
    const y = B[i].codePointAt(0);
    if (x !== y) return x < y;
  }
  return A.length < B.length;
}

describe("tied costs order by project name", () => {
  // `share` sorts by its only money column; `combined` by Total$, the third.
  for (const [cmd, keyColumn] of [["share", 0], ["combined", 2]]) {
    test(`${cmd} is sorted by descending key, then by name`, () => {
      const r = rows(cmd, keyColumn);
      // Asserting the INVARIANT rather than a hardcoded list: the tie groups differ between
      // the two commands (in `combined`, alpha's Codex spend lifts it out of the tie), so a
      // fixed expectation would encode the fixture rather than the rule.
      for (let i = 1; i < r.length; i++) {
        const prev = r[i - 1];
        const cur = r[i];
        assert.ok(prev.key >= cur.key, `${cmd}: ${prev.name} ($${prev.key}) before ${cur.name} ($${cur.key})`);
        if (prev.key === cur.key) {
          assert.ok(
            codePointLess(prev.name, cur.name),
            `${cmd}: tied at $${cur.key} but ${prev.name} is not before ${cur.name} by code point`,
          );
        }
      }
    });

    test(`${cmd} actually contains a tie, so the rule above is exercised`, () => {
      // Without this the loop can pass vacuously on a fixture where nothing ties.
      const r = rows(cmd, keyColumn);
      const ties = r.filter((x, i) => i > 0 && r[i - 1].key === x.key);
      assert.ok(ties.length >= 2, `${cmd}: fixture produced no tie group (${JSON.stringify(r)})`);
    });

    test(`${cmd} does not depend on payload insertion order`, () => {
      // The fixture emits zulu, alpha, mike — deliberately neither alphabetical nor reversed,
      // so a port that merely preserved insertion order would differ here. Two runs also pin
      // that nothing varies run to run.
      const names = () => rows(cmd, keyColumn).map((x) => x.name);
      assert.deepEqual(names(), names());
      assert.notDeepEqual(names().slice(0, 3), ["zulu", "alpha", "mike"]);
    });
  }

  test("the oracle really is nondeterministic here, which is why parity is silent on it", () => {
    // Measured rather than asserted from the docs: if CPython ever made this stable, the
    // allowlist entry would be describing a behaviour that no longer exists, and these
    // commands could go back to being ordinary differential cases.
    const orders = new Set();
    for (const seed of ["0", "1", "2", "12345", "99"]) {
      const r = spawnSync("python3", [join(REPO, "usage.py"), "share"], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          TZ: "America/Vancouver",
          LC_ALL: "C.UTF-8",
          LANG: "C.UTF-8",
          HOME: fixture.home,
          PYTHONHASHSEED: seed,
          CCUSAGE_CMD: `python3 ${FAKE}`,
          FAKE_MODE: "tied",
          USAGE_CONFIG: join(REPO, "tests", "fixture-config.json"),
        },
      });
      assert.equal(r.status, 0, r.stderr);
      orders.add(
        r.stdout
          .split("\n")
          .map((l) => /^(alpha|mike|zulu)\b/i.exec(l))
          .filter(Boolean)
          .map((m) => m[1].toLowerCase())
          .join(","),
      );
    }
    assert.ok(
      orders.size > 1,
      `usage.py produced ONE order across five hash seeds (${[...orders]}); ` +
        "ties may have become deterministic, so ALLOWLIST 24 needs revisiting",
    );
  });
});
