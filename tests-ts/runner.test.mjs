// Runner: process boundary. Error classification must be exhaustive, because runCcusage
// renders ANY spawnError as the frozen "not found" message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageError } from "../dist/errors.js";
import { createDeps, DEFAULT_CONFIG } from "../dist/context.js";
import { runCcusage } from "../dist/ccusage.js";
import {
  createRunner,
  truncateUtf8,
  MAX_CAPTURE_BYTES,
  MAX_STDERR_DIAGNOSTIC_BYTES,
  TIMEOUT_MS,
} from "../dist/runner.js";

const node = process.execPath;
const run = (opts = {}) => createRunner(opts);
const script = (src) => [node, ["-e", src]];

test("production constants are the measured values", () => {
  // Worst observed payload was 4.25 MB (codex session, all-time), so 64 MiB is ~15x
  // headroom; a 1 or 4 MiB cap would reject legitimate output.
  assert.equal(MAX_CAPTURE_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_STDERR_DIAGNOSTIC_BYTES, 1024 * 1024);
  assert.equal(TIMEOUT_MS, 120_000);
});

test("a normal run returns status, stdout and stderr", () => {
  const r = run()(...script('process.stdout.write("{\\"ok\\":1}");process.stderr.write("warn")'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"ok":1}');
  assert.equal(r.stderr, "warn");
  assert.equal(r.spawnError, undefined);
});

test("a nonzero exit that still produced JSON is NOT an error here", () => {
  // Parity: Python only errors when the exit code is nonzero AND stdout is blank, so the
  // runner must surface this combination rather than throwing.
  const r = run()(...script('process.stdout.write("{}");process.exit(3)'));
  assert.equal(r.status, 3);
  assert.equal(r.stdout, "{}");
});

test("ONLY ENOENT travels as spawnError", () => {
  const r = run()("/definitely/not/a/real/binary-xyz", []);
  assert.equal(r.spawnError?.code, "ENOENT");
});

// Classification is asserted through an INJECTED spawn so it runs identically everywhere.
// The filesystem version below needs POSIX permission bits, which Windows — an advertised
// supported platform — does not have, so it would fail there (code review R1).
// Streams are injected as BUFFERS because that is what `spawnSync` returns under
// `encoding: "buffer"`, which runner.ts requires so it can decode strictly itself rather
// than let spawnSync substitute U+FFFD (code review R7). A string fake is rejected as an
// internal wiring error, deliberately — see the last test in this file.
const B = (s) => Buffer.from(s, "utf8");
const failingSpawn = (error) => () => ({ status: null, signal: null, stdout: B(""), stderr: B(""), error });
const errno = (code) => Object.assign(new Error(code), { code });

test("error classification is platform-independent, and only ENOENT is 'not found'", () => {
  const r = createRunner({ spawn: failingSpawn(errno("ENOENT")) })("x", []);
  assert.equal(r.spawnError?.code, "ENOENT", "ENOENT alone may travel as spawnError");

  for (const code of ["EACCES", "EPERM", "EAGAIN", "EMFILE", "ELOOP"]) {
    assert.throws(
      () => createRunner({ spawn: failingSpawn(errno(code)) })("x", []),
      (e) => {
        assert.ok(e instanceof UsageError, `${code} must be a UsageError`);
        assert.match(e.message, new RegExp(`could not run ccusage \\(${code}\\)`));
        assert.doesNotMatch(e.message, /not found/, `${code} must not claim a missing install`);
        return true;
      },
    );
  }
  // An error with no `code` must still classify rather than fall through.
  assert.throws(
    () => createRunner({ spawn: failingSpawn(new Error("weird")) })("x", []),
    (e) => e instanceof UsageError && /unknown error/.test(e.message),
  );
});

test("EACCES becomes a distinct error, not the frozen 'not found' message", {
  skip: process.platform === "win32" ? "POSIX permission bits only" : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-"));
  const f = join(dir, "not-executable");
  writeFileSync(f, "#!/bin/sh\necho hi\n");
  chmodSync(f, 0o644); // readable, not executable
  try {
    assert.throws(() => run()(f, []), (e) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, /could not run ccusage \(EACCES\)/);
      assert.doesNotMatch(e.message, /not found/, "must not claim the binary is missing");
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// spawnSync throws SYNCHRONOUSLY for an invalid argument — no result object ever exists —
// so this path is not reachable through res.error and was previously untested (code
// review R1). It must still arrive as a classified UsageError, never a raw Node exception.
test("a synchronous spawn throw is classified, not leaked", () => {
  const boom = () => {
    throw errno("ERR_INVALID_ARG_VALUE");
  };
  assert.throws(
    () => createRunner({ spawn: boom })("some-exe", []),
    (e) => {
      assert.ok(e instanceof UsageError, "must not escape as a raw Node exception");
      assert.match(e.message, /ERR_INVALID_ARG_VALUE/);
      assert.match(e.message, /cmd: some-exe/);
      return true;
    },
  );
  // A thrown non-errno Error still classifies, using its message.
  assert.throws(
    () => createRunner({ spawn: () => { throw new Error("kaboom"); } })("some-exe", []),
    (e) => e instanceof UsageError && /kaboom/.test(e.message),
  );
});

// A missing exit status follows PYTHON'S rule, which is `returncode != 0 AND not
// stdout.strip()` (usage.py:118) — not "always fatal".
//
// R5 added this guard unconditionally, reasoning that a null status carrying parseable JSON
// "would be accepted as a successful run". That IS what Python does: a signal shows up as a
// negative returncode, and with non-blank stdout usage.py parses it and exits 0. Measured —
// a child that writes a complete payload and is then SIGKILLed makes usage.py print the
// table and exit 0, while the port exited 1. Exit codes are byte-frozen and nothing
// sanctions that flip, so the guard is now gated on blank stdout (code review R8).
test("a missing exit status is fatal only when stdout is blank, as in Python", () => {
  const noStatus = (stdout, signal = null) => () => ({ status: null, signal, stdout, stderr: B("") });

  // Blank stdout -> fatal, both spellings.
  assert.throws(
    () => createRunner({ spawn: noStatus(B("")) })("x", []),
    (e) => {
      assert.ok(e instanceof UsageError, "must not be handed back as a successful run");
      assert.match(e.message, /without an exit status/);
      assert.match(e.message, /cmd: x/);
      return true;
    },
  );
  assert.throws(
    () => createRunner({ spawn: noStatus(B("   \n\t "), "SIGKILL") })("x", []),
    (e) => e instanceof UsageError && /terminated by signal SIGKILL/.test(e.message),
    "whitespace-only stdout is blank, so the signal is still fatal",
  );

  // Non-blank stdout -> NOT fatal. This is the case that flipped the exit code: the runner
  // must hand the payload back so ccusage.ts can parse it exactly as usage.py does.
  for (const signal of [null, "SIGKILL"]) {
    const r = createRunner({ spawn: noStatus(B('{"daily":[]}'), signal) })("x", []);
    assert.equal(r.status, null, "the missing status is reported honestly, not invented");
    assert.equal(r.stdout, '{"daily":[]}', `signal=${signal}: output produced before dying must survive`);
  }

  // A real exit status of 0 is of course still fine — the guard must key on null, not on
  // falsiness, or every successful run would start failing.
  const ok = createRunner({ spawn: () => ({ status: 0, signal: null, stdout: B("{}"), stderr: B("") }) })("x", []);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "{}");
});

// The end-to-end consequence of the rule above, through the real state machine: usage.py
// prints the table and exits 0 for a signalled child that produced a complete payload.
test("a signalled child that produced a full payload is parsed, not turned into exit 1", () => {
  const payload = '{"daily":[],"totals":{"totalCost":0,"totalTokens":0}}';
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", () => ({
    status: null,
    stdout: payload,
    stderr: "",
  }));
  assert.deepEqual(
    runCcusage({ deps, config: DEFAULT_CONFIG }, ["daily", "--json"]),
    { daily: [], totals: { totalCost: 0, totalTokens: 0 } },
    "Python parses this and exits 0; the port must not exit 1",
  );
});

