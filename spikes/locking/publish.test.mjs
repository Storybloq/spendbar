/**
 * T-008 §3.6 tests 7 and 8 — what atomic rename buys, and the documented limit of the
 * advisory monotonicity check. Deterministic throughout: no free-running reader loops.
 *
 * Run: node --test spikes/locking/publish.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isProxy } from "node:util/types";
import vm from "node:vm";

import { compareManifests, publishInPlaceMutant, publishSnapshot, readSnapshot } from "./publish.mjs";

/**
 * Harness bound. These tests are filesystem-only, but three of them hand control to the writer's
 * own hooks mid-publish — if that sequencing ever regresses into a deadlock, an unbounded test
 * hangs the repository-wide gate instead of failing it. This round showed what that costs: an
 * unbounded storm elsewhere held `test:all` for 876 seconds.
 */
const WAIT_MS = 15_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const dirs = [];
/** A fresh scratch directory, tracked for teardown. `target()` is this plus a snapshot filename. */
const workdir = () => {
  const d = mkdtempSync(join(tmpdir(), "spendbar-publish-"));
  dirs.push(d);
  return d;
};
const target = () => join(workdir(), "snapshot.json");
after(() => {
  // Independent removals, failures aggregated — see the note in auth.test.mjs. Missed in round 11
  // when the same fix went into three sibling suites.
  const problems = [];
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); }
    catch (err) { problems.push(`remove ${d}: ${err.message}`); }
  }
  if (problems.length) throw new Error(`teardown could not clean up: ${problems.join("; ")}`);
});

test("manifest dominance: the full truth table, including the incomparable cases that fail closed", () => {
  const live = { "claude.jsonl": 100, "codex.jsonl": 50 };
  assert.equal(compareManifests({ "claude.jsonl": 101, "codex.jsonl": 50 }, live), "dominates");
  assert.equal(compareManifests({ "claude.jsonl": 100, "codex.jsonl": 50, "new.jsonl": 1 }, live), "dominates");
  assert.equal(compareManifests({ "claude.jsonl": 100, "codex.jsonl": 50 }, live), "equal");
  assert.equal(compareManifests({ "claude.jsonl": 99, "codex.jsonl": 50 }, live), "regressed");
  // The case a scalar max gets WRONG: this candidate's largest offset (200) beats live's largest
  // (100), yet it silently dropped codex.jsonl entirely. A max-based comparison publishes it and
  // the snapshot loses data while looking newer. The manifest rule refuses to rank it at all.
  assert.equal(compareManifests({ "claude.jsonl": 200 }, live), "incomparable");
  // Advance on one source does not excuse truncation of another.
  assert.equal(compareManifests({ "claude.jsonl": 200, "codex.jsonl": 49 }, live), "regressed");
});

test("REGRESSION: inherited property names are not sources", () => {
  // The two reproduced failures, pinned exactly. `in` / plain lookup made Object.prototype look
  // like data: a live source named toString read as PRESENT in an empty candidate (so a snapshot
  // that dropped every input ranked "equal" and could publish), and a new candidate source named
  // constructor did not count as an advance. The truth table above uses ordinary names only, so
  // reverting either Object.hasOwn call leaves it entirely green.
  assert.equal(compareManifests({}, { toString: 5 }), "incomparable");
  assert.equal(compareManifests({ constructor: 1, a: 1 }, { a: 1 }), "dominates");
  assert.equal(compareManifests({ hasOwnProperty: 2 }, { hasOwnProperty: 1 }), "dominates");
  assert.equal(compareManifests({ valueOf: 1 }, { valueOf: 2 }), "regressed");
});

test("REGRESSION: manifest validation is unconditional — the FIRST publish cannot persist garbage", { timeout: WAIT_MS }, async () => {
  // The reproduced bug: validation lived only inside compareManifests, which runs only when a
  // live snapshot exists, so a fresh install published {a: NaN} happily. Calling compareManifests
  // directly (as the garbage-manifest test does) always validates and therefore proves nothing
  // about the call sites.
  const t = target();
  await assert.rejects(() => publishSnapshot(t, "x", { a: NaN }), TypeError);
  assert.equal(readSnapshot(t), null, "and nothing was written to the fresh target");

  // The non-record case, reproduced before it was fixed: publishSnapshot reported "published"
  // while writing a snapshot readSnapshot immediately rejected as corrupt — a writer that
  // believes it succeeded plus a permanently unreadable file. The validated value and the
  // published bytes must be the same thing.
  await assert.rejects(() => publishSnapshot(t, "x", new Date()), TypeError);
  assert.equal(readSnapshot(t), null, "the non-record manifest wrote nothing either");

  // The other newly added call site: readSnapshot must reject a stored manifest that is invalid
  // but CHECKSUM-CONSISTENT — i.e. written intact by an older or buggier build. Reconstructing
  // the checksum is what makes this reach the stored-manifest branch rather than the torn-file one.
  const manifest = { a: -1 };
  const payload = "intact";
  const sum = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(manifest).sort())))
    .update("\u0000")
    .update(payload)
    .digest("hex");
  // Mode 0600 explicitly: readSnapshot now enforces the documented snapshot contract (regular file,
  // our uid, exactly 0600) on the READ path too, so a fixture written at the umask default would be
  // rejected on the mode before ever reaching the stored-manifest branch this test is isolating.
  writeFileSync(t, JSON.stringify({ manifest, payload, checksum: sum }), { mode: 0o600 });
  chmodSync(t, 0o600);   // writeFileSync's mode is umask-filtered, like every other creation here
  assert.throws(() => readSnapshot(t), TypeError, "a checksum-valid snapshot with an unrankable manifest is still refused");
});

