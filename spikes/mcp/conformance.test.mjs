// Tests for the conformance suite itself (plan §5): every case must be able to FAIL.
//
// The mutant server (mutant-server.mjs) exists for exactly this: a case that passes against
// the defect it claims to detect is vacuous, and a suite of vacuous cases would wave both
// SDKs through. The baseline (`none`) run proves the opposite direction — the cases measure
// behavior, not SDK identity, since a hand-rolled correct server passes all eight.
//
// This file runs under `node --test` or directly (`node spikes/mcp/conformance.test.mjs`);
// test:mcp-spike uses direct execution. An earlier header blamed the test runner for a child
// that never exited — review round 1 found the real cause in THIS suite: importing MUTANTS
// executed the mutant server, whose readline interface held the importing process's stdin.
// mutant-server.mjs now guards its runtime behind a direct-entry check.

import test from "node:test";
import assert from "node:assert/strict";

import { CASES, runCase, spawnMutant } from "./conformance.mjs";
import { MUTANTS } from "./mutant-server.mjs";

// Each mutant must die to the ORACLE CLAUSE it exists to prove, not merely die: a mutant
// killed by an unrelated failure (framing-wrong-code crashing at startup, say) would credit
// the wrong-code check without ever exercising it (review round 1). Patterns are literal
// fragments of the intended clause's failure message.
const KILL_REASONS = {
  "blank-version": /is not a date-shaped string/,
  "tool-absent": /absent from tools\/list/,
  "schema-drop": /inputSchema lost the nonce field/,
  "no-structured": /structuredContent missing or nonce not echoed/,
  "empty-text": /text fallback missing or empty/,
  "framing-wrong-code": /only -32700 or silence is conformant/,
  // No alternation. The second branch was the SAME clause framing-wrong-code and framing-late
  // die to, so this mutant could have been credited to a check it never exercised — which is the
  // one thing this table exists to prevent. It dies to the unframeable-bytes clause, measured
  // (review round 2, chunk 14).
  "framing-garbage": /answered with unframeable bytes/,
  "framing-late": /only -32700 or silence is conformant/,
  "framing-dies": /server died on a malformed line/,
  "args-accept": /accepted instead of rejected/,
  "args-crash": /before answering tools\/call/,
  "cancel-ignored": /waiting for the aborted release witness/,
  "cancel-wedged": /a response to tools\/call \(id 10\)/,
  "eof-alive": /after client EOF/,
  "stdout-noise": /non-JSON bytes on stdout/,
  "stdout-blank-lines": /empty line/,
  "stdout-unterminated": /unterminated/,
  "stderr-silent": /no log output on stderr/,
};

test("the mutant roster and the cases' kill claims are the same set, with no double-claims", () => {
  const claimed = CASES.flatMap((c) => c.mutants);
  assert.deepEqual(
    [...claimed].sort(),
    MUTANTS.filter((m) => m !== "none").sort(),
    "every non-baseline mutant must be claimed by a case, and no case may claim a ghost",
  );
  assert.equal(new Set(claimed).size, claimed.length, "a mutant is claimed twice");
  assert.deepEqual(
    Object.keys(KILL_REASONS).sort(),
    MUTANTS.filter((m) => m !== "none").sort(),
    "every non-baseline mutant must declare its intended kill reason",
  );
});

test("the eight-case list matches the plan's literal case names", () => {
  // An independent oracle for the suite's own shape — dropping a case while refactoring
  // must fail here, not silently shrink the matrix.
  assert.deepEqual(
    CASES.map((c) => c.name),
    [
      "initialize",
      "tools-list",
      "tools-call",
      "broken-framing",
      "schema-violation",
      "cancellation",
      "client-eof",
      "stdout-purity",
    ],
  );
});

test("the correct baseline server passes all eight cases", async () => {
  for (const def of CASES) {
    const r = await runCase(def, () => spawnMutant("none"));
    assert.equal(r.status, "pass", `${def.name} vs correct baseline: ${r.detail}`);
  }
});