test("an empty executable is refused before spawning", () => {
  // The real reachable route: a whitespace-only CCUSAGE_CMD splits to exe "". createDeps
  // now rejects it too, but the process boundary must not rely on a caller's validation.
  assert.throws(
    () => run()("", []),
    (e) => e instanceof UsageError && /no executable was configured/.test(e.message),
  );
});

test("a timeout is reported as a timeout", () => {
  assert.throws(
    () => run({ timeoutMs: 150 })(...script("setTimeout(()=>{}, 10000)")),
    (e) => e instanceof UsageError && /timed out after/.test(e.message),
  );
});

test("output past the capture cap is refused, not silently truncated", () => {
  // Injected limits keep this at kilobytes instead of allocating 64 MiB.
  assert.throws(
    () => run({ maxCaptureBytes: 1024 })(...script('process.stdout.write("a".repeat(5000))')),
    (e) => e instanceof UsageError && /exceeds the limit/.test(e.message),
  );
  // The same single maxBuffer governs stderr — spawnSync has no per-stream setting.
  assert.throws(
    () => run({ maxCaptureBytes: 1024 })(...script('process.stderr.write("a".repeat(5000))')),
    (e) => e instanceof UsageError && /exceeds the limit/.test(e.message),
  );
  // Just under the cap still succeeds.
  const r = run({ maxCaptureBytes: 8192 })(...script('process.stdout.write("a".repeat(1000))'));
  assert.equal(r.stdout.length, 1000);
});