test("REGRESSION: a failure after the candidate is written leaves no .tmp behind", { timeout: WAIT_MS }, async () => {
  // The cleanup guard used to open only around `renameSync`, so anything throwing before it — the
  // candidate write itself (ENOSPC, EACCES) or the `beforeCommit` hook — left a complete `.tmp`
  // beside the live snapshot, and repeated failures accumulated residue. Review round 11, and the
  // same rule the write-once allocation needed three rounds to learn: the guard has to cover every
  // statement that can throw, not the ones that happened to be in view.
  const t = target();
  const dir = dirname(t);
  await publishSnapshot(t, "live", { a: 1 });
  assert.deepEqual(readdirSync(dir), ["snapshot.json"], "precondition: one published snapshot, no residue");

  const boom = new Error("simulated failure with the candidate already on disk");
  await assert.rejects(
    () => publishSnapshot(t, "doomed", { a: 2 }, { hooks: { beforeCommit: () => { throw boom; } } }),
    /simulated failure/,
  );
  assert.deepEqual(readdirSync(dir), ["snapshot.json"],
    "the failed publish removed its candidate instead of stranding it next to the live snapshot");
  assert.equal(readSnapshot(t).payload, "live", "and the live snapshot is untouched");

  // The CANDIDATE-WRITE failure, which the hook case above does not reach. A mutant moving
  // `writeCandidate` back outside the guard while leaving the hook inside kept this test green, so
  // the ENOSPC/partial-write path was still unpinned even after the guard was widened (round 12).
  // The injected writer creates the file and then throws, which is what a partial write looks like.
  await assert.rejects(
    () => publishSnapshot(t, "doomed", { a: 3 }, {
      hooks: { writeCandidate: (f) => { writeFileSync(f, '{"partial":'); throw new Error("simulated ENOSPC mid-write"); } },
    }),
    /simulated ENOSPC/,
  );
  assert.deepEqual(readdirSync(dir), ["snapshot.json"], "a partial candidate is removed too");

  // And NOTHING runs after a successful commit. `rmSync(force)` suppresses ENOENT but not EACCES or
  // EIO, so an unconditional post-rename removal could throw while the new snapshot was already
  // live — reporting failure for a publication that succeeded, and sending the caller to retry
  // something irreversible. The remover here throws if it is ever reached.
  assert.equal(
    await publishSnapshot(t, "committed", { a: 4 }, {
      hooks: { removeCandidate: () => { throw new Error("cleanup must not run after a successful commit"); } },
    }),
    "published",
  );
  assert.equal(readSnapshot(t).payload, "committed");
  assert.deepEqual(readdirSync(dir), ["snapshot.json"]);

  // The RENAME failing is the third way in, and until round 13 it was the one nothing exercised:
  // both cases above fail before `renameSync` is reached, so `committed` was only ever observed
  // false-before-write or true-after-rename. A real rename can fail (EXDEV across a bind mount,
  // EACCES on the directory, ENOENT if the candidate was swept), and that path must still clean up.
  //
  // Provoked without adding a rename hook to production: `beforeCommit` runs immediately before the
  // rename, so removing the candidate there makes renameSync fail with a genuine ENOENT rather than
  // a simulated one. The `committed` flag is what is under test, not the errno.
  let removerRan = false;
  await assert.rejects(
    () => publishSnapshot(t, "vanished", { a: 5 }, {
      hooks: {
        beforeCommit: (tmp) => { rmSync(tmp); },
        removeCandidate: (f) => { removerRan = true; rmSync(f, { force: true }); },
      },
    }),
    // Since round 15 the mode/type/owner verification runs AFTER beforeCommit and immediately
    // before the rename, so a candidate the hook deleted is caught by the verifier rather than by
    // renameSync's ENOENT. Stricter and earlier, same path: still pre-commit, still cleaned up.
    /no snapshot at .*\.tmp/,
  );
  assert.equal(removerRan, true, "a failed commit must still run the candidate cleanup");
  assert.equal(readSnapshot(t).payload, "committed", "and must not disturb the live snapshot");
  assert.deepEqual(readdirSync(dir), ["snapshot.json"], "leaving no residue");
});

