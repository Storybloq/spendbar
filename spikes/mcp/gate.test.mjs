// Tests for the gate command (plan §1), added in review round 2 chunk 10.
//
// gate.mjs had no tests at all, which is how it kept the one defect every other module in this
// pipeline had already been given a guard against: its whole body ran at module top level, so
// merely IMPORTING it verified evidence, deleted DECISION.md and decision.json from the working
// tree, wrote attempt-report.json, mutated the live ticket graph and called process.exit.
// Demonstrated exactly that way before the fix.
//
// Runs under `node --test` or directly (`node spikes/mcp/gate.test.mjs`).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "evidence");

// DYNAMIC, and behind the same protection as the subprocess below. A static import is hoisted
// above every statement in this file, so if the direct-entry guard were removed the gate would
// run — deleting the committed evidence — before any test body could stop it. Found the hard
// way while mutation-testing this very guard: the mutation deleted DECISION.md and
// decision.json from the working tree through this file's own import.
chmodSync(EVIDENCE, 0o500);
let gate;
try {
  gate = await import("./gate.mjs");
} finally {
  chmodSync(EVIDENCE, 0o755);
}
const { ticketRows } = gate;

test("importing the gate runs nothing and exits nothing", () => {
  // The evidence directory is made unwritable for the duration. With the guard in place nothing
  // touches it — but if a future edit removes the guard, this test must FAIL rather than delete
  // the committed evidence it would otherwise reach. A test that can destroy the artifacts it
  // exists to protect is not a test worth having.
  chmodSync(EVIDENCE, 0o500);
  let result;
  try {
    result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(join(HERE, "gate.mjs"))}); console.log("INERT");`],
      { encoding: "utf8", env: { ...process.env, PATH: dirname(process.execPath) } },
    );
  } finally {
    chmodSync(EVIDENCE, 0o755);
  }
  assert.equal(
    result.stdout.trim(),
    "INERT",
    `importing gate.mjs executed its body: exit ${result.status}, stderr: ${result.stderr.trim()}`,
  );
  assert.equal(result.status, 0, "importing gate.mjs terminated the importing process");
});

test("the gate exposes its body as a function rather than running it", () => {
  assert.equal(typeof gate.main, "function");
});

// ---------- the ticket-list envelope ------------------------------------------------------------
//
// This response decides whether a resolution ticket is CREATED. Reading an unrecognised envelope
// as an empty list made "I could not read the list" indistinguishable from "the list is empty",
// so a CLI that changed its wrapper produced a duplicate ticket on every run.

test("a recognised ticket-list envelope yields its rows", () => {
  assert.deepEqual(ticketRows([]), []);
  assert.deepEqual(ticketRows([{ title: "a" }]), [{ title: "a" }]);
  assert.deepEqual(ticketRows({ tickets: [] }), []);
  assert.deepEqual(ticketRows({ tickets: [{ title: "b" }] }), [{ title: "b" }]);
});

test("an unrecognised ticket-list envelope is refused, never read as empty", () => {
  for (const bad of [{}, { items: [{ title: "a" }] }, { data: { tickets: [] } }, null, "[]", 0, { tickets: null }]) {
    assert.throws(
      () => ticketRows(bad),
      /ticket list:/,
      `${JSON.stringify(bad)} was accepted — a missed ticket creates a duplicate`,
    );
  }
});

test("an envelope carrying a non-array 'tickets' is refused by name", () => {
  // Distinct from the unrecognised-envelope case: here the key IS present, so the failure is
  // about its type and the message should say so rather than list the keys.
  assert.throws(() => ticketRows({ tickets: { a: 1 } }), /'tickets' is object, not an array/);
});