test("a signal kill is reported explicitly, not as an empty result", () => {
  assert.throws(
    () => run()(...script("process.kill(process.pid, 'SIGKILL')")),
    (e) => e instanceof UsageError && /terminated by signal SIGKILL/.test(e.message),
  );
});

// --- truncateUtf8 -----------------------------------------------------------------

test("truncateUtf8 leaves short input untouched", () => {
  assert.equal(truncateUtf8("hello", 100), "hello");
  assert.equal(truncateUtf8("", 100), "");

  // EXACTLY at budget is the boundary the `<=` encodes, and nothing else reached it —
  // `buf.length < maxBytes` survived the whole suite (code review R8). A budget-length
  // stderr is not over budget, so appending a marker to it would both mangle a complete
  // message and push the result PAST the limit this function exists to honour.
  assert.equal(truncateUtf8("a".repeat(100), 100), "a".repeat(100));
  assert.equal(truncateUtf8("a".repeat(101), 100).length < 101, true);
  // Same boundary counted in BYTES, not code units: 50 × 2-byte é is exactly 100 bytes.
  assert.equal(truncateUtf8("é".repeat(50), 100), "é".repeat(50));
  assert.match(truncateUtf8("é".repeat(51), 100), /truncated/);
});

test("truncateUtf8 respects a BYTE budget, marker included", () => {
  const out = truncateUtf8("a".repeat(500), 100);
  assert.ok(Buffer.byteLength(out, "utf8") <= 100, `got ${Buffer.byteLength(out, "utf8")} bytes`);
  assert.match(out, /truncated/, "truncation must be visible, not a silent tail drop");
});

test("truncateUtf8 never splits a multibyte character", () => {
  // 'é' is 2 bytes; cutting at an odd offset would land mid-character.
  const s = "é".repeat(200);
  for (const budget of [40, 41, 42, 43]) {
    const out = truncateUtf8(s, budget);
    assert.ok(Buffer.byteLength(out, "utf8") <= budget);
    assert.ok(!out.includes("�"), `budget ${budget} produced a replacement character`);
  }
  // 4-byte astral characters too.
  const astral = "😀".repeat(100);
  for (const budget of [40, 41, 42, 43]) {
    const out = truncateUtf8(astral, budget);
    assert.ok(Buffer.byteLength(out, "utf8") <= budget);
    assert.ok(!out.includes("�"), `astral budget ${budget} produced a replacement character`);
  }
});

