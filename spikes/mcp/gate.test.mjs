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
import { chmodSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "evidence");

// The directory's OWN mode, read rather than assumed. This used to restore a hardcoded 0o755:
// correct for the directory as it stands today, and silently world-widening the moment anyone
// hardens it to 0o700 — which is exactly what every fixture directory in this repo is created
// as (review round 2, chunk 14).
const EVIDENCE_MODE = statSync(EVIDENCE).mode & 0o7777;

/**
 * Make the evidence directory unwritable, run `fn`, restore the mode it actually had.
 *
 * And PROVE the protection before relying on it. `chmod` is advisory in two situations that
 * matter here: the process is root, or the filesystem does not enforce modes. In either one
 * this whole file becomes a loaded gun aimed at committed artifacts — every guarded block
 * below exists to keep a REMOVED direct-entry guard from deleting DECISION.md and
 * decision.json, and it can only do that if the write actually fails. So it is attempted.
 */
async function withEvidenceReadOnly(fn) {
  // ASYNC-aware. A synchronous `return fn()` restores the mode the moment fn returns a
  // promise, so the protected work would run with the directory already writable again —
  // which is the detached-promise defect this review round keeps finding, in the one helper
  // whose whole job is to be holding the door shut while the risky thing happens.
  chmodSync(EVIDENCE, 0o500);
  try {
    const canary = join(EVIDENCE, ".write-probe");
    let enforced = false;
    try {
      writeFileSync(canary, "");
      rmSync(canary, { force: true });
    } catch {
      enforced = true;
    }
    assert.ok(
      enforced,
      "the evidence directory is still writable while chmod 0500 is in effect — refusing to run a test " +
        "whose only protection for committed artifacts is that mode (running as root?)",
    );
    return await fn();
  } finally {
    chmodSync(EVIDENCE, EVIDENCE_MODE);
  }
}

/**
 * Prove inertness in a DISPOSABLE process before this one imports anything.
 *
 * chmod protects files. It does not protect the ticket graph, and on a `blocked` outcome the
 * gate's body creates a resolution ticket and attaches it as a blocker to T-013 — a real,
 * durable mutation that happens BEFORE anything touches the filesystem. So the mode bits were
 * never the whole boundary, and an in-process import at module scope bet this session's
 * repository state on a guard the import itself would be the first thing to violate
 * (review round 2, chunk 14).
 *
 * The subprocess runs with PATH reduced to the node binary's own directory, so the storybloq
 * CLI cannot be found and no graph mutation is reachable however the module behaves, and with
 * the evidence directory read-only. Only if it prints INERT — meaning the module ran nothing
 * and did not terminate its importer — does this process import it.
 */
const inertProbe = await withEvidenceReadOnly(() =>
  spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(join(HERE, "gate.mjs"))}); console.log("INERT");`],
    { encoding: "utf8", env: { ...process.env, PATH: dirname(process.execPath) } },
  ),
);

// DYNAMIC, and gated on the probe above. A static import is hoisted over every statement in
// this file, so a removed direct-entry guard would run the gate before any test body could
// stop it. Found the hard way while mutation-testing that guard: the mutation deleted
// DECISION.md and decision.json from the working tree through this file's own import.
const gate = inertProbe.stdout.trim() === "INERT" ? await withEvidenceReadOnly(() => import("./gate.mjs")) : null;
const ticketRows = gate?.ticketRows;

test("importing the gate runs nothing and exits nothing", () => {
  // If this fails, nothing below imported the module either — the probe is what authorises
  // that. A test that can destroy the artifacts it exists to protect is not a test worth having.
  assert.equal(
    inertProbe.stdout.trim(),
    "INERT",
    `importing gate.mjs executed its body: exit ${inertProbe.status}, stderr: ${inertProbe.stderr.trim()}`,
  );
  assert.equal(inertProbe.status, 0, "importing gate.mjs terminated the importing process");
});

test("the gate exposes its body as a function rather than running it", () => {
  assert.ok(gate, "the module was never imported because it is not inert");
  assert.equal(typeof gate.main, "function");
});

// ---------- the ticket-list envelope ------------------------------------------------------------
//
// This response decides whether a resolution ticket is CREATED. Reading an unrecognised envelope
// as an empty list made "I could not read the list" indistinguishable from "the list is empty",
// so a CLI that changed its wrapper produced a duplicate ticket on every run.

test("a recognised ticket-list envelope yields its rows", () => {
  assert.ok(ticketRows, "the module was never imported because it is not inert");
  assert.deepEqual(ticketRows([]), []);
  assert.deepEqual(ticketRows([{ title: "a" }]), [{ title: "a" }]);
  assert.deepEqual(ticketRows({ tickets: [] }), []);
  assert.deepEqual(ticketRows({ tickets: [{ title: "b" }] }), [{ title: "b" }]);
});

test("an unrecognised ticket-list envelope is refused, never read as empty", () => {
  assert.ok(ticketRows, "the module was never imported because it is not inert");
  for (const bad of [{}, { items: [{ title: "a" }] }, { data: { tickets: [] } }, null, "[]", 0, { tickets: null }]) {
    assert.throws(
      () => ticketRows(bad),
      /ticket list:/,
      `${JSON.stringify(bad)} was accepted — a missed ticket creates a duplicate`,
    );
  }
});

test("an envelope carrying a non-array 'tickets' is refused by name", () => {
  assert.ok(ticketRows, "the module was never imported because it is not inert");
  // Distinct from the unrecognised-envelope case: here the key IS present, so the failure is
  // about its type and the message should say so rather than list the keys.
  assert.throws(() => ticketRows({ tickets: { a: 1 } }), /'tickets' is object, not an array/);
});