test("REGRESSION: a snapshot is EXACTLY 0600 whatever the umask, and never world-readable", { timeout: WAIT_MS }, () => {
  // The third site of the umask class in this spike, and the one I missed. The token learned this in
  // round 12 and the port allocation in round 13; the snapshot's default writer was still
  // `writeFileSync(f, text)`, which takes the umask — so under the ordinary 022 the committed
  // snapshot was 0644 and every local user could read the account's usage data. Found in review
  // round 14, immediately after I recorded a "deliberate sibling audit" that swept teardowns and
  // hook resolution and never thought to sweep file creation.
  //
  // Two umasks, because they fail in opposite directions: 022 leaves the file too OPEN (the leak),
  // 0200 leaves it too CLOSED (the permanently-unreadable brick the token hit). Exact-mode is the
  // only rule that catches both. Child process, since process.umask() is global.
  const dir = workdir();
  const script = join(dir, "umask-child.mjs");
  writeFileSync(script, `
    import { publishSnapshot, readSnapshot } from ${JSON.stringify(join(HERE, "publish.mjs"))};
    import { statSync } from "node:fs";
    process.umask(parseInt(process.argv[3], 8));
    const t = process.argv[2];
    const r = await publishSnapshot(t, "secret-usage-data", { a: 1 });
    const mode = (statSync(t).mode & 0o7777).toString(8);
    let readable = null, error = null;
    try { readable = readSnapshot(t).payload; } catch (e) { error = e.message; }
    process.stdout.write(JSON.stringify({ r, mode, readable, error }));
  `);
  for (const umask of ["022", "0200", "077"]) {
    const t = join(dir, `snap-${umask}.json`);
    const res = spawnSync(process.execPath, [script, t, umask], { encoding: "utf8", timeout: WAIT_MS, killSignal: "SIGKILL" });
    assert.equal(res.error, undefined, `child was killed rather than finishing under umask ${umask}: ${res.error?.message}`);
    assert.equal(res.status, 0, `child failed under umask ${umask}: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.r, "published", `precondition: it published under umask ${umask}`);
    assert.equal(out.mode, "600", `snapshot must be exactly 600 under umask ${umask}, got ${out.mode}`);
    assert.equal(out.error, null, `and must remain readable under umask ${umask}: ${out.error}`);
    assert.equal(out.readable, "secret-usage-data");
  }
});

test("REGRESSION: a snapshot directory this code CREATES is 0700, whatever the umask", { timeout: WAIT_MS }, () => {
  // The sibling of the file-mode bug, one level up: the snapshot became 0600 while the directory
  // holding it was created with no mode at all — 0755 under the ordinary umask — so other local
  // users could list it and learn which sources exist and when they last changed. auth.mjs already
  // states this rule in its header; this call ignored it (review round 15).
  //
  // Nested target, so the publish genuinely creates the directory rather than reusing the 0700
  // mkdtemp. umask 0200 is included because mkdir's mode argument is umask-filtered exactly like
  // open's: `{ mode: 0o700 }` alone yields 0500 there, and a snapshot directory the publisher
  // cannot write to is the same brick the token hit.
  const dir = workdir();
  const script = join(dir, "dirmode-child.mjs");
  writeFileSync(script, `
    import { publishSnapshot } from ${JSON.stringify(join(HERE, "publish.mjs"))};
    import { statSync } from "node:fs";
    import { dirname } from "node:path";
    process.umask(parseInt(process.argv[3], 8));
    const t = process.argv[2];
    const r = await publishSnapshot(t, "x", { a: 1 });
    process.stdout.write(JSON.stringify({ r, mode: (statSync(dirname(t)).mode & 0o7777).toString(8) }));
  `);
  for (const umask of ["022", "0200", "077"]) {
    const t = join(dir, `nested-${umask}`, "sub", "snapshot.json");
    const res = spawnSync(process.execPath, [script, t, umask], { encoding: "utf8", timeout: WAIT_MS, killSignal: "SIGKILL" });
    assert.equal(res.error, undefined, `child was killed rather than finishing under umask ${umask}: ${res.error?.message}`);
    assert.equal(res.status, 0, `child failed under umask ${umask}: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.r, "published", `precondition: it published under umask ${umask}`);
    assert.equal(out.mode, "700", `the created snapshot directory must be exactly 700 under umask ${umask}`);
  }
});

test("REGRESSION: a candidate with the wrong mode is REFUSED before the rename, not committed", { timeout: WAIT_MS }, async () => {
  // The enforcement, separate from the default writer: an injected writer must not be able to
  // publish a snapshot the mode rule would have refused. It is checked before renameSync, where a
  // throw is still safe -- past the rename nothing may throw, so this could not be a post-commit
  // check even if that were simpler.
  const t = target();
  assert.equal(await publishSnapshot(t, "live", { a: 1 }), "published");
  await assert.rejects(
    () => publishSnapshot(t, "loose", { a: 2 }, {
      // chmod after the write: writeFileSync's mode argument is umask-filtered, so under umask 077
      // this fixture would create a 0600 candidate and the test would fail without ever exercising
      // the refusal it exists for (review round 15).
      hooks: { writeCandidate: (f, text) => { writeFileSync(f, text); chmodSync(f, 0o644); } },
    }),
    /expected exactly 600/,
  );
  assert.equal(readSnapshot(t).payload, "live", "the loose-mode candidate never became the snapshot");
  assert.deepEqual(readdirSync(dirname(t)), ["snapshot.json"], "and it was cleaned up");
});