for (const def of CASES) {
  for (const mutant of def.mutants) {
    test(`case ${def.name} kills mutant ${mutant} for the intended reason`, async () => {
      const r = await runCase(def, () => spawnMutant(mutant));
      assert.equal(r.status, "fail", `${def.name} PASSED against ${mutant} — the case is vacuous`);
      assert.match(
        r.detail,
        KILL_REASONS[mutant],
        `${mutant} died, but to the wrong clause — the intended oracle was never exercised: ${r.detail}`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Review round 2, chunk 9: the harness itself, and the isolation claim.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { Harness, sdkWitness, judgeCaseIsolation, aggregateIsolation, MAX_STREAM_BYTES } from "./conformance.mjs";

/**
 * A stand-in for a spawned server, so harness properties are testable without a process.
 *
 * It models the two things about a REAL piped child that the harness depends on: chunks arrive
 * as Buffers, and the stream supports setEncoding. The tests used to emit JavaScript strings,
 * which is not what `stdio: "pipe"` produces — so the byte-accounting and multi-byte-boundary
 * paths were never exercised at all (review round 2, chunk 14). `emit` here honours whatever
 * encoding the harness set, exactly as a real stream would.
 */
function fakeChild() {
  const child = new EventEmitter();
  const stream = () => {
    const s = new EventEmitter();
    s.setEncoding = (enc) => {
      s.decoder = new StringDecoder(enc);
    };
    s.feed = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      s.emit("data", s.decoder ? s.decoder.write(buf) : buf);
    };
    return s;
  };
  child.stdout = stream();
  child.stderr = stream();
  child.stdin = Object.assign(new EventEmitter(), { write: () => true, end: () => {}, destroy: () => {} });
  child.kill = () => {};
  return child;
}

test("an observation that overflowed is a failure even when the predicate is satisfied", async () => {
  const child = fakeChild();
  const h = new Harness(child);
  // The response and the overflow arrive in the SAME event. Taking the predicate first
  // reported a passing request over a stream the harness had stopped capturing.
  h.overflow = "stdout";
  await assert.rejects(
    () => h.waitFor(() => true, 1_000, "anything"),
    /stdout exceeded/,
    "a satisfied predicate was allowed to override a known-failed observation",
  );
});

test("overflow arriving in the same event that satisfies the predicate still fails", async () => {
  const child = fakeChild();
  const h = new Harness(child);
  // The asynchronous path, not the early check: nothing is wrong when the wait begins, and
  // then ONE event both floods the stream and makes the predicate true. Taking the predicate
  // first here reported a pass over a stream the harness had just stopped capturing.
  const waiting = h.waitFor(() => h.stdoutRaw.length > 0, 2_000, "any output");
  child.stdout.feed("x".repeat(6_000_000));
  await assert.rejects(() => waiting, /exceeded/, "a satisfied predicate overrode a failed observation mid-wait");
});

test("the parse buffer is bounded, not only the retained stream", async () => {
  const child = fakeChild();
  const h = new Harness(child);
  // Six megabytes with no newline: nothing is ever framed, so the cap on the retained copy
  // never limited what the parser held.
  //
  // Watching `overflow` flip is NOT enough: an implementation that raises the flag and keeps
  // appending every byte — the exact memory-exhaustion defect this bound exists to stop —
  // satisfies that (review round 2, chunk 14). So the buffer itself is measured, across
  // several floods, because the bound has to hold for the second one too.
  for (let i = 0; i < 3; i++) {
    child.stdout.feed("x".repeat(6_000_000));
    assert.ok(
      h.parseBuffer.length <= MAX_STREAM_BYTES,
      `flood ${i + 1}: the parse buffer holds ${h.parseBuffer.length} bytes, past the ${MAX_STREAM_BYTES} cap`,
    );
  }
  assert.equal(h.overflow, "stdout", "an unterminated flood did not register as overflow");
  await assert.rejects(() => h.waitFor(() => false, 500, "a frame"), /exceeded/);
});

test("a multi-byte character split across two reads is not corrupted", () => {
  // A piped child emits Buffers, and appending each one to a string decodes it on its own — so
  // a three-byte character straddling a chunk boundary became two replacement characters, in
  // the retained stream and in the framing buffer, and the JSON line built from it no longer
  // parsed (review round 2, chunk 14).
  const child = fakeChild();
  const h = new Harness(child);
  const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "中🙂é" } }) + "\n", "utf8");
  const cut = line.indexOf(Buffer.from("中", "utf8")) + 1; // mid-character, deliberately
  child.stdout.feed(line.subarray(0, cut));
  child.stdout.feed(line.subarray(cut));
  assert.equal(h.messages.length, 1, `the split line did not frame: ${JSON.stringify(h.stdoutRaw)}`);
  assert.equal(h.messages[0].result.text, "中🙂é", "the character was corrupted across the chunk boundary");
});

test("a case whose child would not close is failed, not reported on", async () => {
  // dispose() bounds its wait so an unkillable child cannot hang the run — but returning
  // quietly meant the caller read a resolution log a live process was still writing.
  const def = { name: "fake", async run() {} };
  const r = await runCase(def, () => {
    const child = fakeChild();
    child.kill = () => {}; // never emits 'close'
    return child;
  });
  assert.equal(r.status, "fail");
  assert.match(r.detail, /did not close after SIGKILL/);
});