// The budget can be smaller than the marker itself. Appending the whole marker anyway
// returned MORE bytes than requested — the one guarantee this function makes (code review
// R1). Every budget from 0 up must hold, and none may emit a replacement character.
test("truncateUtf8 honours budgets smaller than the truncation marker", () => {
  const markerBytes = Buffer.byteLength("\n[… truncated]", "utf8");
  assert.ok(markerBytes > 1, "fixture assumes a multi-byte marker");
  const s = "a".repeat(500);
  for (let budget = 0; budget <= markerBytes + 2; budget += 1) {
    const out = truncateUtf8(s, budget);
    assert.ok(
      Buffer.byteLength(out, "utf8") <= budget,
      `budget ${budget} produced ${Buffer.byteLength(out, "utf8")} bytes`,
    );
    assert.ok(!out.includes("�"), `budget ${budget} produced a replacement character`);
  }
  assert.equal(truncateUtf8(s, 0), "", "a zero budget yields nothing at all");
});

test("truncateUtf8 keeps the head, so a message after leading whitespace is not lost", () => {
  const out = truncateUtf8(" ".repeat(20) + "REAL ERROR HERE" + "x".repeat(500), 80);
  assert.match(out, /REAL ERROR HERE/);
});

test("stderr is truncated for diagnostics at the production limit", () => {
  const r = run()(
    ...script(`process.stderr.write("z".repeat(${MAX_STDERR_DIAGNOSTIC_BYTES + 5000}))`),
  );
  assert.ok(Buffer.byteLength(r.stderr, "utf8") <= MAX_STDERR_DIAGNOSTIC_BYTES);
  assert.match(r.stderr, /truncated/);
});

// `encoding: "utf8"` on spawnSync substitutes U+FFFD for every malformed byte. ALLOWLIST
// entry 12 already refuses that leniency for rollout FILES, on the grounds that replacement
// "would substitute U+FFFD and hand back a corrupted-but-trusted" value — and the subprocess
// boundary is the same hazard one layer up, with a sharper edge: replacement can turn
// malformed stdout into *parseable* JSON, so the port would print a clean table from altered
// data where usage.py:114 (`subprocess.run(..., text=True)`) raises UnicodeDecodeError and
// exits 1 (code review R7).
//
// Precisely: text mode decodes with errors='strict' using the LOCALE encoding, so "0xFF is
// invalid" holds in the UTF-8 environment the goldens are captured under, not universally —
// under e.g. cp1252 that byte decodes fine. The port always decodes UTF-8 regardless of
// locale, which is the deliberate choice recorded in ALLOWLIST entry 16 (code review R7).
//
// The payload below is exactly that worst case: `{"cost":"\xff"}` is not valid UTF-8, but
// under replacement it decodes to `{"cost":"�"}`, which JSON.parse accepts.
const INVALID_UTF8_BYTES = [0x7b, 0x22, 0x63, 0x6f, 0x73, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d];
const INVALID_UTF8_JSON = JSON.stringify(INVALID_UTF8_BYTES);

test("malformed UTF-8 on stdout is refused, never silently replaced with U+FFFD", () => {
  // First prove the premise rather than assuming it: this really would have become
  // valid JSON under the old lenient decode.
  const replaced = Buffer.from(INVALID_UTF8_BYTES).toString("utf8");
  assert.match(replaced, /�/, "premise: lenient decoding yields a replacement char");
  assert.deepEqual(JSON.parse(replaced), { cost: "�" }, "premise: and it parses as JSON");

  assert.throws(
    () => run()(...script(`process.stdout.write(Buffer.from(${INVALID_UTF8_JSON}))`)),
    (e) => {
      assert.ok(e instanceof UsageError, "must be a clean refusal, not a raw decode throw");
      assert.match(e.message, /stdout that is not valid UTF-8/);
      assert.match(e.message, /cmd: /);
      return true;
    },
  );
});