test("REGRESSION: beforeCommit cannot invalidate the candidate after it was verified", { timeout: WAIT_MS }, async () => {
  // The check originally ran BEFORE the hook, so beforeCommit could chmod the candidate to 0644 or
  // swap it for a symlink and the rename committed the object the check had already approved. The
  // guarantee held against an injected WRITER and not against an injected HOOK — and the test
  // written for it used only a loose initial writer, so the bypass was invisible (review round 15).
  const t = target();
  const dir = dirname(t);
  assert.equal(await publishSnapshot(t, "live", { a: 1 }), "published");

  await assert.rejects(
    () => publishSnapshot(t, "loosened", { a: 2 }, { hooks: { beforeCommit: (tmp) => { chmodSync(tmp, 0o644); } } }),
    /expected exactly 600/,
    "a hook that loosens the candidate must be caught before the rename",
  );
  assert.equal(readSnapshot(t).payload, "live", "and the live snapshot is untouched");

  // The symlink variant, which is why the verification uses lstat: stat follows the link and would
  // report the mode of a perfectly legitimate 0600 REFERENT while the symlink itself gets published.
  const decoy = join(dir, "decoy");
  writeFileSync(decoy, "not a snapshot");
  chmodSync(decoy, 0o600);
  await assert.rejects(
    () => publishSnapshot(t, "swapped", { a: 3 }, {
      hooks: { beforeCommit: (tmp) => { rmSync(tmp); symlinkSync(decoy, tmp); } },
    }),
    /not a regular file/,
    "a candidate replaced by a symlink must be refused even though its referent is a valid 0600 file",
  );
  assert.equal(readSnapshot(t).payload, "live", "the live snapshot is still untouched");
  assert.deepEqual(readdirSync(dir).sort(), ["decoy", "snapshot.json"], "and no candidate residue remains");
});

test("REGRESSION: readSnapshot enforces the same contract the writer promises", { timeout: WAIT_MS }, async () => {
  // SNAPSHOT_MODE was documented as the rule for "every snapshot and candidate" while only the
  // default writer enforced it, so a 0644 snapshot left by an older build — or planted by another
  // local user — was read and trusted. The embedded checksum is no defence: it is unkeyed, so
  // anyone who can write the file can write a consistent one (review round 15).
  const t = target();
  assert.equal(await publishSnapshot(t, "live", { a: 1 }), "published");
  assert.equal(readSnapshot(t).payload, "live", "precondition: a well-formed snapshot reads back");

  chmodSync(t, 0o644);
  assert.throws(() => readSnapshot(t), /expected exactly 600/, "a world-readable snapshot is refused on READ, not only on write");
  chmodSync(t, 0o600);
  assert.equal(readSnapshot(t).payload, "live", "and restoring the mode restores the read");

  // A symlink standing in for the snapshot, with a checksum-valid referent: accepted before,
  // because readFileSync follows links and the bytes were genuinely consistent.
  const other = target();
  assert.equal(await publishSnapshot(other, "attacker", { a: 9 }), "published");
  const planted = join(dirname(t), "planted.json");
  symlinkSync(other, planted);
  assert.throws(() => readSnapshot(planted), /not a regular file/, "a symlink in the snapshot's place is refused");

  // Absent stays a legitimate first-run answer rather than an error.
  assert.equal(readSnapshot(join(dirname(t), "never-written.json")), null);
});

test("REGRESSION: every hook is resolved ONCE, before the candidate is written", { timeout: WAIT_MS }, async () => {
  // `if (hooks.X) await hooks.X()` reads the property TWICE, so a getter can return a function to
  // the existence check and something else to the call — choosing what runs after the guard has
  // already decided. Two of this function's four hooks were written that way, under a comment
  // claiming all of them were resolved up front (review round 14, found by auditing for the class
  // that round 13 found in the credential probe rather than by being told).
  //
  // Counting reads is what discriminates: asserting the hooks merely "work" passes on both versions.
  const t = target();
  const reads = { afterDominanceCheck: 0, beforeCommit: 0, writeCandidate: 0, removeCandidate: 0 };
  const calls = [];
  const hooks = {};
  for (const name of Object.keys(reads)) {
    Object.defineProperty(hooks, name, {
      enumerable: true,
      get() {
        reads[name]++;
        // Only the two observation hooks get a function; the other two fall through to the real
        // implementations via `??`, which is the shape the publisher actually uses.
        if (name === "afterDominanceCheck" || name === "beforeCommit") return () => { calls.push(name); };
        return undefined;
      },
    });
  }

  assert.equal(await publishSnapshot(t, "hooked", { a: 1 }, { hooks }), "published");
  for (const [name, n] of Object.entries(reads)) {
    assert.equal(n, 1, `hooks.${name} was read ${n} times; each hook must be resolved exactly once`);
  }
  assert.deepEqual(calls, ["afterDominanceCheck", "beforeCommit"], "and both hooks still fired, in order");

  // The in-place mutant is the SIBLING entry point, and round 14 claimed both were fixed while only
  // this one was covered (review round 15). Its hooks are what synchronize the reader into each torn
  // window, so a getter that hands back a different function on the second read would change which
  // window the evidence tests actually observe.
  const mutantReads = { afterTruncate: 0, afterPartialWrite: 0 };
  const mutantCalls = [];
  const mutantHooks = {};
  for (const name of Object.keys(mutantReads)) {
    Object.defineProperty(mutantHooks, name, {
      enumerable: true,
      get() { mutantReads[name]++; return () => { mutantCalls.push(name); }; },
    });
  }
  await publishInPlaceMutant(target(), "torn", { a: 1 }, { hooks: mutantHooks });
  for (const [name, n] of Object.entries(mutantReads)) {
    assert.equal(n, 1, `publishInPlaceMutant read hooks.${name} ${n} times; exactly 1 is allowed`);
  }
  assert.deepEqual(mutantCalls, ["afterTruncate", "afterPartialWrite"], "and both fired, in order");
});

