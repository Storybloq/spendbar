/**
 * T-008 §4 — tests for the credential fallback and the pre-bind path guard.
 *
 * Run: node --test spikes/socket-cred/auth.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const fsyncDirNoop = () => {};
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { DARWIN_ONLY, POSIX_ONLY } from "../platform.mjs";

import {
  AuthError, SUN_PATH_MAX, TOKEN_BYTES, assertBindablePath, publishToken, readToken,
  tokenMatches, validateRuntimeDirStat, validateTokenStat, writeAll,
} from "./auth.mjs";
import { REVIEWED_MAJOR, probeOnConnectedUnixSocket, probePeerCredentials, renderFinding } from "./probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const dirs = [];
const workdir = () => {
  const d = mkdtempSync(join(tmpdir(), "spendbar-auth-"));
  dirs.push(d);
  return d;
};
after(() => {
  // Independent removals, failures aggregated. I fixed this in three suites last round and missed
  // two — including this one — while writing "all three teardowns" into the report. Fixing a class
  // in some of its sites and believing it fixed everywhere is this ticket's most persistent defect.
  const problems = [];
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); }
    catch (err) { problems.push(`remove ${d}: ${err.message}`); }
  }
  if (problems.length) throw new Error(`teardown could not clean up: ${problems.join("; ")}`);
});

// ---------------------------------------------------------------------------- path guard

test("an over-long CANONICAL path is rejected and listen is never called", { skip: POSIX_ONLY }, () => {
  const dir = workdir();
  const path = join(dir, "x".repeat(SUN_PATH_MAX));
  // The spy is the contract: rejection must happen BEFORE bind, because the kernel was measured
  // to bind the 104-byte prefix silently while listen() reports success. A guard that ran after
  // listen would be checking an API already observed to lie.
  let listenCalled = false;
  const spyServer = { listen: () => { listenCalled = true; } };
  assert.throws(() => { spyServer.listen(assertBindablePath(path, { root: dir })); }, AuthError);
  assert.equal(listenCalled, false, "listen was never reached");
});

test("the guard measures the canonical form: a path that fits pre-realpath but not post- is refused", { skip: POSIX_ONLY }, () => {
  const requested = "/tmp/" + "y".repeat(95);                      // 100 bytes as written
  const fakeRealpath = () => "/private/tmp";                       // canonical: 108 bytes
  assert.equal(Buffer.byteLength(requested), 100);
  assert.throws(() => assertBindablePath(requested, { realpath: fakeRealpath }), /108 bytes canonical/);
});

test("the real macOS layout initializes fine: /tmp being a symlink is the trusted root, not a violation", {
  // The /tmp -> /private/tmp expansion is a macOS fact; asserting it on Linux would fail for a
  // reason that says nothing about the code. Skipped WITH A REASON rather than silently, and the
  // macOS CI job requires zero skips so this cannot quietly stop running where it matters.
  skip: DARWIN_ONLY,
}, () => {
  const canonical = assertBindablePath("/tmp/spendbar-auth-test.sock", { root: "/tmp" });
  assert.match(canonical, /^\/private\/tmp\//, "canonicalization resolved the platform symlink");
});

test("a symlink BELOW the trusted root is refused", { skip: POSIX_ONLY }, () => {
  const dir = workdir();
  const real = join(dir, "real");
  mkdirSync(real);
  symlinkSync(real, join(dir, "sneaky"));
  // The bug this test caught in the first implementation: realpath'ing the full parent resolves
  // the symlink and the guard never sees it. The root is canonicalized; "sneaky" must not be.
  assert.throws(() => assertBindablePath(join(dir, "sneaky", "svc.sock"), { root: dir }), /symlink below the trusted root/);
});

test("TRAVERSAL: dot-dot, dot, and empty components are refused — the reproduced escape cannot recur", { skip: POSIX_ONLY }, () => {
  // Review round 1's critical, REPRODUCED before fixing: "/tmp/../etc/svc.sock" starts with
  // "/tmp/", passed the prefix check, and came back as /private/tmp/../etc/svc.sock — outside
  // the root the moment the filesystem resolves it. Every shape of that escape is a fixture.
  for (const evil of [
    "/tmp/../etc/svc.sock",
    "/tmp/a/../../etc/svc.sock",
    "/tmp/a/../../../var/svc.sock",
    "/tmp/./svc.sock",
    "/tmp//svc.sock",
    "/tmp/a//b/svc.sock",
  ]) {
    assert.throws(() => assertBindablePath(evil, { root: "/tmp" }), /component; refusing/, `${evil} must be refused`);
  }
  // And the guard still admits the boring path, so the rule is refusal of traversal, not of /tmp.
  // (Single component: the symlink walk lstats intermediate dirs, which must exist — in real
  // startup the runtime dir is created and validated before this guard runs.)
  const ok = assertBindablePath("/tmp/svc-traversal-test.sock", { root: "/tmp" });
  assert.ok(ok.endsWith("/svc-traversal-test.sock"), "the boring path is still admitted");
});

// ---------------------------------------------------------------------------- runtime dir

test("runtime directory validation: the primary isolation boundary, every branch via injected stats", () => {
  const uid = 501;
  const good = { isDirectory: () => true, isSymbolicLink: () => false, uid, mode: 0o40700 };
  assert.equal(validateRuntimeDirStat(good, { uid }), true);
  assert.throws(() => validateRuntimeDirStat(null, { uid }), /missing/);
  assert.throws(() => validateRuntimeDirStat({ ...good, isSymbolicLink: () => true }, { uid }), /symlink/);
  assert.throws(() => validateRuntimeDirStat({ ...good, isDirectory: () => false }, { uid }), /not a directory/);
  assert.throws(() => validateRuntimeDirStat({ ...good, uid: 0 }, { uid }), /owned by uid 0/);
  // EXACT 0700 — 0755 and 0777 are the classic pre-existing-dir attacks, 0500 is broken-but-ours,
  // and all of them mean this protocol did not create the directory it is about to trust.
  for (const mode of [0o40755, 0o40777, 0o40500, 0o40770]) {
    assert.throws(() => validateRuntimeDirStat({ ...good, mode }, { uid }), /expected exactly 700/);
  }
  // REGRESSION: setuid, setgid and sticky live ABOVE the low nine bits, so masking with 0o777 let
  // 01700 / 02700 / 04700 pass an "exactly 700" check (review round 5). A sticky or setgid runtime
  // directory is precisely the "something else created this" signal exact-mode validation exists
  // to catch. The mutant this kills is the one-character revert of 0o7777 back to 0o777.
  for (const special of [0o1000, 0o2000, 0o4000]) {
    assert.throws(
      () => validateRuntimeDirStat({ ...good, mode: 0o40700 | special }, { uid }),
      /expected exactly 700/,
      `mode ${(0o700 | special).toString(8)} must be refused`,
    );
  }
});

test("REGRESSION: an injected stat is read ONCE per property, so the message names the value that was JUDGED", () => {
  // Both validators are DESIGNED to take an injected stat — that is how the foreign-owner branches
  // are reachable without root — and both were written as `if (st.X !== ok) throw new AuthError(...
  // ${st.X} ...)`: validate, then re-read the same property to build the message. Identical to the
  // shape round 13 found in the credential probe, and here the hostile input is the SUPPORTED one.
  //
  // The discriminator has to be a FAILING check. A getter returning good-then-bad never reaches the
  // second read, because the second read only happens when the value is rejected — my first version
  // of this test asserted exactly that and the double-read mutant survived it. So each property is
  // given two DIFFERENT rejectable values: the error must name the first, and the read counter must
  // still be 1. Code that re-reads reports the second value and is caught by both assertions.
  for (const [label, validate, base, hostile] of [
    ["runtime dir", validateRuntimeDirStat,
      { isDirectory: () => true, isSymbolicLink: () => false, uid: 501, mode: 0o40700 },
      { uid: [901, 902], mode: [0o40755, 0o40777] }],
    ["token", validateTokenStat,
      { isFile: () => true, uid: 501, mode: 0o100600, size: 64 },
      { uid: [901, 902], mode: [0o100644, 0o100666], size: [11, 22] }],
  ]) {
    for (const [key, [first, second]] of Object.entries(hostile)) {
      let reads = 0;
      const st = { ...base };
      Object.defineProperty(st, key, {
        enumerable: true,
        get() { return ++reads === 1 ? first : second; },
      });
      // The reported number is the low bits for a mode, the raw value otherwise — either way it is
      // derived from the FIRST read and must never be the second.
      const expected = key === "mode" ? (first & 0o7777).toString(8) : String(first);
      const forbidden = key === "mode" ? (second & 0o7777).toString(8) : String(second);
      let message = null;
      assert.throws(() => validate(st, { uid: 501 }), (err) => { message = err.message; return true; },
        `${label}: a bad ${key} must be rejected`);
      assert.ok(message.includes(expected),
        `${label}: the error must name the ${key} it judged (${expected}); got: ${message}`);
      assert.ok(!message.includes(forbidden),
        `${label}: the error named ${forbidden}, a value read AFTER the decision; got: ${message}`);
      assert.equal(reads, 1, `${label}: st.${key} was read ${reads} times; exactly 1 is allowed`);
    }
  }
});

test("REGRESSION: the stat METHOD members are read once too, not once per typeof and once per call", () => {
  // `typeof st.X === "function" ? st.X() : st.X` reads the property twice, so a getter can satisfy
  // the typeof check and then hand back a non-function (a TypeError instead of a named refusal), or
  // return a different predicate than the one that was type-checked. The value fields were fixed
  // first and these were missed in the same pass — the same partial-sweep shape this ticket keeps
  // producing (review round 15).
  for (const [label, validate, base, members] of [
    ["runtime dir", validateRuntimeDirStat,
      { uid: 501, mode: 0o40700 }, { isDirectory: true, isSymbolicLink: false }],
    ["token", validateTokenStat, { uid: 501, mode: 0o100600, size: 64 }, { isFile: true }],
  ]) {
    const reads = {};
    const st = { ...base };
    for (const [name, answer] of Object.entries(members)) {
      reads[name] = 0;
      Object.defineProperty(st, name, {
        enumerable: true,
        // A callable on the first read; a NON-callable afterwards. Code that reads twice calls
        // `st.X()` on the second value and dies with a TypeError instead of validating.
        get() { return ++reads[name] === 1 ? () => answer : "not a function"; },
      });
    }
    assert.equal(validate(st, { uid: 501 }), true, `${label}: validates from the first read`);
    for (const [name, n] of Object.entries(reads)) {
      assert.equal(n, 1, `${label}: st.${name} was read ${n} times; exactly 1 is allowed`);
    }
  }
});

test("REGRESSION: publishToken reads each hook exactly once", { skip: POSIX_ONLY }, () => {
  // The existing hostile-getter test throws on the FIRST access, which cannot distinguish one read
  // from two, and it covered only `beforeLink` — `removeCandidate` and `syncDir` were unmeasured
  // (review round 15). Counting reads on hooks that SUCCEED is what discriminates.
  const p = join(workdir(), "token");
  const reads = { beforeLink: 0, removeCandidate: 0, syncDir: 0 };
  const calls = [];
  const hooks = {};
  for (const name of Object.keys(reads)) {
    Object.defineProperty(hooks, name, {
      enumerable: true,
      get() {
        reads[name]++;
        // removeCandidate and syncDir must still do their real work, or the publication under test
        // is not the one the rest of the suite verifies.
        if (name === "removeCandidate") return (f) => { calls.push(name); rmSync(f, { force: true }); };
        if (name === "syncDir") return () => { calls.push(name); };
        return () => { calls.push(name); };
      },
    });
  }
  const { token, warning } = publishToken(p, { tag: "counted", hooks });
  assert.equal(warning, null, "the clean path reports no warning");
  assert.equal(readToken(p), token, "and the token really was published");
  for (const [name, n] of Object.entries(reads)) {
    assert.equal(n, 1, `hooks.${name} was read ${n} times; each hook must be resolved exactly once`);
  }
  assert.deepEqual(calls, ["beforeLink", "syncDir", "removeCandidate"],
    "and each ran once, in publication order");
});

// ---------------------------------------------------------------------------- token

test("token publication race, held INSIDE the window: the loser adopts the winner's token", { skip: POSIX_ONLY }, () => {
  const p = join(workdir(), "token");
  // Not two sequential calls — that exercises none of the race this protocol exists for. A is
  // held between completing its candidate and linking it (the actual window); B publishes fully
  // inside that window; then A links, loses with EEXIST, and must come back with B's token.
  let tokenB;
  const { token: tokenA } = publishToken(p, {
    tag: "a",
    hooks: { beforeLink: () => { tokenB = publishToken(p, { tag: "b" }).token; } },
  });
  assert.equal(tokenA, tokenB, "A lost the link and adopted B's token instead of clobbering it");
  assert.equal(readToken(p), tokenB);
  assert.equal(tokenB.length, TOKEN_BYTES * 2);

  // BOTH candidates were cleaned up. Convergence alone left this unpinned: a mutant dropping either
  // `rmSync` satisfied every assertion above and merely stranded a `.tmp` beside the token, which
  // the suite's recursive directory teardown then removed without comment (review round 11).
  assert.deepEqual(readdirSync(dirname(p)).sort(), ["token"],
    "the race left exactly the published token — no candidate residue from either writer");
});

test("the documented-surface claim is issued ONLY for the Node version actually reviewed", () => {
  const clean = { answer: "no", verified: [], nominated: [], nearby: [], surfaceSize: 120 };

  const reviewed = renderFinding(`${REVIEWED_MAJOR}.18.0`, clean);
  assert.match(reviewed, /Reviewed documented surface/);
  assert.doesNotMatch(reviewed, /UNVERIFIED/);
  assert.match(reviewed, /ANSWER: no peer-UID API/);

  // Any other major: the enumeration still stands, the documentation claim must not be made.
  for (const v of [`${REVIEWED_MAJOR + 1}.0.0`, `${REVIEWED_MAJOR + 2}.5.1`, `${REVIEWED_MAJOR - 1}.9.0`]) {
    const out = renderFinding(v, clean);
    assert.match(out, /UNVERIFIED/, `Node ${v} must not claim a review that was never done`);
    assert.doesNotMatch(out, /Reviewed documented surface/);
    assert.doesNotMatch(out, /ANSWER: no peer-UID API/,
      "and it must not print the unqualified negative either — that is the claim resting on the review");
    assert.match(out, /enumeration only/);
  }

  // A verified capability overrides both branches, on every version.
  for (const v of [`${REVIEWED_MAJOR}.18.0`, `${REVIEWED_MAJOR + 1}.0.0`]) {
    assert.match(renderFinding(v, { ...clean, answer: "yes", verified: [{ name: "peerUid" }] }), /ANSWER CHANGED/);
  }
});

test("a nominated property whose uid getter THROWS is unverifiable, not fatal", () => {
  // One hostile nominee used to abort the entire probe, turning "this candidate cannot be verified"
  // into "no answer at all" — in a gate whose only output is the answer. The uid is also read once
  // now, so a stateful accessor cannot report a different value than the one that was verified.
  let reads = 0;
  const hostile = Object.create(net.Socket.prototype);
  Object.defineProperty(hostile, "peerCred", {
    enumerable: true,
    get() { reads++; return { get uid() { throw new Error("hostile uid getter"); } }; },
  });
  const r = probePeerCredentials(hostile);
  assert.equal(r.answer, "no", "an unverifiable nominee is not a capability");
  assert.ok(reads > 0, "precondition: the nominee really was inspected");
  const entry = r.nominated.find((c) => c.name === "peerCred");
  assert.ok(entry, "it was nominated by name");
  assert.equal(entry.verified, false);
  assert.match(entry.why, /uid getter threw/, "and the reason names what actually happened");
});

// The test above cannot catch a double read: its uid getter throws on the FIRST access, so code that
// reads twice never reaches the second read and behaves identically. Its `reads` counter measures
// peerCred access, not uid access. That gap is why the "read once" claim above survived two rounds
// while both branches of the probe still read the getter twice — once to validate, once to build the
// message. These two tests measure the uid getter itself, and they fail on the code that shipped.
for (const shape of [
  { branch: "property", nominate: (get) => ({ enumerable: true, get: () => ({ get uid() { return get(); } }) }) },
  { branch: "callable", nominate: (get) => ({ enumerable: true, value: () => ({ get uid() { return get(); } }) }) },
]) {
  test(`a ${shape.branch} nominee's uid getter is read EXACTLY ONCE, so a stateful accessor cannot lie`, () => {
    // First access returns a valid uid; every later access returns garbage. Code that reads twice
    // either records the garbage or rejects a capability it had already verified — and which of
    // those two it does depends on the second value, so neither outcome is safely wrong.
    let reads = 0;
    const stateful = () => (++reads === 1 ? 501 : -7);
    const nominee = Object.create(net.Socket.prototype);
    Object.defineProperty(nominee, "peerCred", shape.nominate(stateful));

    const r = probePeerCredentials(nominee);
    assert.equal(reads, 1, `the uid getter was read ${reads} times; the single-read guarantee allows exactly 1`);
    assert.equal(r.answer, "yes", "the first read verified a real uid, so the capability is verified");
    const entry = r.nominated.find((c) => c.name === "peerCred");
    assert.equal(entry.verified, true);
    assert.match(entry.why, /uid 501/, "and it reports the uid it actually verified, not a later value");
  });
}

test("the sun_path limit is INCLUSIVE: exactly 104 bytes binds, 105 is refused", { skip: POSIX_ONLY, timeout: 15_000 }, () => {
  // The existing tests reject paths well over the limit and accept ordinary short ones, which
  // leaves `> SUN_PATH_MAX` and `>= SUN_PATH_MAX` indistinguishable — a mutant rejecting the last
  // VALID length would keep every one of them green (review round 12). Since the whole finding here
  // is that macOS silently truncates rather than erroring, being one byte too strict is a real
  // regression: it refuses a path the kernel handles correctly.
  //
  // An injected realpath makes the canonical length exact and independent of the machine's tmpdir,
  // which is the only way to sit precisely on the boundary rather than near it.
  const root = "/canon";
  const realpath = (p) => (p === root ? root : p);
  const exact = `${root}/${"x".repeat(SUN_PATH_MAX - root.length - 1)}`;
  assert.equal(Buffer.byteLength(exact), SUN_PATH_MAX, "precondition: the fixture is exactly at the limit");
  assert.equal(assertBindablePath(exact, { root, realpath, lstat: () => ({ isSymbolicLink: () => false }) }), exact,
    `${SUN_PATH_MAX} bytes is the last VALID length and must be accepted`);

  const oneOver = `${root}/${"x".repeat(SUN_PATH_MAX - root.length)}`;
  assert.equal(Buffer.byteLength(oneOver), SUN_PATH_MAX + 1, "precondition: one byte over");
  assert.throws(() => assertBindablePath(oneOver, { root, realpath, lstat: () => ({ isSymbolicLink: () => false }) }), AuthError,
    "and one byte over must be refused BEFORE listen, because the kernel would truncate instead of failing");
});

test("REGRESSION: a restrictive umask cannot publish a permanently-unreadable token", { skip: POSIX_ONLY, timeout: 15_000 }, async () => {
  // Measured, not argued: the mode argument to open() is filtered through the process umask, so it
  // is a REQUEST. Under `umask 0200` the candidate is created 0400, linkSync publishes that mode
  // WRITE-ONCE, and readToken then refuses it forever — "token mode is 400, expected exactly 600".
  // Startup is permanently broken and retrying cannot repair it, because the token is never
  // rewritten. A valid umask silently bricking the install is the worst class of defect this gate
  // exists to find: correct code, correct configuration, permanently wrong result (round 12).
  //
  // Run in a CHILD process because process.umask() is global — setting it in-process would leak
  // into every test that runs after this one, in a suite whose files share a runner.
  const dir = mkdtempSync(join(tmpdir(), "spendbar-auth-umask-"));
  dirs.push(dir);
  const script = join(dir, "child.mjs");
  const tokenPath = join(dir, "token");
  writeFileSync(script, `
    import { publishToken, readToken } from ${JSON.stringify(join(HERE, "auth.mjs"))};
    import { statSync } from "node:fs";
    process.umask(0o200);
    const { token } = publishToken(${JSON.stringify(tokenPath)});
    const mode = statSync(${JSON.stringify(tokenPath)}).mode & 0o7777;
    process.stdout.write(JSON.stringify({ mode: mode.toString(8), readable: readToken(${JSON.stringify(tokenPath)}) === token }));
  `);
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
  assert.equal(r.error, undefined, `child was killed rather than finishing: ${r.error?.message}`);
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, "600", "the published token must be exactly 600 regardless of the umask in force");
  assert.equal(out.readable, true, "and readToken must accept what publishToken published");
});

test("a post-link failure reports a WARNING, never a publication failure", { skip: POSIX_ONLY, timeout: 15_000 }, () => {
  // The token is public and write-once the instant linkSync returns, so a later failure — the
  // directory fsync, the candidate removal — must not be reported as "publication failed". Telling
  // the caller to retry an operation that can never be redone is the same stranded-state bug the
  // write-once port allocation needed three rounds to eliminate, on this file's own irreversible
  // boundary (review round 12).
  const dir = mkdtempSync(join(tmpdir(), "spendbar-auth-postlink-"));
  dirs.push(dir);
  const p = join(dir, "token");
  const boom = new Error("simulated cleanup failure after the link");

  const { token, warning } = publishToken(p, { hooks: { removeCandidate: () => { throw boom; } } });
  assert.equal(token.length, TOKEN_BYTES * 2, "the token is returned even though cleanup failed");
  assert.equal(warning, boom, "and the failure is surfaced as a warning rather than thrown");
  assert.equal(readToken(p), token, "the published token is live and readable");

  // EVERY post-link operation, not just the one that was easy to inject. Cleanup was the only
  // branch covered, so the directory fsync could still have thrown straight out of the function and
  // reported a published token as a failed publication (review round 13).
  const p2 = join(dir, "token2");
  const fsyncBoom = new Error("simulated fsync failure after the link");
  const r2 = publishToken(p2, { hooks: { syncDir: () => { throw fsyncBoom; } } });
  assert.equal(r2.warning, fsyncBoom, "a post-link durability failure is a warning, not a throw");
  assert.equal(r2.token.length, TOKEN_BYTES * 2);
  assert.equal(readToken(p2), r2.token, "the token really is published despite the fsync failure");

  // And the winner never re-reads the published file, so a read that would fail cannot turn a
  // successful publication into a reported failure. Proven by making the file unreadable the
  // instant it is linked: publishToken must still return the token it generated.
  const p3 = join(dir, "token3");
  const r3 = publishToken(p3, { hooks: { syncDir: (d) => { chmodSync(p3, 0o000); fsyncDirNoop(d); } } });
  assert.equal(r3.token.length, TOKEN_BYTES * 2, "the winner returns the token it generated, not one it re-read");
  assert.throws(() => readToken(p3), AuthError, "precondition: the published file really is unreadable now");
  chmodSync(p3, 0o600);
  assert.equal(readToken(p3), r3.token, "and once readable again it matches what publishToken returned");
});

test("REGRESSION: a candidate-NAME collision never deletes the other attempt's file", { skip: POSIX_ONLY }, () => {
  // Cleanup used to run unconditionally, so an `openSync(candidate,"wx")` that failed EEXIST — a tag
  // collision with another publisher mid-flight — removed a file this call never created. The same
  // errno was also read as "we lost the token link" although linkSync was never reached, so the
  // failure was swallowed and the function went on to read a token that need not exist.
  //
  // Every other test here uses a fresh tag, which is exactly why this path stayed invisible: the
  // convergence assertions still passed and the suite's recursive teardown removed the residue
  // without comment (review round 14).
  const dir = workdir();
  const p = join(dir, "token");
  const sentinel = "another publisher's in-progress candidate";
  writeFileSync(`${p}.taken.tmp`, sentinel, { mode: 0o600 });

  assert.throws(() => publishToken(p, { tag: "taken" }), { code: "EEXIST" },
    "a candidate collision is an error, not a silent adoption of a token nobody published");
  assert.equal(readFileSync(`${p}.taken.tmp`, "utf8"), sentinel,
    "and the other attempt's candidate is byte-identical — this call must not delete what it did not create");
  assert.deepEqual(readdirSync(dir).sort(), ["token.taken.tmp"], "nothing was published");
});

test("REGRESSION: a throwing beforeLink hook publishes nothing and leaves no candidate behind", () => {
  // The failure-path half of the cleanup contract, which the race test above cannot reach: it only
  // exercises paths where the link is attempted. Here the hook throws BEFORE the link, so nothing is
  // published — and the candidate must still be gone.
  //
  // This also pins the hook being resolved and invoked inside the cleanup guard. Reading
  // `hooks.beforeLink` is a property access a getter can make throw, and the call originally sat
  // outside the `finally` that removes the candidate — the same pair of defects the write-once
  // allocation needed three rounds to eliminate, still present in this file's publication path
  // until round 11.
  const dir = mkdtempSync(join(tmpdir(), "spendbar-auth-hookfail-"));
  dirs.push(dir);
  const p = join(dir, "token");
  const boom = new Error("simulated failure before the link");

  assert.throws(() => publishToken(p, { tag: "a", hooks: { beforeLink: () => { throw boom; } } }), /before the link/);
  assert.deepEqual(readdirSync(dir), [], "a failed publication leaves neither a token nor a candidate");

  // And a hostile GETTER on the hooks object fails the same way — resolved before the candidate
  // exists, so there is nothing to clean up and nothing to strand.
  const hostile = {};
  Object.defineProperty(hostile, "beforeLink", { enumerable: true, get() { throw new Error("hostile hook getter"); } });
  assert.throws(() => publishToken(p, { tag: "a", hooks: hostile }), /hostile hook getter/);
  assert.deepEqual(readdirSync(dir), [], "and a hook that cannot even be resolved leaves nothing either");

  // The control: the same path publishes normally once the hook is well-behaved.
  const { token, warning } = publishToken(p, { tag: "a" });
  assert.equal(warning, null, "the clean path reports no warning, and the shape is the same either way");
  assert.equal(token.length, TOKEN_BYTES * 2);
  assert.deepEqual(readdirSync(dir), ["token"]);
});

test("REGRESSION: token comparison hashes FIRST — wrong length and wrong bytes share one code path", () => {
  // The documented property is that a wrong-length token and a wrong-byte token are rejected by
  // the same instructions: timingSafeEqual's own length-mismatch THROW is a length oracle, and an
  // early length return is a timing branch. Asserting only the false/true results cannot tell those
  // apart — my mutation sweep proved it, by adding an early length return that the entire suite
  // accepted. What discriminates is that the comparator is REACHED, with two equal-length digests.
  const seen = [];
  const spy = (a, b) => { seen.push([a.length, b.length]); return a.equals(b); };

  assert.equal(tokenMatches("a".repeat(64), "b".repeat(4), { compare: spy }), false, "wrong length rejects");
  assert.equal(tokenMatches("a".repeat(64), "c".repeat(64), { compare: spy }), false, "wrong bytes reject");
  assert.equal(tokenMatches("d".repeat(64), "d".repeat(64), { compare: spy }), true, "the real token matches");

  assert.equal(seen.length, 3, "every comparison reached the comparator — no early length return");
  for (const [la, lb] of seen) {
    assert.equal(la, 32, "presented was hashed to a fixed-size digest before comparison");
    assert.equal(lb, 32, "actual was hashed to a fixed-size digest before comparison");
  }
});

test("writeAll survives a short-writing fd; a zero-progress write is an error, not a spin", () => {
  // The injected write yields one byte at a time — the behaviour writeSync is PERMITTED to have
  // and almost never shows, which is exactly why it needs an injection to be testable.
  const sink = [];
  const oneByte = (fd, buf, off) => { sink.push(buf[off]); return 1; };
  writeAll(1, Buffer.from("abc"), { write: oneByte });
  assert.deepEqual(Buffer.from(sink).toString(), "abc");
  assert.throws(() => writeAll(1, Buffer.from("abc"), { write: () => 0 }), /no progress/);
});

test("ownership validation via injected stats: every rejection branch is reachable without root", () => {
  const uid = 501;
  const good = { isFile: () => true, uid, mode: 0o100600, size: 64 };
  assert.equal(validateTokenStat(good, { uid }), true);
  assert.throws(() => validateTokenStat({ ...good, uid: 502 }, { uid }), /owned by uid 502/);
  assert.throws(() => validateTokenStat(null, { uid }), /missing/);
  assert.throws(() => validateTokenStat({ ...good, isFile: () => false }, { uid }), /not a regular file/);
  assert.throws(() => validateTokenStat({ ...good, mode: 0o100644 }, { uid }), /expected exactly 600/);
  // 0700 slipped past the first version's group/world-bits check; exact-mode comparison is the fix.
  assert.throws(() => validateTokenStat({ ...good, mode: 0o100700 }, { uid }), /expected exactly 600/);
  // REGRESSION, same class as the runtime dir: the special bits sit above the low nine, so a
  // 0o777 mask accepted 04600 as "exactly 600". A setuid token file is not our token file.
  for (const special of [0o1000, 0o2000, 0o4000]) {
    assert.throws(() => validateTokenStat({ ...good, mode: 0o100600 | special }, { uid }), /expected exactly 600/);
  }
  assert.throws(() => validateTokenStat({ ...good, size: 12 }, { uid }), /12 bytes/);
});

test("a symlink planted at the token path is refused by the real lstat path", { skip: POSIX_ONLY }, () => {
  const dir = workdir();
  const target = join(dir, "elsewhere");
  writeFileSync(target, "f".repeat(64), { mode: 0o600 });
  const tokenPath = join(dir, "token");
  symlinkSync(target, tokenPath);
  assert.throws(() => readToken(tokenPath), /not a regular file/);
});

test("tokenMatches: one code path — wrong length and wrong bytes are the same rejection, and only the exact token passes", () => {
  const token = "a".repeat(64);
  assert.equal(tokenMatches("a".repeat(63), token), false);
  assert.equal(tokenMatches("b".repeat(64), token), false);
  assert.equal(tokenMatches("", token), false);
  assert.equal(tokenMatches(token, token), true);
  // Digest-compare means there IS no early length return to observe; this asserts the outcome
  // (uniform false) — the structural claim lives in the implementation, which has a single path.
});

// ---------------------------------------------------------------------------- probe falsifiability

test("the probe on a REAL CONNECTED unix socket answers NO", { skip: POSIX_ONLY, timeout: 15_000 }, async () => {
  // An unconnected `new net.Socket()` is the wrong subject: a genuine peer-credential API would
  // need an accepted connection and would plausibly throw ENOTCONN on a bare socket, so the probe
  // would answer "no" for the wrong reason and the false-negative would be invisible.
  const real = await probeOnConnectedUnixSocket();
  assert.equal(real.answer, "no", `Node ${process.version} exposes no verified peer-credential surface on a connected socket`);
  assert.deepEqual(real.verified, []);
  assert.ok(real.surfaceSize > 50, "the enumeration actually walked a real surface");
});

test("an injected REAL capability flips the answer to YES — under a string key, a prototype key, and a Symbol key", () => {
  // A probe that has never answered yes is a constant, not a detector.
  const symbolCase = Object.create(net.Socket.prototype);
  symbolCase[Symbol("peerCred")] = () => ({ uid: 0 });
  for (const injected of [
    Object.assign(new net.Socket(), { getPeerCredentials: () => ({ uid: 0 }) }),
    Object.create({ peerCred: { uid: 501 } }),
    symbolCase,
    // REGRESSION (review round 6): the two most plausible shapes a real API could take were both
    // scored INERT, because verification demanded an object with a .uid. A bare uid is the answer
    // ONLY under a name that says so (peerUid/peerEid/getpeereid) — round 6's first rule accepted
    // a bare integer from anything credential-ish, and was rejected for scoring `socket.credits`
    // or an unrelated `soPeerTimeout` as a peer-credential API. A false negative here is exactly
    // what the gate's recorded "NO" would have been resting on.
    Object.assign(new net.Socket(), { peerUid: 501 }),
    Object.assign(new net.Socket(), { getPeerUid: () => 501 }),
    Object.assign(new net.Socket(), { peer_uid: 0 }),          // uid 0 is a real uid, not falsy-absent
  ]) {
    assert.equal(probePeerCredentials(injected).answer, "yes", "a verified credential capability MUST flip the answer");
  }
});

test("two Symbols sharing a description do not shadow each other — only the second verifies", () => {
  // Keying the surface by rendered Symbol description collapsed distinct Symbols into one entry,
  // so an inert Symbol("peerCred") encountered first could hide a real capability under a
  // different Symbol("peerCred") — a false negative in the exact place the probe claims coverage.
  const proto = {};
  proto[Symbol("peerCred")] = 17;                       // inert decoy, found FIRST (deeper proto)
  const obj = Object.create(proto);
  obj[Symbol("peerCred")] = () => ({ uid: 501 });       // the real one, same description
  const r = probePeerCredentials(obj);
  assert.equal(r.answer, "yes", "the second same-description Symbol was still reached");
  assert.equal(r.nominated.length, 2, "both Symbols are in the surface, not deduped by name");
});

test("FALSE-POSITIVE fixtures: credential-LIKE names that yield no uid do not count", () => {
  // The SO_PEERCRED case from review: an inert constant is an option number, not an API. And a
  // callable with the right name but no uid in its return is a name, not a capability. Both are
  // NOMINATED (the inventory did its job) and neither VERIFIES (the semantic layer did its job).
  for (const decoy of [
    Object.assign(new net.Socket(), { SO_PEERCRED: 17 }),
    Object.assign(new net.Socket(), { getPeerCredentials: () => undefined }),
    Object.assign(new net.Socket(), { peerCredentialHelper: () => { throw new Error("ENOTSUP"); } }),
    // The line the bare-integer rule must NOT cross: these are option NUMBERS under generic
    // credential names, with no supported setsockopt surface in Node to feed them to. If accepting
    // `peerUid: 501` ever starts accepting these too, the probe has become a name scanner again.
    Object.assign(new net.Socket(), { LOCAL_PEERCRED: 1 }),
    Object.assign(new net.Socket(), { SO_PEERCRED: 0 }),
    Object.assign(new net.Socket(), { peerCred: -1 }),         // negative is not a uid
    // GENERIC callables returning integers (review round 7). These are the branch the round-6 rule
    // was too loose about: 0 could be a status code, 17 an option value, and neither says "uid".
    // Callability proves the member does something; only a uid-specific NAME says what the number
    // means. Without these fixtures the claim "both directions are pinned" was unsupported.
    Object.assign(new net.Socket(), { getPeerCredentials: () => 0 }),
    Object.assign(new net.Socket(), { peerCredentialHelper: () => 17 }),
    Object.assign(new net.Socket(), { ucred: () => 501 }),
  ]) {
    const r = probePeerCredentials(decoy);
    assert.equal(r.answer, "no", "a name alone must never flip the answer");
    assert.ok(r.nominated.length > 0, "the decoy WAS nominated — rejection happened at verification, not by luck of the regex");
    decoy.destroy?.();
  }
});