test("isolation requires the candidate SDK to have been resolved, not merely something in-root", () => {
  const rootReal = "/tmp/candidate-root";
  const sdk = "@modelcontextprotocol/server";
  const inSdk = join(rootReal, "node_modules", "@modelcontextprotocol", "server", "dist", "index.js");
  const notSdk = [
    join(rootReal, "server.mjs"),
    join(rootReal, "instrument.mjs"),
    join(rootReal, "node_modules", "@modelcontextprotocol", "server-extras", "index.js"),
  ];
  // Every one of these is inside the root, so the old "inside > 0" test passed — and a
  // server.mjs that had stopped importing the SDK entirely would have passed with it.
  assert.equal(sdkWitness({ rootReal, insidePaths: notSdk }, sdk), 0);
  assert.equal(sdkWitness({ rootReal, insidePaths: [...notSdk, inSdk] }, sdk), 1);
  // The sibling package must not be mistaken for the package: prefix matching without the
  // separator would count `server-extras` as `server`.
  assert.equal(sdkWitness({ rootReal, insidePaths: [notSdk[2]] }, sdk), 0);
});

test("a case that never resolved the candidate SDK is recorded as uninstrumented", () => {
  const rootReal = "/tmp/candidate-root";
  const sdk = "@modelcontextprotocol/server";
  const base = { rootReal, total: 40, violations: [] };
  const withoutSdk = judgeCaseIsolation({ ...base, insidePaths: [join(rootReal, "server.mjs")] }, sdk, 0);
  assert.equal(withoutSdk.sdkResolutions, 0);
  assert.match(withoutSdk.error, /did not exercise the candidate SDK/);

  const withSdk = judgeCaseIsolation(
    { ...base, insidePaths: [join(rootReal, "node_modules", "@modelcontextprotocol", "server", "index.js")] },
    sdk,
    0,
  );
  assert.equal(withSdk.error, undefined);
  assert.equal(withSdk.sdkResolutions, 1);
});

test("every way isolation can be false actually makes it false", () => {
  // The positive control is the shape PRODUCTION builds: one record per case, for every case in
  // the real list, each carrying what judgeCaseIsolation returns. It used to be a single
  // fabricated `{ a: { sdkResolutions: 3 } }` — which passed, and in passing asserted that a
  // record missing seven of eight cases is fully isolated (review round 2, chunk 14).
  const perCase = Object.fromEntries(
    CASES.map((c) => [
      c.name,
      judgeCaseIsolation(
        {
          rootReal: "/tmp/candidate-root",
          total: 40,
          violations: [],
          insidePaths: [join("/tmp/candidate-root", "node_modules", "@modelcontextprotocol", "server", "index.js")],
        },
        "@modelcontextprotocol/server",
        0,
      ),
    ]),
  );
  const clean = { perCase, violations: [], descendants: [], oppositeSdkProbe: "not-found" };
  assert.equal(aggregateIsolation(clean).ok, true, "the positive control does not pass");
  assert.equal(Object.keys(perCase).length, 8, "the control must cover the whole case list");

  // A MISSING case is not a clean run. `[].every(...)` is true, so an empty or partial record
  // reported everyCaseInstrumented and ok — a verdict about cases nobody looked at.
  for (const dropped of CASES.map((c) => c.name)) {
    const partial = { ...perCase };
    delete partial[dropped];
    const r = aggregateIsolation({ ...clean, perCase: partial });
    assert.equal(r.ok, false, `dropping ${dropped} still reported isolation ok`);
    assert.equal(r.caseSetComplete, false, `dropping ${dropped} still reported a complete case set`);
  }
  assert.equal(aggregateIsolation({ ...clean, perCase: {} }).ok, false, "an EMPTY record reported isolation ok");

  // An unknown case name is not a substitute for a missing one.
  const renamed = { ...perCase, ghost: perCase[CASES[0].name] };
  delete renamed[CASES[0].name];
  assert.equal(aggregateIsolation({ ...clean, perCase: renamed }).ok, false, "a renamed case passed as the real one");

  const broken = { ...perCase, [CASES[0].name]: { error: "no SDK" } };
  assert.equal(aggregateIsolation({ ...clean, perCase: broken }).ok, false);
  assert.equal(aggregateIsolation({ ...clean, perCase: broken }).everyCaseInstrumented, false);
  assert.equal(aggregateIsolation({ ...clean, violations: [{}] }).ok, false);
  assert.equal(aggregateIsolation({ ...clean, descendants: [{}] }).ok, false);
  assert.equal(aggregateIsolation({ ...clean, oppositeSdkProbe: "resolved" }).ok, false);
});