test("rename-publish: a reader synchronized into the writer's own hook window sees ONLY complete snapshots", { timeout: WAIT_MS }, async () => {
  const t = target();
  await publishSnapshot(t, "generation-1", { a: 1 });
  // The strongest window rename-publish offers an observer: the COMPLETE temp file exists, one
  // syscall from publication. (The first version observed at afterDominanceCheck — before the
  // temp file was even written — so an in-place mutant corrupting the target right after that
  // hook would still have shown old-then-new. Review caught it; beforeCommit is the honest spot.)
  let observed;
  await publishSnapshot(t, "generation-2", { a: 2 }, {
    hooks: { beforeCommit: () => { observed = readSnapshot(t); } },
  });
  assert.equal(observed.payload, "generation-1", "mid-publish, the reader still sees the OLD complete snapshot");
  assert.equal(readSnapshot(t).payload, "generation-2", "after publish, the new one — nothing in between exists");
});

// Name says "read failure", not "checksum failure": both assertions below require a SyntaxError
// from JSON.parse, so calling this a checksum result contradicted its own evidence (review round
// 5). What proves the checksum is load-bearing is the parseable-corruption test that follows —
// these two windows happen to die earlier, in parsing, and the name now says exactly that.
test("the in-place mutant IS caught: both torn windows produce a deterministic READ failure (here, in parsing)", { timeout: WAIT_MS }, async () => {
  const t = target();
  await publishSnapshot(t, "good", { a: 1 });
  // Not a probabilistic reader loop — review round 4 killed that shape because it can miss every
  // window and pass a broken writer. The mutant holds itself open at each torn state and the
  // reader is walked straight into it. These two hooks prove DETERMINISTIC READ FAILURE only —
  // both die in JSON.parse, so deleting checksum validation would leave them green. The
  // parseable-corruption test that follows is what makes the checksum load-bearing; this one must
  // not be read as covering it (review round 6 caught the comment still claiming otherwise after
  // the test name had already been corrected).
  await publishInPlaceMutant(t, "evil", { a: 2 }, {
    hooks: {
      afterTruncate: () => assert.throws(() => readSnapshot(t), SyntaxError, "truncated file is not a readable snapshot"),
      afterPartialWrite: () => assert.throws(() => readSnapshot(t), SyntaxError, "half-written file is not a readable snapshot"),
    },
  });
  assert.equal(readSnapshot(t).payload, "evil", "the mutant does complete eventually — the torn states were transient, which is why a loop can miss them");
});

test("a parseable snapshot with a wrong checksum is rejected — checksum, not JSON.parse, is the discriminator", { timeout: WAIT_MS }, async () => {
  const t = target();
  await publishSnapshot(t, "honest", { "claude.jsonl": 1 });
  // Both torn-window assertions above happen to die in JSON.parse, so on their own they would
  // stay green if the checksum comparison were deleted (review's exact point). This snapshot
  // parses FINE — its manifest was edited after publication, the corruption that decides
  // dominance while looking healthy. Only the checksum can catch it.
  const doc = JSON.parse(readFileSync(t, "utf8"));
  doc.manifest["claude.jsonl"] = 999_999;
  writeFileSync(t, JSON.stringify(doc));
  assert.throws(() => readSnapshot(t), /fails its checksum/);
});

test("REGRESSION: a payload that cannot round-trip is refused before the target is touched", { timeout: WAIT_MS }, async () => {
  const t = target();
  await publishSnapshot(t, "honest", { a: 1 });

  // The reproduced bug, one level out from the Date-manifest bug: createHash.update() accepts a
  // Buffer, but JSON.stringify serializes it as {"type":"Buffer","data":[...]}. So this returned
  // "published" and readSnapshot then fed that OBJECT back to createHash.update(), which throws —
  // a snapshot successfully published and permanently unreadable.
  for (const bad of [Buffer.from("x"), new Uint8Array([1, 2]), { a: 1 }, 42, null, undefined]) {
    await assert.rejects(() => publishSnapshot(t, bad, { a: 2 }), TypeError, `payload ${String(bad)} must be refused`);
  }

  // Refused BEFORE the rename: the good snapshot is untouched, not replaced by an unreadable one.
  assert.equal(readSnapshot(t).payload, "honest", "a refused publish left the live snapshot intact");

  // And the read side is validated independently, IN THE RIGHT ORDER — the payload's shape is
  // checked before the checksum is consulted.
  //
  // This previously accepted EITHER the payload error or a checksum failure, and the alternation is
  // what made it useless: both were available, so a mutant moving `assertValidPayload` after the
  // checksum comparison still threw something the pattern matched and survived. Naming the one
  // error is what kills it — and the ordering is genuinely load-bearing rather than cosmetic,
  // because the checksum helper cannot hash a non-string payload at all: reached first, it throws
  // an opaque ERR_INVALID_ARG_TYPE from `hash.update()` instead of the contract error that says
  // what is actually wrong with the file. Review round 9.
  const t2 = target();
  await publishSnapshot(t2, "fine", { a: 1 });
  const doc = JSON.parse(readFileSync(t2, "utf8"));
  doc.payload = { type: "Buffer", data: [120] };
  writeFileSync(t2, JSON.stringify(doc));
  assert.throws(() => readSnapshot(t2), /stored payload is object/,
    "the payload contract must be enforced BEFORE the checksum, not merely somewhere");
});