test("malformed UTF-8 on stderr is refused too", () => {
  assert.throws(
    () => run()(...script(`process.stderr.write(Buffer.from([0xff,0xfe]));process.exit(1)`)),
    (e) => e instanceof UsageError && /stderr that is not valid UTF-8/.test(e.message),
  );
});

test("valid multi-byte UTF-8 still round-trips, including a split-safe BOM", () => {
  // The strict decoder must not become a general refusal: real ccusage output is UTF-8 and
  // must survive untouched. `ignoreBOM: true` means the BOM is PRESERVED, not stripped —
  // the same choice codex.ts makes, so both languages fail to parse a BOM-prefixed payload
  // rather than one silently succeeding (ALLOWLIST entry 12).
  const r = run()(...script('process.stdout.write("\\uFEFF{\\"k\\":\\"é🙂\\"}")'));
  assert.equal(r.stdout, '﻿{"k":"é🙂"}');
  assert.equal(r.stdout.codePointAt(0), 0xfeff, "the BOM is preserved, not consumed");
});

// A fatal TextDecoder throws TypeError both for malformed bytes and for a non-BufferSource
// argument, so an injected string fake would otherwise be reported as "the child produced
// invalid UTF-8" — a claim about the subprocess that is really about our own test wiring.
test("a stream injected as a string is an internal error, not a UTF-8 complaint", () => {
  const spawn = () => ({ status: 0, signal: null, stdout: "{}", stderr: B("") });
  assert.throws(
    () => createRunner({ spawn })("x", []),
    (e) => {
      assert.ok(!(e instanceof UsageError), "must not masquerade as a user-facing ccusage fault");
      assert.match(e.message, /internal: stdout was not captured as bytes \(got string\)/);
      return true;
    },
  );
});

// ORDERING: the process outcome must be classified BEFORE any decoding happens.
//
// Every existing limit/timeout/signal test produces valid or empty UTF-8, so moving the
// decode ahead of classification would leave the whole suite green — while in production a
// capture cut mid-character (ENOBUFS truncates at a BYTE limit, and a SIGKILL can land
// anywhere) would report "not valid UTF-8" instead of the real reason the run failed. The
// diagnosis would name the wrong problem entirely (code review R7).
test("a malformed capture never masks the reason the process failed", () => {
  const BAD = Buffer.from([0xff, 0xfe]); // invalid UTF-8 on BOTH streams
  const cases = [
    [{ status: null, signal: null, stdout: BAD, stderr: BAD, error: errno("ENOBUFS") }, /exceeds the limit/],
    [{ status: null, signal: null, stdout: BAD, stderr: BAD, error: errno("ETIMEDOUT") }, /timed out after/],
    [{ status: null, signal: null, stdout: BAD, stderr: BAD, error: errno("EACCES") }, /could not run ccusage \(EACCES\)/],
  ];
  // NOTE the signal and no-status cases are deliberately NOT in this list. Their verdict
  // depends on whether stdout is blank (Python's `returncode != 0 AND not stdout.strip()`),
  // so they cannot be decided before decoding — and Python decodes even earlier, inside
  // `subprocess.run`, so a malformed stream raises there regardless of returncode. Those two
  // are covered below with VALID bytes (code review R8).
  for (const [res, expected] of cases) {
    assert.throws(
      () => createRunner({ spawn: () => res })("x", []),
      (e) => {
        assert.ok(e instanceof UsageError);
        assert.match(e.message, expected);
        assert.doesNotMatch(
          e.message,
          /not valid UTF-8/,
          `decoding ran before classification: ${e.message}`,
        );
        return true;
      },
      `expected ${expected}`,
    );
  }

  // ENOENT is the same hazard in return form rather than throw form: it does not throw, so
  // a decode there would replace the frozen "'X' not found" message runCcusage builds from
  // spawnError. The child never ran, so these streams are not decoded at all.
  const r = createRunner({ spawn: () => ({ status: null, signal: null, stdout: BAD, stderr: BAD, error: errno("ENOENT") }) })("x", []);
  assert.equal(r.spawnError?.code, "ENOENT", "must still travel as the frozen not-found signal");
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");

  // The signal / no-status pair, with VALID bytes so the blankness rule is what is measured.
  assert.throws(
    () => createRunner({ spawn: () => ({ status: null, signal: "SIGKILL", stdout: B(""), stderr: B("boom") }) })("x", []),
    (e) => e instanceof UsageError && /terminated by signal SIGKILL/.test(e.message),
  );
  assert.throws(
    () => createRunner({ spawn: () => ({ status: null, signal: null, stdout: B(""), stderr: B("") }) })("x", []),
    (e) => e instanceof UsageError && /without an exit status/.test(e.message),
  );
});

