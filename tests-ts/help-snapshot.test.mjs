/**
 * Shipped-mode help, against a reviewed snapshot (plan section 10.1 step 4).
 *
 * The oracle goldens pin `prog = usage`. They cannot pin `prog = spendbar`, because the
 * shipped CLI emits different bytes by design (ALLOWLIST 22) — so that mode gets its own
 * expectation, and the expectation is a committed FILE that a human approved.
 *
 * The two must not share a generator. If the snapshot were produced at test time from the
 * same template that drives `src/help.ts`, a template bug would generate a wrong help text
 * and a matching expectation, and this file would pass while the help was wrong. So the
 * snapshot is read from disk as opaque data and never regenerated here.
 *
 * Regenerating it is therefore a deliberate, reviewable act: re-run the command in the
 * snapshot header, read the diff, and only then commit.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main, SUBCOMMANDS } from "../dist/main.js";

const SNAPSHOT = resolve(dirname(fileURLToPath(import.meta.url)), "snapshots", "shipped-help.txt");

/** Parse the snapshot into { section -> text }. Comment lines are the approval record. */
function loadSnapshot() {
  const raw = readFileSync(SNAPSHOT, "utf8");
  const sections = new Map();
  let current = null;
  let buf = [];
  for (const line of raw.split("\n")) {
    const m = /^===== (\S+) =====$/.exec(line);
    if (m) {
      if (current !== null) sections.set(current, buf.join("\n"));
      current = m[1];
      buf = [];
      continue;
    }
    if (current === null) continue; // header/comments
    buf.push(line);
  }
  if (current !== null) sections.set(current, buf.join("\n"));
  // Each captured block is preceded by a blank line and the file ends with one; the CLI's
  // own trailing newline is what remains, so compare after trimming exactly that framing.
  for (const [k, v] of sections) sections.set(k, v.replace(/^\n/, "").replace(/\n$/, ""));
  return sections;
}

/** Run the shipped entrypoint in-process and capture stdout. */
function help(argv) {
  const out = [];
  const code = main({
    argv,
    prog: "spendbar",
    today: () => "20260715",
    env: {},
    stdout: (c) => out.push(c),
    stderr: (c) => assert.fail(`help wrote to stderr: ${c}`),
  });
  assert.equal(code, 0, `help exited ${code}`);
  return out.join("").replace(/\n$/, "");
}

const snapshot = loadSnapshot();

describe("shipped-mode help matches the reviewed snapshot", () => {
  test("the snapshot covers the top-level help and every subcommand", () => {
    // Guards the snapshot itself: a subcommand added without a snapshot entry would
    // otherwise be silently unchecked rather than failing.
    assert.deepEqual(
      [...snapshot.keys()].sort(),
      ["__top__", ...SUBCOMMANDS].sort(),
      "snapshot sections do not match the CLI's subcommands",
    );
    for (const [name, text] of snapshot) {
      assert.ok(text.trim().length > 0, `snapshot section ${name} is empty`);
    }
  });

  test("top-level help", () => {
    assert.equal(help(["--help"]), snapshot.get("__top__"));
  });

  for (const cmd of SUBCOMMANDS) {
    test(`${cmd} --help`, () => {
      assert.equal(help([cmd, "--help"]), snapshot.get(cmd));
    });
  }
});

describe("the properties the snapshot was approved for", () => {
  // Stated as assertions as well as prose, so that re-approving a snapshot cannot quietly
  // drop one of them. These read the SNAPSHOT, not the implementation.
  const top = () => snapshot.get("__top__");

  test("every command-table row names the shipped program", () => {
    for (const cmd of SUBCOMMANDS) {
      assert.match(top(), new RegExp(`^  spendbar ${cmd}\\s`, "m"), `no row for ${cmd}`);
    }
  });

  test("the oracle's program name appears nowhere as a command", () => {
    const all = [...snapshot.values()].join("\n");
    assert.doesNotMatch(all, new RegExp(`\\busage (${SUBCOMMANDS.join("|")})\\b`));
  });

  test("argparse's own `usage:` label is NOT rewritten", () => {
    // The most likely blanket-substitution bug: `usage:` names a section, not the program.
    assert.match(top(), /^usage: spendbar \[-h\]/m);
    for (const cmd of SUBCOMMANDS) {
      assert.match(snapshot.get(cmd), new RegExp(`^usage: spendbar ${cmd} `, "m"));
    }
  });

  test("the config path is the corrected one, not the oracle's", () => {
    assert.match(top(), /~\/\.config\/spendbar\/config\.json/);
    assert.doesNotMatch(top(), /usage-config\.json/);
  });

  test("ordinary English is left alone where it happens to read `usage`", () => {
    // `spendbar — a CLI over ccusage ...` must survive: `ccusage` contains `usage`, and a
    // blanket substitution corrupts it into `ccspendbar`.
    assert.match(top(), /\bccusage\b/);
    assert.doesNotMatch(top(), /ccspendbar/);
  });
});