test("REGRESSION: a manifest whose reads DIVERGE is REFUSED, so nothing unreadable can be published", { timeout: WAIT_MS }, async () => {
  const t = target();

  // Found in review round 6, and the resolution was REVERSED in round 10. A Proxy over a plain
  // object passes every structural check — its prototype IS Object.prototype, it owns no toJSON,
  // and its descriptor trap reports a well-behaved data property. But `get` can answer differently
  // each time, so the value that was VALIDATED, the value that was CHECKSUMMED and the value that
  // was SERIALIZED were three different numbers, and the published file failed its own checksum.
  let reads = 0;
  const shifty = new Proxy({ a: 1 }, {
    get(target, key, recv) {
      if (key === "a") return ++reads;          // 1, 2, 3, ... — a different answer every read
      return Reflect.get(target, key, recv);
    },
  });

  // Round 6's fix was "read once and publish that reading", and this test asserted the publish
  // SUCCEEDED. Round 10 showed read-once is not sufficient: it constrains the `get` trap but not
  // `ownKeys`, which may legally hide a configurable own Symbol property — so a Proxy could still
  // publish a manifest missing a source, which is the mis-ranking bug in a different disguise.
  // Proxies are now refused outright. Read-once canonicalization is retained and still matters, as
  // it governs every plain object too.
  await assert.rejects(() => publishSnapshot(t, "payload", shifty), /is a Proxy/,
    "an object whose key set cannot be trusted cannot be validated, so it must not be published");
  assert.equal(reads, 0, "refused before any value was read");
  assert.equal(readSnapshot(t), null, "the refused publish left no snapshot");

  // "No trap ran AT ALL" needs every trap watched, not just `get`.
  //
  // The assertion above counts only `get`, so it passed while the implementation still called
  // `Object.getPrototypeOf` and `Object.hasOwn` ahead of the Proxy check — both of which invoke
  // traps. It therefore did not pin the reject-before-inspection ordering it was written to prove
  // (review round 11). This fixture counts every trap the validator could plausibly reach.
  const touched = [];
  const watchAll = new Proxy({ a: 1 }, new Proxy({}, {
    get: (_t, trap) => (...args) => {
      touched.push(trap);
      return Reflect[trap](...args);
    },
  }));
  await assert.rejects(() => publishSnapshot(target(), "payload", watchAll), /is a Proxy/);
  assert.deepEqual(touched, [],
    `refusal must reach NO trap; these ran: ${touched.join(", ")}`);

  // The property this test has always been about is unchanged and still holds: nothing unreadable
  // reaches disk. Refusing is a stronger way to satisfy it than publishing a sanitized copy.
  const honest = target();
  assert.equal(await publishSnapshot(honest, "payload", { a: 1 }), "published");
  assert.doesNotThrow(() => readSnapshot(honest), "a snapshot reported as published must be readable");
  assert.equal(Object.getPrototypeOf(readSnapshot(honest).manifest), Object.prototype);
});

test("publishSnapshot DECLINES anything that does not dominate — not just regressions", { timeout: WAIT_MS }, async () => {
  // Found by my own mutation sweep, and the most serious survivor in it: changing the guard from
  // `rank !== "dominates"` to `rank === "regressed"` left the ENTIRE suite green. Every other test
  // here calls compareManifests DIRECTLY, so the ranking truth table was fully covered while the
  // one line that ACTS on the ranking was covered only for the regressed case.
  //
  // What that mutant permits is the exact failure the dominance rule exists to prevent: an
  // INCOMPARABLE candidate — one that silently dropped an input source — overwriting a good
  // snapshot. That is data loss, not wasted work.
  const t = target();
  await publishSnapshot(t, "live", { "claude.jsonl": 100, "codex.jsonl": 50 });
  const before = readFileSync(t, "utf8");

  // incomparable: advances one source but has dropped codex.jsonl entirely
  assert.equal(await publishSnapshot(t, "lossy", { "claude.jsonl": 200 }), "declined:incomparable");
  // equal: identical inputs, so republishing is waste rather than progress
  assert.equal(await publishSnapshot(t, "same", { "claude.jsonl": 100, "codex.jsonl": 50 }), "declined:equal");
  // regressed: the case that WAS already covered, kept so the three verdicts sit together
  assert.equal(await publishSnapshot(t, "old", { "claude.jsonl": 99, "codex.jsonl": 50 }), "declined:regressed");

  assert.equal(readFileSync(t, "utf8"), before, "not one of the three declines touched the live snapshot");
  assert.equal(readSnapshot(t).payload, "live");
});