// CPython's `text=True` wraps each pipe in a TextIOWrapper with `newline=None`, i.e.
// UNIVERSAL NEWLINES: `\r\n` and a lone `\r` both become `\n`. Neither `encoding: "utf8"`
// nor a bare TextDecoder does that, so the port carried raw CRs into `ccusage failed:
// {stderr}` — a message that comes from usage.py and is byte-frozen (code review R8).
//
// Expected value measured against CPython, not derived from the implementation:
//   subprocess.run([...], capture_output=True, text=True).stderr == 'E1\nE2\nE3'
test("captured output gets Python's universal-newline translation", () => {
  const r = run()(
    ...script('process.stderr.write("E1\\r\\nE2\\rE3");process.stdout.write("A\\r\\nB")'),
  );
  assert.equal(r.stderr, "E1\nE2\nE3", "CRLF and lone CR must both become LF");
  assert.equal(r.stdout, "A\nB", "stdout is translated too — Python wraps both pipes");
  // A bare LF is untouched, and a CR is never DROPPED (that would silently join lines).
  const plain = run()(...script('process.stderr.write("x\\ny")'));
  assert.equal(plain.stderr, "x\ny");
});

// `SpawnResultLike` types both streams as `Buffer | null`, and `spawnSync` really does report
// null (a stream that was not piped, or a spawn that produced nothing). Every fake supplied a
// Buffer, so dropping `?? EMPTY` on the decoding path survived the suite (code review R8).
// Without the coalesce, `decodeStream`'s Buffer.isBuffer guard turns a perfectly ordinary
// empty capture into an "internal:" wiring error.
test("a null stdout/stderr capture decodes as empty, not as an internal error", () => {
  const r = createRunner({ spawn: () => ({ status: 0, signal: null, stdout: null, stderr: null }) })(
    "x",
    [],
  );
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");

  // And a null stdout still counts as BLANK for the missing-status rule, so that path keeps
  // Python's `not stdout.strip()` semantics rather than crashing ahead of it.
  assert.throws(
    () =>
      createRunner({ spawn: () => ({ status: null, signal: "SIGKILL", stdout: null, stderr: null }) })(
        "x",
        [],
      ),
    (e) => e instanceof UsageError && /terminated by signal SIGKILL/.test(e.message),
  );
});

// ALLOWLIST entry 18: the child gets NO stdin. Python's `capture_output=True` redirects only
// the two output streams and leaves stdin inherited (measured: a child spawned that way reads
// the parent's fd 0), so this is a deliberate divergence in the safe direction — a ccusage
// that ever read stdin would block usage.py forever on a terminal and return here. Pinned so
// the option cannot be "cleaned up" into inheritance without tripping something.
test("the ccusage child is given no stdin, per ALLOWLIST 18", () => {
  const r = run()(
    ...script('process.stdout.write(JSON.stringify({stdin: require("fs").readFileSync(0).toString()}))'),
  );
  assert.equal(r.status, 0, "reading fd 0 must succeed, not fail — 'ignore' means /dev/null");
  assert.deepEqual(JSON.parse(r.stdout), { stdin: "" }, "the child must see immediate EOF");
});