test("REGRESSION: a source literally named __proto__ survives canonicalization", { timeout: WAIT_MS }, async () => {
  // Review round 7. `canonical[source] = value` invokes Object.prototype's legacy __proto__ SETTER
  // rather than creating an own property, so a manifest parsed from {"__proto__":1} canonicalized
  // to {} — the source vanished. That is the single worst way to lose a source, because dropping
  // one is exactly what the "incomparable" verdict exists to catch: the loss converted a candidate
  // that should have been REFUSED into one that cleanly dominates, and published a snapshot missing
  // an entire transcript file while reporting success.
  //
  // JSON.parse is the realistic origin: a stored manifest round-trips through it on every read, and
  // it creates __proto__ as an ordinary own enumerable property.
  const weird = JSON.parse(String.raw`{"__proto__":1,"a":2}`);
  assert.deepEqual(Object.keys(weird), ["__proto__", "a"], "precondition: it really is an own key");

  // It must count as a source for ranking...
  assert.equal(compareManifests(weird, { a: 2 }), "dominates", "__proto__ is a new source, so this advances");
  assert.equal(compareManifests({ a: 2 }, weird), "incomparable", "and dropping it must be REFUSED, not ranked");

  // ...and it must round-trip through publish and read with its value intact.
  const t = target();
  assert.equal(await publishSnapshot(t, "payload", weird), "published");
  const stored = readSnapshot(t);
  assert.equal(Object.keys(stored.manifest).length, 2, "both sources were published");
  assert.equal(Object.getOwnPropertyDescriptor(stored.manifest, "__proto__")?.value, 1,
    "__proto__ survived as an OWN data property, not as a mangled prototype");
  assert.equal(stored.manifest.a, 2);

  // And the regression is genuinely about loss: a candidate missing it cannot overwrite.
  assert.equal(await publishSnapshot(t, "lossy", { a: 3 }), "declined:incomparable");
});

test("REGRESSION: a Symbol-keyed source is REFUSED, not silently dropped", { timeout: WAIT_MS }, async () => {
  // The same source-loss class as `__proto__` above, arriving through a different door and found in
  // review round 9. `Object.keys()` does not see Symbol keys, so canonicalization simply omitted
  // one and published a manifest missing a source the caller had supplied — and a lost source is
  // exactly the input the incomparable rule exists to catch, so the omission can turn a genuine
  // "incomparable" into a clean "dominates" and overwrite a snapshot it does not dominate.
  //
  // Refused rather than supported: a Symbol key cannot survive JSON serialization at all, so
  // accepting it would mean accepting a manifest that provably cannot round-trip. Failing closed is
  // the only honest answer, and it must be an error rather than a silent drop.
  const t = target();
  const symKey = Symbol("claude.jsonl");
  await assert.rejects(() => publishSnapshot(t, "payload", { [symKey]: 1, a: 2 }), /Symbol-keyed/,
    "a source that cannot round-trip must be refused, not quietly discarded");
  assert.equal(readSnapshot(t), null, "the refused publish left no snapshot behind");

  // And the refusal must not have been incidental — the same manifest without the Symbol publishes.
  assert.equal(await publishSnapshot(t, "payload", { a: 2 }), "published");

  // Inherited and non-enumerable Symbols are covered too, by two different rules: an inherited one
  // fails the plain-prototype check, a non-enumerable own one fails the check above.
  const withProto = Object.create(Object.defineProperty({}, symKey, { value: 5, enumerable: true }));
  withProto.a = 2;
  await assert.rejects(() => publishSnapshot(target(), "payload", withProto), /custom prototype/);
  const nonEnum = Object.defineProperty({ a: 2 }, symKey, { value: 5, enumerable: false, configurable: true });
  await assert.rejects(() => publishSnapshot(target(), "payload", nonEnum), /Symbol-keyed/);
});

test("REGRESSION: a Proxy whose ownKeys trap HIDES a Symbol source is refused, leaving no residue", { timeout: WAIT_MS }, async () => {
  // I recorded this case as undetectable by construction, having verified that `Reflect.ownKeys`,
  // `Object.keys`, `Object.getOwnPropertySymbols`, spread and `JSON.stringify` all route through
  // the same [[OwnPropertyKeys]] internal method and therefore all return the trap's answer. That
  // observation was correct and the conclusion drawn from it was not: `util.types.isProxy` answers
  // directly without enumerating anything. Review round 10.
  //
  // Second time on this ticket that "I could not find a way" got written down as "there is no way",
  // which is why the rule now is that declaring something undetectable needs a higher bar than any
  // ordinary assertion — it is the one claim that ends the search.
  const sym = Symbol("hidden.jsonl");
  const backing = Object.defineProperty({ a: 2 }, sym, { value: 5, enumerable: true, configurable: true });
  const liar = new Proxy(backing, { ownKeys: () => ["a"] });

  assert.deepEqual(Object.getOwnPropertySymbols(liar), [], "precondition: the lie really does hide it from every enumeration");
  assert.equal(Object.getOwnPropertyDescriptor(liar, sym).value, 5, "precondition: and the source is genuinely still there");

  const dir = mkdtempSync(join(tmpdir(), "spendbar-residue-"));
  dirs.push(dir);
  const t = join(dir, "snap.json");
  await assert.rejects(() => publishSnapshot(t, "payload", liar), /is a Proxy/);

  // Residue-free, checked by listing the DIRECTORY rather than the target. Asserting only that the
  // target is absent would pass while a `.tmp` candidate was stranded beside it — a refusal that
  // litters is not a refusal that happened early enough.
  assert.deepEqual(readdirSync(dir), [], "a refused publish must leave no candidate or target behind");

  // The two non-obvious shapes `isProxy` has to cover, checked because "it works" is a claim about
  // Node's implementation and this rule is now load-bearing.
  //
  // A REVOKED proxy: still detected, which matters because every other route to it throws an opaque
  // TypeError — refusing it by name gives the caller a message that says what is wrong.
  const { proxy: revoked, revoke } = Proxy.revocable({ a: 1 }, {});
  revoke();
  await assert.rejects(() => publishSnapshot(target(), "payload", revoked), /is a Proxy/,
    "a revoked proxy is refused by name, not by an opaque TypeError from enumerating it");

  // And a CROSS-REALM proxy, the case that would silently bypass a same-realm check such as an
  // instanceof or a constructor comparison. `isProxy` is a V8-level test and sees through the realm
  // boundary; verified rather than assumed.
  const foreign = vm.runInContext("new Proxy({ a: 1 }, { ownKeys: () => ['a'] })", vm.createContext({}));
  assert.equal(isProxy(foreign), true, "precondition: it really is cross-realm and really is a Proxy");
  await assert.rejects(() => publishSnapshot(target(), "payload", foreign), /is a Proxy/,
    "a proxy from another realm is refused too");
});

test("garbage manifests are refused, never ranked", () => {
  const live = { "claude.jsonl": 100 };
  // NaN is the vicious one: NaN < x and NaN > x are both false, so an unvalidated NaN offset
  // neither regresses nor reads incomparable — it sails through to "equal"/"dominates" purely on
  // the OTHER entries. Strings compare lexically. None of these are orderings over offsets.
  for (const garbage of [
    { "claude.jsonl": NaN },
    { "claude.jsonl": "200" },
    { "claude.jsonl": -1 },
    { "claude.jsonl": 1.5 },
    { "claude.jsonl": null },
    null,
    [100],
    new Date(),                              // enumerable-free, but JSON.stringify's to a STRING
    Object.assign(Object.create(null), { a: 1, toJSON: () => "nope" }),
    Object.defineProperty({}, "a", { get: () => 1, enumerable: true }),   // accessor: re-reads differ
  ]) {
    assert.throws(() => compareManifests(garbage, live), TypeError, `${JSON.stringify(garbage)} must be refused`);
    assert.throws(() => compareManifests(live, garbage), TypeError, `${JSON.stringify(garbage)} as live must be refused`);
  }
});

test("monotonicity case (a): an older writer that OBSERVES the newer snapshot declines", { timeout: WAIT_MS }, async () => {
  const t = target();
  await publishSnapshot(t, "newer", { "claude.jsonl": 200 });
  const verdict = await publishSnapshot(t, "older", { "claude.jsonl": 100 });
  assert.equal(verdict, "declined:regressed");
  assert.equal(readSnapshot(t).payload, "newer", "the newer snapshot survives");
});

test("monotonicity case (b): held past its check, the older writer DOES regress the target — the documented TOCTOU", { timeout: WAIT_MS }, async () => {
  const t = target();
  await publishSnapshot(t, "gen-1", { "claude.jsonl": 100 });

  // The older writer passes its dominance check against gen-1, then is HELD. The newer writer
  // publishes. The older writer resumes and renames anyway.
  let release;
  const held = new Promise((r) => { release = r; });
  const older = publishSnapshot(t, "stale-gen-2", { "claude.jsonl": 150 }, {
    hooks: { afterDominanceCheck: () => held },
  });
  await publishSnapshot(t, "gen-3", { "claude.jsonl": 300 });
  release();
  assert.equal(await older, "published", "the stale writer believes it succeeded");

  // Asserted, not hidden: the target has REGRESSED. This is the precise limit of read-then-rename
  // — plan §3.5.3 calls the check advisory for exactly this reason, and a test that pretended
  // otherwise would be the candidate-B overclaim again. The saving property is the second
  // assertion: the regressed snapshot is COMPLETE, and the next dominating publish self-corrects.
  const now = readSnapshot(t);
  assert.equal(now.payload, "stale-gen-2", "regression happened, as documented");
  assert.equal(await publishSnapshot(t, "gen-4", { "claude.jsonl": 300 }), "published", "self-correction works");
  assert.equal(readSnapshot(t).payload, "gen-4");
});
