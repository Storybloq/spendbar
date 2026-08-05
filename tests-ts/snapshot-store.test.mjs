// T-010 snapshot store — the store's own protocol.
//
// Organised by the plan's test obligations, which are in turn the ticket's acceptance
// criteria. The obligations that came out of review rounds 30-32 (bounded staging, gated
// reset, the reader's snapshot transaction, classification precedence) are marked by name,
// because each of them exists to close a specific race someone had to find.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeFs, FakeAuthority, errno } from "./snapshot-fakefs.mjs";
import {
  storePaths,
  stagingPath,
  classifyStore,
  startWriter,
  resetStore,
  publishSnapshot,
  readSnapshot,
  collectGarbage,
  createPin,
  readGeneration,
  deriveFreshness,
  localDayBounds,
  isExplicitInstant,
  FreshnessRequestError,
  assertManifestInvariants,
  assertGenerationInvariants,
  assertPinInvariants,
} from "../dist/snapshot/store.js";
import {
  encodeEnvelope,
  checksumOf,
  canonicalize,
  NonCanonicalValueError,
  SCHEMA_VERSION,
} from "../dist/snapshot/envelope.js";
import { canonicalSourceVersion, compareSourceVersions } from "../dist/snapshot/dominance.js";
import { createWriteAuthority, LatchingWriteAuthority, TERMINATED } from "../dist/snapshot/authority.js";
import {
  SnapshotNotDominatingError,
  SourceVersionManifestError,
  AuthorityHandlerContractError,
  AuthorityLostError,
  SnapshotCommitFailure,
  classifyFsError,
  snapshotFsErrorKind,
  snapshotErrorTag,
  SnapshotPathError,
  SnapshotIdError,
} from "../dist/snapshot/errors.js";
import { decodeEnvelope } from "../dist/snapshot/envelope.js";
import { assertUmaskAllowsOwnerModes, createNodeSnapshotFs } from "../dist/snapshot/node-fs.js";
import { MAX_ARTIFACT_BYTES } from "../dist/snapshot/types.js";

/** Injected faults arrive branded; the native errno lives on `.cause` (round 37). */
const causeCode = (err) => err?.cause?.code;

const STATE = "/state";
const P = storePaths(STATE);

function provenance(overrides = {}) {
  return {
    coverage: [{ start: "2026-01-01", end: "2026-02-01" }],
    // Per-field coverage deliberately DIFFERS from the whole-snapshot coverage: `cost` runs
    // the full range, `tokens` stops half way. That is what makes "no global stale flag"
    // checkable rather than asserted — the same generation must answer differently depending
    // on which fields were asked for.
    fieldCoverage: {
      cost: [{ start: "2026-01-01", end: "2026-02-01" }],
      tokens: [{ start: "2026-01-01", end: "2026-01-15" }],
    },
    sourceTimestamps: { claude: "2026-01-31T00:00:00Z" },
    refreshTier: "slow",
    ccusageVersion: "17.1.3",
    ccusageInvokedAt: "2026-01-31T00:00:00Z",
    timezone: "America/Vancouver",
    dayBoundaryPolicy: "local-midnight",
    ...overrides,
  };
}

function candidate(id, sourceVersion, extra = {}) {
  return {
    generationId: id,
    sourceVersion,
    provenance: provenance(),
    payload: { total: 1 },
    publishedAt: "2026-01-31T00:00:00Z",
    ...extra,
  };
}

/** A store with directories present and no snapshot yet. */
function freshStore() {
  const fs = new FakeFs();
  fs.mkdirp(P.generationsDir);
  fs.mkdirp(P.pinsDir);
  fs.mkdirp(P.stagingDir);
  const authority = new FakeAuthority(fs);
  return { fs, authority };
}

/** A store carrying one published generation. */
function publishedStore() {
  const { fs, authority } = freshStore();
  const result = publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 10 }), {
    live: null,
  });
  assert.equal(result.status, "published");
  const manifest = JSON.parse(fs.files.get(P.manifest).data).body;
  fs.calls.length = 0;
  return { fs, authority, manifest };
}

// ---------------------------------------------------------------------------------------
// Obligation 1 / AC 1 — rename is the commit boundary
// ---------------------------------------------------------------------------------------

test("publish: generation is committed before the manifest that references it", () => {
  const { fs, authority } = freshStore();
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });

  const renames = fs.calls.filter((c) => c.op === "rename").map((c) => c.path);
  assert.deepEqual(renames, [
    stagingPath(P, "generation"),
    stagingPath(P, "manifest"),
  ]);
});

test("publish: a pre-commit failure leaves the prior snapshot byte-identical", () => {
  const { fs, authority, manifest } = publishedStore();
  const before = fs.snapshotBytes();

  fs.failOn("write", "staging/generation.json", errno("ENOSPC", "no space"));
  assert.throws(
    () =>
      publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), {
        live: manifest,
      }),
    (err) => causeCode(err) === "ENOSPC",
  );
  fs.clearHooks();

  const after = fs.snapshotBytes();
  for (const [path, bytes] of before) {
    assert.equal(after.get(path), bytes, `${path} must be byte-identical`);
  }
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1");
});

test("publish: a failing manifest rename leaves the prior manifest live", () => {
  const { fs, authority, manifest } = publishedStore();
  const priorManifest = fs.files.get(P.manifest).data;

  fs.failOn("rename", "staging/manifest.json", errno("EACCES", "denied"));
  assert.throws(
    () =>
      publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), {
        live: manifest,
      }),
    (err) => causeCode(err) === "EACCES",
  );
  fs.clearHooks();

  assert.equal(fs.files.get(P.manifest).data, priorManifest);
  // The cleanup of the staging file must not mask the original error, and must not leave
  // the staging name behind either.
  assert.equal(fs.files.has(stagingPath(P, "manifest")), false);
});

test("publish: no fsync is ever performed on snapshot data", () => {
  const { fs, authority } = freshStore();
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });
  // The seam has no fsync at all: a derived cache is crash-atomic, not power-durable, and
  // this assertion is what keeps that decision from silently regressing.
  assert.equal(typeof fs.fsync, "undefined");
  assert.equal(fs.calls.some((c) => c.op === "fsync"), false);
});

test("publish: a CRASH between the generation and manifest commits leaves a usable store", () => {
  const { fs, authority, manifest } = publishedStore();

  // A real crash, not an injected exception, and the difference is not pedantic. Throwing from
  // a hook lets `commitArtifact`'s catch and finally run, so staging is cleaned up and the
  // descriptor is closed — a strictly CLEANER state than a killed process leaves. Asserting
  // recovery from the clean state and calling it crash recovery is asserting that the startup
  // sweep is unnecessary. `captureState` is taken at the instant the manifest rename is about
  // to run, and restoring it afterwards discards everything the unwinding did.
  let crashState = null;
  fs.hooks.set("rename", (path) => {
    if (crashState === null && path === stagingPath(P, "manifest")) {
      crashState = fs.captureState();
      throw errno("EIO", "the process dies here");
    }
  });
  assert.throws(() =>
    publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
  );
  fs.clearHooks();
  assert.ok(crashState !== null, "the crash point was never reached");
  fs.restoreState(crashState);

  // What a crash actually leaves: gen-2 committed, the old manifest still live, and the staged
  // manifest stranded. Classification REFUSES that state, and correctly — clearing staging is
  // the sweep's job, so a store that classified as usable with residue in staging would be
  // saying the sweep does nothing.
  assert.equal(fs.files.has(stagingPath(P, "manifest")), true, "a crash strands the staged file");
  assert.equal(fs.files.has(`${P.generationsDir}/gen-2.json`), true);
  assert.equal(classifyStore(fs, P).status, "not-usable");

  // Recovery is the next START, which is where the sweep lives.
  const started = startWriter(fs, authority, P);
  assert.equal(started.status, "usable");
  assert.deepEqual(started.sweptStaging, [stagingPath(P, "manifest")]);
  // gen-2 exists but nothing references it. That is the residue the commit order promises —
  // ordinary GC input, never damage.
  assert.deepEqual(started.unreferencedGenerations, ["gen-2"]);
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1");
});

// ---------------------------------------------------------------------------------------
// Obligation 2 / AC 8 — write authority
// ---------------------------------------------------------------------------------------

// The mutating half of the seam, pinned HERE rather than read from the fake.
//
// The gating test below filters the call trace by this set, so whatever defines it also
// decides what the test bothers to look at. Taking it from `FakeFs.MUTATING_OPS` made that
// circular: dropping an op from the fake's set did not fail anything, it just quietly removed
// that op from the test's attention — the classification under test was also the filter
// deciding what got tested. This list is the test's own claim about the protocol, and the
// partition test that follows is what stops it from drifting away from the seam.
const MUTATING_SEAM_OPS = ["fchmod", "mkdir", "openExclusive", "rename", "rmdir", "unlink", "write"];

// Every umask the adapter ACCEPTS, at its boundaries. The guard refuses exactly those masks that
// clear owner READ from a 0700 directory (0o400), because the repair has to reopen what it
// created; everything else is supported and must therefore work. Tests used to hardcode three
// masks under a name that claimed "every umask", so a failure specific to 0o300 — a mask this
// store SUPPORTS, and one where a crash before `fchmod` leaves a wrong-mode file behind — could
// ship green. Anything reading this list is making a claim about the whole accepted range, so
// the refused boundary is asserted right here rather than assumed.
const ACCEPTED_UMASKS = [0o000, 0o022, 0o077, 0o100, 0o200, 0o300, 0o377];
const REFUSED_UMASK = 0o400;

test("publish: a manifest that is present but not ours refuses, it is not treated as first-run", () => {
  // `readGuarded` returns null for ABSENT and for PRESENT-BUT-NOT-OURS alike, and publish read
  // the live manifest through it. So a manifest that is a symlink, a FIFO, wrong-mode, oversized
  // or not valid UTF-8 read as "no live snapshot" — and with `live: null` that skips the
  // dominance check entirely and COMMITS OVER it. Two guarantees at once: a regressed candidate
  // could replace the prior snapshot (AC 5), and an invalid store could repair itself into a
  // usable-looking one without ever taking the atomic reset the derived-cache rule requires.
  for (const [label, corrupt] of [
    ["a wrong-mode manifest", (fs) => { fs.files.get(P.manifest).mode = 0o644; }],
    ["a manifest that is not valid UTF-8", (fs) => fs.putBytes(P.manifest, Buffer.from([0x7b, 0x80, 0x7d]))],
    ["a symlinked manifest", (fs) => { fs.nodes.delete(P.manifest); fs.symlink(P.manifest, "/outside/x"); }],
  ]) {
    const { fs, authority } = publishedStore();
    fs.mkdirp("/outside");
    fs.put("/outside/x", "{}");
    corrupt(fs);

    assert.throws(
      () => publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 99 }), { live: null }),
      (err) => {
        assert.equal(err.name, "SnapshotStoreResetError", label);
        return true;
      },
      label,
    );
    // ...and NOTHING was committed. A refusal that still writes is not a refusal.
    assert.equal(fs.files.has(`${P.generationsDir}/gen-2.json`), false, `${label}: gen-2 was committed`);
  }
});

test("privacy: the accepted-umask list this suite tests against is the adapter's real boundary", () => {
  // Without this, ACCEPTED_UMASKS is just a list someone typed: narrowing the adapter's guard
  // would leave every test that iterates it passing against masks production now rejects, and
  // widening it would leave the new masks untested while the names still say "every umask".
  for (const mask of ACCEPTED_UMASKS) {
    assert.doesNotThrow(() => assertUmaskAllowsOwnerModes(mask), `umask ${mask.toString(8)}`);
    const fs = new FakeFs();
    assert.doesNotThrow(() => { fs.umaskBits = mask; }, `fake umask ${mask.toString(8)}`);
  }
  assert.throws(() => assertUmaskAllowsOwnerModes(REFUSED_UMASK), /owner READ/);
  assert.throws(() => { new FakeFs().umaskBits = REFUSED_UMASK; }, /refuses umask/);
  // 0o377 is the largest accepted mask and 0o400 the smallest refused one: adjacent, so this
  // pins the boundary itself rather than two points on either side of a gap.
  assert.equal(Math.max(...ACCEPTED_UMASKS) + 1, REFUSED_UMASK);
});

test("authority: assertHeld immediately precedes every mutating seam call", () => {
  const { fs, authority } = freshStore();
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });

  // EVERY mutating seam call must be directly preceded by an assertion, with nothing in
  // between — not just the create and the commit. A generic trace assertion is the point:
  // an enumerated list of "the ops we remembered to gate" is the bug it would be checking for.
  const mutating = new Set(MUTATING_SEAM_OPS);
  let gated = 0;
  for (let i = 0; i < fs.calls.length; i++) {
    if (!mutating.has(fs.calls[i].op)) continue;
    gated += 1;
    assert.equal(
      fs.calls[i - 1]?.op,
      "assertHeld",
      `${fs.calls[i].op} on ${fs.calls[i].path} is not gated`,
    );
  }
  // A loop that inspects nothing passes vacuously; this publish must actually mutate.
  assert.ok(gated >= 6, `only ${gated} mutating calls were inspected`);
});

test("authority: a revoked authority publishes nothing, repeatedly", () => {
  const { fs, authority } = freshStore();
  FakeAuthority.revoke(authority);

  for (let attempt = 0; attempt < 5; attempt++) {
    assert.throws(
      () => publishSnapshot(fs, authority, P, candidate(`gen-${attempt}`, { claude: 1 }), { live: null }),
      /authority/,
    );
  }

  // Obligation 6/14: repeated revoked invocations produce ZERO staging files and ZERO
  // mutating seam calls. A staging file created before the gate would fail this, and would
  // then block the successor with EEXIST after its sweep.
  assert.deepEqual(fs.mutations(), []);
  assert.equal(fs.files.has(stagingPath(P, "generation")), false);
});

test("authority: the inner assertHeld is pinned at construction, not re-read on every call", () => {
  // The constructor validated `inner.assertHeld` and then `assertHeld()` dispatched through
  // `this.#inner.assertHeld()` — a fresh read of an object the CALLER still owns. Freezing the
  // authority does not freeze the inner one, so replacing the method afterwards left a frozen,
  // GUARDED-registered authority that passes `assertGuardedAuthority` and asserts nothing: AC 8
  // defeated through the one object the latch does not control.
  let realCalls = 0;
  let swappedCalls = 0;
  const inner = {
    assertHeld() {
      realCalls += 1;
      throw new Error("the lock is gone");
    },
  };
  const authority = createWriteAuthority(inner, () => TERMINATED);

  // THE SWAP, performed after construction — the whole point is that it is allowed to happen.
  inner.assertHeld = () => { swappedCalls += 1; };

  assert.throws(() => authority.assertHeld(), /the lock is gone/, "the pinned method must run");
  assert.equal(realCalls, 1, "the method validated at construction is the one that ran");
  assert.equal(swappedCalls, 0, "the replacement must never be reached");

  // An ACCESSOR is the same hazard without any post-construction mutation: it can answer with a
  // real function while the constructor is looking and a no-op on every call afterwards. One
  // read is what closes it, so there is only ever one answer to give.
  let reads = 0;
  const shifty = {};
  Object.defineProperty(shifty, "assertHeld", {
    get() {
      reads += 1;
      return reads === 1 ? () => { throw new Error("held check"); } : () => {};
    },
    configurable: true,
  });
  const guarded = createWriteAuthority(shifty, () => TERMINATED);
  assert.throws(() => guarded.assertHeld(), /held check/);
  assert.equal(reads, 1, "the property must be read exactly once, at construction");

  // ...and the pinned FUNCTION is not dispatched through either. Pinning stopped the caller's
  // object being re-read; invoking the result as `pinned.call(receiver)` then re-read `call` off
  // that function, which is an ordinary inherited property of an object the caller still owns.
  // So `held.call = () => undefined` disarms every assertion while the authority stays frozen
  // and branded — the same defect pinning fixed, one level down. `Reflect.apply` reads nothing.
  let ran = 0;
  const inner2 = {
    assertHeld() {
      ran += 1;
      throw new Error("still held-checking");
    },
  };
  const pinned = createWriteAuthority(inner2, () => TERMINATED);
  inner2.assertHeld.call = () => undefined;
  assert.throws(() => pinned.assertHeld(), /still held-checking/, "`call` must not be consulted");
  assert.equal(ran, 1, "the pinned function itself must have run");

  // ...and not through the GLOBAL either. `Reflect.apply` is a mutable property of a mutable
  // global, so reading it per-assertion just moved the same hazard one step further out: replace
  // it after construction and every check is a no-op while the authority stays frozen and
  // branded. Three forms of one defect — the caller's object, the caller's function, the global
  // — each introduced by the fix for the previous one. The intrinsic is captured at module load.
  const realApply = Reflect.apply;
  let viaGlobal = 0;
  const inner3 = { assertHeld() { viaGlobal += 1; throw new Error("global route"); } };
  const guardedGlobal = createWriteAuthority(inner3, () => TERMINATED);
  try {
    Reflect.apply = () => undefined;
    assert.throws(
      () => guardedGlobal.assertHeld(),
      /global route/,
      "patching Reflect.apply after construction must not disarm the assertion",
    );
    assert.equal(viaGlobal, 1);
  } finally {
    Reflect.apply = realApply;
  }
});

test("authority: the latch refuses a no-op lock-loss handler and disables publishing", () => {
  const raw = { assertHeld() { throw new Error("lost"); } };
  const quiet = createWriteAuthority(raw, () => undefined);
  assert.throws(() => quiet.assertHeld(), AuthorityHandlerContractError);

  let terminated = 0;
  const good = createWriteAuthority(raw, () => { terminated++; return TERMINATED; });
  assert.throws(() => good.assertHeld(), /lost/);
  assert.equal(terminated, 1);
  // Latched: a publish attempted after an observed loss is refused without even consulting
  // the inner authority, which by now may be answering for the successor.
  assert.throws(() => good.assertHeld(), AuthorityLostError);
  assert.equal(terminated, 1);
});

// ---------------------------------------------------------------------------------------
// Obligation 3 — the one rule: every invalid state resets, with no branch on the reason
// ---------------------------------------------------------------------------------------

const INVALID_STORES = [
  ["manifest-unparsable", (fs) => fs.put(P.manifest, "{not json")],
  [
    "manifest-checksum-mismatch",
    (fs) => {
      const doc = JSON.parse(encodeEnvelope("manifest", { a: 1 }));
      doc.body = { a: 2 };
      fs.put(P.manifest, JSON.stringify(doc));
    },
  ],
  [
    "manifest-schema-version",
    (fs) => {
      const body = { activeGenerationId: "g", retainedGenerationIds: ["g"], publishedAt: "2026-01-31T00:00:00Z", sourceVersion: {} };
      fs.put(
        P.manifest,
        JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, kind: "manifest", checksum: checksumOf(body), body }),
      );
    },
  ],
  [
    "manifest-invariants",
    (fs) => {
      // Active generation not among the retained ones: the next GC would delete what the
      // manifest points at.
      const body = { activeGenerationId: "g", retainedGenerationIds: ["other"], publishedAt: "2026-01-31T00:00:00Z", sourceVersion: {} };
      // Built with `encodeEnvelope` so the BYTES are canonical and the only defect is the one
      // this row is named for. A hand-assembled envelope has its keys in source order, which
      // the decoder now rejects as non-canonical before it ever reaches the invariants — so
      // the row would have passed while proving something else entirely.
      fs.put(P.manifest, encodeEnvelope("manifest", body));
    },
  ],
  [
    "generation-missing",
    (fs) => {
      const body = { activeGenerationId: "gone", retainedGenerationIds: ["gone"], publishedAt: "2026-01-31T00:00:00Z", sourceVersion: {} };
      fs.put(P.manifest, encodeEnvelope("manifest", body));
    },
  ],
  [
    "generation-checksum-mismatch",
    (fs) => {
      const body = { activeGenerationId: "g1", retainedGenerationIds: ["g1"], publishedAt: "2026-01-31T00:00:00Z", sourceVersion: {} };
      fs.put(P.manifest, encodeEnvelope("manifest", body));
      const gen = JSON.parse(encodeEnvelope("generation", { generationId: "g1" }));
      gen.body = { generationId: "tampered" };
      fs.put(`${P.generationsDir}/g1.json`, JSON.stringify(gen));
    },
  ],
  ["unknown-entry", (fs) => fs.put(`${P.root}/stray.txt`, "hello")],
  // An artifact whose BYTES are not valid UTF-8. The strict decoder turned silent U+FFFD
  // substitution into a named failure, but the failure classified as `other`, and
  // `readStoreFile` handles absence and symlinks and rethrows everything else — so a corrupt
  // artifact CRASHED the reader instead of resetting the derived cache. A guard whose refusal
  // reaches a caller with no disposition for it is not yet a guard.
  ["artifact-invalid-encoding", (fs) => fs.putBytes(P.manifest, Buffer.from([0x7b, 0x80, 0x7d]))],
  ["residue-without-manifest", (fs) => fs.put(`${P.generationsDir}/orphan.json`, "{}")],
];

for (const [reason, seed] of INVALID_STORES) {
  test(`one rule: ${reason} classifies not-usable and resets`, () => {
    const { fs, authority } = freshStore();
    seed(fs);

    const classification = classifyStore(fs, P);
    assert.equal(classification.status, "not-usable");
    assert.equal(classification.error.reason, reason);

    const started = startWriter(fs, authority, P);
    assert.equal(started.status, "not-usable");
    assert.equal(started.reset.stoppedOnAuthorityLoss, false);

    // The disposition is identical for every reason: an empty, initialized skeleton.
    assert.equal(classifyStore(fs, P).status, "first-run");
    assert.equal(fs.files.has(P.manifest), false);
    assert.deepEqual(fs.listDir(P.generationsDir), []);
  });
}

test("one rule: the reset reason is observability only — the code path never branches on it", async () => {
  // The structural half: the reason is data on ONE error type, not a family of types a caller
  // could switch on. This is necessary and it is not sufficient — it was the whole test, under
  // a name that claims something about CONTROL FLOW, and a `switch (err.reason)` in the store
  // would have satisfied every assertion in it. `errors.ts` states the same claim in prose and
  // cites "a test asserts that", so the claim was being made twice and checked nowhere.
  const seen = new Set();
  for (const [, seed] of INVALID_STORES) {
    const { fs } = freshStore();
    seed(fs);
    const err = classifyStore(fs, P).error;
    seen.add(err.constructor.name);
  }
  assert.deepEqual([...seen], ["SnapshotStoreResetError"]);

  const { readFileSync } = await import("node:fs");

  // The vocabulary comes from the union in `errors.ts`, not from a list retyped here: a reason
  // added later must be covered without anyone remembering to add it, which is the failure mode
  // a hand-maintained copy has. Parsed rather than imported because the union is a TYPE and is
  // erased before anything runs.
  const errorsSrc = readFileSync(new URL("../src/snapshot/errors.ts", import.meta.url), "utf8");
  const decl = errorsSrc.slice(errorsSrc.indexOf("export type ResetReason ="));
  const reasons = [...decl.slice(0, decl.indexOf(";")).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 15, `parsed only ${reasons.length} reasons — the parse broke`);
  assert.ok(reasons.includes("unknown-entry") && reasons.includes("container-replaced"));

  // The behavioural half, which is what the name actually claims. Branching on a reason means
  // COMPARING it, and a comparison against this vocabulary has to name one of these strings.
  // So the check is narrow and mechanical: no `=== "<reason>"`, no `case "<reason>"`, anywhere
  // the store decides anything. It is deliberately not a general dataflow analysis — it is the
  // one syntactic shape the claim rules out, checked against the built code that actually runs.
  for (const file of ["store.js", "errors.js", "envelope.js", "freshness.js", "dominance.js"]) {
    const src = readFileSync(new URL(`../dist/snapshot/${file}`, import.meta.url), "utf8");
    for (const reason of reasons) {
      const branch = new RegExp(`(===|!==|==(?!=)|!=(?!=))\\s*["']${reason}["']|case\\s+["']${reason}["']`);
      assert.equal(
        branch.test(src),
        false,
        `${file} branches on the reset reason "${reason}": the reason is for logging, and a ` +
          `code path that reads it makes one invalid store recover differently from another`,
      );
    }
  }
});

// ---------------------------------------------------------------------------------------
// Obligation 4 / 12 — reset is gated per mutation and idempotent
// ---------------------------------------------------------------------------------------

test("reset: every individual mutation is gated, and a mid-reset loss stops it dead", () => {
  const { fs, authority, manifest } = publishedStore();
  createPin(fs, authority, P, { pinId: "pin-1", generationId: "gen-1", until: "2099-01-01" });
  fs.calls.length = 0;

  // Revoke immediately after the manifest unlink — the moment a successor could take over.
  fs.hooks.set("unlink", (path) => {
    if (path === P.manifest) FakeAuthority.revoke(authority);
  });

  const result = resetStore(fs, authority, P);
  fs.clearHooks();

  assert.equal(result.stoppedOnAuthorityLoss, true);
  // The manifest unlink happened (it was gated and authority was still held); nothing after
  // it did. A recursive removal behind one assertion would have deleted everything here.
  assert.equal(fs.files.has(P.manifest), false);
  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), true);
  assert.equal(fs.files.has(`${P.pinsDir}/pin-1.json`), true);

  for (let i = 0; i < fs.calls.length; i++) {
    if (fs.calls[i].op !== "unlink") continue;
    assert.equal(fs.calls[i - 1]?.op, "assertHeld", "each reset unlink must be gated");
  }
});

test("reset: a stale writer cannot touch the successor's rebuilt store", () => {
  const { fs, authority, manifest } = publishedStore();

  // Stale writer starts a reset, then loses the lock after the manifest unlink.
  fs.hooks.set("unlink", (path) => {
    if (path === P.manifest) FakeAuthority.revoke(authority);
  });
  resetStore(fs, authority, P);
  fs.clearHooks();

  // Successor takes over and rebuilds completely.
  const successor = new FakeAuthority(fs);
  startWriter(fs, successor, P);
  publishSnapshot(fs, successor, P, candidate("gen-successor", { claude: 99 }), { live: null });
  const successorFiles = fs.snapshotBytes();
  fs.calls.length = 0;

  // Stale writer resumes its reset. It must perform no further mutation at all.
  const resumed = resetStore(fs, authority, P);
  assert.equal(resumed.stoppedOnAuthorityLoss, true);
  assert.deepEqual(fs.mutations(), []);
  const afterStaleReset = fs.snapshotBytes();
  for (const [path, bytes] of successorFiles) {
    assert.equal(afterStaleReset.get(path), bytes, `${path} must survive the stale reset`);
  }
});

test("reset: crashing partway leaves a state the next start classifies and resets again", () => {
  const { fs, authority } = publishedStore();
  fs.failOn("unlink", "generations/", errno("EIO", "crash"), 1);
  resetStore(fs, authority, P);
  fs.clearHooks();

  // Manifest gone, residue left: manifest-absent + residue is a reset, not a first run.
  assert.equal(classifyStore(fs, P).status, "not-usable");
  const started = startWriter(fs, authority, P);
  assert.equal(started.status, "not-usable");
  assert.equal(classifyStore(fs, P).status, "first-run");

  // Idempotent: running it again on the now-empty store is a no-op first run.
  assert.equal(startWriter(fs, authority, P).status, "first-run");
});

// ---------------------------------------------------------------------------------------
// Obligation 13 — reads are an optimistic snapshot transaction
// ---------------------------------------------------------------------------------------

test("read: a reader mid-flight during a reset gets no-snapshot, never a partial view", () => {
  const { fs, authority, manifest } = publishedStore();

  // The reset lands between the manifest read and the generation read — the exact window
  // where a reader already holds a valid manifest naming files that are being deleted.
  fs.hooks.set("openRead", (path) => {
    if (path === `${P.generationsDir}/gen-1.json`) {
      fs.clearHooks();
      resetStore(fs, authority, P);
    }
  });

  const result = readSnapshot(fs, P);
  fs.clearHooks();
  assert.equal(result.status, "no-snapshot");
});

test("read: a generation vanishing mid-read is not reported as corruption", () => {
  const { fs, authority, manifest } = publishedStore();
  fs.hooks.set("openRead", (path) => {
    if (path === `${P.generationsDir}/gen-1.json`) {
      fs.clearHooks();
      fs.files.delete(`${P.generationsDir}/gen-1.json`);
      fs.files.delete(P.manifest);
    }
  });

  const result = readSnapshot(fs, P);
  fs.clearHooks();
  // A reset legitimately removes referenced generations; calling that damage would
  // quarantine a healthy store.
  assert.equal(result.status, "no-snapshot");
});

test("read: a manifest replaced mid-read is retried, yielding the complete new snapshot", () => {
  const { fs, authority, manifest } = publishedStore();

  let swapped = false;
  fs.hooks.set("openRead", (path) => {
    if (!swapped && path === `${P.generationsDir}/gen-1.json`) {
      swapped = true;
      fs.clearHooks();
      publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
    }
  });

  const result = readSnapshot(fs, P);
  fs.clearHooks();
  assert.equal(result.status, "ok");
  assert.equal(result.view.generation.generationId, "gen-2");
});

test("read: a container swapped for a DIFFERENT REAL directory mid-read is not served", () => {
  const { fs, authority } = publishedStore();

  // Not a symlink, and not a wrong-moded directory — a genuine 0700 directory holding a
  // byte-identical copy of the generation the live manifest names. Every acceptability check
  // the reader can make passes on it: it is a directory, it is not a link, its mode is exactly
  // right, and the artifact inside it is valid, correctly named and checksum-correct. Only
  // IDENTITY separates it from the real one, which is why re-running the assertions at the
  // closing bracket was not enough.
  fs.mkdirp("/decoy", 0o700);
  fs.put(`/decoy/gen-1.json`, fs.files.get(`${P.generationsDir}/gen-1.json`).data);

  let swapped = false;
  fs.hooks.set("openRead", (path) => {
    if (swapped || path !== P.manifest) return;
    swapped = true;
    fs.renameDirect(P.generationsDir, "/parked");
    fs.renameDirect("/decoy", P.generationsDir);
  });
  const read = readSnapshot(fs, P);
  fs.clearHooks();

  assert.equal(swapped, true, "the swap must actually have happened");
  assert.equal(read.status, "no-snapshot", `served ${JSON.stringify(read)}`);
});

test("commit: a staging file replaced during the CLOSE window is never published", () => {
  const { fs, authority } = freshStore();
  startWriter(fs, authority, P);
  const staging = stagingPath(P, "generation");
  const target = `${P.generationsDir}/gen-1.json`;

  // `close` is a seam call like any other: it can run a hook, block, or flush for an unbounded
  // time on a real filesystem. So every check placed BEFORE it is stale by the time the rename
  // runs — which is why the commit now closes first and checks afterwards. The forged file is
  // a valid 0600 generation envelope carrying its own correct checksum, so nothing downstream
  // would reject it: if the rename happens, the store publishes it.
  let swapped = false;
  fs.hooks.set("close", () => {
    if (swapped || !fs.files.has(staging)) return;
    swapped = true;
    const forged = encodeEnvelope("generation", {
      generationId: "gen-1",
      sourceVersion: { claude: 999 },
      provenance: provenance(),
      payload: { total: 66613 },
      publishedAt: "2026-01-31T00:00:00Z",
    });
    fs.files.delete(staging);
    fs.put(staging, forged);
  });

  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null }),
    /was replaced between staging and commit/,
  );
  fs.clearHooks();

  assert.equal(swapped, true, "the swap must actually have happened");
  assert.equal(fs.files.has(target), false, "the forged artifact was published");
  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
});

test("read: a bit-flipped active generation quarantines and serves the retained known-good", () => {
  const { fs, authority, manifest } = publishedStore();
  const second = publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), {
    live: manifest,
  });
  assert.equal(second.status, "published");

  // Flip a byte inside the active generation's body; the checksum is what catches it.
  const path = `${P.generationsDir}/gen-2.json`;
  const doc = JSON.parse(fs.files.get(path).data);
  doc.body.payload = { total: 999 };
  fs.put(path, JSON.stringify(doc));

  const result = readSnapshot(fs, P);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.view.quarantined, ["gen-2"]);
  assert.equal(result.view.generation.generationId, "gen-1");
});

test("read: a parseable-but-corrupt payload still fails, so the checksum is load-bearing", () => {
  const { fs } = publishedStore();
  const path = `${P.generationsDir}/gen-1.json`;
  const doc = JSON.parse(fs.files.get(path).data);
  doc.body.payload = { total: 2 }; // valid JSON, valid shape, wrong content
  fs.put(path, JSON.stringify(doc));

  const result = readSnapshot(fs, P);
  assert.equal(result.status, "no-snapshot");
});

test("read: a wrong-mode artifact is refused (mode is enforced on the read side too)", () => {
  const { fs } = publishedStore();
  fs.files.get(P.manifest).mode = 0o644;
  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
});

// ---------------------------------------------------------------------------------------
// Obligation 5 / AC 5 — version scoping is the downgrade mechanism
// ---------------------------------------------------------------------------------------

test("version scoping: another version's directory is never opened or touched", () => {
  const { fs, authority } = freshStore();
  const otherRoot = `${STATE}/store-v${SCHEMA_VERSION + 1}`;
  fs.mkdirp(`${otherRoot}/generations`);
  fs.put(`${otherRoot}/manifest.json`, "newer-schema-manifest");
  fs.put(`${otherRoot}/generations/gen-x.json`, "newer-schema-generation");
  const before = fs.snapshotBytes();

  startWriter(fs, authority, P);
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });

  // EVERY pathname operand, not just the primary one — the same fix `callsOutside` already
  // carries, left standing here. `rename` takes two, and `c.path` is only the SOURCE, so a
  // regression that staged inside this version and renamed the artifact into the other one had
  // an in-scope `c.path` and was invisible to this assertion.
  const touched = fs.calls.flatMap((c) => c.paths ?? []).filter((p) => contained(p, otherRoot));
  assert.deepEqual(touched, [], "no seam call may address another version's directory");

  // The whole SUBTREE, compared as a set as well as by bytes. Iterating only the files that
  // existed `before` cannot see a file that was CREATED under the other root — which is exactly
  // what a rename into it would produce, and exactly the case the byte comparison reads as
  // proof against.
  const under = (snap) => [...snap.keys()].filter((p) => contained(p, otherRoot)).sort();
  const afterPublish = fs.snapshotBytes();
  assert.deepEqual(under(afterPublish), under(before), "no entry may appear or vanish there");
  for (const [path, bytes] of before) {
    if (contained(path, otherRoot)) {
      assert.equal(afterPublish.get(path), bytes, `${path} must be byte-identical`);
    }
  }
});

// ---------------------------------------------------------------------------------------
// Obligation 6 / 14 — bounded staging, swept at start
// ---------------------------------------------------------------------------------------

test("staging: the happy path leaves zero staging files", () => {
  const { fs, authority } = freshStore();
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });
  assert.deepEqual(fs.listDir(P.stagingDir), []);
});

test("staging: residue is bounded by three fixed names even when cleanup cannot run", () => {
  const { fs, authority, manifest } = publishedStore();
  const staged = () => fs.files.keys().filter((p) => p.startsWith(`${P.stagingDir}/`)).sort();

  // ALL THREE KINDS, not just the generation.
  //
  // The previous shape failed only the generation rename, so the manifest and pin staging
  // names were never left behind at all — and then asserted `residue.length <= 3` immediately
  // after a deepEqual pinning residue to exactly one file. That second assertion cannot fail
  // if the first passed. It read as evidence for the three-name bound while the scenario only
  // ever produced one name, so a regression to unique per-invocation MANIFEST or PIN staging
  // names was outside what this test could see.
  //
  // Cleanup must actually FAIL, or every iteration ends with zero residue and the test proves
  // nothing about boundedness at all.
  fs.failOn("unlink", "staging/", errno("EIO", "cleanup failed"));

  // Each kind is driven to residue in turn, in an order where none blocks the next: the fixed
  // names are per-kind, so a stranded generation.json does not stop a manifest or pin commit.
  for (let attempt = 0; attempt < 25; attempt++) {
    // (a) pin residue — the pin's own rename fails.
    fs.failOn("rename", "staging/pin.json", errno("EIO", "pin commit failed"));
    try {
      createPin(fs, authority, P, {
        pinId: `pin-${attempt}`,
        generationId: "gen-1",
        until: "2099-01-01",
      });
    } catch {
      // Expected.
    }
    fs.clearHooks();
    fs.failOn("unlink", "staging/", errno("EIO", "cleanup failed"));

    // (b) manifest residue — the generation commits, then the manifest rename fails.
    fs.failOn("rename", "staging/manifest.json", errno("EIO", "manifest commit failed"));
    try {
      publishSnapshot(fs, authority, P, candidate(`gen-m${attempt}`, { claude: 200 + attempt }), {
        live: manifest,
      });
    } catch {
      // Expected.
    }
    fs.clearHooks();
    fs.failOn("unlink", "staging/", errno("EIO", "cleanup failed"));

    // (c) generation residue — the generation rename itself fails.
    fs.failOn("rename", "staging/generation.json", errno("EIO", "commit failed"));
    try {
      publishSnapshot(fs, authority, P, candidate(`gen-${attempt}`, { claude: 100 + attempt }), {
        live: manifest,
      });
    } catch {
      // Expected.
    }
    fs.clearHooks();
    fs.failOn("unlink", "staging/", errno("EIO", "cleanup failed"));
  }
  fs.clearHooks();

  // Exactly the three fixed names after 75 stranded commits — one per artifact kind, which is
  // the whole point of the scheme. An exact set, so unique-name regressions in ANY kind fail.
  assert.deepEqual(staged(), [
    `${P.stagingDir}/generation.json`,
    `${P.stagingDir}/manifest.json`,
    `${P.stagingDir}/pin.json`,
  ]);

  // And the next start clears all three.
  startWriter(fs, authority, P);
  assert.deepEqual(staged(), []);
});

test("staging: the startup sweep clears residue, and authority is verified before it runs", () => {
  const { fs, authority } = freshStore();
  fs.put(stagingPath(P, "manifest"), "crash residue");

  FakeAuthority.revoke(authority);
  assert.throws(() => startWriter(fs, authority, P), /authority/);
  // Nothing swept: a process that already lost the lock must not begin a sweep, because
  // the fixed names it would remove may already belong to its successor.
  assert.equal(fs.files.has(stagingPath(P, "manifest")), true);
  assert.deepEqual(fs.mutations(), []);

  // The sweep that DOES run belongs to a successor, not to the revoked writer. That is not a
  // test convenience: the authority latches on first loss and never recovers, so un-revoking
  // it — which this test used to do by poking a public field — was exercising a resurrection
  // production makes impossible. A new process with a new authority is the real sequence.
  const successor = new FakeAuthority(fs);
  const started = startWriter(fs, successor, P);
  assert.deepEqual(started.sweptStaging, [stagingPath(P, "manifest")]);
});

test("staging: a stale invocation cannot remove the successor's file at the same fixed name", () => {
  const { fs, authority } = freshStore();

  // Stale writer stages, then loses the lock before its commit.
  fs.hooks.set("rename", () => {
    FakeAuthority.revoke(authority);
    throw errno("EIO", "lock transferred");
  });
  assert.throws(() =>
    publishSnapshot(fs, authority, P, candidate("gen-stale", { claude: 1 }), { live: null }),
  );
  fs.clearHooks();

  // Its residue is LEFT, not deleted — by now the name may not be its own.
  assert.equal(fs.files.has(stagingPath(P, "generation")), true);

  // Successor sweeps and stages its own file at the same fixed name.
  const successor = new FakeAuthority(fs);
  startWriter(fs, successor, P);
  fs.put(stagingPath(P, "generation"), "successor's in-flight artifact");
  fs.calls.length = 0;

  // Stale writer retries: it must not create, rename, or remove the successor's file.
  assert.throws(() =>
    publishSnapshot(fs, authority, P, candidate("gen-stale-2", { claude: 2 }), { live: null }),
  );
  assert.deepEqual(fs.mutations(), []);
  assert.equal(fs.files.get(stagingPath(P, "generation")).data, "successor's in-flight artifact");
});

// ---------------------------------------------------------------------------------------
// Obligation 15 — classification precedence
// ---------------------------------------------------------------------------------------

test("classification: empty skeleton is first-run; any residue is a reset", () => {
  const { fs } = freshStore();
  assert.equal(classifyStore(fs, P).status, "first-run");

  fs.put(`${P.pinsDir}/pin-1.json`, "{}");
  const withResidue = classifyStore(fs, P);
  assert.equal(withResidue.status, "not-usable");
  assert.equal(withResidue.error.reason, "residue-without-manifest");
});

test("classification: a valid manifest beside an orphan generation stays usable", () => {
  const { fs, authority } = publishedStore();
  fs.put(`${P.generationsDir}/gen-orphan.json`, encodeEnvelope("generation", { generationId: "gen-orphan" }));

  const classification = classifyStore(fs, P);
  assert.equal(classification.status, "usable");
  assert.deepEqual(classification.unreferencedGenerations, ["gen-orphan"]);

  // And it is ordinary GC input, not a reset trigger.
  collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
  assert.equal(fs.files.has(`${P.generationsDir}/gen-orphan.json`), false);
  assert.equal(classifyStore(fs, P).status, "usable");
});

// ---------------------------------------------------------------------------------------
// Obligation 9 / AC 4 — GC and pins
// ---------------------------------------------------------------------------------------

test("gc: the last known-good generation is always retained", () => {
  const { fs, authority, manifest } = publishedStore();
  collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), true);
});

test("gc: an unexpired pin protects its generation; an expired one is removed", () => {
  const { fs, authority, manifest } = publishedStore();
  const m2 = (() => {
    publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
    return JSON.parse(fs.files.get(P.manifest).data).body;
  })();
  const m3 = (() => {
    publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), { live: m2 });
    return JSON.parse(fs.files.get(P.manifest).data).body;
  })();

  createPin(fs, authority, P, { pinId: "pin-live", generationId: "gen-1", until: "2099-01-01" });
  createPin(fs, authority, P, { pinId: "pin-dead", generationId: "gen-1", until: "2020-01-01" });

  collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");

  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), true, "pinned generation survives");
  assert.equal(fs.files.has(`${P.pinsDir}/pin-dead.json`), false, "expired pin is removed");
  assert.equal(fs.files.has(`${P.pinsDir}/pin-live.json`), true);
});

test("gc: an unparsable pin is removed without touching a generation another pin protects", () => {
  const { fs, authority, manifest } = publishedStore();

  // gen-1 must be COLLECTABLE before the pin can be shown to protect it.
  //
  // Written against the freshly-published store, gen-1 was still the active generation and was
  // retained by the live manifest, so its survival said nothing whatsoever about the valid
  // pin — a collector that ignored every pin passed. Two newer generations at retain 1 push
  // gen-1 out of the manifest's retention set, so from here the ONLY thing keeping it is
  // pin-ok.
  const m2 = (() => {
    publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest, retain: 1 });
    return JSON.parse(fs.files.get(P.manifest).data).body;
  })();
  publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), { live: m2, retain: 1 });
  const live = JSON.parse(fs.files.get(P.manifest).data).body;
  assert.equal(live.activeGenerationId, "gen-3");
  assert.equal(
    live.retainedGenerationIds.includes("gen-1"),
    false,
    "the premise: gen-1 must be unreferenced, or the pin proves nothing",
  );

  // A second unreferenced generation with NO pin, as the control. Without it, a sweep that
  // collected nothing at all would also satisfy every assertion below.
  fs.put(
    `${P.generationsDir}/gen-unpinned.json`,
    encodeEnvelope("generation", { generationId: "gen-unpinned" }),
  );

  fs.put(`${P.pinsDir}/pin-bad.json`, "{not json");
  createPin(fs, authority, P, { pinId: "pin-ok", generationId: "gen-1", until: "2099-01-01" });

  collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");

  assert.equal(fs.files.has(`${P.pinsDir}/pin-bad.json`), false, "the malformed pin must go");
  assert.equal(fs.files.has(`${P.pinsDir}/pin-ok.json`), true, "the valid pin must survive");
  assert.equal(
    fs.files.has(`${P.generationsDir}/gen-unpinned.json`),
    false,
    "the control: an unreferenced, unpinned generation must actually be collected",
  );
  assert.equal(
    fs.files.has(`${P.generationsDir}/gen-1.json`),
    true,
    "gen-1 is unreferenced and survives only because pin-ok protects it",
  );
});

test("gc: a mid-sweep authority loss stops the sweep instead of continuing ungated", () => {
  const { fs, authority, manifest } = publishedStore();
  fs.put(`${P.generationsDir}/gen-old-a.json`, encodeEnvelope("generation", { generationId: "a" }));
  fs.put(`${P.generationsDir}/gen-old-b.json`, encodeEnvelope("generation", { generationId: "b" }));

  fs.hooks.set("unlink", () => FakeAuthority.revoke(authority));
  const result = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
  fs.clearHooks();

  assert.equal(result.stoppedOnAuthorityLoss, true);
  assert.equal(result.removedGenerations.length, 1);
  assert.equal(fs.files.has(`${P.generationsDir}/gen-old-b.json`), true);
});

// ---------------------------------------------------------------------------------------
// Obligation 10 / AC 7 — dominance
// ---------------------------------------------------------------------------------------

test("dominance: only strict dominance publishes", () => {
  const { fs, authority, manifest } = publishedStore();

  for (const [label, versions] of [
    ["equal", { claude: 10 }],
    ["regressed", { claude: 5 }],
  ]) {
    const before = fs.files.get(P.manifest).data;
    assert.throws(
      () => publishSnapshot(fs, authority, P, candidate("gen-x", versions), { live: manifest }),
      SnapshotNotDominatingError,
      label,
    );
    assert.equal(fs.files.get(P.manifest).data, before, `${label} must leave the snapshot intact`);
  }
});

test("dominance: the scalar-max counterexample is incomparable, never dominating", () => {
  // A advances, B regresses. max() rises, so a scalar version would publish data loss.
  const live = canonicalSourceVersion({ a: 5, b: 9 });
  const cand = canonicalSourceVersion({ a: 20, b: 1 });
  assert.equal(compareSourceVersions(cand, live), "incomparable");
  assert.ok(Math.max(...Object.values(cand)) > Math.max(...Object.values(live)));
});

test("dominance: a dropped source is incomparable, never dominating (fails closed)", () => {
  const live = canonicalSourceVersion({ a: 5, b: 9 });
  const dropped = canonicalSourceVersion({ a: 50 });
  assert.equal(compareSourceVersions(dropped, live), "incomparable");
});

test("dominance: every non-dominating verdict is refused BY publishSnapshot, store untouched", () => {
  // The verdicts above are unit facts about `compareSourceVersions`. This is the fact that
  // matters: that `publishSnapshot` acts on them. Nothing proved the wiring end to end, so a
  // publish path that computed the verdict and then ignored it would have passed everything.
  const cases = [
    ["equal", { claude: 10 }],
    ["incomparable", { claude: 20, gemini: 1 }],
    ["regressed", { claude: 1 }],
  ];
  for (const [verdict, sourceVersion] of cases) {
    const { fs, authority, manifest } = publishedStore(); // live: { claude: 10 }
    const before = fs.snapshotBytes();

    assert.throws(
      () => publishSnapshot(fs, authority, P, candidate("gen-2", sourceVersion), { live: manifest }),
      (err) => {
        assert.equal(err.name, "SnapshotNotDominatingError", verdict);
        // The verdict is carried on the error, so a caller can tell "you are behind" from
        // "these two are not comparable" — the distinction the fail-closed rule turns on.
        assert.equal(err.verdict, verdict, `expected ${verdict}, got ${err.verdict}`);
        return true;
      },
      verdict,
    );
    // The prior snapshot is not merely still readable — it is byte-identical, and the refusal
    // wrote nothing anywhere.
    assert.deepEqual(fs.snapshotBytes(), before, `${verdict}: the store was modified`);
    assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1", verdict);
    assert.equal(fs.files.has(`${P.generationsDir}/gen-2.json`), false, verdict);
    assert.equal(fs.files.has(stagingPath(P, "generation")), false, verdict);
  }
});

test("dominance: hostile manifests are refused or handled without becoming dominating", () => {
  // A source legitimately named __proto__ must survive as an ordinary own key.
  const withProto = canonicalSourceVersion(JSON.parse('{"__proto__": 3, "a": 1}'));
  assert.equal(Object.hasOwn(withProto, "__proto__"), true);
  assert.equal(withProto["__proto__"], 3);
  assert.equal(Object.getPrototypeOf(withProto), null);

  // toString/constructor are ordinary keys too.
  const withToString = canonicalSourceVersion({ toString: 1, constructor: 2 });
  assert.equal(withToString.toString, 1);

  assert.throws(() => canonicalSourceVersion({ [Symbol("s")]: 1, a: 1 }), SourceVersionManifestError);
  assert.throws(() => canonicalSourceVersion(new Proxy({ a: 1 }, {})), SourceVersionManifestError);
  const revocable = Proxy.revocable({ a: 1 }, {});
  revocable.revoke();
  assert.throws(() => canonicalSourceVersion(revocable.proxy), SourceVersionManifestError);
  assert.throws(
    () => canonicalSourceVersion(Object.defineProperty({}, "a", { get: () => 1, enumerable: true })),
    SourceVersionManifestError,
  );
  assert.throws(() => canonicalSourceVersion({ a: 1.5 }), SourceVersionManifestError);
  assert.throws(() => canonicalSourceVersion({ a: -1 }), SourceVersionManifestError);
});

test("dominance: a publish prepared against a STALE manifest is refused, not applied", () => {
  // This test used to assert the opposite, and asserting it was the defect. `live` was taken
  // as the answer to "what am I required to dominate", so a caller holding a manifest one
  // publish behind dominated offsets nobody held any more while REGRESSING against the offsets
  // that were actually live — and the store accepted it. Nothing about the argument was
  // invalid; it was simply not current, which is precisely why validating it could never have
  // caught this. It is the same defect `collectGarbage` was fixed for, and the fix is the same:
  // the file that defines the live snapshot is the only defensible source for what it is.
  const { fs, authority, manifest } = publishedStore();
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
  const before = fs.snapshotBytes();

  assert.throws(
    () =>
      publishSnapshot(fs, authority, P, candidate("gen-1b", { claude: 11 }), {
        live: manifest, // deliberately stale
      }),
    (err) => /not the live one/.test(err.message),
  );

  // Refused with the store byte-identical: no staging residue, no orphan generation.
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-2");
  const after = fs.snapshotBytes();
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [path, bytes] of before) assert.equal(after.get(path), bytes, path);

  // `live: null` is refused for the same reason, and this is the sharper half: it used to skip
  // the dominance check ENTIRELY, so a regressed candidate published straight over the live
  // snapshot with no comparison performed at all.
  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-1c", { claude: 1 }), { live: null }),
    (err) => /not the live one/.test(err.message),
  );
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-2");

  // And the current manifest still publishes normally.
  const live = JSON.parse(fs.files.get(P.manifest).data).body;
  publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), { live });
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-3");
});

// ---------------------------------------------------------------------------------------
// Obligation 10 / AC 6 — provenance and derived freshness
// ---------------------------------------------------------------------------------------

test("freshness: derived per requested range — there is no global stale flag", () => {
  const prov = provenance({
    coverage: [
      { start: "2026-01-01", end: "2026-01-15" },
      { start: "2026-01-20", end: "2026-02-01" },
    ],
  });

  const covered = deriveFreshness(prov, { start: "2026-01-02", end: "2026-01-10" });
  assert.equal(covered.covered, true);
  assert.deepEqual(covered.gaps, []);

  const gapped = deriveFreshness(prov, { start: "2026-01-10", end: "2026-01-25" });
  assert.equal(gapped.covered, false);
  assert.deepEqual(gapped.gaps, [
    { start: "2026-01-15T00:00:00.000Z", end: "2026-01-20T00:00:00.000Z" },
  ]);

  // Same generation, two answers: freshness is a property of the question, not the store.
  assert.notEqual(covered.covered, gapped.covered);
});

test("freshness: the SAME range answers differently per requested field (AC 6)", () => {
  const prov = provenance();
  const range = { start: "2026-01-10", end: "2026-01-20" };

  // The range is fully covered by the snapshot as a whole...
  assert.equal(deriveFreshness(prov, range).covered, true);

  // ...and yet `tokens` is not covered over it, because that field's own coverage stops on
  // the 15th. If a single stored `stale` flag existed, one of these two answers would be
  // wrong — which is the entire reason AC 6 forbids one.
  const answer = deriveFreshness(prov, { ...range, fields: ["cost", "tokens"] });
  assert.equal(answer.fields.cost.covered, true);
  assert.equal(answer.fields.tokens.covered, false);
  assert.deepEqual(answer.fields.tokens.gaps, [
    { start: "2026-01-15T00:00:00.000Z", end: "2026-01-20T00:00:00.000Z" },
  ]);
  assert.notEqual(answer.fields.cost.covered, answer.fields.tokens.covered);
});

test("freshness: a field with no recorded coverage is not covered (absence is not a claim)", () => {
  const answer = deriveFreshness(provenance(), {
    start: "2026-01-02",
    end: "2026-01-03",
    fields: ["cost", "models"],
  });
  assert.equal(answer.fields.cost.covered, true);
  // `models` was never recorded. Treating an absent field as covered would be the same
  // substitution dominance.ts refuses when a source key goes missing.
  assert.equal(answer.fields.models.covered, false);
  assert.deepEqual(answer.fields.models.gaps, [
    { start: "2026-01-02T00:00:00.000Z", end: "2026-01-03T00:00:00.000Z" },
  ]);
});

test("freshness: a query in a different timezone invalidates the whole answer (AC 6)", () => {
  const prov = provenance();
  const range = { start: "2026-01-02", end: "2026-01-03", fields: ["cost"] };

  // Same timezone: ordinary answer.
  const matched = deriveFreshness(prov, { ...range, timezone: "America/Vancouver" });
  assert.equal(matched.timezoneMismatch, false);
  assert.equal(matched.covered, true);
  assert.equal(matched.fields.cost.covered, true);

  // Different timezone: v0.2's rule is query-tz-must-match-snapshot-tz (re-bucketing is
  // future work), so the snapshot cannot answer at all — not "covered, but note the tz".
  const mismatched = deriveFreshness(prov, { ...range, timezone: "UTC" });
  assert.equal(mismatched.timezoneMismatch, true);
  assert.equal(mismatched.covered, false);
  assert.equal(mismatched.fields.cost.covered, false);
});

// HISTORICAL transitions, deliberately — 2024, not a future year.
//
// These assertions pin exact UTC instants, which means they are pinning what the running
// Node's tzdata says. For a FUTURE date that is a hostage: a government moves a changeover (or
// abolishes DST, which several jurisdictions keep proposing), tzdata ships the new rule, and
// this suite goes red on a machine where `localDayBounds` is behaving perfectly — reporting a
// store defect that does not exist. A transition that has already happened is a fact tzdata
// records rather than predicts, so the expectations stay exact and stay stable.
const DST_SPRING = { year: 2024, month: 3, day: 10 }; // 02:00 -> 03:00, a 23-hour local day
const DST_FALL = { year: 2024, month: 11, day: 3 }; //  02:00 -> 01:00, a 25-hour local day

test("freshness: DST — a local day is 23h in the spring gap and 25h in the fall fold", () => {
  const tz = "America/Vancouver";

  const springForward = localDayBounds(tz, DST_SPRING);
  assert.equal(springForward.start, "2024-03-10T08:00:00.000Z");
  assert.equal(springForward.end, "2024-03-11T07:00:00.000Z");
  assert.equal(
    (Date.parse(springForward.end) - Date.parse(springForward.start)) / 3_600_000,
    23,
    "the spring-forward day must be 23 hours, not 24",
  );

  const fallBack = localDayBounds(tz, DST_FALL);
  assert.equal(fallBack.start, "2024-11-03T07:00:00.000Z");
  assert.equal(fallBack.end, "2024-11-04T08:00:00.000Z");
  assert.equal(
    (Date.parse(fallBack.end) - Date.parse(fallBack.start)) / 3_600_000,
    25,
    "the fall-back day must be 25 hours, not 24",
  );

  // An ordinary day is still 24.
  const ordinary = localDayBounds(tz, { year: 2024, month: 6, day: 15 });
  assert.equal((Date.parse(ordinary.end) - Date.parse(ordinary.start)) / 3_600_000, 24);
});

test("freshness: a non-enumerable field is refused, because canonicalization drops it", () => {
  // The write/read boundary again. `JSON.stringify` — and therefore `canonicalize`, and
  // therefore every byte that reaches disk — visits enumerable own string keys only. Freshness
  // read its inputs through `getOwnPropertyDescriptors`, which returns non-enumerable ones too,
  // and copied them with `enumerable: true`. So a provenance could answer questions HERE using
  // a field the generation written from that same object does not contain.
  const hidden = provenance();
  // `timezone`, the field freshness actually READS — not `timeZone`, which this test used to
  // hide and which no provenance has. `defineProperty` on an absent key ADDS one whose value is
  // `undefined`, so the fixture was proving only that an unrelated extra non-enumerable key is
  // refused. A build that accepted a hidden `timezone` and answered from it, while still
  // rejecting every other hidden key, passed. Both premise assertions were vacuous too:
  // `undefined === undefined` twice over.
  assert.equal(
    Object.getOwnPropertyDescriptor(hidden, "timezone")?.enumerable,
    true,
    "the fixture must start with the field present and enumerable, or nothing below is hidden",
  );
  const tz = hidden.timezone;
  assert.equal(typeof tz, "string", "and it must carry a real value to hide");
  Object.defineProperty(hidden, "timezone", { value: tz, enumerable: false, configurable: true });

  // The premise, stated rather than assumed: this really is the field-dropping shape.
  assert.equal(JSON.parse(JSON.stringify(hidden)).timezone, undefined, "the write path drops it");
  assert.equal(hidden.timezone, tz, "...while a plain read still finds it");

  assert.throws(
    () => deriveFreshness(hidden, { start: "2026-01-01", end: "2026-01-02" }),
    /non-enumerable/,
    "a field the stored generation would not contain must not answer a freshness question",
  );

  // Same rule one level down, on an interval element: two of this file's three descriptor loops
  // enforced it and the interval loop did not.
  const sparse = provenance();
  const intervals = [...sparse.coverage];
  Object.defineProperty(intervals, "0", { value: intervals[0], enumerable: false, configurable: true });
  assert.throws(
    () => deriveFreshness({ ...sparse, coverage: intervals }, { start: "2026-01-01", end: "2026-01-02" }),
    /non-enumerable/,
  );

  // The honest negative: an ordinary enumerable provenance still answers, or this test would
  // pass against a module that had simply started refusing everything.
  assert.equal(deriveFreshness(provenance(), { start: "2026-01-02", end: "2026-01-03" }).covered, true);

  // An unknown timezone keeps the platform's own account of WHY, as an opaque cause. It used to
  // be discarded, which for an ICU build shipped without a zone database left an operator with a
  // refusal and no explanation of it.
  assert.throws(
    () => deriveFreshness(provenance(), { start: "2026-01-01", end: "2026-01-02", timezone: "Mars/Olympus" }),
    (err) => {
      assert.match(err.message, /unknown timezone: Mars\/Olympus/);
      assert.notEqual(err.cause, undefined, "the platform's own failure must travel with it");
      return true;
    },
  );
});

test("freshness: DST gap — coverage of 24h from local midnight OVERSHOOTS the 23h day", () => {
  const tz = "America/Vancouver";
  const day = localDayBounds(tz, DST_SPRING);

  // A snapshot that recorded "midnight plus 24 hours" on the spring-forward day claims an
  // hour that belongs to the NEXT local day. Freshness for the real 23-hour day is covered;
  // freshness for the next day must NOT be, or that stolen hour would hide a genuine gap.
  const naive = provenance({
    coverage: [{ start: day.start, end: new Date(Date.parse(day.start) + 24 * 3_600_000).toISOString() }],
  });
  assert.equal(deriveFreshness(naive, { start: day.start, end: day.end }).covered, true);

  const nextDay = localDayBounds(tz, { year: 2024, month: 3, day: 11 });
  const next = deriveFreshness(naive, { start: nextDay.start, end: nextDay.end });
  assert.equal(next.covered, false, "the next local day must not be covered by the overshoot");
  assert.deepEqual(next.gaps, [
    { start: "2024-03-11T08:00:00.000Z", end: nextDay.end },
  ]);
});

test("freshness: DST fold — the repeated local hour is two distinct instants", () => {
  const tz = "America/Vancouver";
  const day = localDayBounds(tz, DST_FALL);

  // 01:30 local occurs TWICE on the fall-back day: 08:30Z (PDT) and 09:30Z (PST). Coverage
  // that stops at the first occurrence leaves the second uncovered — which is only
  // expressible because intervals are instants. Wall-clock text could not tell them apart.
  const firstOccurrence = "2024-11-03T08:30:00.000Z";
  const partial = provenance({ coverage: [{ start: day.start, end: firstOccurrence }] });
  const answer = deriveFreshness(partial, { start: day.start, end: day.end });
  assert.equal(answer.covered, false);
  assert.deepEqual(answer.gaps, [{ start: firstOccurrence, end: day.end }]);
  // The second occurrence of 01:30 local falls inside that gap, an hour after the first.
  assert.ok(Date.parse("2024-11-03T09:30:00.000Z") > Date.parse(firstOccurrence));
});

test("freshness: an empty or inverted range yields no gaps rather than a backwards one", () => {
  const prov = provenance({ coverage: [] });
  assert.deepEqual(deriveFreshness(prov, { start: "2026-01-05", end: "2026-01-05" }).gaps, []);
  assert.deepEqual(deriveFreshness(prov, { start: "2026-01-10", end: "2026-01-05" }).gaps, []);
});

test("freshness: an unparseable instant is a named error, not a silent NaN comparison", () => {
  assert.throws(
    () => deriveFreshness(provenance(), { start: "not-a-date", end: "2026-01-05" }),
    /invalid freshness request/,
  );
});

test("provenance: every generation records the full provenance record", () => {
  const { fs } = publishedStore();
  const doc = JSON.parse(fs.files.get(`${P.generationsDir}/gen-1.json`).data).body;
  // The EXACT own-key set, not a subset probed with `in`.
  //
  // Two ways the previous version could not fail for the reason its name gives. It omitted
  // `fieldCoverage` — the field carrying AC 6's per-field freshness claims — so a
  // serialization regression that dropped exactly that field passed. And `in` walks the
  // prototype chain and is satisfied by a field that merely EXISTS, so a record inheriting
  // a name it never persisted would have counted as "recorded".
  assert.deepEqual(
    Object.keys(doc.provenance).sort(),
    [
      "ccusageInvokedAt",
      "ccusageVersion",
      "coverage",
      "dayBoundaryPolicy",
      "fieldCoverage",
      "refreshTier",
      "sourceTimestamps",
      "timezone",
    ],
    "the persisted provenance must be exactly the protocol's provenance record",
  );
  for (const field of Object.keys(doc.provenance)) {
    assert.ok(Object.hasOwn(doc.provenance, field), `provenance.${field} must be an OWN property`);
  }
});

// ---------------------------------------------------------------------------------------
// Obligation 10 / AC 9 — privacy
// ---------------------------------------------------------------------------------------

test("privacy: files are 0600 and directories 0700 under every umask", () => {
  for (const umask of ACCEPTED_UMASKS) {
    const fs = new FakeFs();
    fs.umaskBits = umask;
    // The state directory is the CALLER's (T-011 creates it); the store creates only its own
    // version-scoped root and below. The fake enforces that now: mkdir needs a real parent.
    fs.mkdirp(STATE);
    const authority = new FakeAuthority(fs);
    startWriter(fs, authority, P);
    publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });

    assert.equal(fs.files.get(P.manifest).mode & 0o7777, 0o600, `umask ${umask.toString(8)}`);
    // `P.root` included: it is a directory the store creates and owns like any other, and a
    // regression specific to the root's mode passed a test whose name is "directories 0700"
    // because only its three children were checked.
    for (const dir of [P.root, P.generationsDir, P.pinsDir, P.stagingDir]) {
      assert.equal(fs.dirs.get(dir).mode & 0o7777, 0o700, `umask ${umask.toString(8)} dir ${dir}`);
    }
  }
});

test("privacy: the mode is set and verified on the fd, not requested at open", () => {
  const { fs, authority } = freshStore();
  fs.umaskBits = 0o022;
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });

  const seq = fs.calls.filter((c) => ["openExclusive", "write", "fchmod", "fstat"].includes(c.op));
  const firstOpen = seq.findIndex((c) => c.op === "openExclusive");
  const fchmodAt = seq.findIndex((c, i) => i > firstOpen && c.op === "fchmod");
  assert.ok(fchmodAt > firstOpen, "the mode must be set after open, not requested at open");
  assert.equal(seq[fchmodAt + 1]?.op, "fstat", "the mode must be verified on the fd");
});

test("privacy: a setuid bit is a refusal signal, not a rounding error", () => {
  const { fs } = publishedStore();
  fs.files.get(P.manifest).mode = 0o4600;
  assert.equal(classifyStore(fs, P).status, "not-usable");
  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
});

test("privacy: a symlinked artifact is refused", () => {
  const { fs } = publishedStore();
  // A real symlink REPLACES the file at that name and points somewhere else entirely — the
  // arrangement the check exists for. (The fake used to model this as a file that was also
  // flagged as a link, which no filesystem can produce.)
  fs.files.delete(P.manifest);
  fs.symlink(P.manifest, "/elsewhere/manifest.json");
  assert.equal(classifyStore(fs, P).status, "not-usable");
  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
});

test("privacy: dot, dot-dot, and empty path components are refused outright", () => {
  assert.throws(() => storePaths("/state/../etc"), /unsafe snapshot path/);
  assert.throws(() => storePaths("/state/./x"), /unsafe snapshot path/);
  assert.throws(() => storePaths("/state//x"), /unsafe snapshot path/);
  assert.throws(() => storePaths(""), /unsafe snapshot path/);
});

// ---------------------------------------------------------------------------------------
// Obligation 2 / AC 8 — the mutant that deletes the assertion MUST fail
// ---------------------------------------------------------------------------------------

test("mutation: deleting the assertHeld before the commit rename is caught", async () => {
  // AC 8 asks for a mutant, not a promise. The compiled module is rewritten with the
  // pre-rename gate removed and re-imported; the store must then do what the gate exists to
  // prevent — mutate on behalf of a writer that no longer holds the lock. A guard nobody
  // can show failing is a comment.
  // Via the shared helper, which requires the marker to occur EXACTLY once. This test used to
  // inline its own `includes`-then-`replace`, which edits the first match only — so a marker
  // that compilation ever duplicated would have quietly mutated a different call site while
  // the test kept this name.
  const mutant = await importMutant(
    "authority.assertHeld();\n        fs.rename(staging, targetPath);",
    "fs.rename(staging, targetPath);",
  );

  const { fs, authority } = freshStore();
  // Revoked at the last ungated step before the commit, so the ONLY thing standing between
  // this writer and a committed artifact is the single gate the mutant removed.
  fs.hooks.set("close", () => FakeAuthority.revoke(authority));

  try {
    mutant.publishSnapshot(fs, authority, P, candidate("gen-mutant", { claude: 1 }), { live: null });
  } catch {
    // The publish still fails at the NEXT gate (the manifest's), which is the point: the
    // damage a deleted gate does is a committed artifact, not a returned success.
  }
  fs.clearHooks();

  assert.equal(
    fs.files.has(`${P.generationsDir}/gen-mutant.json`),
    true,
    "the mutant must commit a generation without authority — otherwise this test proves nothing",
  );

  // The real module, same scenario, refuses.
  const { fs: fs2, authority: auth2 } = freshStore();
  fs2.hooks.set("close", () => FakeAuthority.revoke(auth2));
  assert.throws(
    () => publishSnapshot(fs2, auth2, P, candidate("gen-real", { claude: 1 }), { live: null }),
    /authority/,
  );
  fs2.clearHooks();
  assert.equal(fs2.files.has(`${P.generationsDir}/gen-real.json`), false);
});

// ---------------------------------------------------------------------------------------
// Round 33 — every mutating seam call is gated, classification is exhaustive inside the
// known directories, and manifest identity is the exact bytes
// ---------------------------------------------------------------------------------------

/** Counts non-overlapping occurrences of a literal substring. */
function occurrences(haystack, needle) {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    count += 1;
  }
  return count;
}

/**
 * Re-imports the compiled store with one exact source line removed.
 *
 * EXACTLY ONE occurrence is required, not at least one. `String.prototype.replace` with a
 * string pattern edits only the FIRST match, so a marker that compilation duplicates would
 * silently mutate a different call site than the test names — and the test would then
 * demonstrate a real defect somewhere else entirely while reporting it as this one. That is
 * the same wrong-occurrence failure the separate mutation harness already had once; a marker
 * that stops being unique must be a loud failure, not a quiet retarget.
 */
async function importMutant(marker, replacement = "") {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../dist/snapshot/store.js", import.meta.url), "utf8");
  assert.equal(
    occurrences(source, marker),
    1,
    `the shipped source must contain EXACTLY ONE: ${marker.trim()}`,
  );
  const mutated = source
    .replace(marker, replacement)
    .replace(/from "\.\//g, `from "${new URL("../dist/snapshot/", import.meta.url)}`);
  // The edit landed where it was meant to, and nowhere else.
  assert.equal(occurrences(mutated, marker), 0, "the marker must be gone after the edit");
  return import(`data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`);
}

test("mutation: deleting the gate before the staging WRITE is caught", async () => {
  const mutant = await importMutant(
    "            authority.assertHeld();\n            const n = fs.write(handle, bytes, written);",
    "            const n = fs.write(handle, bytes, written);",
  );

  const { fs, authority } = freshStore();
  // Revoked once the staging inode exists: without the per-write gate, a writer that no
  // longer holds the lock keeps writing bytes into a name its successor may own.
  fs.hooks.set("openExclusive", () => FakeAuthority.revoke(authority));
  try {
    mutant.publishSnapshot(fs, authority, P, candidate("gen-m", { claude: 1 }), { live: null });
  } catch {}
  fs.clearHooks();
  // The mutant half must PROVE the bytes landed. `assert.notEqual(x, "")` did not: if the
  // mutant had written nothing at all — or never created the staging file — `?.data` is
  // `undefined`, and `undefined !== ""` is true, so the assertion passed while demonstrating
  // the exact opposite of what it claims. A mutant nobody can show misbehaving proves the
  // original nothing.
  const staged = fs.files.get(stagingPath(P, "generation"));
  assert.ok(staged !== undefined, "the mutant must have created the staging file");
  assert.equal(
    JSON.parse(staged.data).body.generationId,
    "gen-m",
    "the mutant must write the WHOLE document without authority — otherwise this proves nothing",
  );

  const { fs: fs2, authority: auth2 } = freshStore();
  fs2.hooks.set("openExclusive", () => FakeAuthority.revoke(auth2));
  assert.throws(() =>
    publishSnapshot(fs2, auth2, P, candidate("gen-r", { claude: 1 }), { live: null }),
  );
  fs2.clearHooks();
  // The real module: the staging inode exists (openExclusive created it before the gate ran)
  // and is EMPTY. Stated as existence-then-emptiness so the absent-file case cannot satisfy
  // it by accident either.
  const notStaged = fs2.files.get(stagingPath(P, "generation"));
  assert.ok(notStaged !== undefined, "the staging inode is created before the gate is reached");
  assert.equal(notStaged.data, "", "not one byte may be written after authority is lost");
});

test("mutation: deleting the gate before fchmod is caught", async () => {
  const mutant = await importMutant(
    "        authority.assertHeld();\n        fs.fchmod(handle, FILE_MODE);",
    "        fs.fchmod(handle, FILE_MODE);",
  );

  const { fs, authority } = freshStore();
  fs.hooks.set("write", () => FakeAuthority.revoke(authority));
  try {
    mutant.publishSnapshot(fs, authority, P, candidate("gen-m", { claude: 1 }), { live: null });
  } catch {}
  fs.clearHooks();
  const calls = fs.calls.filter((c) => c.op === "fchmod");
  assert.equal(calls.length, 1, "the mutant must chmod without authority");

  const { fs: fs2, authority: auth2 } = freshStore();
  fs2.hooks.set("write", () => FakeAuthority.revoke(auth2));
  assert.throws(() =>
    publishSnapshot(fs2, auth2, P, candidate("gen-r", { claude: 1 }), { live: null }),
  );
  fs2.clearHooks();
  assert.equal(fs2.calls.filter((c) => c.op === "fchmod").length, 0);
});

test("publish: short writes are retried, and every retry carries its own gate", () => {
  const { fs, authority } = freshStore();
  fs.shortWriteLimit = 7; // force many partial writes per artifact
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });

  const writes = fs.calls.filter((c) => c.op === "write");
  assert.ok(writes.length > 4, "the short-write path must actually be exercised");
  for (let i = 0; i < fs.calls.length; i++) {
    if (fs.calls[i].op !== "write") continue;
    assert.equal(fs.calls[i - 1]?.op, "assertHeld", "each write retry must be gated");
  }
  assert.equal(readSnapshot(fs, P).status, "ok");
});

const FOREIGN_ENTRIES = [
  ["a symlink under generations/", (fs) => fs.symlink(`${P.generationsDir}/gen-x.json`, "/elsewhere/gen.json")],
  ["a nested directory under generations/", (fs) => fs.mkdirp(`${P.generationsDir}/nested`)],
  // A directory wearing a valid artifact FILENAME *and* a valid artifact MODE. These are the
  // only rows that reach the entry's TYPE check, and it took both disguises to get there:
  // every other non-file row is refused by the filename grammar first, and a directory at its
  // natural 0700 is refused by the mode check next — so disabling `!stat.isFile` outright left
  // the whole table green. Here the name is legal and the mode is legal, and nothing but the
  // type distinguishes it from a real artifact.
  ["a 0600 directory named like a real artifact under generations/", (fs) => fs.mkdirp(`${P.generationsDir}/gen-x.json`, 0o600)],
  ["a 0600 directory named like a real artifact under pins/", (fs) => fs.mkdirp(`${P.pinsDir}/pin-x.json`, 0o600)],
  ["a malformed filename under generations/", (fs) => fs.put(`${P.generationsDir}/notes.txt`, "hi")],
  ["a wrong-mode entry under generations/", (fs) => fs.put(`${P.generationsDir}/gen-x.json`, "{}", 0o644)],
  ["an unknown file under pins/", (fs) => fs.put(`${P.pinsDir}/README`, "hi")],
];

for (const [label, seed] of FOREIGN_ENTRIES) {
  test(`classification: ${label} resets, and the reset converges`, () => {
    const { fs, authority } = publishedStore();
    seed(fs);

    const classification = classifyStore(fs, P);
    assert.equal(classification.status, "not-usable", label);
    assert.equal(classification.error.constructor.name, "SnapshotStoreResetError");

    const started = startWriter(fs, authority, P);
    assert.notEqual(started.status, "usable");
    // Convergence is the property that matters: a reset that cannot clear what it refused
    // would classify not-usable forever. (That is a real defect this suite already caught
    // once, for unknown root entries.)
    assert.equal(classifyStore(fs, P).status, "first-run");
  });
}

test("classification: leftover staging residue is SWEPT, not reset over", () => {
  // Staging residue has its own deterministic disposition — the startup sweep — so it never
  // reaches the reset rule. Classification still refuses a store whose staging is non-empty,
  // which is what makes "swept before anything is built on it" an order rather than a hope.
  const { fs, authority } = publishedStore();
  fs.put(stagingPath(P, "manifest"), "crash residue");
  assert.equal(classifyStore(fs, P).status, "not-usable");

  const started = startWriter(fs, authority, P);
  assert.equal(started.status, "usable");
  assert.deepEqual(started.sweptStaging, [stagingPath(P, "manifest")]);
  // The healthy snapshot survives: sweeping residue must not cost the store its data.
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1");
});

test("classification: a wrong-mode directory is REPAIRED, not reset", () => {
  // The line between reset and repair is whether the fix is deterministic. A directory mode
  // is: chmod 0700 and it is exactly what this protocol writes, with the artifacts inside
  // still validated on their own terms. Resetting over it would throw away a healthy store
  // to fix a permission bit.
  const { fs, authority } = publishedStore();
  fs.dirs.get(P.pinsDir).mode = 0o755;
  assert.equal(classifyStore(fs, P).status, "not-usable");

  const started = startWriter(fs, authority, P);
  assert.equal(started.status, "usable");
  assert.equal(fs.dirs.get(P.pinsDir).mode & 0o7777, 0o700);
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1");
});

test("classification: a malformed pin DOCUMENT is GC's to remove, not a reset", () => {
  // Entry versus content: a bad pin document is data GC owns; a bad pin ENTRY means
  // something other than this protocol wrote there, which is not GC's call to make.
  const { fs, authority, manifest } = publishedStore();
  fs.put(`${P.pinsDir}/pin-bad.json`, "{not json");

  assert.equal(classifyStore(fs, P).status, "usable");
  collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
  assert.equal(fs.files.has(`${P.pinsDir}/pin-bad.json`), false);
});

test("read: manifest identity is the exact bytes — an ABA replacement is detected", () => {
  const { fs, authority, manifest } = publishedStore();

  // Two publishes during one read, with the manifest ending at the same size and (in this
  // fake, as on a coarse clock) the same timestamp. Only a digest over the exact bytes
  // distinguishes the result from "nothing changed".
  //
  // That equal-length premise is ASSERTED below, not assumed. Left unstated it was a fixture
  // accident: any change that made the final manifest a different length would let a
  // size-based identity — `String(raw.length)`, the mutant this test exists to kill — notice
  // the replacement and pass, and the exact-byte claim in the name would go unfalsified
  // without anything failing to say so.
  const manifestBefore = fs.files.get(P.manifest).data;
  let swaps = 0;
  fs.hooks.set("openRead", (path) => {
    if (path.startsWith(P.generationsDir) && swaps === 0) {
      swaps++;
      fs.clearHooks();
      const m2 = (() => {
        publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
        return JSON.parse(fs.files.get(P.manifest).data).body;
      })();
      // `retain: 1` is what MAKES the premise true rather than merely asserted: the final
      // manifest then carries one retained id and a two-digit sourceVersion, exactly like the
      // one it replaced, so it is the same byte length with different bytes. Left at the
      // default the retention set grew and the manifest got eight bytes longer — a change a
      // size oracle would have caught, which is the whole thing this test must rule out.
      publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), {
        live: m2,
        retain: 1,
      });
    }
  });

  const result = readSnapshot(fs, P);
  fs.clearHooks();
  assert.equal(swaps, 1, "the ABA window must actually have been exercised");

  // The premise: same length, different bytes. This is what makes the window an "ABA" rather
  // than an ordinary change any coarse oracle would catch.
  const manifestAfter = fs.files.get(P.manifest).data;
  assert.equal(
    Buffer.byteLength(manifestAfter, "utf8"),
    Buffer.byteLength(manifestBefore, "utf8"),
    "the premise — the replaced manifest must be the SAME byte length, or a size oracle would suffice",
  );
  assert.notEqual(manifestAfter, manifestBefore, "the premise — the bytes must actually differ");

  assert.equal(result.status, "ok");
  assert.equal(result.view.generation.generationId, "gen-3", "must serve the final snapshot, not a mix");
});

// ---------------------------------------------------------------------------------------
// Round 34 — the write loop's no-progress contract, and close as unconditional cleanup
// ---------------------------------------------------------------------------------------

const BAD_WRITE_RETURNS = [
  ["zero (no progress)", () => 0],
  ["negative", () => -1],
  ["larger than the remaining buffer", (remaining) => remaining + 1],
  ["NaN", () => NaN],
  ["fractional", () => 1.5],
];

for (const [label, produce] of BAD_WRITE_RETURNS) {
  test(`write contract: a seam returning ${label} fails fast instead of hanging`, () => {
    const { fs, authority, manifest } = publishedStore();
    const priorManifest = fs.files.get(P.manifest).data;

    // A seam reporting no progress would spin the retry loop forever while authority stays
    // held. A hang is worse than a failure: nothing ever reports it, and the writer never
    // gets to the next gate. So the count is contract-checked rather than trusted.
    //
    // The seam is BOUNDED to a single call, and that bound is the test's real safety net.
    // Returning the bad count on every call meant this test handled its own named regression
    // by hanging: delete the no-progress guard and the loop spins forever, the runner reports
    // nothing, and "fails fast instead of hanging" becomes a test that hangs. (This is the
    // same unsafe shape the realfs suite removed when `/dev/zero` was replaced by a finite
    // FIFO.) A correct implementation refuses on the FIRST bad return and never reaches the
    // second call; a looping mutant hits the sentinel and fails immediately, with a message
    // naming what went wrong.
    let writeCalls = 0;
    const realWrite = fs.write.bind(fs);
    fs.write = (handle, bytes, offset) => {
      writeCalls += 1;
      if (writeCalls > 1) {
        throw new Error(
          `LOOPED: the write loop retried after a contract-violating return (${label})`,
        );
      }
      realWrite(handle, bytes, offset);
      return produce(bytes.length - offset);
    };

    assert.throws(
      () =>
        publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
      (err) => err.name === "SnapshotWriteContractError" && err.remaining > 0,
      label,
    );
    assert.equal(writeCalls, 1, `${label}: the bad count must be refused, not retried`);

    // Pre-commit failure semantics are unchanged by the new error: prior manifest live,
    // nothing committed, staging cleared.
    assert.equal(fs.files.get(P.manifest).data, priorManifest);
    assert.equal(fs.files.has(`${P.generationsDir}/gen-2.json`), false);
    assert.equal(fs.files.has(stagingPath(P, "generation")), false);
  });
}

test("close: the descriptor is released exactly once on every path, authority or not", () => {
  // Closing publishes nothing, removes nothing, and renames nothing — it is resource
  // cleanup, so it must not be conditional on still owning the store. Gating it would leak
  // the descriptor of exactly the writer that lost the lock.
  for (const [label, revokeOn] of [
    ["after create", "openExclusive"],
    ["mid-write", "write"],
    ["after fchmod", "fchmod"],
  ]) {
    const { fs, authority } = freshStore();
    fs.shortWriteLimit = 5; // several writes, so "mid-write" is really mid-write
    fs.hooks.set(revokeOn, () => FakeAuthority.revoke(authority));

    assert.throws(
      () => publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null }),
      /authority/,
      label,
    );
    fs.clearHooks();

    const closes = fs.calls.filter((c) => c.op === "close");
    assert.equal(closes.length, 1, `${label}: close must run exactly once`);
    assert.equal(fs.open.size, 0, `${label}: no descriptor may be left open`);

    // And nothing persistent happened after the loss: the staging name is LEFT (it may be
    // the successor's by now) and no rename or unlink followed.
    const afterRevoke = fs.calls.slice(fs.calls.findIndex((c) => c.op === revokeOn));
    assert.equal(
      afterRevoke.some((c) => c.op === "rename" || c.op === "unlink"),
      false,
      `${label}: no persistent mutation may follow an observed authority loss`,
    );
  }
});

test("close: a failing close never masks the failure that caused it", () => {
  const { fs, authority, manifest } = publishedStore();
  fs.failOn("write", "staging/generation.json", errno("ENOSPC", "no space"));
  const realClose = fs.close.bind(fs);
  fs.close = (handle) => {
    realClose(handle);
    throw errno("EIO", "close blew up");
  };

  // "Not masked" now means preserved by identity in a module-owned structure, rather than
  // surfacing as the thrown value's own message — reading that message is itself the
  // property access on an arbitrary value the commit path must not perform.
  assert.throws(
    () =>
      publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
    (err) => err.name === "SnapshotCommitFailure" && causeCode(err.primaryError) === "ENOSPC",
    "the original error must survive a failing close",
  );
});

// ---------------------------------------------------------------------------------------
// Round 35 — a close-only failure is the failure, not a footnote
// ---------------------------------------------------------------------------------------

for (const code of ["EIO", "ENOSPC"]) {
  test(`close: a ${code} on close alone fails the publish and commits nothing`, () => {
    // close can report a delayed I/O failure the buffered writes were charged against. With
    // no earlier error, that IS the failure: the staging bytes never landed, so there is
    // nothing safe to rename.
    const { fs, authority, manifest } = publishedStore();
    const priorManifest = fs.files.get(P.manifest).data;
    const realClose = fs.close.bind(fs);
    fs.close = (handle) => {
      realClose(handle);
      throw errno(code, `delayed ${code} on close`);
    };

    assert.throws(
      () =>
        publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
      (err) => causeCode(err) === code,
    );

    assert.equal(fs.files.get(P.manifest).data, priorManifest, "prior manifest must be byte-identical");
    assert.equal(fs.files.has(`${P.generationsDir}/gen-2.json`), false, "nothing may be committed");
    assert.equal(fs.files.has(stagingPath(P, "generation")), false, "staging must be cleared");
    assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1");
  });
}

test("close: both failures are preserved in a module-owned structure, neither mutated", () => {
  const { fs, authority, manifest } = publishedStore();
  fs.failOn("write", "staging/generation.json", errno("ENOSPC", "no space"));
  const realClose = fs.close.bind(fs);
  fs.close = (handle) => {
    realClose(handle);
    throw errno("EIO", "close blew up");
  };

  assert.throws(
    () =>
      publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
    (err) => {
      assert.equal(err.name, "SnapshotCommitFailure");
      assert.equal(causeCode(err.primaryError), "ENOSPC", "the earlier failure must stay primary");
      assert.equal(causeCode(err.closeError), "EIO", "the close failure must be preserved, not lost");
      return true;
    },
  );
});

test("close: a hostile or exotic primary error is never touched", () => {
  // The thrown value belongs to whoever threw it. Writing a property onto it to "attach"
  // the close error can throw on a frozen object, do nothing on a primitive, or run
  // arbitrary code through a Proxy trap — losing the exact failure we are reporting. So the
  // store never writes to it and never reads from it.
  const frozen = Object.freeze(errno("EIO", "frozen primary"));
  const revocable = Proxy.revocable(errno("EIO", "proxy primary"), {});
  revocable.revoke();

  const primaries = [
    ["a frozen Error", frozen],
    ["a string", "just a string"],
    ["null", null],
    ["a revoked Proxy", revocable.proxy],
  ];

  for (const [label, primary] of primaries) {
    const { fs, authority, manifest } = publishedStore();
    const priorManifest = fs.files.get(P.manifest).data;
    fs.hooks.set("write", () => { throw primary; });
    const realClose = fs.close.bind(fs);
    fs.close = (handle) => {
      realClose(handle);
      throw errno("EIO", "close also failed");
    };

    assert.throws(
      () =>
        publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
      (err) => {
        assert.equal(err.name, "SnapshotCommitFailure", label);
        // Identity, not equality: the original value is carried through untouched.
        assert.equal(err.primaryError, primary, `${label}: the primary must be preserved as-is`);
        assert.equal(causeCode(err.closeError), "EIO", label);
        return true;
      },
      label,
    );
    fs.clearHooks();

    assert.equal(fs.files.get(P.manifest).data, priorManifest, `${label}: prior manifest intact`);
    assert.equal(fs.files.has(`${P.generationsDir}/gen-2.json`), false, `${label}: nothing committed`);
  }

  // The revoked Proxy survived the whole path without a trap being invoked — every trap on
  // a revoked Proxy throws, so reaching here at all is the assertion.
  assert.throws(() => Object.keys(revocable.proxy), TypeError);
});

// ---------------------------------------------------------------------------------------
// Round 37 — the core classifies by brand, and touches no thrown value
// ---------------------------------------------------------------------------------------

test("errors: an unbranded Proxy thrown by any seam op has ZERO traps invoked", () => {
  // A try/catch around a property read contains the throw, not the side effect: a `get`
  // trap can mutate state, recurse, or never return. So the core does not read at all — it
  // asks a WeakSet whether the value is one the seam itself branded, which invokes no trap.
  for (const op of ["openExclusive", "rename", "listDir", "openRead", "lstat"]) {
    const traps = [];
    const hostile = new Proxy(new Error("hostile"), {
      get(target, prop, receiver) {
        traps.push(String(prop));
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        traps.push(`has:${String(prop)}`);
        return Reflect.has(target, prop);
      },
      getPrototypeOf(target) {
        traps.push("getPrototypeOf");
        return Reflect.getPrototypeOf(target);
      },
    });

    const { fs, authority, manifest } = publishedStore();
    fs.hooks.set(op, () => { throw hostile; });

    let thrown;
    try {
      startWriter(fs, authority, P);
      publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
    } catch (err) {
      thrown = err;
    }
    fs.clearHooks();

    assert.ok(thrown !== undefined, `${op}: the hostile value must not be swallowed`);
    assert.deepEqual(traps, [], `${op}: the core invoked ${traps.length} trap(s): ${traps}`);
    // Unbranded means unknown: it propagates untouched rather than being classified as
    // "not found" and quietly treated as an absent file.
    //
    // IDENTITY IS CHECKED FIRST, and the short-circuit is the point. The previous version
    // unwrapped with `thrown?.name === "SnapshotCommitFailure"`, which reads a property off
    // the hostile Proxy — so the test invoked the exact trap it had asserted was never
    // invoked, two lines earlier, and would have kept passing while doing it. Only once the
    // value is known NOT to be the hostile one is it safe to inspect as a module-owned
    // wrapper.
    const surfaced =
      thrown === hostile
        ? thrown
        : thrown instanceof SnapshotCommitFailure
          ? thrown.primaryError
          : thrown;
    assert.ok(surfaced === hostile, `${op}: the value must propagate by identity`);
    assert.deepEqual(traps, [], `${op}: still zero traps after the identity check`);
  }
});

test("errors: a hostile value thrown by unlink is absorbed by reset without a single trap", () => {
  // Reset absorbs ORDINARY per-path removal failures — it records the path and moves on,
  // because the next start retries and nothing unsafe is exposed either way. What it must
  // NOT do is inspect what was thrown to decide that. The manifest is deliberately excluded
  // here: its removal is the visibility boundary and is NOT absorbed (see the test below).
  const traps = [];
  const hostile = new Proxy(new Error("hostile"), {
    get(t, p, r) { traps.push(String(p)); return Reflect.get(t, p, r); },
    getPrototypeOf(t) { traps.push("getPrototypeOf"); return Reflect.getPrototypeOf(t); },
  });

  const { fs, authority } = publishedStore();
  fs.hooks.set("unlink", (path) => {
    if (path.startsWith(P.generationsDir)) throw hostile;
  });
  const result = resetStore(fs, authority, P);
  fs.clearHooks();

  assert.deepEqual(traps, [], `reset invoked ${traps.length} trap(s): ${traps}`);
  assert.ok(result.failed.length > 0, "the unremovable paths must be reported, not silently dropped");
  assert.equal(result.stoppedOnAuthorityLoss, false);
  assert.equal(result.stoppedAtManifest, false);
  // The manifest — which unlinked fine — is gone, so the store is no longer observable.
  assert.equal(fs.files.has(P.manifest), false);
});

test("reset: a failing manifest unlink STOPS the reset before any generation is removed", () => {
  // The manifest unlink is the atomic visibility boundary. Until it succeeds the manifest is
  // still live and still names its generations, so continuing past its failure would delete
  // the files a served manifest points at — manufacturing the one structurally corrupt state
  // (a live manifest referencing missing generations) the commit order exists to prevent.
  // An earlier revision of this suite ACCEPTED that behaviour; accepting it was the defect.
  for (const code of ["EIO", "EACCES"]) {
    const { fs, authority } = publishedStore();
    const before = fs.snapshotBytes();
    fs.failOn("unlink", "manifest.json", errno(code, code));
    fs.calls.length = 0;

    const result = resetStore(fs, authority, P);
    fs.clearHooks();

    assert.equal(result.stoppedAtManifest, true, code);
    assert.deepEqual(result.failed, [P.manifest], code);
    assert.deepEqual(result.removed, [], code);
    // Zero mutations after the one that failed: no unlink of any generation, no rmdir, no
    // chmod rebuilding the skeleton.
    assert.deepEqual(
      fs.mutations().filter((c) => c.path !== P.manifest),
      [],
      `${code}: nothing may be mutated after the visibility boundary fails`,
    );
    // And the store is byte-identical and still fully readable.
    const after = fs.snapshotBytes();
    for (const [path, bytes] of before) {
      assert.equal(after.get(path), bytes, `${code}: ${path} must be byte-identical`);
    }
    assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1", code);
  }
});

// ---------------------------------------------------------------------------------------
// Containment — the store may never read, write, or delete outside its version-scoped root
// ---------------------------------------------------------------------------------------

/**
 * Every seam call this run made that landed outside the version-scoped root.
 *
 * Two defects this used to have, both of which made it report "contained" for genuinely
 * escaping calls:
 *
 * A bare `startsWith(root)` is TEXT containment, not PATH containment. For a root of
 * `/state/store-v1` it accepts `/state/store-v1-escape` and `/state/store-v1.bak` — sibling
 * directories the store has no business touching — because the root is a prefix of their
 * names. Containment is `=== root` or `startsWith(root + "/")`, and nothing else.
 *
 * And it inspected only the FIRST pathname operand of each call. `rename` has two, and the
 * DESTINATION is the one that would carry data out of the root; a rename from inside to
 * outside was invisible here. The fake now records every operand in `c.paths`.
 */
function contained(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function callsOutside(fs, root = P.root) {
  return fs.calls.filter((c) => (c.paths ?? []).some((p) => !contained(p, root)));
}

test("containment: the containment ORACLE itself detects the escapes it is asked about", () => {
  // A detector every caller asserts is EMPTY is a detector nothing exercises: each row of the
  // tables below passes `callsOutside(fs) === []`, and would go on passing if this function
  // returned `[]` unconditionally. So the oracle is tested directly, against the two escapes
  // that used to slip through it.
  const { fs, authority } = freshStore();

  // 1. A sibling whose NAME merely starts with the root's text. `startsWith(root)` called this
  //    contained; it is a different directory entirely.
  fs.mkdirp(`${P.root}-escape`);
  fs.put(`${P.root}-escape/loot.json`, "{}");
  fs.calls.length = 0;
  fs.readFile(`${P.root}-escape/loot.json`);
  assert.deepEqual(
    callsOutside(fs).map((c) => c.op),
    ["readFile"],
    "a sibling sharing the root's textual prefix is NOT inside the root",
  );

  // 2. A rename whose SOURCE is inside and whose DESTINATION is outside. The trace recorded
  //    only the source, so this read as fully contained while carrying data out of the store.
  fs.calls.length = 0;
  fs.put(stagingPath(P, "generation"), "{}");
  fs.rename(stagingPath(P, "generation"), `${P.root}-escape/exfiltrated.json`);
  const escaping = callsOutside(fs).filter((c) => c.op === "rename");
  assert.equal(escaping.length, 1, "a rename OUT of the root must be reported");
  assert.deepEqual(escaping[0].paths, [
    stagingPath(P, "generation"),
    `${P.root}-escape/exfiltrated.json`,
  ]);

  // And the root itself, plus anything genuinely beneath it, is contained.
  assert.equal(contained(P.root, P.root), true);
  assert.equal(contained(P.manifest, P.root), true);
  assert.equal(contained(`${P.root}-escape`, P.root), false);
  assert.equal(contained(`${P.root}.bak/x.json`, P.root), false);

  // A clean publish touches nothing outside the root — the positive case the tables rely on,
  // stated once here where the oracle is known to work.
  const { fs: fs2, authority: auth2 } = freshStore();
  publishSnapshot(fs2, auth2, P, candidate("gen-1", { claude: 1 }), { live: null });
  assert.deepEqual(callsOutside(fs2), []);
  void authority;
});

for (const dirName of ["generations", "pins", "staging"]) {
  test(`containment: a symlinked ${dirName}/ is unlinked as a link, never followed`, () => {
    const { fs, authority } = publishedStore();
    const dir = `${P.root}/${dirName}`;
    // An external tree the link points at. Nothing under it may be touched.
    fs.mkdirp("/outside/victim");
    fs.put("/outside/victim/precious.txt", "do not delete me");
    fs.mkdirp("/outside/victim/nested");
    fs.put("/outside/victim/nested/also-precious.txt", "nor me");
    const outsideBefore = fs.snapshotBytes();

    // Replace the real directory with a symlink to that tree.
    for (const path of [...fs.nodes.keys()]) {
      if (path === dir || path.startsWith(`${dir}/`)) fs.nodes.delete(path);
    }
    fs.symlink(dir, "/outside/victim");

    assert.equal(classifyStore(fs, P).status, "not-usable");

    const reset = resetStore(fs, authority, P);
    assert.equal(reset.stoppedOnAuthorityLoss, false);

    // The victim tree is byte-identical: `listDir` follows a symlink, so a traversal that
    // listed the directory before proving it was one deleted the target's contents. That is
    // a reset used as an arbitrary deletion primitive, reachable from a state classification
    // already calls not-usable.
    const outsideAfter = fs.snapshotBytes();
    for (const [path, bytes] of outsideBefore) {
      if (!path.startsWith("/outside/")) continue;
      assert.equal(outsideAfter.get(path), bytes, `${path} must be byte-identical`);
    }
    assert.equal(fs.dirs.has("/outside/victim/nested"), true, "the target tree must survive");

    // And the store converges: the link is gone, a real directory is back, and the next
    // classification is no longer not-usable.
    assert.equal(fs.lstat(dir).isSymbolicLink, false);
    assert.equal(fs.lstat(dir).isDirectory, true);
    assert.equal(classifyStore(fs, P).status, "first-run");
  });
}

test("containment: a known directory that is a plain FILE converges instead of looping", () => {
  const { fs, authority } = publishedStore();
  for (const path of [...fs.nodes.keys()]) {
    if (path === P.generationsDir || path.startsWith(`${P.generationsDir}/`)) fs.nodes.delete(path);
  }
  fs.put(P.generationsDir, "i am a file, not a directory");

  // Classification refuses it, and — the part that matters — the reset CLEARS it. An earlier
  // revision chmodded the file to 0700 and left it, so the store classified not-usable
  // forever, reset after reset, and never rebuilt.
  assert.equal(classifyStore(fs, P).status, "not-usable");
  startWriter(fs, authority, P);
  assert.equal(classifyStore(fs, P).status, "first-run");
  assert.equal(fs.dirs.has(P.generationsDir), true);
});

test("containment: a symlinked store ROOT is replaced, and nothing beneath it is touched", () => {
  const fs = new FakeFs();
  const authority = new FakeAuthority(fs);
  fs.mkdirp(STATE);
  fs.mkdirp("/outside/other-store/generations");
  fs.put("/outside/other-store/manifest.json", "someone else's manifest");
  const before = fs.snapshotBytes();
  fs.symlink(P.root, "/outside/other-store");

  // Every path the store builds is `${root}/...`, so a symlinked root redirects all of them
  // at once — including the manifest unlink, which would have deleted the other store's.
  assert.equal(classifyStore(fs, P).status, "not-usable");
  startWriter(fs, authority, P);

  const after = fs.snapshotBytes();
  for (const [path, bytes] of before) {
    if (path.startsWith("/outside/")) {
      assert.equal(after.get(path), bytes, `${path} must be byte-identical`);
    }
  }
  assert.equal(fs.lstat(P.root).isDirectory, true);
  assert.equal(classifyStore(fs, P).status, "first-run");
});

// ---------------------------------------------------------------------------------------
// Artifact ids are path components — validated on the way OUT, not only on the way in
// ---------------------------------------------------------------------------------------

const UNSAFE_IDS = [
  ["dot-dot traversal", "../../../../etc/pwned"],
  ["a bare separator", "a/b"],
  ["a leading dot", ".hidden"],
  ["dot", "."],
  ["dot-dot", ".."],
  ["an absolute path", "/etc/passwd"],
  ["a backslash", "a\\b"],
  ["a NUL", "gen\u0000evil"],
  ["empty", ""],
  ["over the length cap", "g".repeat(129)],
  ["not a string", 7],
];

for (const [label, id] of UNSAFE_IDS) {
  test(`traversal: publish refuses a generationId with ${label}`, () => {
    const { fs, authority } = freshStore();
    fs.calls.length = 0;

    assert.throws(
      () => publishSnapshot(fs, authority, P, candidate(id, { claude: 1 }), { live: null }),
      (err) => err.name === "SnapshotIdError",
      label,
    );
    // Refused BEFORE any path was built from it: not one seam call, anywhere.
    assert.deepEqual(fs.mutations(), [], `${label}: nothing may be written`);
    assert.deepEqual(callsOutside(fs), [], `${label}: nothing may be touched outside the root`);
  });

  test(`traversal: createPin refuses a pinId with ${label}`, () => {
    const { fs, authority } = freshStore();
    fs.calls.length = 0;
    assert.throws(
      () => createPin(fs, authority, P, { pinId: id, generationId: "gen-1", until: "2099-01-01" }),
      (err) => err.name === "SnapshotIdError",
      label,
    );
    assert.deepEqual(fs.mutations(), [], label);
    assert.deepEqual(callsOutside(fs), [], label);
  });
}

test("traversal: a manifest naming an unsafe generation id is refused before the path is built", () => {
  const { fs, authority } = publishedStore();
  // A manifest whose ids escape the store would make the READER open arbitrary paths, which
  // is why the grammar runs inside the manifest invariants rather than only at the publish
  // API. Written directly, as a tampered file would be.
  const body = {
    activeGenerationId: "../../../../etc/passwd",
    retainedGenerationIds: ["../../../../etc/passwd"],
    publishedAt: "2026-01-31T00:00:00Z",
    sourceVersion: { claude: 99 },
  };
  fs.put(P.manifest, encodeEnvelope("manifest", body));
  fs.calls.length = 0;

  assert.equal(classifyStore(fs, P).status, "not-usable");
  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
  assert.deepEqual(callsOutside(fs), [], "no path outside the root may be opened");

  // And it converges rather than wedging.
  startWriter(fs, authority, P);
  assert.equal(classifyStore(fs, P).status, "first-run");
});

test("traversal: a pin naming an unsafe generation id is collected, not resolved", () => {
  const { fs, authority } = publishedStore();
  fs.put(
    `${P.pinsDir}/pin-evil.json`,
    encodeEnvelope("pin", {
      pinId: "pin-evil",
      generationId: "../../../../etc/passwd",
      until: "2099-01-01T00:00:00Z",
    }),
  );
  const manifest = JSON.parse(fs.files.get(P.manifest).data).body;
  fs.calls.length = 0;

  const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
  assert.deepEqual(swept.removedPins, [`${P.pinsDir}/pin-evil.json`]);
  assert.deepEqual(callsOutside(fs), []);
});

// ---------------------------------------------------------------------------------------
// Documents are validated, not merely checksummed
// ---------------------------------------------------------------------------------------

test("generation: a checksum-valid generation under the WRONG filename is refused", () => {
  const { fs, authority, manifest } = publishedStore();
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });

  // Copy gen-1's bytes over gen-2's name. The envelope is intact and the checksum matches —
  // it is simply a different generation wearing this one's filename. Without the id binding
  // the manifest's reference to gen-2 silently resolves to gen-1's data, which is the
  // substitution a checksum cannot see.
  fs.files.set(`${P.generationsDir}/gen-2.json`, {
    data: fs.files.get(`${P.generationsDir}/gen-1.json`).data,
  });

  assert.equal(classifyStore(fs, P).status, "not-usable");
  assert.equal(classifyStore(fs, P).error.reason, "generation-invariants");

  // The reader quarantines it and falls back to the retained known-good generation rather
  // than serving the impostor.
  const read = readSnapshot(fs, P);
  assert.equal(read.status, "partial");
  assert.deepEqual(read.view.quarantined, ["gen-2"]);
  assert.equal(read.view.generation.generationId, "gen-1");
});

const MALFORMED_GENERATIONS = [
  ["provenance missing", (body) => { delete body.provenance; }],
  ["provenance.coverage not an array", (body) => { body.provenance.coverage = "all of it"; }],
  ["a coverage interval missing its end", (body) => { body.provenance.coverage = [{ start: "x" }]; }],
  ["fieldCoverage not an object", (body) => { body.provenance.fieldCoverage = []; }],
  ["timezone missing", (body) => { delete body.provenance.timezone; }],
  ["sourceVersion holding a non-integer", (body) => { body.sourceVersion = { claude: 1.5 }; }],
  ["publishedAt missing", (body) => { delete body.publishedAt; }],
  ["payload missing", (body) => { delete body.payload; }],
];

for (const [label, corrupt] of MALFORMED_GENERATIONS) {
  test(`generation: a checksum-valid generation with ${label} is refused, not served`, () => {
    const { fs } = publishedStore();
    const body = JSON.parse(fs.files.get(`${P.generationsDir}/gen-1.json`).data).body;
    corrupt(body);
    // Re-encoded, so the checksum is CORRECT for the malformed body: this proves the shape
    // check is load-bearing beyond the checksum, in the direction the checksum cannot help.
    fs.put(`${P.generationsDir}/gen-1.json`, encodeEnvelope("generation", body));

    assert.equal(classifyStore(fs, P).status, "not-usable", label);
    assert.equal(classifyStore(fs, P).error.reason, "generation-invariants", label);
    assert.equal(readSnapshot(fs, P).status, "no-snapshot", label);
  });
}

test("generation: publish validates its OWN candidate before staging anything", () => {
  const { fs, authority } = freshStore();
  fs.calls.length = 0;
  assert.throws(
    () =>
      publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }, {
        provenance: { coverage: [] }, // missing every other required field
      }), { live: null }),
    (err) => err.reason === "generation-invariants",
  );
  assert.deepEqual(fs.mutations(), [], "a bad candidate must not reach staging");
});

// ---------------------------------------------------------------------------------------
// Pins are hints, but they are VALIDATED hints
// ---------------------------------------------------------------------------------------

const BAD_PINS = [
  ["until is an object", { pinId: "pin-x", generationId: "gen-1", until: {} }],
  ["until is missing", { pinId: "pin-x", generationId: "gen-1" }],
  ["until is not a date", { pinId: "pin-x", generationId: "gen-1", until: "whenever" }],
  ["the body id disagrees with the filename", { pinId: "pin-other", generationId: "gen-1", until: "2099-01-01T00:00:00Z" }],
  ["generationId is unsafe", { pinId: "pin-x", generationId: "../x", until: "2099-01-01T00:00:00Z" }],
];

for (const [label, body] of BAD_PINS) {
  test(`gc: a checksum-valid pin where ${label} is collected, not honoured`, () => {
    const { fs, authority, manifest } = publishedStore();
    // gen-1 must be genuinely UNPROTECTED once the bad pin is discounted, or "not honoured"
    // is not what this test measures.
    //
    // Published without `retain: 1`, gen-1 stayed in the live manifest's retention set, so the
    // test proved only that a malformed pin FILE is removed. A collector that honoured the
    // pin's `generationId` first and deleted the file afterwards passed every assertion —
    // which is precisely the "malformed pin protects a generation for the life of the store"
    // outcome the row names.
    publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), {
      live: manifest,
      retain: 1,
    });
    const live = JSON.parse(fs.files.get(P.manifest).data).body;
    assert.equal(
      live.retainedGenerationIds.includes("gen-1"),
      false,
      `${label}: the premise — gen-1 must be unreferenced`,
    );
    fs.put(`${P.pinsDir}/pin-x.json`, encodeEnvelope("pin", body));

    const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
    // `{} <= "2026-…"` is false, so an unvalidated `until` read as unexpired against every
    // timestamp there will ever be — a malformed pin pinning a generation for the life of
    // the store, which is the opposite of the documented disposition.
    assert.deepEqual(swept.removedPins, [`${P.pinsDir}/pin-x.json`], label);
    // The generation it claimed to protect is collected too. That is the half that makes
    // "not honoured" mean something.
    assert.equal(
      fs.files.has(`${P.generationsDir}/gen-1.json`),
      false,
      `${label}: the pin must not have protected gen-1`,
    );
  });
}

test("gc: a pin guarding a generation that no longer exists is collected", () => {
  const { fs, authority } = publishedStore();
  const manifest = JSON.parse(fs.files.get(P.manifest).data).body;
  fs.put(
    `${P.pinsDir}/pin-dangling.json`,
    encodeEnvelope("pin", {
      pinId: "pin-dangling",
      generationId: "gen-long-gone",
      until: "2099-01-01T00:00:00Z",
    }),
  );

  const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
  // Unexpired, well-formed, and pointing at nothing. Keeping it would leave a pin alive
  // forever guarding a name that is never coming back.
  assert.deepEqual(swept.removedPins, [`${P.pinsDir}/pin-dangling.json`]);
});

test("gc: a valid unexpired pin still protects its generation", () => {
  const { fs, authority, manifest } = publishedStore();
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
  publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), {
    live: JSON.parse(fs.files.get(P.manifest).data).body,
    retain: 1,
  });
  createPin(fs, authority, P, { pinId: "cursor-1", generationId: "gen-1", until: "2099-01-01T00:00:00Z" });

  const live = JSON.parse(fs.files.get(P.manifest).data).body;
  const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");

  assert.deepEqual(swept.removedPins, [], "a live pin must survive");
  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), true, "the pinned generation survives");
  assert.equal(swept.removedGenerations.includes(`${P.generationsDir}/gen-2.json`), true);
});

test("errors: only the seam's own branded errors are classified as not-found", () => {
  // A look-alike carrying code: "ENOENT" must NOT be read as an absent file — that is the
  // whole point of branding by identity rather than by shape.
  const { fs } = publishedStore();
  const lookalike = new Error("pretending");
  lookalike.code = "ENOENT";
  lookalike.kind = "not-found";
  fs.hooks.set("openRead", (path) => {
    if (path === P.manifest) throw lookalike;
  });

  assert.throws(() => classifyStore(fs, P), (err) => err === lookalike);
  fs.clearHooks();
});

// ---------------------------------------------------------------------------------------
// Trust boundary — the core classifies by identity and coerces nothing it did not create
// ---------------------------------------------------------------------------------------

test("errors: the classification cannot be edited off a genuinely branded error", () => {
  // `classifyFsError` is exported, so anyone can obtain a real branded error. A WeakSet brand
  // plus a `kind` property read was only half a boundary: the brand proved provenance, and
  // then the core read an ordinary mutable property off the value anyway.
  const branded = classifyFsError("unlink", "/x", Object.assign(new Error("gone"), { code: "ENOENT" }));
  assert.equal(snapshotFsErrorKind(branded), "not-found");

  // Overwrite the public field. The classification must not move.
  branded.kind = "other";
  assert.equal(snapshotFsErrorKind(branded), "not-found", "kind is a label, not the decision");

  // Replace it with a throwing getter. Reading it would run foreign code at the exact seam
  // that exists to prevent that, and would throw out of a classifier that must not throw.
  let getterCalls = 0;
  Object.defineProperty(branded, "kind", {
    get() { getterCalls += 1; throw new Error("trap"); },
    configurable: true,
  });
  assert.equal(snapshotFsErrorKind(branded), "not-found");
  assert.equal(getterCalls, 0, "the classifier must not read the value at all");
});

test("errors: a mutated branded error still drives the store's not-found handling", () => {
  const { fs } = publishedStore();
  const forged = classifyFsError("readFile", P.manifest, Object.assign(new Error("x"), { code: "ENOENT" }));
  forged.kind = "other"; // would flip listOrEmpty/readOrNull if the property were read
  fs.hooks.set("openRead", (path) => { if (path === P.manifest) throw forged; });

  // Still treated as "absent", because the recorded classification is what counts.
  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
  fs.clearHooks();
});

test("write contract: a hostile byte count is refused without being coerced", () => {
  // The seam's return value is arbitrary. `String(x)` on it reaches Symbol.toPrimitive,
  // valueOf and toString, any of which a Proxy can make throw, hang, or mutate state —
  // replacing the bounded contract failure with something else entirely.
  const traps = [];
  const hostile = new Proxy(
    {},
    {
      get(t, prop, r) { traps.push(String(prop)); return Reflect.get(t, prop, r); },
      has(t, prop) { traps.push(`has:${String(prop)}`); return Reflect.has(t, prop); },
    },
  );

  const { fs, authority, manifest } = publishedStore();
  const before = fs.snapshotBytes();
  const realWrite = fs.write.bind(fs);
  fs.write = (handle, bytes, offset) => {
    realWrite(handle, bytes, offset);
    return hostile;
  };

  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
    (err) => {
      assert.equal(err.name, "SnapshotWriteContractError");
      assert.equal(err.reported, hostile, "the value must be preserved by identity");
      assert.ok(!err.message.includes("[object"), "the message must not coerce it");
      return true;
    },
  );

  assert.deepEqual(traps, [], `the store invoked ${traps.length} trap(s): ${traps}`);
  // Bounded: staging cleaned up, nothing committed, prior snapshot byte-identical.
  assert.equal(fs.files.has(stagingPath(P, "generation")), false);
  const after = fs.snapshotBytes();
  for (const [path, bytes] of before) {
    assert.equal(after.get(path), bytes, `${path} must be byte-identical`);
  }
});

test("envelope: a pin failure carries a PIN reason, not a generation one", () => {
  const cases = [
    ["not JSON", "{{{", "pin-unparsable"],
    ["a wrong kind", encodeEnvelope("generation", { a: 1 }), "pin-unparsable"],
    [
      "a checksum mismatch",
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: "pin", checksum: "0".repeat(64), body: { a: 1 } }),
      "pin-checksum-mismatch",
    ],
    [
      "a wrong schema version",
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION + 1,
        kind: "pin",
        checksum: checksumOf({ a: 1 }),
        body: { a: 1 },
      }),
      "pin-schema-version",
    ],
  ];
  for (const [label, raw, expected] of cases) {
    assert.throws(
      () => decodeEnvelope("pin", "/pins/p.json", raw),
      (err) => {
        assert.equal(err.reason, expected, label);
        return true;
      },
      label,
    );
  }
});

// ---------------------------------------------------------------------------------------
// Dominance hygiene
// ---------------------------------------------------------------------------------------

test("dominance: an object that is not PLAIN is refused rather than read as empty", () => {
  // These all pass "not null, not an array, typeof object" and then canonicalize to {} —
  // because their state lives in internal slots, not own enumerable properties. An empty
  // manifest is the "no claim" value, so a rich-looking object would publish claiming
  // nothing at all.
  class Versions { constructor() { this.claude = 5; } }
  const exotic = [
    ["a Date", new Date()],
    ["a Map", new Map([["claude", 5]])],
    ["a Set", new Set([1])],
    ["an Error", new Error("x")],
    ["a class instance", new Versions()],
    ["a custom prototype", Object.create({ inherited: 1 })],
  ];
  for (const [label, value] of exotic) {
    assert.throws(() => canonicalSourceVersion(value), SourceVersionManifestError, label);
  }
  // A null-prototype object IS plain, and this function's own output is one.
  assert.doesNotThrow(() => canonicalSourceVersion(canonicalSourceVersion({ a: 1 })));
});

test("dominance: compareSourceVersions refuses a manifest that was never canonicalized", () => {
  // The parameter type is a compile-time brand, and this module ships as JS to callers
  // TypeScript never checked — so the comparison re-canonicalizes rather than trusting it.
  //
  // NaN is the case that does damage silently. It is neither `>` nor `<`, so a source that
  // actually regressed contributes nothing to either flag: paired with one real advance, the
  // verdict is `dominates` and the store publishes a snapshot that LOST data, which is the
  // exact substitution AC 7 exists to prevent. It cannot arrive through canonicalSourceVersion
  // (isSafeInteger refuses it), which is precisely why the second entry point had to refuse it
  // too rather than assume its caller went through the first.
  const live = canonicalSourceVersion({ a: 5, b: 9 });
  assert.throws(
    () => compareSourceVersions({ a: 20, b: Number.NaN }, live),
    SourceVersionManifestError,
    "a raw manifest with a NaN offset was compared instead of refused",
  );
  // ...and the same for every other shape the canonical pass refuses, on either side.
  assert.throws(() => compareSourceVersions({ a: 20, b: 10.5 }, live), SourceVersionManifestError);
  assert.throws(
    () => compareSourceVersions({ a: 20, b: Number.MAX_SAFE_INTEGER + 2 }, live),
    SourceVersionManifestError,
  );
  assert.throws(() => compareSourceVersions(new Proxy({ a: 1, b: 1 }, {}), live), SourceVersionManifestError);
  assert.throws(
    () => compareSourceVersions(live, Object.defineProperty({}, "a", { get: () => 1, enumerable: true })),
    SourceVersionManifestError,
  );

  // A genuinely canonical pair still compares, so the guard did not simply break the function.
  assert.equal(compareSourceVersions(canonicalSourceVersion({ a: 6, b: 9 }), live), "dominates");
  assert.equal(compareSourceVersions(canonicalSourceVersion({ a: 5, b: 9 }), live), "equal");
});

test("dominance: the canonical copy cannot gain a source after validation", () => {
  const canonical = canonicalSourceVersion({ a: 1 });
  assert.equal(Object.isFrozen(canonical), true);
  // Non-writable per key stops a value CHANGING; only freezing stops a key being ADDED
  // between validation and the comparison or checksum that reads it.
  assert.throws(() => { "use strict"; canonical.b = 2; }, TypeError);
  assert.equal(Object.hasOwn(canonical, "b"), false);
  assert.throws(() => Object.defineProperty(canonical, "b", { value: 2 }), TypeError);
});

// ---------------------------------------------------------------------------------------
// Gating — generic over the seam, and over every path that mutates
// ---------------------------------------------------------------------------------------

test("gating: every SnapshotFs method is classified as mutating, read, or cleanup", () => {
  // The trace assertion is only as generic as this classification. A seam method added
  // without being classified would silently escape the "assertHeld immediately before"
  // check — so the classification is checked against the seam itself rather than trusted.
  const seam = createNodeSnapshotFs();
  const methods = Object.keys(seam).sort();
  const mutating = [...FakeFs.MUTATING_OPS].sort();
  const reading = [...FakeFs.READ_OPS].sort();
  const classified = [...mutating, ...reading, ...FakeFs.CLEANUP_OPS].sort();
  assert.deepEqual(methods, classified, "every seam method must be classified exactly once");

  // The half that breaks the circularity: `MUTATING_SEAM_OPS` is the TEST's own claim about
  // which ops mutate, so dropping an op from the fake's set fails here instead of quietly
  // removing that op from what the gating loops bother to inspect. Union coverage alone does
  // not catch it — a mutating op misfiled as read-only still appears exactly once overall.
  assert.deepEqual(mutating, [...MUTATING_SEAM_OPS].sort(), "the fake's mutating set has drifted");
  assert.equal(
    mutating.filter((op) => reading.includes(op)).length,
    0,
    "no op may be classified as both mutating and read-only",
  );
  // `close` is the one deliberate exemption: releasing a descriptor is not a mutation of the
  // store, which is why the no-intervening-await rule names it explicitly.
  assert.deepEqual([...FakeFs.CLEANUP_OPS], ["close"]);

  // The fake implements the same surface as the real adapter.
  const fake = new FakeFs();
  for (const method of methods) {
    assert.equal(typeof fake[method], "function", `FakeFs is missing ${method}`);
  }
});

/**
 * Asserts the gating invariant over whatever seam calls `run` produced.
 *
 * Filtered by the TEST-owned `MUTATING_SEAM_OPS`, for the same reason the single-publish
 * gating test above is. This helper had the identical circularity and kept it after that one
 * was fixed: taking the filter from `FakeFs.MUTATING_OPS` means the fake decides what the
 * assertion looks at, so an op dropped from the fake's set is not a failure here — it is an op
 * that stops being checked. The classification test above pins the two sets together.
 */
function assertEveryMutationGated(fs, label) {
  const mutatingOps = new Set(MUTATING_SEAM_OPS);
  let mutations = 0;
  for (let i = 0; i < fs.calls.length; i++) {
    if (!mutatingOps.has(fs.calls[i].op)) continue;
    mutations += 1;
    assert.equal(
      fs.calls[i - 1]?.op,
      "assertHeld",
      `${label}: ${fs.calls[i].op} on ${fs.calls[i].path} is not gated`,
    );
  }
  assert.ok(mutations > 0, `${label}: exercised no mutations, so it proved nothing`);
  return mutations;
}

test("gating: the invariant holds across publish, pin, startup, reset and GC", () => {
  // The earlier version of this test ran the trace over publishSnapshot only, so the reset
  // traversal, the startup sweep, the skeleton rebuild and the GC sweep — all of which
  // mutate — were never checked by it.
  const scenarios = {
    publish: () => {
      const { fs, authority } = freshStore();
      fs.calls.length = 0;
      publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });
      return fs;
    },
    createPin: () => {
      const { fs, authority } = publishedStore();
      fs.calls.length = 0;
      createPin(fs, authority, P, { pinId: "p1", generationId: "gen-1", until: "2099-01-01T00:00:00Z" });
      return fs;
    },
    "startWriter (skeleton + sweep)": () => {
      const fs = new FakeFs();
      fs.mkdirp(STATE);
      const authority = new FakeAuthority(fs);
      fs.put(`${STATE}/store-v${SCHEMA_VERSION}/staging/manifest.json`, "residue");
      fs.calls.length = 0;
      startWriter(fs, authority, P);
      return fs;
    },
    "reset (traversal + rebuild)": () => {
      const { fs, authority } = publishedStore();
      fs.mkdirp(`${P.root}/stray/nested`);
      fs.put(`${P.root}/stray/nested/x.txt`, "x");
      fs.put(`${P.pinsDir}/pin-a.json`, "junk");
      fs.calls.length = 0;
      resetStore(fs, authority, P);
      return fs;
    },
    "collectGarbage": () => {
      const { fs, authority, manifest } = publishedStore();
      publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
      publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), {
        live: JSON.parse(fs.files.get(P.manifest).data).body,
        retain: 1,
      });
      fs.put(`${P.pinsDir}/pin-dead.json`, encodeEnvelope("pin", {
        pinId: "pin-dead", generationId: "gen-1", until: "2020-01-01T00:00:00Z",
      }));
      const live = JSON.parse(fs.files.get(P.manifest).data).body;
      fs.calls.length = 0;
      collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
      return fs;
    },
  };

  const seen = new Set();
  for (const [label, run] of Object.entries(scenarios)) {
    const fs = run();
    assertEveryMutationGated(fs, label);
    for (const call of fs.mutations()) seen.add(call.op);
  }
  // And between them the scenarios actually exercised the whole mutating surface, so the
  // invariant is not being proved over three ops out of eight.
  assert.deepEqual([...seen].sort(), [...MUTATING_SEAM_OPS].sort());
});

test("mutation: deleting the gate inside the reset traversal is caught", async () => {
  // The reset is MANY mutations. Gating only its first would let a writer that lost the lock
  // mid-sweep keep deleting a successor's freshly published files, so the gate lives inside
  // the per-path helper and this mutant removes it there.
  const mutant = await importMutant(
    "        // entirely rather than continuing into the successor's store.\n        gate();",
    "        // entirely rather than continuing into the successor's store.",
  );

  // Authority is lost DURING the traversal, not before it: the manifest unlink (gated
  // directly, not through the helper) must succeed first, or the mutant stops at that gate
  // and the test proves nothing about the one it removed.
  function scenario() {
    const { fs, authority } = publishedStore();
    fs.hooks.set("unlink", () => FakeAuthority.revoke(authority));
    return { fs, authority };
  }

  const m = scenario();
  try {
    mutant.resetStore(m.fs, m.authority, P);
  } catch {
    // The skeleton rebuild still hits an ungated assertion; the damage is what matters.
  }
  m.fs.clearHooks();
  assert.equal(
    m.fs.files.has(`${P.generationsDir}/gen-1.json`),
    false,
    "the mutant must keep deleting after the loss — otherwise this test proves nothing",
  );

  // The real module stops at the first gate after the loss: the manifest is gone (that
  // unlink ran while authority was held) and every generation survives.
  const r = scenario();
  const result = resetStore(r.fs, r.authority, P);
  r.fs.clearHooks();
  assert.equal(result.stoppedOnAuthorityLoss, true);
  assert.equal(
    r.fs.files.has(`${P.generationsDir}/gen-1.json`),
    true,
    "a stale writer must not delete a successor's generations",
  );
});

test("mutation: deleting the GC gate is caught", async () => {
  const mutant = await importMutant(
    "        try {\n            authority.assertHeld();\n        }\n        catch {\n            return { ...empty, stoppedOnAuthorityLoss: true };\n        }\n        try {\n            fs.unlink(path);\n            removedGenerations.push(path);",
    "        try {\n            fs.unlink(path);\n            removedGenerations.push(path);",
  );

  // Two collectable generations and an authority that drops on the first removal.
  function scenario() {
    const { fs, authority, manifest } = publishedStore();
    publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
    publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), {
      live: JSON.parse(fs.files.get(P.manifest).data).body,
      retain: 1,
    });
    return { fs, authority };
  }

  const m = scenario();
  m.fs.hooks.set("unlink", () => FakeAuthority.revoke(m.authority));
  mutant.collectGarbage(m.fs, m.authority, P, "2026-02-01T00:00:00Z");
  m.fs.clearHooks();
  const mutantRemoved = ["gen-1", "gen-2"].filter(
    (id) => !m.fs.files.has(`${P.generationsDir}/${id}.json`),
  );
  assert.ok(
    mutantRemoved.length > 1,
    "the mutant must keep collecting after the loss — otherwise this test proves nothing",
  );

  // The real module stops at the first gate after the loss.
  const r = scenario();
  r.fs.hooks.set("unlink", () => FakeAuthority.revoke(r.authority));
  const swept = collectGarbage(r.fs, r.authority, P, "2026-02-01T00:00:00Z");
  r.fs.clearHooks();
  assert.equal(swept.stoppedOnAuthorityLoss, true);
  assert.equal(swept.removedGenerations.length, 1, "exactly the one removal that ran before the loss");
});

// ---------------------------------------------------------------------------------------
// AC 1 — failure injection at EVERY pre-commit boundary, for both commits
// ---------------------------------------------------------------------------------------

const COMMIT_BOUNDARIES = [
  ["exclusive create", "openExclusive", "EACCES"],
  ["the staging write", "write", "ENOSPC"],
  ["the fd chmod", "fchmod", "EPERM"],
  ["the fd stat", "fstat", "EIO"],
  ["the pre-commit lstat", "lstat", "EIO"],
  ["the commit rename", "rename", "EXDEV"],
];

for (const [label, op, code] of COMMIT_BOUNDARIES) {
  for (const stage of ["generation", "manifest"]) {
    test(`AC1: a failure at ${label} during the ${stage} commit leaves the prior snapshot intact`, () => {
      const { fs, authority, manifest } = publishedStore();
      const before = fs.snapshotBytes();
      const priorRead = readSnapshot(fs, P);
      assert.equal(priorRead.status, "ok");

      // Scope the fault to the artifact under test, so the generation commit completes
      // normally when the manifest commit is the one being broken.
      // Scoped to the STAGING PATH, not to the substring "manifest"/"generation".
      // `publishSnapshot` now reads the live manifest through a guarded read before it stages
      // anything, so a substring match on "manifest" caught that read's `fstat` and failed the
      // publish before the commit under test was reached. The staging path names exactly one
      // artifact's commit and nothing else in the function.
      const match = stagingPath(P, stage);
      fs.failOn(op, match, errno(code, code));
      fs.calls.length = 0;

      let threw = null;
      try {
        publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
      } catch (err) {
        threw = err;
      }
      fs.clearHooks();

      assert.ok(threw !== null, `${stage}/${label}: the publish must fail`);
      // The original error survives: cleanup on the failure path must not mask it.
      //
      // This assertion used to compute its EXPECTED value from the same `surfaced` it was
      // checking, so every EIO row passed unconditionally — a tautology wearing the name of
      // the criterion it was supposed to enforce. The injected code is a constant known
      // before the call; that is what it is compared against.
      const surfaced = threw.name === "SnapshotCommitFailure" ? threw.primaryError : threw;
      assert.equal(
        causeCode(surfaced),
        code,
        `${stage}/${label}: the original failure must not be masked`,
      );

      // Nothing was committed at this stage's target, and no staging residue is left.
      assert.equal(fs.files.has(stagingPath(P, stage)), false, `${stage}/${label}: staging residue`);

      // WHICH STAGE ACTUALLY FAILED, asserted rather than assumed.
      //
      // Comparing only the pre-existing bytes could not tell these two apart, because gen-2 is
      // in neither snapshot: a generation-stage fault that wrongly committed gen-2 and then
      // rethrew passed, and so did a manifest-stage row whose fault fired during the GENERATION
      // commit instead — which is exactly what a too-loose substring match on `failOn` would
      // cause. The stage under test is therefore identified by gen-2's disposition.
      const gen2 = `${P.generationsDir}/gen-2.json`;
      if (stage === "generation") {
        assert.equal(fs.files.has(gen2), false, `${stage}/${label}: gen-2 must not be committed`);
      } else {
        // The generation commit ran to completion before the manifest commit failed, so gen-2
        // exists as a valid, unreferenced generation — the residue the commit order promises.
        assert.equal(fs.files.has(gen2), true, `${stage}/${label}: gen-2 must have been committed`);
        assert.equal(
          JSON.parse(fs.files.get(gen2).data).body.generationId,
          "gen-2",
          `${stage}/${label}: the committed generation must be gen-2`,
        );
        assert.deepEqual(
          classifyStore(fs, P).unreferencedGenerations,
          ["gen-2"],
          `${stage}/${label}: gen-2 must be unreferenced, not live`,
        );
      }

      // The prior manifest and every generation it references are byte-identical...
      const after = fs.snapshotBytes();
      for (const [path, bytes] of before) {
        assert.equal(after.get(path), bytes, `${stage}/${label}: ${path} must be byte-identical`);
      }
      // ...and still served.
      const nowRead = readSnapshot(fs, P);
      assert.equal(nowRead.view.generation.generationId, "gen-1", `${stage}/${label}`);
    });
  }
}

test("AC1: a short write is retried to completion and the artifact is intact", () => {
  const { fs, authority } = freshStore();
  fs.shortWriteLimit = 1; // one byte per syscall
  const result = publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });
  assert.equal(result.status, "published");
  // Byte-for-byte identical to a single-write publish, and checksum-valid on read.
  assert.equal(readSnapshot(fs, P).status, "ok");
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1");
});

test("AC1: a short write that splits a multi-byte character still round-trips", () => {
  // The fake writes RAW BYTES at the descriptor's position. Decoding each short chunk as
  // UTF-8 and concatenating strings — which it used to do — inserts U+FFFD whenever a chunk
  // boundary falls inside a character, inventing checksum failures the kernel never produces
  // and hiding offset bugs whenever the fixture happens to be ASCII.
  const { fs, authority } = freshStore();
  fs.shortWriteLimit = 1;
  const payload = { note: "日本語テキスト — naïve café 🎉", nested: { emoji: "👩‍💻" } };
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }, { payload }), { live: null });

  const read = readSnapshot(fs, P);
  assert.equal(read.status, "ok", "a split multi-byte character must not corrupt the artifact");
  assert.deepEqual(read.view.generation.payload, payload);
});

// ---------------------------------------------------------------------------------------
// The commit revalidates the whole owned prefix, not just the final component
// ---------------------------------------------------------------------------------------

/**
 * Swaps a container in immediately before the check that guards it, anchored SEMANTICALLY.
 *
 * Two earlier shapes of this fixture were both wrong for the same reason — they identified the
 * window by POSITION.
 *
 * The first fired on the first pre-open root lstat, so the very next container check rejected
 * the swap before a descriptor even existed; the test passed without reaching the window it
 * named. The second counted root lstats and fired on the 2nd or 3rd, which is derived from the
 * current call order inside `commitArtifact`: adding or removing one `assertOwnedChain` call
 * silently retargets it, and a `seen >= n` assertion still passes while the swap now lands
 * before staging exists or after a different check entirely. An ordinal is not a description of
 * a race window; it is a fossil of one particular implementation.
 *
 * This arms on the staging descriptor's CLOSE — the event that opens the commit window — and
 * then fires on the next `lstat` of the directory actually under attack, immediately before
 * delegating to the real one. Both facts are things the test can assert about the state at the
 * moment the swap ran, which is what makes drift loud instead of silent.
 */
function swapBeforeGuardOf(fs, dir, swap) {
  const seen = { closed: false, fired: false, stagingBytes: null };
  const realClose = fs.close.bind(fs);
  fs.close = (handle) => {
    const result = realClose(handle);
    // Armed on the close of the STAGING descriptor specifically, not on "a close happened".
    // The looser anchor was another fossil of one implementation: `publishSnapshot` now reads
    // the live manifest through a guarded read, which opens and closes a descriptor before any
    // staging file exists, so "the first close" armed the swap before the window it names had
    // opened — and the test then failed on its own state assertion rather than silently
    // testing nothing, which is the whole point of asserting the state.
    if ((fs.files.get(stagingPath(P, "generation"))?.data ?? null) !== null) seen.closed = true;
    return result;
  };
  const realLstat = fs.lstat.bind(fs);
  fs.lstat = (path) => {
    if (seen.closed && !seen.fired && path === dir) {
      seen.fired = true;
      // Recorded at the instant of the swap: the staging artifact must already be written and
      // still present, or this is not the pre-rename window.
      seen.stagingBytes = fs.files.get(stagingPath(P, "generation"))?.data ?? null;
      swap();
    }
    return realLstat(path);
  };
  return seen;
}

// A swap AFTER the guarding check is the irreducible window documented on `assertOwnedChain` —
// it needs `renameat` against a held directory descriptor, which Node does not expose — and
// this suite does not claim to prevent it.
for (const swapped of ["generations", "staging"]) {
  test(`commit: swapping ${swapped}/ for a symlink before the rename is refused`, () => {
    const { fs, authority, manifest } = publishedStore();
    fs.mkdirp("/outside/landing");
    const before = fs.snapshotBytes();
    const dir = `${P.root}/${swapped}`;

    const seen = swapBeforeGuardOf(fs, dir, () => {
      for (const key of [...fs.nodes.keys()]) {
        if (key === dir || key.startsWith(`${dir}/`)) fs.nodes.delete(key);
      }
      fs.symlink(dir, "/outside/landing");
    });

    assert.throws(
      () => publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
      // The refusal can surface as a path/mode verdict or as a branded not-found, depending on
      // which check reaches the swapped prefix first. What must NOT vary is that it is refused
      // and nothing lands outside the store, which is what the rest of this test asserts.
      (err) =>
        err.name === "SnapshotPathError" ||
        err.name === "SnapshotModeError" ||
        err.name === "SnapshotFsError",
      `${swapped}: a swapped parent must be refused`,
    );

    // The window is asserted by its STATE, not by a call count: the descriptor was closed, the
    // swap ran, and the staging artifact was written and still present when it did. If the
    // commit is ever restructured so that no guarding lstat of this directory follows the
    // close, `fired` goes false and this fails loudly instead of quietly testing nothing.
    assert.equal(seen.closed, true, `${swapped}: the descriptor must have been closed`);
    assert.equal(seen.fired, true, `${swapped}: the swap never reached the commit window`);
    assert.ok(
      seen.stagingBytes && seen.stagingBytes.includes("gen-2"),
      `${swapped}: the staging artifact must be written and present when the swap fires`,
    );
    assert.equal(fs.files.has(`${P.generationsDir}/gen-2.json`), false, "nothing may be published");

    const after = fs.snapshotBytes();
    for (const [path, bytes] of before) {
      if (path.startsWith("/outside/")) {
        assert.equal(after.get(path), bytes, `${path} must be byte-identical`);
      }
    }
    assert.equal([...after.keys()].some((k) => k.startsWith("/outside/landing/")), false);
  });
}

test("commit: replacing the staging FILE after it is written is refused", () => {
  // Proving the staging DIRECTORY says nothing about the file inside it. Once the descriptor's
  // work is done, the staging name can be unlinked and replaced by a different regular file
  // carrying its own valid checksum — and the rename would publish an artifact this writer
  // never wrote.
  const { fs, authority, manifest } = publishedStore();
  const staging = stagingPath(P, "generation");
  const impostor = encodeEnvelope("generation", {
    generationId: "gen-2",
    publishedAt: "2026-01-31T00:00:00Z",
    sourceVersion: { claude: 999 },
    provenance: provenance(),
    payload: { total: "attacker-controlled" },
  });

  // Swap during the target lstat — after the staging chain has been proved, before the rename.
  const real = fs.lstat.bind(fs);
  let swapped = false;
  fs.lstat = (path) => {
    // `fs.files.has(staging)` is the anchor, not just the path: the single-use-id check
    // lstats this same name BEFORE anything is staged, and firing there swapped an impostor
    // into an empty staging slot so the commit met EEXIST instead of the window under test.
    if (!swapped && path === `${P.generationsDir}/gen-2.json` && fs.files.has(staging)) {
      swapped = true;
      fs.files.delete(staging);
      fs.put(staging, impostor);      // a DIFFERENT inode at the same name
    }
    return real(path);
  };

  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
    (err) => err.name === "SnapshotPathError" && /replaced between staging and commit/.test(err.message),
  );
  assert.ok(swapped, "the swap must have fired");

  // Nothing was published, and the impostor never became a generation.
  assert.equal(fs.files.has(`${P.generationsDir}/gen-2.json`), false);
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1");
});

test("commit: a staging file whose mode changed under us is refused", () => {
  const { fs, authority, manifest } = publishedStore();
  const staging = stagingPath(P, "generation");
  const real = fs.lstat.bind(fs);
  fs.lstat = (path) => {
    // Same anchor as above: only once the staging file actually exists.
    if (path === `${P.generationsDir}/gen-2.json` && fs.files.has(staging)) {
      fs.files.get(staging).mode = 0o644;
    }
    return real(path);
  };
  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
    (err) => err.name === "SnapshotModeError",
  );
  assert.equal(fs.files.has(`${P.generationsDir}/gen-2.json`), false);
});

test("commit: a wrong-mode owned directory is refused before the rename", () => {
  const { fs, authority, manifest } = publishedStore();
  fs.dirs.get(P.generationsDir).mode = 0o755;
  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest }),
    (err) => err.name === "SnapshotModeError",
  );
});

// ---------------------------------------------------------------------------------------
// Containment, second pass: GC and the reader have the same prefix obligation as the reset
// ---------------------------------------------------------------------------------------

for (const dirName of ["pins", "generations"]) {
  test(`containment: collectGarbage refuses a symlinked ${dirName}/ instead of sweeping it`, () => {
    // GC lists two directories and unlinks what it finds — the same list-then-mutate shape as
    // the reset, and it had the same hole. With pins/ pointing at an external tree, an
    // ordinary sweep read the target's files, found none of them to be valid pins, classified
    // them as collectable, and deleted them.
    const { fs, authority } = publishedStore();
    const manifest = JSON.parse(fs.files.get(P.manifest).data).body;
    fs.mkdirp("/outside/victim");
    fs.put("/outside/victim/tax-return.pdf", "important");
    fs.put("/outside/victim/photos.zip", "irreplaceable");
    const before = fs.snapshotBytes();

    const dir = `${P.root}/${dirName}`;
    for (const path of [...fs.nodes.keys()]) {
      if (path === dir || path.startsWith(`${dir}/`)) fs.nodes.delete(path);
    }
    fs.symlink(dir, "/outside/victim");

    assert.throws(
      () => collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z"),
      (err) => err.name === "SnapshotPathError",
      `${dirName}: a symlinked artifact directory must be refused, not swept`,
    );

    const after = fs.snapshotBytes();
    for (const [path, bytes] of before) {
      if (path.startsWith("/outside/")) {
        assert.equal(after.get(path), bytes, `${path} must be byte-identical`);
      }
    }
  });
}

test("containment: the reader refuses a symlinked store root rather than serving through it", () => {
  const fs = new FakeFs();
  fs.mkdirp(STATE);
  // A complete, valid store belonging to somebody else.
  const foreign = "/outside/other-store";
  fs.mkdirp(`${foreign}/generations`);
  fs.mkdirp(`${foreign}/pins`);
  fs.mkdirp(`${foreign}/staging`);
  const foreignPaths = { ...P, root: foreign, manifest: `${foreign}/manifest.json`,
    generationsDir: `${foreign}/generations`, pinsDir: `${foreign}/pins`, stagingDir: `${foreign}/staging` };
  publishSnapshot(fs, new FakeAuthority(fs), foreignPaths, candidate("gen-foreign", { claude: 1 }), { live: null });

  fs.symlink(P.root, foreign);

  // The reader mutates nothing, so there is no deletion to contain here — but every path it
  // reads is `${root}/...`, and following the link would serve another directory's snapshot
  // as this store's.
  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
  assert.equal(classifyStore(fs, P).status, "not-usable");
});

test("containment: the reader refuses a wrong-mode store root", () => {
  const { fs } = publishedStore();
  assert.equal(readSnapshot(fs, P).status, "ok");
  fs.dirs.get(P.root).mode = 0o755;
  // The mode contract is enforced on the read side too: an unkeyed checksum is no defence
  // against whoever can write the file.
  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
});

test("publish validates the caller-supplied live manifest rather than trusting it", () => {
  const { fs, authority } = publishedStore();
  const bad = { activeGenerationId: "gen-1", retainedGenerationIds: "not-an-array",
    publishedAt: "2026-01-31T00:00:00Z", sourceVersion: { claude: 10 } };

  // publish copies the retention list into the manifest it writes, so a malformed `live`
  // would either throw mid-publish or be copied through.
  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: bad }),
    (err) => err.reason === "manifest-invariants",
  );
  assert.deepEqual(fs.mutations(), [], "an invalid live manifest must not mutate anything");

  const unsafe = { activeGenerationId: "../../escape", retainedGenerationIds: ["../../escape"],
    publishedAt: "2026-01-31T00:00:00Z", sourceVersion: { claude: 10 } };
  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: unsafe }),
    (err) => err.reason === "manifest-invariants",
  );
});

test("gc: a STALE caller manifest cannot delete the live generation — GC reads its own", () => {
  // The corruption this closes: a stale-but-perfectly-VALID manifest, one publish behind,
  // makes the newly activated generation look unreferenced. Validating the argument could
  // never have caught it, because the argument was not invalid — it was just not current.
  // So GC no longer accepts one; it reads the manifest that defines what is protected.
  const { fs, authority, manifest } = publishedStore();
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
  const staleView = JSON.parse(fs.files.get(P.manifest).data).body; // activates gen-2
  publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), {
    live: staleView,
    retain: 1,
  });

  // The signature makes the mistake unexpressible: there is no manifest parameter to pass a
  // stale one through.
  //
  // The arity check alone was NOT that regression guard, despite carrying its name. Restoring
  // the parameter as OPTIONAL — `manifest = null` — leaves `.length` at 4, because `Function
  // .length` counts only the parameters before the first default. So a collector that had the
  // parameter back and trusted it passed this test, which never handed it a stale manifest to
  // trust in the first place. The arity is still asserted, but the stale view is now actually
  // PASSED, and the sweep must ignore it: under `staleView` gen-2 is active and gen-3 — the
  // live generation — is unreferenced, so a collector that read the argument deletes it.
  assert.equal(collectGarbage.length, 4, "collectGarbage must not accept a manifest argument");

  const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z", staleView);
  assert.equal(swept.abortedOnManifestChange, false);
  // gen-3 is the live generation and survives; the superseded ones are collected.
  assert.equal(fs.files.has(`${P.generationsDir}/gen-3.json`), true);
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-3");
  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), false);
});

test("gc: a manifest that changes mid-sweep aborts before deleting what the new one protects", () => {
  const { fs, authority, manifest } = publishedStore();
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
  publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), {
    live: JSON.parse(fs.files.get(P.manifest).data).body,
    retain: 1,
  });

  // The plan GC forms at entry: gen-3 is active, and gen-1 is referenced by nothing.
  const before = JSON.parse(fs.files.get(P.manifest).data).body;
  assert.equal(before.activeGenerationId, "gen-3");
  assert.equal(before.retainedGenerationIds.includes("gen-1"), false);
  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), true);

  // A publish lands after that plan was formed, and the new manifest PROTECTS gen-1 — the
  // exact generation the stale plan marked collectable. This is the whole point of the abort,
  // and the previous version of this test could not see it: it changed only `publishedAt`, so
  // the protected set was identical and deleting gen-1 anyway would have passed. It also
  // swapped on the first `unlink`, by which time that deletion's gate had already been
  // cleared — so the test tolerated exactly the stale deletion it was named for.
  //
  // Swapping on the directory LISTING puts the change before any deletion gate runs.
  let swapped = false;
  fs.hooks.set("listDir", () => {
    if (swapped) return;
    swapped = true;
    fs.put(
      P.manifest,
      encodeEnvelope("manifest", {
        ...before,
        retainedGenerationIds: [...before.retainedGenerationIds, "gen-1"],
        publishedAt: "2026-03-01T00:00:00Z",
      }),
    );
  });
  const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
  fs.clearHooks();

  assert.equal(swept.abortedOnManifestChange, true);
  // Aborting means NOTHING was deleted on the strength of the stale plan — not "fewer things".
  assert.deepEqual(swept.removedGenerations, []);
  assert.deepEqual(swept.removedPins, []);
  assert.equal(
    fs.files.has(`${P.generationsDir}/gen-1.json`),
    true,
    "the generation the new manifest protects must survive the stale plan",
  );
});

test("gc: a manifest that changes between deletions stops the remaining ones", () => {
  const { fs, authority, manifest } = publishedStore();
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
  publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), {
    live: JSON.parse(fs.files.get(P.manifest).data).body,
    retain: 1,
  });
  publishSnapshot(fs, authority, P, candidate("gen-4", { claude: 40 }), {
    live: JSON.parse(fs.files.get(P.manifest).data).body,
    retain: 1,
  });
  const before = JSON.parse(fs.files.get(P.manifest).data).body;
  const collectable = ["gen-1", "gen-2", "gen-3"].filter(
    (id) => !before.retainedGenerationIds.includes(id) && id !== before.activeGenerationId,
  );
  assert.ok(collectable.length >= 2, `need at least two collectable generations, got ${collectable}`);

  // The gate is re-evaluated before EVERY deletion, not once before the loop. A publish that
  // lands after the first unlink must stop the second — the residue it leaves behind is the
  // next sweep's problem, and that is strictly better than deleting against a stale plan.
  let deletions = 0;
  fs.hooks.set("unlink", () => {
    deletions += 1;
    if (deletions !== 1) return;
    fs.put(
      P.manifest,
      encodeEnvelope("manifest", { ...before, publishedAt: "2026-03-01T00:00:00Z" }),
    );
  });
  const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
  fs.clearHooks();

  assert.equal(swept.abortedOnManifestChange, true);
  assert.equal(deletions, 1, "exactly one deletion had already passed its gate");
  const survivors = collectable.filter((id) => fs.files.has(`${P.generationsDir}/${id}.json`));
  assert.equal(
    survivors.length,
    collectable.length - 1,
    "every deletion after the change must be refused",
  );
});

test("gc: with no manifest on disk, nothing is collected", () => {
  const { fs, authority } = publishedStore();
  fs.files.delete(P.manifest);
  const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
  // An empty protected set would collect every generation in the store. Clearing a store is
  // the reset's job, under the one rule — never a sweep's side effect.
  assert.equal(swept.noUsableManifest, true);
  assert.deepEqual(swept.removedGenerations, []);
  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), true);
});

test("gc: a manifest it cannot prove is ours supplies no protected set", () => {
  // The protected set is a DELETION LIST by omission, so whoever supplies it decides what
  // survives. `readFile` follows symlinks, and an envelope checksum is computed over the body
  // it ships with — a forged manifest carries a valid one. Only the NAME can be checked.
  for (const [label, corrupt] of [
    [
      "a symlink to an attacker-authored manifest",
      (fs) => {
        fs.mkdirp("/elsewhere");
        fs.put(
          "/elsewhere/manifest.json",
          encodeEnvelope("manifest", {
            activeGenerationId: "gen-nonexistent",
            retainedGenerationIds: ["gen-nonexistent"],
            publishedAt: "2026-02-01T00:00:00Z",
            sourceVersion: { ccusage: "1.0.0" },
          }),
        );
        fs.files.delete(P.manifest);
        fs.symlink(P.manifest, "/elsewhere/manifest.json");
      },
    ],
    [
      "a manifest at a mode this protocol never writes",
      (fs) => fs.chmodDirect(P.manifest, 0o644),
    ],
  ]) {
    const { fs, authority } = publishedStore();
    corrupt(fs);

    const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
    assert.equal(swept.noUsableManifest, true, label);
    assert.deepEqual(swept.removedGenerations, [], label);
    // The store's real generation is untouched — which is the assertion that matters: under
    // the forged manifest it is unreferenced, so an unguarded read collects it.
    assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), true, label);
  }
});

test("gc: a container swapped mid-sweep stops the sweep instead of deleting elsewhere", () => {
  const { fs, authority, manifest } = publishedStore();
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
  publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), {
    live: JSON.parse(fs.files.get(P.manifest).data).body,
    retain: 1,
  });

  // A DIFFERENT REAL 0700 DIRECTORY, not a symlink. That is the case acceptability checks
  // cannot see: mode, type and non-symlink-ness are all properties a substitute reproduces
  // exactly, so only identity distinguishes it. The victim holds files whose names collide
  // with collectable generations, so a sweep that follows the swap deletes them.
  fs.mkdirp("/victim", 0o700);
  fs.put("/victim/gen-1.json", "not ours");
  fs.chmodDirect("/victim/gen-1.json", 0o600);

  let swapped = false;
  fs.hooks.set("openRead", (path) => {
    if (swapped || path !== P.manifest) return;
    swapped = true;
    fs.renameDirect(P.generationsDir, "/generations-parked");
    fs.renameDirect("/victim", P.generationsDir);
  });
  assert.throws(
    () => collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z"),
    /was replaced during the operation/,
  );
  fs.clearHooks();

  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), true, "the substitute's file survives");
});

// ---------------------------------------------------------------------------------------
// AC 1(d) — recovery from the state a CRASH leaves, not the state a catch block leaves
// ---------------------------------------------------------------------------------------

test("AC1(d): recovery from every crash boundary serves a complete, valid snapshot", () => {
  // A CRASH, not an injected exception. Throwing from a hook still unwinds through
  // commitArtifact's catch and finally — staging is cleaned up, the descriptor is closed — so
  // an exception-based "crash" test asserts recovery from a state strictly cleaner than the
  // one a real crash leaves. This captures the filesystem at the instant of death and
  // RESTORES it afterwards, discarding everything the unwinding did.
  // `unlink` is NOT a boundary of a successful publish — nothing is unlinked on the happy
  // path — so listing it produced a row that was silently skipped while the matrix claimed to
  // cover it. Every row below must actually be reached, and that is now asserted.
  const boundaries = ["openExclusive", "write", "fchmod", "fstat", "rename", "close"];

  // Every FakeFs hook fires BEFORE its operation runs, so the state a hook captures is always
  // the state PRECEDING that syscall. That is the point of the matrix — but it also means no
  // row above can ever capture a manifest that has already been renamed into place, so
  // `manifestCommitted` was false in all twelve and the branch below that handles a committed
  // manifest was dead code. This extra row is the only one that reaches it: it lets the real
  // manifest rename COMPLETE and captures immediately afterwards.
  const ROWS = [];
  for (const boundary of boundaries) {
    for (const stage of ["generation", "manifest"]) ROWS.push({ boundary, stage, after: false });
  }
  ROWS.push({ boundary: "rename", stage: "manifest", after: true });

  // Each artifact commits in exactly this order — openExclusive, write, fchmod, fstat, close,
  // lstat, rename — and hooks fire BEFORE their operation, so the staging file's state at the
  // instant of capture is a FINGERPRINT of which boundary actually fired. A row that
  // retargets no longer matches its fingerprint, which turns silent drift into a failure.
  const STAGING_AT_CAPTURE = {
    openExclusive: "absent", // the exclusive create has not run yet
    write: "empty", //          the inode exists; not one byte has landed
    fchmod: "written",
    fstat: "written",
    close: "written",
    lstat: "written", //        the pre-commit staging identity check
    rename: "written",
  };
  const stagingFingerprint = (fs, stage) => {
    const entry = fs.files.get(stagingPath(P, stage));
    if (entry === undefined) return "absent";
    if (entry.data === "") return "empty";
    const body = JSON.parse(entry.data).body;
    const id = stage === "generation" ? body.generationId : body.activeGenerationId;
    return id === "gen-2" ? "written" : `written(${id})`;
  };

  // The mode a staging file HAS at each boundary, which is a different fact from whether it has
  // been written. `openExclusive` requests 0600 and the kernel masks it, so under a restrictive
  // umask the file exists at a mode the store has not yet repaired; `fchmod` is the repair.
  // Running the whole matrix at umask 0 made this invisible — 0600 & ~0 is 0600, so every
  // pre-fchmod crash state already carried the FINAL mode and no row could tell the repaired
  // state from the unrepaired one. A recovery that mishandles a wrong-mode staging file — most
  // damagingly by treating it as ambiguous and resetting the store, losing the prior snapshot —
  // was therefore unreachable while all thirteen rows stayed green. 0o200 and 0o300 are both in
  // the accepted range, so production has to survive exactly this.
  const CRASH_UMASKS = [0o000, 0o200, 0o300];
  // Numeric, not labelled: at umask 0 the masked mode and the repaired mode are the SAME value,
  // so any two-label classifier has to pick one and would report a false mismatch on whichever
  // it did not pick. Comparing the number states both facts in one form — and at umask 0 the
  // two expectations coincide, which is the honest reading of what that mask can prove.
  const MODE_AT_CAPTURE = {
    fchmod: (umask) => 0o600 & ~umask, // the repair has not run yet
    fstat: () => 0o600,
    close: () => 0o600,
    rename: () => 0o600,
  };
  const stagingMode = (fs, stage) => {
    const entry = fs.files.get(stagingPath(P, stage));
    return entry === undefined ? "absent" : entry.mode & 0o7777;
  };

  const reached = [];
  let sawCommittedManifest = 0;

  for (const umask of CRASH_UMASKS) {
    for (const { boundary, stage, after } of ROWS) {
      const { fs, authority, manifest } = publishedStore();
      // Set AFTER the prior snapshot exists: gen-1 and the live manifest are already correctly
      // 0600, so the only thing this mask affects is the commit that is about to be interrupted.
      fs.umaskBits = umask;
      const priorGeneration = fs.files.get(`${P.generationsDir}/gen-1.json`).data;
      const priorManifest = fs.files.get(P.manifest).data;

      let captured = null;
      let capturedAt = null;
      let capturedMode = null;
      const CRASH = Symbol("crash");
      if (after) {
        // Wrapped rather than hooked, because a hook cannot express "after". The real rename
        // runs first, so the captured state is the one a crash between the manifest's commit
        // and the writer's return would leave.
        const realRename = fs.rename.bind(fs);
        fs.rename = (from, to) => {
          const result = realRename(from, to);
          if (captured === null && to === P.manifest) {
            captured = fs.captureState();
            throw CRASH;
          }
          return result;
        };
      } else {
        fs.hooks.set(boundary, (path) => {
          if (captured !== null) return;
          // SEMANTIC, not positional. Every boundary op of an artifact's commit records that
          // artifact's STAGING path — openExclusive/write/fchmod/fstat/close carry the open
          // descriptor's path, the pre-commit lstat is of that same name, and rename records
          // its source — so one matcher targets all six and can match nothing else.
          //
          // Four rows' worth of mis-targeting this replaces, every one of them counted as
          // "reached" while capturing a state other than the one the boundary table names:
          //
          //   * `closes` counted CLOSES, and publishSnapshot now closes the live-manifest
          //     READ's descriptor first. So close #1 was that read, close #2 the generation
          //     and close #3 the manifest — meaning the generation row captured the manifest
          //     read's instant and the manifest row captured the generation's.
          //   * `path.includes(stage)` matched the generations DIRECTORY (stage
          //     "generation") and the live manifest itself (stage "manifest"), both lstat'd
          //     before anything is staged — so neither lstat row ever reached the pre-commit
          //     staging identity check it is named for.
          if (path !== stagingPath(P, stage)) return;
          // The instant before this syscall — which is also the instant after the previous one,
          // so the boundary list covers every inter-operation state.
          capturedAt = stagingFingerprint(fs, stage);
          capturedMode = stagingMode(fs, stage);
          captured = fs.captureState();
          throw CRASH;
        });
      }
      try {
        publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
      } catch (err) {
        if (err !== CRASH) throw err;
      }
      fs.clearHooks();
      const where = `umask ${umask.toString(8).padStart(3, "0")} ${stage}/${boundary}${after ? "/after" : ""}`;
      assert.notEqual(captured, null, `${where}: this boundary was never reached`);
      if (!after) {
        // The row captured the instant it names, not merely SOME instant that matched.
        assert.equal(
          capturedAt,
          STAGING_AT_CAPTURE[boundary],
          `${where}: captured with staging "${capturedAt}", expected "${STAGING_AT_CAPTURE[boundary]}"`,
        );
        // THE PREMISE, asserted rather than assumed: before `fchmod` the staging file carries
        // the umask-masked mode, and after it the repaired 0600. At umask 0 those two are the
        // same value and this says nothing — which is precisely why the matrix now runs masks
        // where they differ, and why this assertion is what proves those runs are doing work.
        if (MODE_AT_CAPTURE[boundary] !== undefined) {
          const expected = MODE_AT_CAPTURE[boundary](umask);
          assert.equal(
            capturedMode,
            expected,
            `${where}: staging mode ${capturedMode.toString?.(8)}, expected ${expected.toString(8)}`,
          );
        }
      }
      reached.push(where);
      // Did the crash land before or after the MANIFEST rename? That is the only division that
      // matters to AC 1(d), and it is decided by looking at the bytes on disk at the instant of
      // death rather than by guessing from the row name.
      const manifestAtCrash = captured.get(P.manifest);
      const manifestCommitted =
        manifestAtCrash !== undefined && manifestAtCrash.bytes.toString("utf8") !== priorManifest;
      if (manifestCommitted) sawCommittedManifest += 1;
      assert.equal(
        manifestCommitted,
        after,
        `${where}: only the post-rename row can capture a committed manifest`,
      );
      fs.restoreState(captured);

      // A fresh writer starts against exactly the state the crash left.
      const started = startWriter(fs, new FakeAuthority(fs), P);
      const read = readSnapshot(fs, P);

      // A crash mid-publish is recoverable by SWEEPING staging, never by resetting: every
      // artifact the live manifest names was committed before it, so there is nothing
      // ambiguous for the reset rule to act on. `usable` for every row is that claim.
      assert.equal(
        started.status,
        "usable",
        `${where}: recovery from a crash must not need a reset`,
      );

      // no-snapshot is never an acceptable outcome here, in EITHER direction — the two
      // directions merely lose different things.
      //
      // This replaces an early return that asserted `manifestCommitted` and then `continue`d.
      // On the one row where `manifestCommitted` is true — the post-rename row, the only row
      // that reaches the committed-manifest branch at all — that made no-snapshot a PASS,
      // while the `else` branch below says in as many words that accepting it "would tolerate
      // losing a snapshot whose commit had succeeded". The prose was right and the control
      // flow disagreed with it; the weaker check won because it ran first, and the branch that
      // forbids the outcome was unreachable for the case it was written for.
      if (read.status === "no-snapshot") {
        assert.fail(
          manifestCommitted
            ? `${where}: the manifest commit SUCCEEDED and the snapshot was lost anyway`
            : `${where}: the prior complete snapshot was lost even though the manifest never moved`,
        );
      }
      if (!manifestCommitted) {
        // The manifest never moved, so the ONLY correct answer is the prior snapshot, whole.
        assert.equal(read.status, "ok", `${where}: ${read.status} where gen-1 was intact`);
        assert.equal(read.view.generation.generationId, "gen-1", where);
      } else {
        // The manifest DID land. Both the new generation and every generation the new manifest
        // still retains were committed before it, so the only correct answer is a complete
        // snapshot serving gen-2 — not `partial`, and certainly not `no-snapshot`. Accepting
        // either of those here would tolerate losing a snapshot whose commit had succeeded.
        assert.equal(read.status, "ok", `${where}: ${read.status} after a committed manifest`);
        assert.equal(read.view.generation.generationId, "gen-2", where);
        assert.deepEqual(read.view.quarantined ?? [], [], `${where}: nothing may be quarantined`);
      }
      // Otherwise it must be a COMPLETE snapshot: never a manifest naming a missing,
      // partial or checksum-invalid generation.
      assert.ok(["ok", "partial"].includes(read.status), `${where}: ${read.status}`);
      const served = read.view.generation.generationId;
      assert.ok(["gen-1", "gen-2"].includes(served), `${where}: served ${served}`);
      if (served === "gen-1") {
        assert.equal(
          fs.files.get(`${P.generationsDir}/gen-1.json`).data,
          priorGeneration,
          `${where}: the prior generation must be byte-identical`,
        );
        // Crashing before the manifest commit must leave the PRIOR manifest exactly as it was.
        if (stage === "manifest" || boundary !== "rename") {
          assert.equal(fs.files.get(P.manifest).data, priorManifest, `${where}: prior manifest`);
        }
      }
      // And the manifest's whole reference set resolves to complete, valid generations.
      const live = JSON.parse(fs.files.get(P.manifest).data).body;
      for (const id of live.retainedGenerationIds) {
        const path = `${P.generationsDir}/${id}.json`;
        assert.equal(fs.files.has(path), true, `${where}: manifest references ${id}, missing`);
        const envelope = JSON.parse(fs.files.get(path).data);
        assert.equal(
          checksumOf(envelope.body),
          envelope.checksum,
          `${where}: ${id} is referenced but checksum-invalid`,
        );
      }
    }
  }

  // Every declared row ran. The loop used to `continue` past any boundary its hook never
  // reached, so the matrix could claim coverage of rows that silently did nothing.
  const expectedRows = ROWS.length * CRASH_UMASKS.length;
  assert.equal(
    reached.length,
    expectedRows,
    `covered ${reached.length} of ${expectedRows} rows: ${reached}`,
  );
  // ...and the post-manifest-rename state was genuinely reached. Without this the branch that
  // handles a committed manifest is unreachable and the matrix silently tests half of AC 1(d).
  assert.equal(
    sawCommittedManifest,
    CRASH_UMASKS.length,
    "exactly one row per umask must capture a committed manifest",
  );
});

test("commit: each artifact's staging file goes through exactly one operation ORDER", () => {
  // The crash matrix above NAMES this order in a comment and calls the staging file's state a
  // "fingerprint" of which boundary fired — but content only distinguishes the first two:
  // absent before `openExclusive`, empty before `write`, and identical "written" for every one
  // of fchmod/fstat/close/lstat/rename. So the matrix could not have detected those five being
  // reordered, while its prose said the order was the thing being pinned. (The mode fingerprint
  // added alongside this now separates pre- from post-`fchmod`, which is a genuine but partial
  // improvement: it splits that run of five into two, not into five.)
  //
  // The order is a real contract, not an implementation detail. `fchmod` after `openExclusive`
  // is what makes the mode independent of the umask; `fstat` after `fchmod` is what VERIFIES it
  // on the descriptor rather than trusting the request; `close` before `rename` is what stops a
  // still-open descriptor being published; and the `lstat` between them is the pre-commit
  // identity check. Every one of those is a property of where the operation sits in the
  // sequence, so the sequence is asserted here as a sequence.
  const { fs, authority } = freshStore();
  startWriter(fs, authority, P);
  fs.calls.length = 0;
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });

  const EXPECTED = ["openExclusive", "write", "fchmod", "fstat", "close", "lstat", "rename"];
  for (const stage of ["generation", "manifest"]) {
    const path = stagingPath(P, stage);
    const ops = fs.calls.filter((c) => c.path === path).map((c) => c.op);
    assert.deepEqual(ops, EXPECTED, `${stage}: ${ops.join(" → ")}`);
  }
});

test("AC1(d): the crash simulation really is dirtier than an injected exception", () => {
  // Guards the guard. If restoreState did not discard the unwinding, this matrix would be
  // testing the same clean states the failure matrix already covers, and would prove nothing
  // beyond it.
  const { fs, authority, manifest } = publishedStore();
  let captured = null;
  const CRASH = Symbol("crash");
  fs.hooks.set("rename", (path) => {
    if (captured !== null || !path.includes("generation")) return;
    captured = fs.captureState();
    throw CRASH;
  });
  try {
    publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
  } catch (err) {
    if (err !== CRASH) throw err;
  }
  fs.clearHooks();

  // After unwinding, the store's own cleanup removed the staging file...
  assert.equal(fs.files.has(stagingPath(P, "generation")), false);
  // ...but the crash state still has it, which is the whole point.
  fs.restoreState(captured);
  assert.equal(
    fs.files.has(stagingPath(P, "generation")),
    true,
    "a crash leaves the staging file that the catch block would have removed",
  );
});

// ---------------------------------------------------------------------------------------
// The reader's containment, per prefix
// ---------------------------------------------------------------------------------------

test("containment: the reader refuses a symlinked generations/ pointing at valid artifacts", () => {
  const { fs } = publishedStore();
  // A perfectly valid generation, at the right mode, in someone else's directory.
  fs.mkdirp("/outside/decoy", 0o700);
  fs.put("/outside/decoy/gen-1.json", fs.files.get(`${P.generationsDir}/gen-1.json`).data);
  for (const key of [...fs.nodes.keys()]) {
    if (key === P.generationsDir || key.startsWith(`${P.generationsDir}/`)) fs.nodes.delete(key);
  }
  fs.symlink(P.generationsDir, "/outside/decoy");

  // Everything it would read through that prefix looks right. It must still refuse: the
  // artifacts are valid, but they are not this store's.
  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
});

test("containment: a container swapped DURING a read is caught by the closing bracket", () => {
  const { fs } = publishedStore();
  fs.mkdirp("/outside/decoy", 0o700);

  // Let the read proceed normally, then swap generations/ just before the bracket closes.
  // Wrapped on `readAll` rather than `readFile`: the store reads artifacts from a DESCRIPTOR
  // now, so the swap has to land after the bytes have been taken from the open file — which
  // is exactly the interval this test is about.
  let reads = 0;
  let swapped = false;
  let manifestReadFirst = false;
  const realRead = fs.readAll.bind(fs);
  fs.readAll = (handle, maxBytes) => {
    const out = realRead(handle, maxBytes);
    const path = fs.entryFor(handle)?.path ?? "";
    if (path === P.manifest && !swapped) manifestReadFirst = true;
    if (path.startsWith(P.generationsDir) && ++reads === 1) {
      swapped = true;
      for (const key of [...fs.nodes.keys()]) {
        if (key === P.generationsDir || key.startsWith(`${P.generationsDir}/`)) fs.nodes.delete(key);
      }
      fs.symlink(P.generationsDir, "/outside/decoy");
    }
    return out;
  };

  // The manifest never changed, so the manifest-identity half of the bracket says "stable".
  // Only the container half can catch this — which is why checking containers once at entry
  // was a hole in the transaction, not merely a missing check.
  const result = readSnapshot(fs, P);

  // THE WINDOW WAS ENTERED, asserted rather than assumed. `no-snapshot` alone is not evidence:
  // a reader that gave up BEFORE opening any generation returns exactly that while `reads`
  // stays 0 and the swap never happens, so the result would be right for a reason that has
  // nothing to do with the closing bracket this test is named for.
  assert.equal(manifestReadFirst, true, "the manifest must have been read before the generation");
  assert.equal(reads, 1, "a generation must actually have been read");
  assert.equal(swapped, true, "the container swap must have fired inside the read");

  assert.equal(result.status, "no-snapshot");
});

test("reader: an I/O failure is NOT reported as an empty or corrupt cache", () => {
  // A bare catch turned EIO into "no snapshot yet", which tells a caller the cache is cold
  // when the truth is that the disk is failing.
  const { fs } = publishedStore();
  fs.failOn("openRead", "manifest.json", errno("EIO", "disk is failing"));
  assert.throws(() => readSnapshot(fs, P), (err) => causeCode(err) === "EIO");
  fs.clearHooks();

  const { fs: fs2 } = publishedStore();
  fs2.failOn("openRead", "generations/", errno("EACCES", "denied"));
  assert.throws(() => readSnapshot(fs2, P), (err) => causeCode(err) === "EACCES");
  fs2.clearHooks();

  // A genuinely corrupt generation is still quarantined rather than thrown.
  const { fs: fs3 } = publishedStore();
  fs3.put(`${P.generationsDir}/gen-1.json`, "{not json");
  assert.equal(readSnapshot(fs3, P).status, "no-snapshot");
});

// ---------------------------------------------------------------------------------------
// The startup sweep clears the three names it wrote, and nothing else
// ---------------------------------------------------------------------------------------

const STAGING_SHAPES = [
  ["an expected staging file", (fs) => fs.put(stagingPath(P, "generation"), "residue"), true],
  ["a nested directory", (fs) => fs.mkdirp(`${P.stagingDir}/nested`), false],
  ["a malformed name", (fs) => fs.put(`${P.stagingDir}/notes.txt`, "hi"), false],
  ["a wrong-mode staging file", (fs) => fs.put(stagingPath(P, "pin"), "x", 0o644), false],
  // The three rows that pin the sweep's mode predicate, which is narrower than "not 0600" and
  // narrower than "a subset of 0600". `openExclusive` requests FILE_MODE and the kernel masks
  // it, so our own pre-`fchmod` residue is 0600 or — under an accepted umask carrying 0o200 —
  // 0400. Those are the ONLY two modes this protocol can leave behind, because the adapter
  // refuses any umask that would clear owner read. So 0400 must be swept (requiring 0600 exactly
  // made the sweep refuse its own crash residue, after which classification reset the store and
  // a complete snapshot was lost), while 0200 and 0000 must NOT be: no permitted umask can
  // produce them from a FILE_MODE request, so a file sitting at one of the three fixed staging
  // names carrying such a mode is not ours, and deleting it is exactly what the mode test exists
  // to prevent.
  ["pre-fchmod residue at 0400", (fs) => fs.put(stagingPath(P, "generation"), "residue", 0o400), true],
  ["a staging file at 0200, which no permitted umask can produce", (fs) => fs.put(stagingPath(P, "generation"), "x", 0o200), false],
  ["a staging file at 0000, which no permitted umask can produce", (fs) => fs.put(stagingPath(P, "generation"), "x", 0o000), false],
  ["a symlinked staging entry", (fs) => fs.symlink(stagingPath(P, "manifest"), "/outside/x"), false],
];

for (const [label, seed, swept] of STAGING_SHAPES) {
  test(`startup: ${label} in staging/ ${swept ? "is swept" : "routes to reset"} and converges`, () => {
    const { fs, authority } = publishedStore();
    seed(fs);

    // Unlinking whatever it found was wrong twice: a nested directory gave EISDIR, which
    // propagated and wedged startup before classification could route the store to a reset;
    // and a foreign file was silently deleted when classification's disposition for "this
    // protocol did not write it" is to reset.
    const priorGeneration = fs.files.get(`${P.generationsDir}/gen-1.json`).data;
    const started = startWriter(fs, authority, P);
    if (swept) {
      assert.deepEqual(started.sweptStaging, [stagingPath(P, "generation")], label);
      assert.equal(started.status, "usable", label);
      // Sweeping residue must not cost the store its data.
      assert.equal(classifyStore(fs, P).status, "usable", label);
      assert.equal(fs.files.get(`${P.generationsDir}/gen-1.json`).data, priorGeneration, label);
    } else {
      assert.equal(started.status, "not-usable", label);
      // NAMED, not merely "not not-usable". `!==` on a three-valued status also accepted
      // `usable`, which is a genuinely different implementation: one that deletes the foreign
      // entry and keeps the snapshot, rather than applying the one reset disposition. These
      // rows are specified to route THROUGH a reset, so the converged state is `first-run` and
      // the prior store is gone.
      assert.equal(classifyStore(fs, P).status, "first-run", `${label}: must reset, not repair`);
      assert.equal(fs.files.has(P.manifest), false, `${label}: the manifest must be gone`);
      assert.deepEqual(fs.listDir(P.generationsDir), [], `${label}: generations must be gone`);
    }

    // Either way staging is empty.
    assert.deepEqual(fs.listDir(P.stagingDir), [], `${label}: staging must be empty`);
  });
}

// ---------------------------------------------------------------------------------------
// A wrong-TYPE container is evidence, not a nuisance
// ---------------------------------------------------------------------------------------

const CONTAINERS = [
  ["the store root", P.root],
  ["generations/", P.generationsDir],
  ["pins/", P.pinsDir],
  ["staging/", P.stagingDir],
];

const WRONG_TYPES = [
  ["a symlink", (fs, path) => fs.symlink(path, "/outside/decoy"), true],
  ["a regular file", (fs, path) => fs.put(path, "not a directory"), false],
  ["a FIFO", (fs, path) => fs.mkfifo(path), false],
];

for (const [where, container] of CONTAINERS) {
  for (const [what, seed, pointsOutside] of WRONG_TYPES) {
    test(`startup: ${what} at ${where} routes through classification, it is not silently replaced`, () => {
      // `startWriter` ensures the skeleton BEFORE it classifies, and `ensureDir` used to unlink
      // any symlink or non-directory it found at a container's name and create a real directory
      // in its place. Inside a reset that is exactly right — the store has been judged, and the
      // unlink is what stops the next classification refusing the same entry forever. Here it
      // ran before anything had judged anything, so the one state the derived-cache rule is
      // written for was DESTROYED and then handed to classification looking like a first run:
      // status `first-run`, no `resetError`, and nothing anywhere for an operator to read.
      const { fs, authority } = publishedStore();
      // Somebody else's directory, with something in it worth not deleting.
      fs.mkdirp("/outside/decoy", 0o700);
      fs.put("/outside/decoy/manifest.json", "a file that belongs to someone else");
      // The container and everything under it, replaced. Leaving the children behind would let
      // the assertions below pass on residue rather than on what the store rebuilt.
      for (const key of [...fs.nodes.keys()]) {
        if (key === container || key.startsWith(`${container}/`)) fs.nodes.delete(key);
      }
      seed(fs, container);

      const started = startWriter(fs, authority, P);

      // NAMED, not merely "not usable": the defect's signature is `first-run` with no
      // diagnostic, and a three-valued status compared with `!==` would accept it.
      assert.equal(started.status, "not-usable", `${what} at ${where}`);
      assert.equal(started.resetError.reason, "unknown-entry", `${what} at ${where}`);
      assert.equal(started.resetError.artifactPath, container, `${what} at ${where}`);
      // The reset removed it, so the store went THROUGH the one rule rather than around it.
      assert.deepEqual(started.reset.failed, [], `${what} at ${where}`);

      // Nothing outside the store was touched. The reset unlinks the ENTRY, never its target —
      // and no seam call addresses a path outside the root at any point.
      if (pointsOutside) {
        assert.equal(
          fs.nodes.get("/outside/decoy/manifest.json")?.type,
          "file",
          `${what} at ${where}: a file outside the store was deleted through the link`,
        );
        assert.equal(fs.nodes.get("/outside/decoy")?.type, "dir", `${what} at ${where}`);
      }
      assert.deepEqual(callsOutside(fs), [], `${what} at ${where}: escaped the root`);

      // And it CONVERGES, which is the whole reason replacing it looked reasonable. One pass
      // later than before, with the reason recorded.
      assert.equal(classifyStore(fs, P).status, "first-run", `${what} at ${where}`);
      const now = fs.lstat(container);
      assert.equal(now.isDirectory, true, `${what} at ${where}: must be a real directory`);
      assert.equal(now.isSymbolicLink, false, `${what} at ${where}`);
      assert.equal(now.mode & 0o7777, 0o700, `${what} at ${where}`);
      assert.equal(startWriter(fs, new FakeAuthority(fs), P).status, "first-run", `${what} at ${where}`);
    });
  }
}

test("startup: the staging sweep does not enumerate a foreign directory through a symlinked staging/", () => {
  // `listDir` FOLLOWS a symlink, and the sweep is a list-then-unlink over three fixed names —
  // so with the wrong-type container now LEFT in place for classification to read, the sweep
  // would enumerate somebody else's directory looking for `manifest.json` to delete. Nothing
  // could actually delete one (`stagingStillOurs` refuses a symlink before every unlink), but
  // an incomplete skeleton means classification is about to reset the store and the reset
  // removes staging wholesale, so the listing buys nothing and is simply not performed.
  const { fs, authority } = publishedStore();
  fs.mkdirp("/outside/decoy", 0o700);
  fs.put("/outside/decoy/manifest.json", "residue that belongs to someone else");
  fs.nodes.delete(P.stagingDir);
  fs.symlink(P.stagingDir, "/outside/decoy");

  let followed = false;
  fs.hooks.set("listDir", (path) => {
    // Hooks fire BEFORE their operation, so the node is still the symlink at this point.
    if (path === P.stagingDir && fs.nodes.get(P.stagingDir)?.type === "symlink") followed = true;
  });
  const started = startWriter(fs, authority, P);
  fs.clearHooks();

  assert.equal(followed, false, "the sweep must not list through the link");
  assert.equal(started.status, "not-usable", "and classification must still have run");
  assert.deepEqual(started.sweptStaging, []);
  assert.equal(fs.nodes.get("/outside/decoy/manifest.json")?.type, "file");
});

test("startup: a wrong-MODE container is still repaired before classification, not reset", () => {
  // The narrowing above is about TYPE and nothing else. The mode repair is deliberate and
  // argued at its own site — a directory mode is a deterministic fix, `chmod 0700` is exactly
  // what this protocol writes, and the artifacts inside are still classified on their own
  // terms — so a change that swept it up with the type case would discard a healthy store to
  // fix a permission bit. Stated here as well as at `classification: a wrong-mode directory is
  // REPAIRED, not reset`, because it is now a boundary between two policies rather than a
  // single rule, and the boundary is what a future narrowing would move.
  for (const dir of [P.root, P.generationsDir, P.pinsDir, P.stagingDir]) {
    const { fs, authority } = publishedStore();
    fs.chmodDirect(dir, 0o755);
    assert.equal(classifyStore(fs, P).status, "not-usable", dir);

    const started = startWriter(fs, authority, P);
    assert.equal(started.status, "usable", dir);
    assert.equal(started.resetError, undefined, dir);
    assert.equal(fs.lstat(dir).mode & 0o7777, 0o700, dir);
    assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1", dir);
  }
});

test("diagnostics: an unusable artifact carries the seam failure it was derived from", () => {
  // Three of `readStoreFile`'s unusable verdicts are reached by CATCHING a classified
  // `SnapshotFsError`, and the conversion into a reset reason used to drop it — including the
  // `TextDecoder` failure the adapter goes out of its way to preserve, which is the only value
  // in the chain that says WHERE an artifact's bytes went wrong. Both callers that turn one of
  // these verdicts into a `SnapshotStoreResetError` have to forward it, and they are different
  // callers: classification builds a diagnostic, publish throws one.
  const CAUSED = [
    [
      "a symlinked manifest",
      (fs) => { fs.nodes.delete(P.manifest); fs.symlink(P.manifest, "/elsewhere.json"); },
      "ELOOP",
    ],
    [
      "bytes that are not valid UTF-8",
      (fs) => fs.putBytes(P.manifest, Buffer.from([0x7b, 0x80, 0x7d])),
      "EILSEQ",
    ],
    [
      "a read past the artifact limit",
      (fs) => fs.failOn("readAll", "manifest.json", errno("EFBIG", "read exceeded")),
      "EFBIG",
    ],
  ];

  for (const [label, seed, code] of CAUSED) {
    // 1. Through CLASSIFICATION.
    const { fs } = publishedStore();
    seed(fs);
    const classified = classifyStore(fs, P).error;
    assert.equal(causeCode(classified.cause), code, `${label}: classification dropped the origin`);

    // 2. And through PUBLISH, which constructs its own and is a third kind of caller.
    const { fs: fs2, authority: auth2 } = publishedStore();
    seed(fs2);
    assert.throws(
      () => publishSnapshot(fs2, auth2, P, candidate("gen-2", { claude: 99 }), { live: null }),
      (err) => {
        assert.equal(err.name, "SnapshotStoreResetError", label);
        assert.equal(causeCode(err.cause), code, `${label}: publish dropped the origin`);
        return true;
      },
      label,
    );
  }

  // The THIRD consumer, and the one round 10's fix missed: a referenced GENERATION that is
  // unusable. The grep that found the other two matched on the local's name, so this site kept
  // dropping the origin while the manifest and publish sites forwarded it — which is how a rule
  // ends up being a coincidence. Every unusable shape routes through here, not just the one.
  // Only TWO of the three shapes can reach it, and the third is excluded for a reason rather
  // than forgotten: `checkArtifactDir` runs first and refuses a symlink under `generations/` as
  // `unknown-entry` — a verdict with no caught value at all — so a symlinked generation never
  // gets as far as `readStoreFile`. Asserting a cause for it would be asserting a path the code
  // cannot take.
  const genPath = `${P.generationsDir}/gen-1.json`;
  for (const [label, seed, code] of [
    ["bytes that are not valid UTF-8", (fs) => fs.putBytes(genPath, Buffer.from([0x7b, 0x80, 0x7d])), "EILSEQ"],
    ["a read past the artifact limit", (fs) => fs.failOn("readAll", "gen-1.json", errno("EFBIG", "read exceeded")), "EFBIG"],
  ]) {
    const { fs } = publishedStore();
    seed(fs);
    const classified = classifyStore(fs, P);
    assert.equal(classified.status, "not-usable", `${label}: generation`);
    assert.equal(
      causeCode(classified.error.cause),
      code,
      `${label}: the generation consumer dropped the origin`,
    );
  }

  // The DECODER'S OWN error survives the whole chain, which is the specific loss the finding
  // named. Reset diagnostic -> seam error -> the failure the decoder raised.
  const { fs: fs3 } = publishedStore();
  fs3.putBytes(P.manifest, Buffer.from([0x7b, 0x80, 0x7d]));
  const decoded = classifyStore(fs3, P).error;
  assert.equal(decoded.cause.cause.cause instanceof Error, true, "the decoder failure is dropped");

  // And the two verdicts derived from an `fstat` on a healthy descriptor carry NOTHING, because
  // there is no caught value to forward. Asserting a cause there would be asserting a
  // fabrication, and a blanket "always has a cause" rule is how one gets invented.
  for (const [label, seed] of [
    ["a directory at the manifest's name", (fs) => { fs.nodes.delete(P.manifest); fs.mkdirp(P.manifest, 0o700); }],
    ["a wrong-mode manifest", (fs) => fs.chmodDirect(P.manifest, 0o644)],
  ]) {
    const { fs } = publishedStore();
    seed(fs);
    assert.equal(classifyStore(fs, P).error.cause, undefined, label);
  }
});

// ---------------------------------------------------------------------------------------
// Canonicalization is a trust boundary too — the payload is caller data
// ---------------------------------------------------------------------------------------

test("canonicalize: a payload accessor or Proxy is refused, never invoked", () => {
  // The naive walk did `obj[key]`, so a getter in a PAYLOAD ran arbitrary code in the middle
  // of checksumming — after validation, inside the step that describes what was validated.
  let getterCalls = 0;
  const withGetter = {};
  Object.defineProperty(withGetter, "total", {
    get() { getterCalls += 1; return 1; },
    enumerable: true,
  });
  assert.throws(() => canonicalize({ payload: withGetter }), /accessor/);
  assert.equal(getterCalls, 0, "the accessor must never be invoked");

  const traps = [];
  const hostile = new Proxy({ a: 1 }, { get(t, p, r) { traps.push(String(p)); return Reflect.get(t, p, r); } });
  assert.throws(() => canonicalize({ payload: hostile }), /Proxy/);
  assert.deepEqual(traps, []);
});

test("canonicalize: values outside the JSON domain are refused by name", () => {
  const cases = [
    ["undefined", { a: undefined }, /undefined/],
    ["a function", { a: () => 1 }, /function/],
    ["BigInt", { a: 1n }, /BigInt/],
    ["NaN", { a: NaN }, /non-finite/],
    ["Infinity", { a: Infinity }, /non-finite/],
    ["a Date", { a: new Date() }, /plain objects/],
    ["a Map", { a: new Map() }, /plain objects/],
    ["a Symbol value", { a: Symbol("s") }, /Symbol/],
    ["a Symbol key", { [Symbol("s")]: 1 }, /Symbol keys/],
    ["a sparse hole", { a: [1, , 3] }, /sparse/],
  ];
  for (const [label, value, pattern] of cases) {
    assert.throws(() => canonicalize(value), pattern, label);
  }

  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  // A cycle used to blow the stack rather than report anything.
  assert.throws(() => canonicalize(cyclic), /cyclic/);
});

test("envelope: duplicate JSON keys are refused, though the parse result looks valid", () => {
  // Duplicate keys are LEGAL JSON and the last occurrence silently wins, so nothing derived
  // from the parse can see the discarded text. Every check that operates on the parse result —
  // the exact-key set, the kind, the checksum — passes, while the bytes on disk say something
  // else. Only re-encoding and comparing the raw bytes can catch it.
  const body = { generationId: "gen-1", n: 1 };
  const canonical = encodeEnvelope("generation", body);
  const parsed = JSON.parse(canonical);

  // A duplicate ENVELOPE key. The survivor is the correct kind, so `env.kind === kind` passes.
  const dupKind = canonical.replace('"kind":"generation"', '"kind":"pin","kind":"generation"');
  assert.notEqual(dupKind, canonical);
  assert.equal(JSON.parse(dupKind).kind, "generation", "the survivor must look right");
  assert.throws(
    () => decodeEnvelope("generation", "/x.json", dupKind),
    (err) => {
      assert.equal(err.reason, "generation-unparsable");
      assert.match(err.detail, /canonical encoding/);
      return true;
    },
  );

  // A duplicate key INSIDE the body, where the surviving value is the one that was checksummed
  // — so the checksum matches and only the byte comparison notices.
  const dupBody = canonical.replace('"n":1', '"n":99,"n":1');
  assert.equal(JSON.parse(dupBody).checksum, parsed.checksum);
  assert.deepEqual(JSON.parse(dupBody).body, body, "the parse result is indistinguishable");
  assert.throws(() => decodeEnvelope("generation", "/x.json", dupBody), /canonical encoding/);

  // Key order and whitespace are the same property, and are refused for the same reason.
  const reordered = JSON.stringify({
    schemaVersion: parsed.schemaVersion, kind: parsed.kind, checksum: parsed.checksum, body: parsed.body,
  });
  assert.notEqual(reordered, canonical);
  assert.throws(() => decodeEnvelope("generation", "/x.json", reordered), /canonical encoding/);

  // ...and the canonical bytes themselves still decode.
  assert.deepEqual(decodeEnvelope("generation", "/x.json", canonical), body);
});

test("canonicalize: a named property on an array is refused, not silently dropped", () => {
  // An array is an object and carries anything an object can. Walking 0..length-1 and stopping
  // there meant this data was invisible to the checksum — so the two values below, which are
  // NOT the same document, canonicalized to the same bytes. A checksum that cannot tell them
  // apart is the one failure this function exists to prevent.
  const plain = [1, 2, 3];
  const annotated = [1, 2, 3];
  annotated.note = "a value the checksum could not see";

  assert.equal(canonicalize(plain), "[1,2,3]");
  assert.throws(() => canonicalize(annotated), /named property on an array/);

  // NUMERIC-LOOKING keys are the interesting half, and the first version of this test missed
  // them entirely. `Number("01")` is 1, so a check written with numeric coercion treats "01"
  // as an index and drops it — reintroducing the very collision the check exists to close. An
  // index is the canonical spelling and nothing else.
  for (const key of ["01", "1e0", "+1", " 1 ", "-0", "1.0", "0x1"]) {
    const arr = [10, 20, 30];
    Object.defineProperty(arr, key, { value: 7, enumerable: true, configurable: true, writable: true });
    assert.throws(
      () => canonicalize(arr),
      /named property on an array/,
      `an array carrying ${JSON.stringify(key)} must be refused, not silently equal to [10,20,30]`,
    );
  }
  // ...while the canonical spellings ARE indices and canonicalize normally.
  assert.equal(canonicalize([10, 20, 30]), "[10,20,30]");

  const symbolled = [1, 2, 3];
  symbolled[Symbol("s")] = 1;
  assert.throws(() => canonicalize(symbolled), /Symbol keys/);
});

test("canonicalize: a prototype is not a proof of plainness", () => {
  // The prototype check asks what an object INHERITS from, and a prototype is a settable
  // pointer. `Object.setPrototypeOf(new Date(), Object.prototype)` satisfies it, has no own
  // enumerable properties, and canonicalized to `{}` — while the Date's time value sits in an
  // internal slot no descriptor walk can reach. That is the "looks rich, checksums as empty"
  // failure the prototype check was added to prevent, walking through the prototype check.
  const reDate = new Date("2020-01-01T00:00:00Z");
  Object.setPrototypeOf(reDate, Object.prototype);
  const reMap = new Map([["a", 1]]);
  Object.setPrototypeOf(reMap, Object.prototype);
  const reSet = new Set([1, 2]);
  Object.setPrototypeOf(reSet, null);
  const reBoxed = new Number(7);
  Object.setPrototypeOf(reBoxed, Object.prototype);
  const reTyped = new Uint8Array([1, 2, 3]);
  Object.setPrototypeOf(reTyped, Object.prototype);

  for (const [label, value] of [
    ["Date", reDate],
    ["Map", reMap],
    ["Set", reSet],
    ["boxed Number", reBoxed],
    ["Uint8Array", reTyped],
  ]) {
    assert.throws(
      () => canonicalize(value),
      NonCanonicalValueError,
      `a re-prototyped ${label} canonicalized instead of being refused`,
    );
  }

  // `Array.isArray` reads an internal slot too, so it is true for a subclass and for an array
  // whose prototype was replaced — and the array branch never checked the prototype at all.
  class Tagged extends Array {}
  const subclass = Tagged.from([1, 2]);
  const reArray = [1, 2];
  Object.setPrototypeOf(reArray, { evil: 1 });
  assert.throws(() => canonicalize(subclass), NonCanonicalValueError, "an Array subclass");
  assert.throws(() => canonicalize(reArray), NonCanonicalValueError, "a re-prototyped array");

  // The refusal must not have been bought by breaking ordinary documents — including the
  // null-prototype objects JSON.parse produces for a `__proto__` key, which ARE plain.
  assert.equal(canonicalize({ b: 1, a: [1, { c: 2 }] }), '{"a":[1,{"c":2}],"b":1}');
  assert.equal(canonicalize(Object.assign(Object.create(null), { a: 1 })), '{"a":1}');
  assert.equal(canonicalize([]), "[]");

  // And it holds NESTED, not only at the root — the walk is recursive and so is the hazard.
  const nested = { payload: { when: new Date("2020-01-01T00:00:00Z") } };
  Object.setPrototypeOf(nested.payload.when, Object.prototype);
  assert.throws(() => canonicalize(nested), NonCanonicalValueError, "nested re-prototyped Date");
});

test("canonicalize: a non-enumerable property is refused, not silently dropped", () => {
  // Same failure, reached the other way. `JSON.stringify` skips non-enumerable properties, and
  // matching that behaviour was the bug: the property IS on the document, so the checksum
  // described a value the caller never wrote.
  const hidden = { visible: 1 };
  Object.defineProperty(hidden, "secret", { value: 2, enumerable: false });

  assert.equal(JSON.stringify(hidden), '{"visible":1}', "JSON silently drops it — that is the point");
  assert.throws(() => canonicalize(hidden), /non-enumerable/);
});

test("canonicalize: nesting past the limit is a named refusal, not a RangeError", () => {
  // The cycle check catches values pointing BACK at themselves and says nothing about a value
  // that is merely very deep. Deep nesting used to exhaust the stack and surface as an untyped
  // RangeError from whichever frame lost, which no caller classifies.
  let deep = 1;
  for (let i = 0; i < 5000; i++) deep = { next: deep };

  assert.throws(() => canonicalize(deep), (err) => {
    assert.equal(err.name, "NonCanonicalValueError", `got ${err.name}: ${err.message}`);
    assert.match(err.message, /nesting exceeds/);
    return true;
  });

  // Just under the limit still canonicalizes, so the guard is a limit and not a blanket ban.
  let shallow = 1;
  for (let i = 0; i < 60; i++) shallow = { next: shallow };
  assert.ok(canonicalize(shallow).startsWith('{"next":'));
});

test("commit: a close that throws NULL is still a failed close", () => {
  // The seam promises nothing about what a fault throws, and `null` was doing double duty as
  // the "no close failure" sentinel — so a close throwing null read as success and the rename
  // committed an artifact whose close had failed. Every existing close-failure test used
  // Error objects, which is exactly why this survived.
  for (const thrown of [null, undefined, 0, ""]) {
    const { fs, authority } = freshStore();
    startWriter(fs, authority, P);
    let closes = 0;
    fs.hooks.set("close", () => { closes += 1; throw thrown; });

    let caught;
    let threw = false;
    try {
      publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });
    } catch (err) {
      threw = true;
      caught = err;
    }
    const what = `close threw ${JSON.stringify(thrown)}`;

    // This used to be `assert.throws(..., () => true)`, which accepts ANY throw. A typo in the
    // fixture, or a refusal raised long before the commit, satisfied it just as well as the
    // behaviour under test — and the two assertions that follow are also satisfied by a publish
    // that never got as far as opening the artifact, so the whole test could pass without a
    // single close ever failing. (Measured while fixing this: a malformed candidate produced
    // exactly that shape — a reset error, zero closes, and a green test.)
    //
    // A separate flag rather than `caught !== undefined`, because `undefined` is one of the
    // values under test and would otherwise be indistinguishable from not throwing at all.
    assert.ok(threw, `${what} and publishSnapshot returned normally`);
    // The store propagates the seam's value UNCHANGED, so identity is the available proof —
    // and with every value here falsy it is also the only one that means anything.
    assert.ok(Object.is(caught, thrown), `${what} but ${String(caught)} came back instead`);
    // ...and the failure came from the close, not from something earlier that happened to fail.
    assert.equal(closes, 1, `${what}: the close hook fired ${closes} times, expected exactly 1`);
    fs.clearHooks();
    assert.equal(
      fs.files.has(`${P.generationsDir}/gen-1.json`),
      false,
      `close threw ${JSON.stringify(thrown)} and the artifact was published anyway`,
    );
    assert.equal(readSnapshot(fs, P).status, "no-snapshot");
  }
});

test("commit: a swap during the FINAL authority assertion is the documented residual", () => {
  // The last thing before `rename` is `assertHeld()`, not the identity check — AC 8 requires
  // it there. So a replacement performed from inside that assertion lands after every
  // filesystem check has passed. This test does not assert that the store catches it, because
  // it cannot: it PINS the residual so that a future reader finds a test rather than a claim,
  // and so that the day a descriptor-relative rename becomes available, this is the case that
  // starts failing and gets tightened.
  // THE SWAP IS PERFORMED. The previous version of this test performed none: its handler
  // guarded on `data.includes("66613")`, a marker the candidate never carried, so `swaps`
  // stayed 0, no filesystem change ever happened, and the test asserted a successful ordinary
  // publish while claiming to demonstrate a residual. It was an unfinished stub that read like
  // a finding. A residual has to be SHOWN, or it is just a comment with a green tick.
  const { fs } = freshStore();
  const staging = stagingPath(P, "generation");
  const target = `${P.generationsDir}/gen-1.json`;

  // A different, fully valid generation — correct id for the filename, correct checksum — so
  // nothing downstream can reject it. If the rename publishes this, the store served an
  // artifact it never wrote.
  const impostor = encodeEnvelope("generation", {
    generationId: "gen-1",
    sourceVersion: { claude: 1 },
    provenance: provenance(),
    payload: { total: 66613 },
    publishedAt: "2026-01-31T00:00:00Z",
  });

  // Armed by `assertStagingIdentity`, which is the LAST filesystem call before the rename and
  // the only thing that lstats the staging path itself. Anchoring on that event rather than on
  // a call ordinal is the same correction made to `swapBeforeGuardOf`.
  let armed = false;
  const realLstat = fs.lstat.bind(fs);
  fs.lstat = (path) => {
    const result = realLstat(path);
    if (path === staging) armed = true;
    return result;
  };

  let swaps = 0;
  const inner = {
    assertHeld() {
      fs.calls.push({ op: "assertHeld", path: null, paths: [] });
      if (!armed || swaps > 0 || fs.files.has(target)) return;
      swaps += 1;
      fs.files.delete(staging);
      fs.put(staging, impostor);
    },
  };
  const authority = createWriteAuthority(inner, () => TERMINATED);
  startWriter(fs, authority, P);
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });

  assert.equal(swaps, 1, "the swap must have happened exactly once");

  // The publish SUCCEEDS and publishes the impostor, and that IS the finding: a filesystem
  // change made from inside the final assertion lands after every check. This test does not
  // assert the store catches it, because it cannot — `rename(2)` takes two pathnames and
  // nothing short of `renameat` against held directory descriptors can bind either end. The
  // day that becomes available, this is the case that starts failing and gets tightened.
  const served = readSnapshot(fs, P);
  assert.equal(served.view.generation.generationId, "gen-1");
  assert.equal(
    served.view.generation.payload.total,
    66613,
    "the residual: the swapped-in artifact is what got published",
  );
  assert.equal(fs.files.get(target).data, impostor, "byte-for-byte the impostor");

  // And the sequence is pinned, so the ordering cannot be quietly rearranged: EXACTLY one
  // authority assertion sits between the last filesystem check and the rename. Filtering
  // `assertHeld` out of this comparison — which the previous version did — accepted zero
  // assertions just as happily as one, and zero is an AC 8 violation.
  const ops = fs.calls.map((c) => c.op);
  // The GENERATION's commit, which is the first rename in the trace — the manifest commit
  // follows it and would otherwise be the one `lastIndexOf` found.
  const renameAt = ops.indexOf("rename");
  assert.ok(renameAt > 0, "there must be a rename");
  const lastLstat = ops.lastIndexOf("lstat", renameAt);
  assert.ok(lastLstat >= 0 && lastLstat < renameAt, "a check must precede the rename");
  assert.deepEqual(
    ops.slice(lastLstat + 1, renameAt),
    ["assertHeld"],
    "exactly one authority assertion may sit between the last filesystem check and the rename",
  );
});

test("authority: a FORGED brand is refused by every store entry point", () => {
  // `instanceof` is not a brand. It walks a prototype chain, and anyone can put a prototype on
  // an object — so this passes `instanceof LatchingWriteAuthority` while having no private
  // field, no inner authority, no terminal-action contract, and an own `assertHeld` that
  // shadows the real one and latches nothing. `Symbol.hasInstance` can be redefined on the
  // exported constructor besides. Membership in a module-private WeakSet is what cannot be
  // forged: the only way in is through the constructor.
  const forged = Object.create(LatchingWriteAuthority.prototype);
  let asserted = 0;
  // `defineProperty`, not assignment: the prototype is frozen now, so `forged.assertHeld = fn`
  // throws in strict mode before the forgery is even built. That is a stronger outcome and it
  // is asserted separately below — but it would also make this test vacuous, because a forgery
  // that cannot be constructed proves nothing about what the entry points refuse. So the
  // forgery is built the way an attacker who read the error message would build it.
  Object.defineProperty(forged, "assertHeld", {
    value: () => { asserted += 1; },
    writable: true,
    configurable: true,
  });
  assert.ok(forged instanceof LatchingWriteAuthority, "the forgery must actually pass instanceof");

  const { fs } = freshStore();
  const entryPoints = [
    ["startWriter", () => startWriter(fs, forged, P)],
    ["publishSnapshot", () => publishSnapshot(fs, forged, P, candidate("gen-1", { claude: 1 }), { live: null })],
    ["resetStore", () => resetStore(fs, forged, P)],
    ["collectGarbage", () => collectGarbage(fs, forged, P, "2026-02-01T00:00:00Z")],
    ["createPin", () => createPin(fs, forged, P, { pinId: "p", generationId: "g", until: "2099-01-01T00:00:00Z" })],
  ];
  for (const [name, call] of entryPoints) {
    assert.throws(call, (err) => {
      assert.equal(err.name, "AuthorityHandlerContractError", name);
      return true;
    }, name);
  }
  assert.equal(asserted, 0, "the forgery's assertHeld was called — it got past the gate");
  assert.deepEqual(fs.mutations(), [], "a forged authority must not reach the filesystem");
});

test("authority: a genuine guard cannot have its assertHeld shadowed", () => {
  // The WeakSet proves the constructor ran. It says NOTHING about which function the store
  // ends up calling, and the store calls `authority.assertHeld()` — an ordinary dynamic
  // dispatch that an own property shadows. So a caller holding a genuine guard could disable
  // the latch on it and keep every check in this module answering yes.
  const { fs } = freshStore();
  const authority = new FakeAuthority(fs);

  assert.throws(
    () => {
      authority.assertHeld = () => {};
    },
    TypeError,
    "assignment must be refused, not silently ignored",
  );
  assert.throws(
    () => Object.defineProperty(authority, "assertHeld", { value: () => {} }),
    TypeError,
    "defineProperty must be refused too — assignment is not the only way to shadow",
  );
  assert.throws(
    () => Object.setPrototypeOf(authority, { assertHeld: () => {} }),
    TypeError,
    "swapping the prototype must be refused",
  );
  assert.ok(Object.isFrozen(authority));

  // ...and the latch still latches, because private fields are not properties and freezing
  // does not reach them. Without this the test would pass just as well against an authority
  // frozen into uselessness.
  FakeAuthority.revoke(authority);
  assert.throws(() => authority.assertHeld(), /lost/i);
  assert.equal(authority.lost, true);
});

/**
 * Runs `body` with the named globals replaced, and puts them back whatever happens.
 *
 * The window is kept to a single call on purpose: these are intrinsics the runtime and the test
 * framework use too, so `assert` and the TAP writer must never run while one is a no-op. Every
 * assertion below is made AFTER the restore, on a value captured inside.
 */
function withPatchedIntrinsics(patches, body) {
  const saved = patches.map(([holder, key]) => [holder, key, holder[key]]);
  try {
    for (const [holder, key, replacement] of patches) holder[key] = replacement;
    return body();
  } finally {
    for (const [holder, key, original] of saved) holder[key] = original;
  }
}

test("authority: patching WeakSet.prototype.has does not let a forgery into GUARDED", () => {
  // The collection is module-private and cannot be forged — which is exactly what made this
  // look closed for ten review rounds. The METHOD used to interrogate it was an ordinary
  // inherited property of a global prototype, re-read on every check, so
  // `WeakSet.prototype.has = () => true` after import made `assertGuardedAuthority` accept an
  // object that never entered the set. With an own no-op `assertHeld`, the right prototype and
  // a freeze, every remaining check answered yes and store mutations ran behind a gate that
  // asserts nothing. Fourth form of one defect: a value proven at one point, re-read at another.
  const forged = Object.create(LatchingWriteAuthority.prototype);
  let asserted = 0;
  Object.defineProperty(forged, "assertHeld", {
    value: () => { asserted += 1; },
    writable: true,
    configurable: true,
  });
  Object.freeze(forged);
  const { fs } = freshStore();
  fs.calls.length = 0;

  const thrown = withPatchedIntrinsics(
    [[WeakSet.prototype, "has", () => true]],
    () => {
      try {
        startWriter(fs, forged, P);
        return null;
      } catch (err) {
        return err;
      }
    },
  );

  // THE PATCH WAS LOAD-BEARING, asserted rather than assumed: a bare `WeakSet` must now answer
  // yes for an object it has never seen, or this test would pass against a build with no
  // pinning at all.
  const proof = withPatchedIntrinsics(
    [[WeakSet.prototype, "has", () => true]],
    () => new WeakSet().has(forged),
  );
  assert.equal(proof, true, "the patch must actually subvert an unpinned membership test");

  assert.notEqual(thrown, null, "the forgery got past the gate");
  assert.equal(thrown.name, "AuthorityHandlerContractError");
  assert.equal(asserted, 0, "the forgery's assertHeld ran");
  assert.deepEqual(fs.mutations(), [], "a forged authority must not reach the filesystem");
});

test("authority: patching Object.freeze does not leave a genuine guard shadowable", () => {
  // `Object.freeze(this)` in the constructor is what stops an own `assertHeld` shadowing the
  // real one on an authority that IS in GUARDED and DOES have the right prototype — so with
  // `Object.freeze` read dynamically, a caller could neuter it, take a genuine guard, and
  // disable the latch on it while every check in the module kept answering yes. Patching
  // `Object.isFrozen` alongside is what closes the other half: the runtime check would
  // otherwise catch the unfrozen object.
  const { fs } = freshStore();
  const authority = withPatchedIntrinsics(
    [
      [Object, "freeze", (o) => o],
      [Object, "isFrozen", () => true],
    ],
    () => new FakeAuthority(fs),
  );

  // Frozen for real, by the intrinsic captured at load rather than the one in scope at
  // construction. Checked with the restored `Object.isFrozen`, so the answer is not the patch's.
  assert.equal(Object.isFrozen(authority), true, "the constructor's freeze did not happen");
  assert.throws(() => { authority.assertHeld = () => {}; }, TypeError);
  // And it is still a usable authority afterwards, not merely an inert frozen object.
  assert.doesNotThrow(() => startWriter(fs, authority, P));
});

test("errors: patching WeakMap.prototype.get does not unclassify a seam failure", () => {
  // Every seam failure this module set raises is classified by IDENTITY in a module-private
  // WeakMap, and `snapshotFsErrorKind` read `get` off `WeakMap.prototype` on every lookup. With
  // it replaced, every classified failure reads as "not ours" — so `readStoreFile`'s symlink,
  // too-large and invalid-content branches all fall through to the rethrow, and a store that
  // should reset CRASHES the caller instead. The same read also decides whether publish treats
  // an unreadable live manifest as absent and commits over it.
  const { fs } = publishedStore();
  fs.nodes.delete(P.manifest);
  fs.symlink(P.manifest, "/elsewhere.json");

  const classified = withPatchedIntrinsics(
    [[WeakMap.prototype, "get", () => undefined]],
    () => classifyStore(fs, P),
  );

  const proof = withPatchedIntrinsics(
    [[WeakMap.prototype, "get", () => undefined]],
    () => new WeakMap([[P, 1]]).get(P),
  );
  assert.equal(proof, undefined, "the patch must actually subvert an unpinned lookup");

  assert.equal(classified.status, "not-usable");
  assert.equal(classified.reason ?? classified.error.reason, "artifact-not-a-regular-file");
});

test("pollution: a polluted Object.prototype.value cannot turn an accessor into a data field", () => {
  // NO ATTACKER REQUIRED, which is what separates this from the rest of round 12's findings.
  // `getOwnPropertyDescriptor` returns an ordinary object that inherits from `Object.prototype`,
  // so `"value" in descriptor` — the shape every descriptor check in this module set used —
  // answers TRUE for an accessor-only descriptor the moment any library in the process writes
  // `Object.prototype.value`. Prototype pollution is usually an accident, and the consequence
  // here is not: the caller then reads `descriptor.value`, receives the INHERITED value, and
  // concludes it read a data property without running a getter. If the polluted value is itself
  // an accessor, it also runs foreign code inside the boundary that promises to run none.
  const hostile = {};
  let getterCalls = 0;
  Object.defineProperty(hostile, "code", {
    get() { getterCalls += 1; return "ENOENT"; },
    configurable: true,
  });

  const saved = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  let kind;
  try {
    Object.defineProperty(Object.prototype, "value", {
      value: "ENOENT",
      writable: true,
      configurable: true,
    });
    // The premise: an unpinned check really is fooled by this.
    assert.equal("value" in Object.getOwnPropertyDescriptor(hostile, "code"), true,
      "the pollution must actually make an accessor descriptor look like a data one");
    kind = snapshotFsErrorKind(classifyFsError("openRead", "/x", hostile));
  } finally {
    if (saved) Object.defineProperty(Object.prototype, "value", saved);
    else delete Object.prototype.value;
  }

  // An accessor at `.code` carries no errno this boundary may read, so the verdict is `other` —
  // NOT `not-found`, which is what the inherited "ENOENT" would have produced, and which would
  // have let publish treat an unreadable live manifest as absent and commit over it.
  assert.equal(kind, "other");
  assert.equal(getterCalls, 0, "the accessor must never be invoked");
});

test("pollution: a polluted Error.prototype cannot swallow or hijack a tagged error", () => {
  // `this.name = "SnapshotPathError"` and `err.code = "EILSEQ"` are ordinary assignments, so
  // they consult the prototype chain for a setter — and `Error.prototype` is writable. A setter
  // that SWALLOWS leaves an fs error with no own `code`, which classifies as `other` instead of
  // `invalid-content`, so a corrupt artifact propagates where it should reset the cache. A
  // setter that THROWS replaces the store's own error with an arbitrary value that every catch
  // in the module fails to recognise. Both are now impossible: the properties are DEFINED.
  const savedName = Object.getOwnPropertyDescriptor(Error.prototype, "name");
  let built = null;
  let thrown = null;
  try {
    Object.defineProperty(Error.prototype, "name", {
      set() { throw new Error("hijacked"); },
      get() { return "hijacked"; },
      configurable: true,
    });
    try {
      built = new SnapshotPathError("a path failure during pollution");
    } catch (err) {
      thrown = err;
    }
  } finally {
    if (savedName) Object.defineProperty(Error.prototype, "name", savedName);
    else delete Error.prototype.name;
  }

  assert.equal(thrown, null, "the constructor must not be hijacked by an inherited setter");
  assert.equal(built.name, "SnapshotPathError");
  assert.equal(snapshotErrorTag(built), "SnapshotPathError", "and it must still be TAGGED");
});

test("authority: a SUBCLASS cannot register itself as a guarded authority", () => {
  // The constructor is where GUARDED membership is granted, and a subclass runs it. So
  // `class Bypass extends LatchingWriteAuthority { assertHeld() {} }` produced an object the
  // WeakSet vouched for, whose own override shadowed the real method: no inner check, no
  // latch, no terminal-action contract. Refused at construction — before anything holds a
  // reference to it — rather than at the entry point, so there is no window in which a
  // half-built bypass exists.
  class Bypass extends LatchingWriteAuthority {
    assertHeld() {}
  }
  assert.throws(
    () => new Bypass({ assertHeld() {} }, () => TERMINATED),
    (err) => {
      assert.equal(err.name, "AuthorityHandlerContractError");
      assert.match(err.message, /subclass/i);
      return true;
    },
  );
});

test("identity: a replacement on another device with the same inode is refused", () => {
  // `(dev, ino)` together, because an inode number is only unique within a device. Every node
  // in the fake shared one device until this round, so an implementation comparing `ino` alone
  // passed every identity test in the suite.
  const { fs, authority } = freshStore();
  startWriter(fs, authority, P);
  const staging = stagingPath(P, "generation");

  let swapped = false;
  fs.hooks.set("close", () => {
    if (swapped || !fs.files.has(staging)) return;
    swapped = true;
    const original = fs.nodes.get(staging);
    const ino = original.ino;
    fs.files.delete(staging);
    fs.put(staging, encodeEnvelope("generation", {
      generationId: "gen-1",
      sourceVersion: { claude: 999 },
      provenance: provenance(),
      payload: { total: 1 },
      publishedAt: "2026-01-31T00:00:00Z",
    }));
    // SAME inode number, DIFFERENT device. Only the pair distinguishes it.
    fs.setIdentity(staging, { dev: 99n, ino });
  });

  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null }),
    /was replaced between staging and commit/,
  );
  fs.clearHooks();
  assert.equal(swapped, true);
  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), false);
});

test("identity: two inodes that collide as doubles are still distinguished", () => {
  // The migration to bigint is only falsifiable against a PAIR that actually collides once
  // converted. Merely starting the counter above 2^53 does not do it: Number(2^53+1) and
  // Number(2^53+2) are different doubles, so an allocation-order accident could let a
  // Number-based comparison keep passing.
  // Above 2^54 the gap between representable doubles is 4, so these two adjacent integers
  // BOTH round to 18014398509481984. Real inodes reach this range on 64-bit filesystems.
  const a = 18014398509481985n; // 2^54 + 1
  const b = 18014398509481986n; // 2^54 + 2
  assert.notEqual(a, b, "the fixture needs two DIFFERENT inodes");
  assert.equal(Number(a), Number(b), "...that collide as doubles — otherwise this proves nothing");

  const { fs, authority } = freshStore();
  startWriter(fs, authority, P);
  const staging = stagingPath(P, "generation");

  // Pinned at the `fstat` the commit actually captures, rather than at whatever call happens
  // to precede it. Hooking `fchmod` worked only because `fchmod` currently runs immediately
  // before that `fstat` — the same positional dependency that made `swapAtNthLstat` wrong, and
  // reintroducing it here would mean a reordering silently retargets this fixture. Wrapping
  // `fstat` sets the identity on the descriptor's own node in the instant before the value is
  // read, which is the thing this test needs to control.
  let observed = null;
  const realFstat = fs.fstat.bind(fs);
  fs.fstat = (handle) => {
    const node = fs.entryFor(handle)?.node;
    if (node && observed === null && fs.files.has(staging)) {
      fs.setIdentity(staging, { ino: a });
    }
    const stat = realFstat(handle);
    if (observed === null) observed = stat;
    return stat;
  };

  // ...and the replacement, after the close, gets `b`.
  let swapped = false;
  fs.hooks.set("close", () => {
    if (swapped || !fs.files.has(staging)) return;
    swapped = true;
    const bytes = fs.files.get(staging).data;
    fs.files.delete(staging);
    fs.put(staging, bytes);
    fs.setIdentity(staging, { ino: b });
  });

  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null }),
    /was replaced between staging and commit/,
  );
  fs.clearHooks();
  assert.equal(swapped, true, "the replacement must actually have happened");
  // The captured descriptor identity really was `a`, so the comparison the commit performs is
  // between `a` and `b` — the colliding pair — rather than between two values that happened to
  // differ for some other reason.
  assert.equal(observed?.ino, a, "the commit must have captured the pinned inode");
  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), false);
});

test("classify: a manifest that is present but not ours is not-usable, never first-run", () => {
  // The distinction this exists for: ABSENT may legitimately mean first-run, but a symlink at
  // that name cannot mean anything of the sort. Collapsing the two would classify a store
  // whose manifest had been replaced by a link as brand-new, and then let the first-run path
  // build on top of whatever else was sitting there.
  for (const [label, corrupt] of [
    ["a symlink", (fs) => { fs.files.delete(P.manifest); fs.symlink(P.manifest, "/elsewhere.json"); }],
    ["a directory", (fs) => { fs.files.delete(P.manifest); fs.mkdirp(P.manifest, 0o700); }],
    ["the wrong mode", (fs) => fs.chmodDirect(P.manifest, 0o644)],
  ]) {
    const { fs, authority } = publishedStore();
    // Strip the artifacts too, so "first-run" is the answer a naive absent-check would give.
    for (const key of fs.files.keys()) {
      if (key.startsWith(`${P.generationsDir}/`)) fs.files.delete(key);
    }
    corrupt(fs);

    const classified = classifyStore(fs, P);
    assert.equal(classified.status, "not-usable", label);
    assert.match(classified.error.detail, /manifest\.json/, label);
    // And it converges: reset, then a genuine first-run.
    resetStore(fs, authority, P);
    startWriter(fs, new FakeAuthority(fs), P);
    assert.equal(classifyStore(fs, P).status, "first-run", label);
  }
});

test("the WRITER refuses the ambiguous instants the reader refuses", () => {
  // Tightening only the reader would have moved the failure rather than fixed it: a generation
  // published with `2026-01-01T00:00:00` (LOCAL time per spec, so a different instant on every
  // machine) would pass validation and then throw out of `deriveFreshness` at QUERY time, in a
  // caller with no idea why, about a document accepted days earlier. The rule belongs at the
  // point of acceptance, exactly like the IANA timezone check beside it.
  const { fs, authority } = freshStore();
  startWriter(fs, authority, P);
  const bad = "2026-01-01T00:00:00"; // no Z, no offset

  const cases = [
    ["coverage", { coverage: [{ start: bad, end: "2026-02-01T00:00:00Z" }] }],
    ["fieldCoverage", { fieldCoverage: { cost: [{ start: bad, end: "2026-02-01T00:00:00Z" }] } }],
    ["sourceTimestamps", { sourceTimestamps: { claude: bad } }],
    ["ccusageInvokedAt", { ccusageInvokedAt: bad }],
  ];
  for (const [label, overrides] of cases) {
    assert.throws(
      () =>
        publishSnapshot(
          fs,
          authority,
          P,
          { ...candidate("gen-1", { claude: 1 }), provenance: provenance(overrides) },
          { live: null },
        ),
      (err) => {
        assert.equal(err.reason, "generation-invariants", label);
        assert.match(err.detail, /explicit UTC offset/, label);
        return true;
      },
      label,
    );
  }
  assert.throws(
    () =>
      publishSnapshot(
        fs, authority, P,
        { ...candidate("gen-1", { claude: 1 }), publishedAt: bad },
        { live: null },
      ),
    /publishedAt is not an instant with an explicit UTC offset/,
  );
  assert.deepEqual(fs.mutations(), [], "nothing ambiguous may reach the filesystem");

  // Pins and the sweep clock decide EXPIRY by arithmetic, so they get the same rule.
  publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null });
  assert.throws(
    () => createPin(fs, authority, P, { pinId: "pin-1", generationId: "gen-1", until: bad }),
    /until is not an instant with an explicit UTC offset/,
  );
  assert.throws(
    () => collectGarbage(fs, authority, P, bad),
    /explicit UTC offset/,
  );
});

test("validation never READS a hostile document: canonicalization comes first", () => {
  // Every `assert*Invariants` function reaches into caller data — `g["provenance"]`,
  // `Object.entries(sourceTimestamps)` — and each of those is an ordinary property read that
  // runs an accessor or a Proxy trap. Validation is the worst possible place for that: it is
  // the step deciding whether the value is acceptable, so code running inside it can watch the
  // checks happen or return a different value to the check than to the use.
  //
  // The fix is ordering, so this test is about ordering: the trap must never fire.
  let reads = 0;
  const provenanceWithGetter = {};
  Object.defineProperty(provenanceWithGetter, "coverage", {
    enumerable: true,
    get() {
      reads += 1;
      return [];
    },
  });

  const { fs, authority } = freshStore();
  startWriter(fs, authority, P);
  assert.throws(
    () =>
      publishSnapshot(
        fs,
        authority,
        P,
        { ...candidate("gen-1", { claude: 1 }), provenance: provenanceWithGetter },
        { live: null },
      ),
    (err) => {
      assert.equal(err.reason, "generation-invariants");
      assert.match(err.detail, /not canonicalizable/);
      // The SPECIFIC reason now travels as an opaque cause rather than being interpolated into
      // the detail. That is the module-set rule — a caught value is never read — and it is
      // asserted here rather than merely tolerated, because a cause that is dropped instead of
      // carried leaves an operator with "not canonicalizable" and no account of which field or
      // why. Reading `.message` off it is this TEST inspecting the chain, not the store.
      assert.match(err.cause.message, /accessor/);
      return true;
    },
  );
  assert.equal(reads, 0, "the getter ran — validation read the document before proving it inert");
  assert.deepEqual(fs.mutations(), [], "nothing may reach the filesystem");

  // A Proxy is refused on identity, before any trap can run at all.
  let trapped = 0;
  const hostile = new Proxy(
    { coverage: [], fieldCoverage: {}, sourceTimestamps: {}, refreshTier: "slow",
      ccusageVersion: "1", ccusageInvokedAt: "2026-01-31T00:00:00Z",
      timezone: "UTC", dayBoundaryPolicy: "local-midnight" },
    { get(t, k) { trapped += 1; return Reflect.get(t, k); } },
  );
  assert.throws(
    () =>
      publishSnapshot(
        fs,
        authority,
        P,
        { ...candidate("gen-1", { claude: 1 }), provenance: hostile },
        { live: null },
      ),
    (err) => {
      // The refusal names the document; WHY it was refused rides along as the cause, on the
      // same rule as the accessor row above. Matching /Proxy/ against the top-level message
      // stopped working when the caught value stopped being interpolated into it — the
      // information did not disappear, it moved to where a caught value is allowed to live.
      assert.match(err.message, /not canonicalizable/);
      assert.match(err.cause.message, /Proxy/);
      return true;
    },
  );
  assert.equal(trapped, 0, "a Proxy trap ran during validation");
});

test("reset: a directory swapped BETWEEN children stops the traversal", () => {
  // The identity re-check closed the lstat-to-listDir interval. It did not close
  // listDir-to-descend: each child is addressed as `dir/child`, a fresh path resolution
  // through this prefix, so a swap landing after child 1 sends children 2..n somewhere else.
  // Checking once before the loop proved the prefix for the first child and vouched, wrongly,
  // for every one after it.
  const { fs, authority } = freshStore();
  startWriter(fs, authority, P);
  const junk = `${P.root}/junk`;
  fs.mkdirp(junk, 0o700);
  for (const name of ["a", "b", "c", "d"]) fs.put(`${junk}/${name}`, "residue");

  // A different REAL 0700 directory, holding files the reset has no business touching.
  fs.mkdirp("/victim", 0o700);
  for (const name of ["a", "b", "c", "d"]) fs.put(`/victim/${name}`, "not ours");

  let unlinks = 0;
  fs.hooks.set("unlink", (path) => {
    if (!path.startsWith(`${junk}/`)) return;
    unlinks += 1;
    if (unlinks !== 1) return;
    fs.renameDirect(junk, "/parked");
    fs.renameDirect("/victim", junk);
  });
  const reset = resetStore(fs, authority, P);
  fs.clearHooks();

  // THE RACE WINDOW WAS ENTERED. Without this the test could pass by never getting there:
  // a reset that skipped the unknown `junk/` subtree altogether unlinks nothing, so the hook
  // never fires, the swap never happens, all four names stay at `junk` — and a survivor COUNT
  // is satisfied by the four originals just as well as by the three that matter.
  assert.equal(unlinks, 1, "exactly one child unlink must have been attempted");
  assert.equal(fs.files.has("/parked/a"), true, "the swap must have moved the real junk/ aside");
  assert.equal(fs.files.get(`${junk}/b`)?.data, "not ours", "the substitute must occupy junk/ now");

  // And the reset SAYS it could not finish there, rather than reporting a clean sweep over a
  // directory it stopped trusting.
  assert.deepEqual(reset.failed, [junk], "the swapped subtree must be reported as failed");
  assert.deepEqual(reset.removed, [`${junk}/a`], "only the child already in flight was removed");

  // EXACTLY which names survive, and exactly which one does not.
  //
  // `survivors.length >= 3` was satisfied by the correct behaviour and reported nothing about
  // it. The residual here is real and worth stating outright: the hook fires BEFORE the
  // unlink, so the swap lands between the prefix check and the syscall for child `a` — that
  // one unlink resolves through the substitute and deletes the VICTIM's `a`. That is the
  // irreducible path-resolution race, the same one `renameat` would be needed to close.
  // Everything after it is refused, which is the property under test.
  const survivors = ["a", "b", "c", "d"].filter((n) => fs.files.has(`${junk}/${n}`));
  assert.deepEqual(
    survivors,
    ["b", "c", "d"],
    `only the child already in flight may be lost; got ${survivors}`,
  );
  // And the traversal STOPPED rather than carrying on against the directory it had proved:
  // the real junk tree, now parked elsewhere, still holds every one of its own children. A
  // reset that kept going on the old inode would have emptied it.
  assert.deepEqual(
    ["a", "b", "c", "d"].filter((n) => fs.files.has(`/parked/${n}`)),
    ["a", "b", "c", "d"],
    "the traversal must stop at the swap, not continue against the directory it proved",
  );
});

test("publish refuses a payload that cannot be canonicalized, before staging anything", () => {
  const { fs, authority } = freshStore();
  const cyclic = { total: 1 };
  cyclic.self = cyclic;
  fs.calls.length = 0;
  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }, { payload: cyclic }), { live: null }),
    (err) => err.reason === "generation-invariants" && /canonicalizable/.test(err.detail),
  );
  assert.deepEqual(fs.mutations(), [], "a non-canonicalizable payload must not reach staging");
});

test("envelope: an extra envelope field is refused — the checksum does not cover it", () => {
  const { fs } = publishedStore();
  const envelope = JSON.parse(fs.files.get(P.manifest).data);
  // The body and its checksum are untouched and valid; only an unauthenticated extra field
  // rides alongside. Under the one rule, a field the protocol does not define is exactly the
  // "unsupported or ambiguous" state that resets.
  fs.put(P.manifest, JSON.stringify({ ...envelope, injected: "not covered by the checksum" }));
  assert.equal(classifyStore(fs, P).status, "not-usable");
  assert.equal(classifyStore(fs, P).error.reason, "manifest-unparsable");
  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
});

test("generation: interval and timezone values are validated, not just their types", () => {
  const bad = [
    ["an unparseable coverage bound", { coverage: [{ start: "whenever", end: "2026-02-01" }] }],
    ["an inverted coverage interval", { coverage: [{ start: "2026-02-01", end: "2026-01-01" }] }],
    ["an unparseable field bound", { fieldCoverage: { cost: [{ start: "x", end: "2026-02-01" }] } }],
    ["an unknown IANA timezone", { timezone: "Mars/Olympus" }],
    ["an unparseable source timestamp", { sourceTimestamps: { claude: "recently" } }],
    ["an unparseable ccusageInvokedAt", { ccusageInvokedAt: "just now" }],
  ];
  for (const [label, overrides] of bad) {
    const { fs, authority } = freshStore();
    assert.throws(
      () =>
        publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }, {
          provenance: provenance(overrides),
        }), { live: null }),
      (err) => err.reason === "generation-invariants",
      label,
    );
  }
});

test("freshness: a field named __proto__ gets its own answer instead of corrupting the result", () => {
  // Built through JSON.parse: an object LITERAL with a `__proto__:` key sets the prototype
  // instead of creating an own property, so writing the fixture the obvious way would have
  // tested nothing. (JSON.parse defines it as an ordinary own key — which is exactly how such
  // a name reaches this code from a stored generation in the first place.)
  const prov = provenance({
    fieldCoverage: JSON.parse('{"__proto__": [{"start": "2026-01-01", "end": "2026-02-01"}]}'),
  });
  const answer = deriveFreshness(prov, {
    start: "2026-01-02",
    end: "2026-01-03",
    fields: ["__proto__", "constructor"],
  });
  // Plain assignment would have set the RESULT object's prototype and lost the answer.
  assert.equal(Object.hasOwn(answer.fields, "__proto__"), true);
  assert.equal(answer.fields.__proto__.covered, true);
  assert.equal(Object.hasOwn(answer.fields, "constructor"), true);
  assert.equal(answer.fields.constructor.covered, false);
});

test("freshness: the request's field list is validated", () => {
  assert.throws(
    () => deriveFreshness(provenance(), { start: "2026-01-01", end: "2026-01-02", fields: "cost" }),
    /fields is not an array/,
  );
  assert.throws(
    () => deriveFreshness(provenance(), { start: "2026-01-01", end: "2026-01-02", fields: [1] }),
    /fields holds a non-string/,
  );
  // A duplicate is harmless rather than a crash from defining the same key twice.
  const answer = deriveFreshness(provenance(), {
    start: "2026-01-01", end: "2026-01-02", fields: ["cost", "cost"],
  });
  assert.equal(answer.fields.cost.covered, true);
});

test("freshness: localDayBounds refuses dates and zones it cannot answer for", () => {
  // Date.UTC silently normalizes February 30 to March 2, so an unchecked call would return
  // confident bounds for a different day than the caller named.
  assert.throws(() => localDayBounds("America/Vancouver", { year: 2026, month: 2, day: 30 }), /not a real calendar date/);
  assert.throws(() => localDayBounds("America/Vancouver", { year: 2026, month: 13, day: 1 }), /month must be/);
  assert.throws(() => localDayBounds("Mars/Olympus", { year: 2026, month: 1, day: 1 }), /unknown timezone/);
  // (Those three are year-agnostic: February 30 is never a date and Mars/Olympus is never a
  // zone, so no tzdata rule can move them. The ZONE-BEHAVIOUR cases below all use completed
  // historical transitions, for the reason written above DST_SPRING — Havana's rules were
  // still pinned to a FUTURE November when the rest were moved back, which is the same
  // tzdata-hostage defect one file-section away from where it had just been fixed.)
  // EXISTENCE: Pacific/Apia skipped 2011-12-30 entirely when it crossed the date line, and
  // America/Havana transitions AT midnight, so 00:00 does not occur there on the spring day.
  assert.throws(() => localDayBounds("Pacific/Apia", { year: 2011, month: 12, day: 30 }), /no local midnight/);
  assert.throws(() => localDayBounds("America/Havana", DST_SPRING), /no local midnight/);

  // UNIQUENESS, which is a different question and used to go unasked. On Havana's autumn
  // transition the clock goes back AT midnight, so local midnight happens TWICE — an hour
  // apart — and both instants pass the existence check. The old code converged on whichever
  // side its refinement landed on and returned it silently, so the day's boundary depended on
  // an implementation detail and an hour of coverage went to whichever day it preferred.
  assert.throws(
    () => localDayBounds("America/Havana", DST_FALL),
    (err) => {
      assert.match(err.message, /ambiguous local midnight/);
      // Named explicitly: the two candidates are real and exactly one transition apart.
      assert.match(err.message, /2024-11-03T04:00:00\.000Z and 2024-11-03T05:00:00\.000Z/);
      return true;
    },
  );

  // EARLY YEARS, where `Date.UTC` remaps 0..99 to 1900..1999. Correcting the year AFTER
  // normalization was wrong in a way that looked right: year 0 is a leap year in the proleptic
  // Gregorian calendar but 1900 is not, so 0000-02-29 normalized to March 1st and was then
  // stamped back to year 0 — a real date reported as invalid. Rolling forward was worse:
  // 0099-12-31 + 1 day normalized into 2000 and the correction set the year back to 99.
  assert.deepEqual(localDayBounds("UTC", { year: 0, month: 2, day: 29 }), {
    start: "0000-02-29T00:00:00.000Z",
    end: "0000-03-01T00:00:00.000Z",
  });
  assert.deepEqual(localDayBounds("UTC", { year: 99, month: 12, day: 31 }), {
    start: "0099-12-31T00:00:00.000Z",
    end: "0100-01-01T00:00:00.000Z",
  });
  // 1900 really is not a leap year, so the remap cannot be "harmless".
  assert.throws(() => localDayBounds("UTC", { year: 1900, month: 2, day: 29 }), /not a real calendar date/);

  // The year range and the instant grammar agree: bounds this function returns can always be
  // fed back into deriveFreshness. A four-digit ceiling is what makes that true.
  assert.throws(() => localDayBounds("UTC", { year: 10000, month: 1, day: 1 }), /year must be/);
  assert.throws(() => localDayBounds("UTC", { year: -1, month: 1, day: 1 }), /year must be/);
  const early = localDayBounds("UTC", { year: 0, month: 2, day: 29 });
  assert.equal(
    deriveFreshness({ ...provenance(), timezone: "UTC" }, { start: early.start, end: early.end }).covered,
    false,
    "localDayBounds output must be acceptable to deriveFreshness",
  );

  // A zone whose transition is at 02:00 is unaffected by any of this: midnight is ordinary,
  // and the DAY is still short or long. This is the guard against over-refusing.
  assert.deepEqual(localDayBounds("America/Vancouver", DST_SPRING), {
    start: "2024-03-10T08:00:00.000Z",
    end: "2024-03-11T07:00:00.000Z",
  });
  assert.deepEqual(localDayBounds("America/Vancouver", DST_FALL), {
    start: "2024-11-03T07:00:00.000Z",
    end: "2024-11-04T08:00:00.000Z",
  });
});

test("freshness: an instant without an explicit offset is refused, not read as local time", () => {
  // `Date.parse("2026-01-01T00:00:00")` means LOCAL time per spec, so accepting it made the
  // freshness answer depend on the machine's timezone — the same provenance and the same
  // request producing different coverage in Vancouver and in CI.
  const p = provenance();
  for (const bad of ["2026-01-01T00:00:00", "2026-01-01 00:00:00", "January 1, 2026"]) {
    assert.throws(
      () => deriveFreshness(p, { start: bad, end: "2026-02-01T00:00:00Z" }),
      /explicit UTC offset/,
      bad,
    );
  }
  // Date-only IS unambiguous: the spec fixes it to UTC. So are explicit offsets.
  for (const good of ["2026-01-01", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00+00:00"]) {
    assert.equal(deriveFreshness(p, { start: good, end: "2026-01-15T00:00:00Z" }).covered, true, good);
  }
  // And the request's own types are checked, since this crosses an API boundary where
  // TypeScript is not present: `Date.parse` coerces an array to a valid instant.
  assert.throws(
    () => deriveFreshness(p, { start: ["2026-01-01"], end: "2026-02-01T00:00:00Z" }),
    /request.start is not a string/,
  );
  assert.throws(
    () => deriveFreshness(p, { start: "2026-01-01", end: "2026-02-01T00:00:00Z", timezone: 7 }),
    /timezone is not a string/,
  );
});

test("freshness: a timezone-mismatch answer does not share one mutable gaps array", () => {
  // Every field's `gaps` and the summary's `gaps` used to be the SAME array object, so a
  // caller who sorted or spliced one field's answer silently rewrote all the others. Nothing
  // in this module mutates them, which is precisely why the aliasing was invisible here and
  // would have surfaced in whoever consumed the result.
  const answer = deriveFreshness(provenance(), {
    start: "2026-01-01",
    end: "2026-02-01",
    fields: ["cost", "tokens"],
    timezone: "UTC",
  });
  assert.equal(answer.timezoneMismatch, true);
  assert.notEqual(answer.gaps, answer.fields.cost.gaps);
  assert.notEqual(answer.fields.cost.gaps, answer.fields.tokens.gaps);
  assert.deepEqual(answer.gaps, answer.fields.cost.gaps);
});

// ---------------------------------------------------------------------------------------
// Round 5 — findings from the fifth review round, each pinned by the case that produced it
// ---------------------------------------------------------------------------------------

test("paths: a relative stateDir is refused", () => {
  // The real adapter resolves a relative path against `process.cwd()`, which anything in the
  // process can change at any moment — so the same StorePaths value would name a different
  // directory before and after a chdir, and every "the prefix I proved is the prefix the
  // mutation resolves through" argument in the store would be about a path that had moved.
  // The fake refuses relative paths outright, so the divergence ALSO meant the suite was
  // exercising a shape production would have accepted. Same rule, both sides, one behaviour.
  for (const bad of ["state", "./state", "state/store", ""]) {
    assert.throws(() => storePaths(bad), SnapshotPathError, bad);
  }
  assert.equal(storePaths("/state").root, `/state/store-v${SCHEMA_VERSION}`);
});

test("classification: an over-long artifact filename is foreign, not an orphan generation", () => {
  // The read-side name check carried the character class and NOT the 128-byte length bound the
  // write side enforces, so a name `assertArtifactId` could never have produced was classified
  // as an ordinary unreferenced generation — which hands it to GC as collectable rather than
  // recognising the store as foreign and resetting.
  const { fs } = publishedStore();
  const overLong = `${"g".repeat(129)}.json`;
  fs.put(`${P.generationsDir}/${overLong}`, "irrelevant");

  const c = classifyStore(fs, P);
  assert.equal(c.status, "not-usable");
  assert.equal(c.error.reason, "unknown-entry");
  assert.match(c.error.detail, /naming rule/);

  // ...and the boundary itself is where the grammar says it is, not one either side of it.
  const { fs: fs2 } = publishedStore();
  fs2.put(`${P.generationsDir}/${"g".repeat(128)}.json`, "irrelevant");
  const c2 = classifyStore(fs2, P);
  assert.equal(c2.status, "usable");
  assert.deepEqual(c2.unreferencedGenerations, ["g".repeat(128)]);
});

test("size: an artifact larger than the limit is unusable, and the writer cannot create one", () => {
  // BOTH directions, and the symmetry is the finding rather than defence in depth. A
  // reader-only cap turns a legitimately oversized payload into a store that classifies
  // unusable, resets, rebuilds the identical file and resets again — the non-convergent wedge
  // a directory at manifest.json already produced once in this ticket.
  const { fs, authority } = freshStore();
  const huge = "a".repeat(MAX_ARTIFACT_BYTES + 1024);
  assert.throws(
    () =>
      publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }, { payload: huge }), {
        live: null,
      }),
    (err) => {
      assert.equal(err.name, "SnapshotArtifactTooLargeError");
      assert.ok(err.bytes > MAX_ARTIFACT_BYTES);
      return true;
    },
  );
  // Refused BEFORE anything was staged: no descriptor, no bytes, no residue.
  assert.deepEqual(fs.mutations(), []);
  assert.deepEqual(fs.listDir(P.stagingDir), []);
});

test("size: a too-large read is one more unusable artifact, not an I/O failure", () => {
  // The seam reports it as EFBIG, classified at the boundary like every other errno, and the
  // store's disposition for it is the same as a wrong mode or a symlink at that name.
  const { fs } = publishedStore();
  fs.failOn("readAll", "manifest.json", errno("EFBIG", "read exceeded"));

  const c = classifyStore(fs, P);
  assert.equal(c.status, "not-usable");
  assert.equal(c.error.reason, "artifact-too-large");
  fs.clearHooks();

  // And a reader treats it as no snapshot rather than propagating it as a disk fault.
  const { fs: fs2 } = publishedStore();
  fs2.failOn("readAll", "manifest.json", errno("EFBIG", "read exceeded"));
  assert.equal(readSnapshot(fs2, P).status, "no-snapshot");
});

test("documents: an EXTRA field is refused on every fixed-shape document", () => {
  // `decodeEnvelope` already applies the exact-key rule to the envelope; the documents inside
  // were accepting supersets. A field this protocol does not define is verbatim the
  // "unsupported or ambiguous" state the one rule resets on — and tolerating extras is how a
  // document written by a newer build gets read by an older one as though the parts it
  // recognises were the whole story, which is what version-scoping the directory exists to
  // prevent, undone one field at a time.
  const cases = [
    [
      "manifest",
      () =>
        assertManifestInvariants(
          {
            activeGenerationId: "gen-1",
            retainedGenerationIds: ["gen-1"],
            publishedAt: "2026-01-31T00:00:00Z",
            sourceVersion: { claude: 1 },
            surprise: 1,
          },
          P.manifest,
        ),
    ],
    [
      "generation",
      () =>
        assertGenerationInvariants(
          {
            generationId: "gen-1",
            publishedAt: "2026-01-31T00:00:00Z",
            sourceVersion: { claude: 1 },
            provenance: provenance(),
            payload: {},
            surprise: 1,
          },
          `${P.generationsDir}/gen-1.json`,
          "gen-1",
        ),
    ],
    [
      "provenance",
      () =>
        assertGenerationInvariants(
          {
            generationId: "gen-1",
            publishedAt: "2026-01-31T00:00:00Z",
            sourceVersion: { claude: 1 },
            provenance: provenance({ surprise: 1 }),
            payload: {},
          },
          `${P.generationsDir}/gen-1.json`,
          "gen-1",
        ),
    ],
    [
      "coverage interval",
      () =>
        assertGenerationInvariants(
          {
            generationId: "gen-1",
            publishedAt: "2026-01-31T00:00:00Z",
            sourceVersion: { claude: 1 },
            provenance: provenance({
              coverage: [{ start: "2026-01-01", end: "2026-02-01", surprise: 1 }],
            }),
            payload: {},
          },
          `${P.generationsDir}/gen-1.json`,
          "gen-1",
        ),
    ],
    [
      "pin",
      () =>
        assertPinInvariants(
          {
            pinId: "p1",
            generationId: "gen-1",
            until: "2099-01-01T00:00:00Z",
            surprise: 1,
          },
          `${P.pinsDir}/p1.json`,
          "p1",
        ),
    ],
  ];
  for (const [what, run] of cases) {
    assert.throws(
      run,
      (err) => {
        assert.equal(err.name, "SnapshotStoreResetError", what);
        assert.match(err.detail, /expected exactly/, what);
        return true;
      },
      what,
    );
  }

  // The payload stays open-ended — it is caller data, and closing it would be a different
  // product decision, not a safety one.
  assertGenerationInvariants(
    {
      generationId: "gen-1",
      publishedAt: "2026-01-31T00:00:00Z",
      sourceVersion: { claude: 1 },
      provenance: provenance(),
      payload: { anything: { at: ["all"] } },
    },
    `${P.generationsDir}/gen-1.json`,
    "gen-1",
  );
});

test("documents: the extra-field rule is enforced on the paths that actually read documents", () => {
  // The matrix above calls the validators DIRECTLY, which proves only that those functions
  // reject supersets — not that classification, the reader, publish, createPin and GC ever
  // invoke them. A validator nobody calls passes its own unit test forever while every
  // production path accepts the document it was written to refuse. So each path is exercised
  // here with a document that is otherwise entirely valid: canonical bytes, correct checksum,
  // correct id, correct mode. The extra field is the only defect.

  // 1. A manifest with an extra field: classification and the reader.
  {
    const { fs } = publishedStore();
    const body = JSON.parse(fs.files.get(P.manifest).data).body;
    fs.put(P.manifest, encodeEnvelope("manifest", { ...body, surprise: 1 }));
    const c = classifyStore(fs, P);
    assert.equal(c.status, "not-usable", "classification must refuse an extra manifest field");
    assert.equal(c.error.reason, "manifest-invariants");
    assert.equal(readSnapshot(fs, P).status, "no-snapshot", "and the reader must not serve it");
  }

  // 2. A generation with an extra field, referenced by a valid manifest.
  {
    const { fs } = publishedStore();
    const path = `${P.generationsDir}/gen-1.json`;
    const body = JSON.parse(fs.files.get(path).data).body;
    fs.put(path, encodeEnvelope("generation", { ...body, surprise: 1 }));
    const c = classifyStore(fs, P);
    assert.equal(c.status, "not-usable", "classification must refuse an extra generation field");
    assert.equal(c.error.reason, "generation-invariants");
    assert.equal(readSnapshot(fs, P).status, "no-snapshot");
  }

  // 3. An extra field nested in PROVENANCE, which a top-level key set cannot see.
  {
    const { fs } = publishedStore();
    const path = `${P.generationsDir}/gen-1.json`;
    const body = JSON.parse(fs.files.get(path).data).body;
    fs.put(path, encodeEnvelope("generation", {
      ...body,
      provenance: { ...body.provenance, surprise: 1 },
    }));
    assert.equal(classifyStore(fs, P).error.reason, "generation-invariants");
    assert.equal(readSnapshot(fs, P).status, "no-snapshot");
  }

  // 4. PUBLISH refuses an extra field on its own candidate, before staging anything.
  {
    const { fs, authority } = freshStore();
    fs.calls.length = 0;
    assert.throws(
      () =>
        publishSnapshot(fs, authority, P, { ...candidate("gen-1", { claude: 1 }), surprise: 1 }, {
          live: null,
        }),
      (err) => {
        assert.equal(err.reason, "generation-invariants");
        assert.match(err.detail, /expected exactly/);
        return true;
      },
    );
    assert.deepEqual(fs.mutations(), [], "nothing may reach the filesystem");
  }

  // 5. createPin refuses one too.
  {
    const { fs, authority } = publishedStore();
    fs.calls.length = 0;
    assert.throws(
      () =>
        createPin(fs, authority, P, {
          pinId: "p1", generationId: "gen-1", until: "2099-01-01T00:00:00Z", surprise: 1,
        }),
      (err) => {
        assert.match(err.detail, /expected exactly/);
        return true;
      },
    );
    assert.deepEqual(fs.mutations(), []);
  }

  // 6. GC treats an extra-field PIN as unusable and collects it, rather than honouring it.
  {
    const { fs, authority, manifest } = publishedStore();
    publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), {
      live: manifest, retain: 1,
    });
    const live = JSON.parse(fs.files.get(P.manifest).data).body;
    assert.equal(live.retainedGenerationIds.includes("gen-1"), false, "the premise");
    fs.put(
      `${P.pinsDir}/p1.json`,
      encodeEnvelope("pin", {
        pinId: "p1", generationId: "gen-1", until: "2099-01-01T00:00:00Z", surprise: 1,
      }),
    );

    const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
    assert.deepEqual(swept.removedPins, [`${P.pinsDir}/p1.json`], "the pin must be collected");
    assert.equal(
      fs.files.has(`${P.generationsDir}/gen-1.json`),
      false,
      "and it must not have protected its generation",
    );
  }
});

test("reset: a manifest directory that becomes a live manifest mid-removal is not unlinked", () => {
  // The decision to remove manifest.json as a TREE is made on one lstat and carried out by a
  // second. If the directory becomes a regular live manifest in between, the traversal took
  // its file branch and unlinked the artifact the hard stop exists to protect — after which
  // the reset would have gone on to delete the generations that manifest referenced.
  const { fs, authority, manifest } = publishedStore();
  const liveBytes = fs.files.get(P.manifest).data;

  // A directory at manifest.json is what routes the reset into the tree branch.
  fs.renameDirect(P.manifest, `${P.root}/manifest.saved`);
  fs.mkdirp(P.manifest);

  // ...and it turns back into the live manifest between the decision and the traversal.
  //
  // ARMED on the lstat that takes the decision — the first one, which observes a directory —
  // and FIRED on the next observation of that name, which is where the traversal acts on what
  // was decided. `++swaps === 2` named the same instant as a bare ordinal, which is the fossil
  // this suite corrected everywhere else (see `swapBeforeGuardOf`): there are FIVE lstats of
  // this name on this path, ordinals 2 through 5 are all inside the window, and "2" describes
  // it only for as long as the current call order happens to hold. Worse, if the fixture ever
  // stopped firing, the manifest stayed a directory and the assertions below died on a
  // TypeError reading `.data` off `undefined` — a failure that says nothing about the contract.
  // The anchor is the RETURNED STAT, which is the decision itself: the first lstat of this
  // name that answers "directory" is the observation the tree branch is chosen on. The swap
  // lands immediately after that answer is computed and before it is handed back, so the
  // caller decides on a directory and acts on a file. Nothing here depends on how many times
  // the name is looked at.
  let swapped = false;
  const realLstat = fs.lstat.bind(fs);
  fs.lstat = (path) => {
    const stat = realLstat(path);
    if (!swapped && path === P.manifest && stat.isDirectory && !stat.isSymbolicLink) {
      swapped = true;
      for (const key of [...fs.nodes.keys()]) {
        if (key === P.manifest || key.startsWith(`${P.manifest}/`)) fs.nodes.delete(key);
      }
      fs.put(P.manifest, liveBytes);
    }
    return stat;
  };
  const result = resetStore(fs, authority, P);
  fs.clearHooks();

  // The window was entered. Without this the fixture could stop firing and the assertions
  // below would die on a TypeError reading `.data` off `undefined` — a failure that says
  // nothing about the contract.
  assert.equal(swapped, true, "the decision was never taken on a directory — nothing was raced");

  assert.equal(result.stoppedAtManifest, true, "the reset must stop at the manifest boundary");
  assert.equal(fs.files.get(P.manifest)?.data, liveBytes, "the live manifest must survive");
  assert.ok(
    fs.files.has(`${P.generationsDir}/gen-1.json`),
    "and so must the generation it references",
  );
  // ...and the surviving manifest really is the one that references it. (Asserting
  // `manifest.activeGenerationId` instead read a field off the FIXTURE's own object, which no
  // implementation can affect — a decoration, not a check.)
  assert.equal(
    JSON.parse(fs.files.get(P.manifest).data).body.activeGenerationId,
    "gen-1",
    "the surviving manifest must still be the one naming that generation",
  );
  void manifest;
});

test("reset: a wrong-mode ROOT converges without startWriter's help", () => {
  // The repair loop excluded paths.root, so a direct classify -> reset -> classify cycle
  // returned success with the root still at the mode classification refuses. Only
  // startWriter's separate ensureDir pass happened to hide it, which is not convergence — it
  // is a second function accidentally covering for the first.
  const { fs, authority } = publishedStore();
  fs.chmodDirect(P.root, 0o755);

  assert.equal(classifyStore(fs, P).status, "not-usable");
  resetStore(fs, authority, P);
  assert.equal(fs.lstat(P.root).mode & 0o7777, 0o700, "the reset must repair the root itself");
  // NAMED, for the same reason the staging-shapes rows are. `!== "not-usable"` also accepted
  // `usable` — an implementation that chmods the root and keeps the live store, which is a
  // repair rather than the reset disposition this path is specified to apply.
  assert.equal(classifyStore(fs, P).status, "first-run", "the reset must reset, not merely repair");
  assert.equal(fs.files.has(P.manifest), false, "the manifest must be gone");
  assert.deepEqual(fs.listDir(P.generationsDir), [], "the generations must be gone");
});

test("ensureDir: the mode repair cannot be redirected by a swap during the gate", () => {
  // `chmod(2)` follows symlinks and takes a NAME, so the pathname form of this repair was a
  // check-then-act whose interval contained `assertHeld` — a call into caller-supplied code,
  // which is a guaranteed opportunity to swap the name. The repair now goes through a
  // descriptor opened O_NOFOLLOW | O_DIRECTORY, so there is no name left to redirect.
  //
  // What this test can and cannot show, stated plainly rather than implied by its name. It shows
  // that the race RUNS (the swap fires mid-gate), that the victim outside the store is never
  // chmodded, and that the store converges afterwards. It CANNOT be falsified by a mutant that
  // restores the pathname repair, because the seam no longer has a pathname `chmod` to restore —
  // round 5 deleted it, so the regression is not expressible here. The protection is structural:
  // the seam's exact method set is asserted by the classification test, so a pathname `chmod`
  // cannot reappear without failing THAT test. Reordering the open to after the gate is not a
  // falsifying mutant either — the open then resolves the swapped name, hits O_NOFOLLOW and
  // refuses, which this test accepts. Two tests hold this between them; neither holds it alone.
  const fs = new FakeFs();
  fs.mkdirp(STATE);
  fs.mkdirp(P.root, 0o700);
  fs.mkdirp(P.generationsDir, 0o755);
  fs.mkdirp("/outside/victim", 0o700);

  // The swap runs from inside the GATE, which is where the interval actually is.
  //
  // This used to hand-roll an inner authority, because `fs.hooks.set("assertHeld", ...)` was
  // accepted and then never fired: the fake authority pushed its trace entry straight onto
  // `fs.calls`, bypassing the seam's hook dispatcher. The swap never happened, the victim was
  // trivially untouched, and the test reported success for a race it had not run. Asserting
  // `swapped` is what turned that from invisible into a failure; `recordAuthorityAssertion`
  // is what makes the ordinary way of expressing it work, so the next fixture that wants this
  // interval does not have to rediscover the workaround.
  let swapped = false;
  const authority = new FakeAuthority(fs);
  fs.hooks.set("assertHeld", () => {
    if (swapped || !fs.nodes.has(P.generationsDir)) return;
    const stat = fs.lstat(P.generationsDir);
    if (!stat.isDirectory || (stat.mode & 0o7777) !== 0o755) return;
    // The directory has been inspected and the descriptor is open; this is exactly the
    // interval the pathname form of the repair left exposed.
    swapped = true;
    fs.nodes.delete(P.generationsDir);
    fs.symlink(P.generationsDir, "/outside/victim");
  });
  // The throw is CAPTURED, not discarded. A bare `catch {}` here made the test pass in three
  // ways that prove nothing: if `startWriter` failed before it ever reached the mode repair, if
  // the hook's condition never matched so no swap happened at all, or if some unrelated failure
  // aborted the run. The victim's mode is unchanged in all three, so the single assertion left
  // could not tell any of them from success.
  let threw = null;
  try {
    startWriter(fs, authority, P);
  } catch (err) {
    threw = err;
  }
  fs.clearHooks();

  // The race was actually run.
  assert.equal(swapped, true, "the swap never fired — this test exercised nothing");

  // Refusing outright is an acceptable outcome; chmodding the victim is not. But the refusal
  // has to be ABOUT the swapped directory rather than an incidental failure.
  if (threw !== null) {
    assert.ok(
      ["SnapshotPathError", "SnapshotModeError", "SnapshotFsError"].includes(threw.name),
      `startWriter failed for an unrelated reason: ${threw.name}: ${threw.message}`,
    );
  }

  assert.equal(
    fs.lstat("/outside/victim").mode & 0o7777,
    0o700,
    "the repair must never reach a directory outside the store",
  );

  // ...and the store converges: a second start, with the link now the only thing wrong, ends
  // with a real 0700 directory at that name and the victim still untouched.
  const successor = new FakeAuthority(fs);
  startWriter(fs, successor, P);
  const dir = fs.lstat(P.generationsDir);
  assert.equal(dir.isSymbolicLink, false, "the link must be gone");
  assert.equal(dir.isDirectory, true);
  assert.equal(dir.mode & 0o7777, 0o700);
  assert.equal(fs.lstat("/outside/victim").mode & 0o7777, 0o700, "still untouched");
});

test("publish: options is proven inert before any field is read off it", () => {
  // `options.retain` used to be read first, so a null options gave an incidental TypeError
  // instead of this module's error, and an accessor ran caller code ahead of the very check
  // whose job is to prove no such code exists.
  const { fs, authority } = freshStore();

  // EVERY supported field gets its own row, plus a Proxy that observes a read of ANY name.
  //
  // An accessor on `retain` alone did not prove the claim in the name. A regression that read
  // `options.live` first still passed: that read has no observable effect, and validation then
  // rejected the `retain` accessor exactly as expected — so the test reported "no field was
  // read before the check" while a field had been.
  const rows = [];
  for (const field of ["live", "retain"]) {
    rows.push([
      `an accessor on options.${field}`,
      () => {
        let ran = 0;
        const options = { live: null, retain: 2 };
        delete options[field];
        Object.defineProperty(options, field, {
          get() {
            ran += 1;
            return field === "live" ? null : 2;
          },
          enumerable: true,
          configurable: true,
        });
        return { options, reads: () => ran };
      },
    ]);
  }
  rows.push([
    "a Proxy, which observes a read of any name at all",
    () => {
      let ran = 0;
      const options = new Proxy(
        { live: null, retain: 2 },
        {
          get(t, k, r) { ran += 1; return Reflect.get(t, k, r); },
          has(t, k) { ran += 1; return Reflect.has(t, k); },
        },
      );
      return { options, reads: () => ran };
    },
  ]);

  for (const [label, build] of rows) {
    const { options, reads } = build();
    assert.throws(
      () => publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), options),
      (err) => {
        assert.equal(err.name, "SnapshotStoreResetError", label);
        return true;
      },
      label,
    );
    assert.equal(reads(), 0, `${label}: a field was read before options was proven inert`);
    assert.deepEqual(fs.mutations(), [], label);
  }

  // And a null options is this module's NAMED error rather than an incidental TypeError from
  // `options.retain` — which is the regression that started this test.
  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), null),
    (err) => {
      assert.equal(err.name, "SnapshotStoreResetError");
      return true;
    },
  );
  assert.deepEqual(fs.mutations(), []);
});

test("reader: an error IMPERSONATING this module's types is not swallowed", () => {
  // `instanceof` is not proof of provenance: these constructors are exported, so
  // `Object.create(SnapshotPathError.prototype)` passes — and a value that passes was
  // SWALLOWED and reported as "no snapshot". Anything able to throw into the reader could
  // convert a failure the caller must hear about into a quiet empty answer.
  const { fs } = publishedStore();
  const impostor = Object.create(SnapshotPathError.prototype);
  impostor.message = "not really ours";
  // Thrown from the container check, which is one of the places the reader CONSULTS the
  // predicate. Throwing it at the manifest read instead would have proved nothing: that call
  // sits outside the try, so the value propagates whatever the predicate answers — a test that
  // passes for a reason unrelated to the thing it names.
  fs.failOn("lstat", P.root, impostor, 1);

  assert.throws(
    () => readSnapshot(fs, P),
    (err) => {
      assert.equal(err, impostor, "the impostor must propagate untouched");
      return true;
    },
  );
});

test("gc: an unexplained failure while READING a pin propagates instead of deleting it", () => {
  // What this actually pins is the read path, and it is named for that rather than for the
  // catch narrowing next to it. The narrowing is real and correct — a bare catch turns every
  // failure into permission to DELETE the pin — but nothing reachable today can exercise it:
  // everything inside that try (`decodeEnvelope`, `assertPinInvariants`) throws
  // `SnapshotStoreResetError` and nothing else, and the seam calls that could throw anything
  // are outside it. Claiming a mutant for it would be claiming coverage this suite does not
  // have; see the note in `collectGarbage`.
  const { fs, authority } = publishedStore();
  fs.put(
    `${P.pinsDir}/p1.json`,
    encodeEnvelope("pin", {
      pinId: "p1",
      generationId: "gen-1",
      until: "2099-01-01T00:00:00Z",
    }),
  );
  const boom = new Error("unexpected");
  let reads = 0;
  fs.hooks.set("readAll", (path) => {
    if (path?.endsWith("p1.json") && ++reads === 1) throw boom;
  });
  assert.throws(
    () => collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z"),
    (err) => {
      assert.equal(err.cause ?? err, boom);
      return true;
    },
  );
  fs.clearHooks();
  assert.ok(fs.files.has(`${P.pinsDir}/p1.json`), "the pin must survive an unexplained failure");
});

test("dominance: an unsafe-integer offset is refused rather than silently collapsed", () => {
  // Two genuinely different offsets that BOTH round to the same double. Accepted, they compare
  // equal, and "equal" is a refusal to publish — so a real advance reads as no progress. Paired
  // with a real advance on another source it is worse: the pair reads as `dominates` on the
  // strength of a comparison that never happened.
  const a = 2 ** 54 + 1;
  const b = 2 ** 54 + 2;
  assert.equal(a, b, "the premise: these two are indistinguishable as doubles");

  assert.throws(
    () => canonicalSourceVersion({ claude: a }),
    (err) => {
      assert.equal(err.name, "SourceVersionManifestError");
      assert.match(err.message, /safe integer/);
      return true;
    },
  );
  // The boundary is where the name says it is.
  assert.deepEqual({ ...canonicalSourceVersion({ claude: Number.MAX_SAFE_INTEGER }) }, {
    claude: Number.MAX_SAFE_INTEGER,
  });
  assert.throws(
    () => canonicalSourceVersion({ claude: Number.MAX_SAFE_INTEGER + 1 }),
    SourceVersionManifestError,
  );
});

test("dominance: a non-enumerable source is refused, not promoted", () => {
  // `Object.keys(getOwnPropertyDescriptors(x))` sees non-enumerable keys, and the copy defined
  // them as enumerable — PROMOTING data JSON drops into data the checksum covers, so the
  // manifest persisted differently from how it compared. envelope.ts refuses exactly this; this
  // function was silently doing the opposite.
  const hidden = Object.defineProperty({ claude: 1 }, "codex", {
    value: 5,
    enumerable: false,
  });
  assert.throws(
    () => canonicalSourceVersion(hidden),
    (err) => {
      assert.equal(err.name, "SourceVersionManifestError");
      assert.match(err.message, /non-enumerable/);
      return true;
    },
  );
});

test("freshness: the PROVENANCE is proven inert too, not just the request", () => {
  // Both arguments arrive through the same exported function, so the argument for validating
  // one is the argument for validating the other. `request` was checked exhaustively and
  // `provenance` was not checked at all — in production it comes from a decoded generation and
  // is already inert, but this function is exported and T-013 is the caller, where the type
  // annotation does not exist.
  const good = {
    coverage: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" }],
    fieldCoverage: {},
    sourceTimestamps: {},
    refreshTier: "fast",
    ccusageVersion: "1.0.0",
    ccusageInvokedAt: "2026-01-01T00:00:00Z",
    timezone: "America/Vancouver",
    dayBoundaryPolicy: "local-midnight",
  };
  const req = { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" };
  // The baseline answers, so the guard below is not passing by breaking the function.
  assert.equal(deriveFreshness(good, req).covered, true);

  let ran = 0;
  const hostile = [
    // `coverage.map` on a non-array threw an incidental TypeError, not this module's error.
    ["coverage is not an array", { ...good, coverage: "everything" }],
    ["coverage is a Proxy", { ...good, coverage: new Proxy([], {}) }],
    ["a coverage element is not an object", { ...good, coverage: [1] }],
    [
      "a coverage element carries an accessor",
      {
        ...good,
        coverage: [
          Object.defineProperty({ end: "2026-01-02T00:00:00Z" }, "start", {
            get() {
              ran++;
              return "2026-01-01T00:00:00Z";
            },
            enumerable: true,
          }),
        ],
      },
    ],
    ["fieldCoverage is not an object", { ...good, fieldCoverage: [] }],
    ["a fieldCoverage entry is not an array", { ...good, fieldCoverage: { cost: "all" } }],
    ["sourceTimestamps holds a non-string", { ...good, sourceTimestamps: { a: 5 } }],
    ["timezone is not a string", { ...good, timezone: 5 }],
    ["provenance is null", null],
    ["provenance is a Proxy", new Proxy(good, {})],
  ];
  for (const [label, provenance] of hostile) {
    assert.throws(
      () => deriveFreshness(provenance, req),
      FreshnessRequestError,
      `${label}: not refused as a freshness request error`,
    );
  }
  assert.equal(ran, 0, "an accessor on a coverage interval ran during validation");

  // An inherited getter on provenance itself must not run either — the prototype check is what
  // stops it, since it owns no descriptor for the validator to find.
  const inherited = Object.create({
    get timezone() {
      ran++;
      return "America/Vancouver";
    },
  });
  Object.assign(inherited, {
    coverage: [],
    fieldCoverage: {},
    sourceTimestamps: {},
  });
  assert.throws(() => deriveFreshness(inherited, req), FreshnessRequestError);
  assert.equal(ran, 0, "an inherited provenance getter ran during validation");
});

test("freshness: proving a container inert does not make CALLING its methods safe", () => {
  // Validating the caller's array and then handing that SAME array to `gapsFor` proved the
  // wrong thing. `gapsFor` does `intervals.map(...)`, and `map` can be an OWN property: a plain
  // array with `a.map = () => []` carries a key the index loop never looks at, so caller code
  // ran inside the function computing the coverage answer, after the array had been declared
  // usable. Nothing of the caller's array survives normalization now.
  const base = {
    coverage: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" }],
    fieldCoverage: {},
    sourceTimestamps: {},
    refreshTier: "fast",
    ccusageVersion: "1.0.0",
    ccusageInvokedAt: "2026-01-01T00:00:00Z",
    timezone: "America/Vancouver",
    dayBoundaryPolicy: "local-midnight",
  };
  const req = { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" };

  let ran = 0;
  const withOwnMap = [{ start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" }];
  withOwnMap.map = function () {
    ran++;
    return [];
  };
  assert.throws(
    () => deriveFreshness({ ...base, coverage: withOwnMap }, req),
    FreshnessRequestError,
    "an own `map` on coverage was accepted and then invoked",
  );

  // Same hazard through a subclass, where the override lives on the prototype instead.
  class Sneaky extends Array {
    map() {
      ran++;
      return [];
    }
  }
  const subclassed = Sneaky.from([{ start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" }]);
  assert.throws(
    () => deriveFreshness({ ...base, coverage: subclassed }, req),
    FreshnessRequestError,
    "an Array subclass overriding map was accepted",
  );
  assert.equal(ran, 0, "a caller-supplied map() ran inside the coverage computation");

  // An enumerable SYMBOL accessor survived validation because `Object.entries` cannot see one —
  // and then ran, because object spread copies enumerable own symbols. The place that bites is
  // the spread of `sourceTimestamps`, immediately after it was declared inert.
  const sneakySymbol = Symbol("leak");
  const timestamps = {};
  Object.defineProperty(timestamps, sneakySymbol, {
    get() {
      ran++;
      return "2026-01-01T00:00:00Z";
    },
    enumerable: true,
  });
  assert.throws(
    () => deriveFreshness({ ...base, sourceTimestamps: timestamps }, req),
    FreshnessRequestError,
    "an enumerable Symbol accessor on sourceTimestamps was accepted",
  );
  assert.equal(ran, 0, "a Symbol getter ran during the sourceTimestamps spread");
});

test("freshness: a date that does not exist is refused, not normalized into a different one", () => {
  // `Date.parse("2026-02-30")` does not fail — it returns 2026-03-02. So matching the SHAPE and
  // then trusting the parse meant a request naming a date that never happened was answered
  // confidently, about a range two days from the one the caller asked for. The calendar is now
  // checked without normalization before `Date.parse` is consulted at all.
  const prov = {
    coverage: [{ start: "2020-01-01T00:00:00Z", end: "2030-01-01T00:00:00Z" }],
    fieldCoverage: {},
    sourceTimestamps: {},
    refreshTier: "fast",
    ccusageVersion: "1.0.0",
    ccusageInvokedAt: "2026-01-01T00:00:00Z",
    timezone: "America/Vancouver",
    dayBoundaryPolicy: "local-midnight",
  };
  for (const bad of [
    "2026-02-30",
    "2025-02-29", // not a leap year
    "2100-02-29", // divisible by 4 but NOT a leap year — the shorthand rule gets this wrong
    "2026-04-31",
    "2026-00-10",
    "2026-13-01",
    "2026-01-32",
    "2026-01-01T24:00:00Z", // a second spelling of the next day's midnight
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:61Z",
    "2026-01-01T00:00:00+99:00",
  ]) {
    assert.throws(
      () => deriveFreshness(prov, { start: bad, end: "2026-06-01" }),
      FreshnessRequestError,
      `${bad} was accepted as an instant`,
    );
    // ...and on the PROVENANCE side too, which reads instants through the same grammar.
    assert.throws(
      () => deriveFreshness({ ...prov, coverage: [{ start: bad, end: "2026-06-01" }] },
        { start: "2026-01-01", end: "2026-06-01" }),
      FreshnessRequestError,
      `${bad} was accepted as a coverage bound`,
    );
  }

  // Real dates, including the leap days the rule above must NOT reject, still work.
  for (const ok of ["2024-02-29", "2000-02-29", "2026-01-31", "2026-12-31T23:59:59Z", "2026-06-01T00:00:00+05:30"]) {
    assert.doesNotThrow(
      () => deriveFreshness(prov, { start: ok, end: "2029-01-01" }),
      `${ok} was refused`,
    );
  }
});

test("freshness: an inherited getter cannot run inside request validation", () => {
  // Refusing accessors on the OWN properties is not enough: a custom prototype carries an
  // INHERITED getter, which owns no descriptor here and still runs when the field is read.
  let ran = 0;
  const proto = {
    get start() {
      ran += 1;
      return "2026-01-01";
    },
  };
  const request = Object.create(proto);
  request.end = "2026-02-01";
  assert.throws(
    () => deriveFreshness(provenance(), request),
    (err) => {
      assert.equal(err.name, "FreshnessRequestError");
      assert.match(err.message, /prototype/);
      return true;
    },
  );
  assert.equal(ran, 0, "the inherited getter must never run");

  // A revoked Proxy is refused as a Proxy rather than escaping as an incidental TypeError from
  // `Array.isArray`, which is itself a trapped operation.
  const revocable = Proxy.revocable({ start: "2026-01-01", end: "2026-02-01" }, {});
  revocable.revoke();
  assert.throws(
    () => deriveFreshness(provenance(), revocable.proxy),
    (err) => {
      assert.equal(err.name, "FreshnessRequestError");
      assert.match(err.message, /Proxy/);
      return true;
    },
  );
});

test("freshness: the field list is read through descriptors, never iterated", () => {
  // `for (const f of fields)` runs the array's iterator and every element read is a property
  // access — so a trap runs caller code inside the validator, and can hand one value to the
  // check and another to the use.
  let ran = 0;
  const fields = new Proxy(["cost"], {
    get(target, key, receiver) {
      ran += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.throws(
    () => deriveFreshness(provenance(), { start: "2026-01-01", end: "2026-02-01", fields }),
    (err) => {
      assert.equal(err.name, "FreshnessRequestError");
      assert.match(err.message, /Proxy/);
      return true;
    },
  );
  assert.equal(ran, 0, "no trap may fire");

  // An accessor at an index, and a named property, are both refused by name.
  const withAccessor = [];
  Object.defineProperty(withAccessor, 0, { get: () => "cost", enumerable: true, configurable: true });
  assert.throws(
    () => deriveFreshness(provenance(), { start: "2026-01-01", end: "2026-02-01", fields: withAccessor }),
    /accessor/,
  );
  const withNamed = ["cost"];
  withNamed.note = "x";
  assert.throws(
    () => deriveFreshness(provenance(), { start: "2026-01-01", end: "2026-02-01", fields: withNamed }),
    /named property/,
  );

  // The ordinary case still works, and duplicates still collapse.
  const ok = deriveFreshness(provenance(), {
    start: "2026-01-01",
    end: "2026-02-01",
    fields: ["cost", "cost", "tokens"],
  });
  assert.deepEqual(Object.keys(ok.fields).sort(), ["cost", "tokens"]);
});

test("freshness: a local day whose UTC bounds leave the four-digit year range is refused", () => {
  // Narrowing the INPUT range to 0..9999 was necessary and not sufficient, and the edges are
  // exactly where it failed: the end of 9999-12-31 is local midnight on 10000-01-01, and local
  // midnight on 0000-01-01 in any positive-offset zone falls in year -1 UTC. `toISOString`
  // renders both in EXPANDED form, which INSTANT_RE refuses — so this function handed
  // `deriveFreshness` a bound `deriveFreshness` rejects, which is the same
  // one-function-produces-what-another-refuses defect the narrowing was meant to remove.
  for (const [zone, day] of [
    ["UTC", { year: 9999, month: 12, day: 31 }],
    ["Asia/Tokyo", { year: 0, month: 1, day: 1 }],
  ]) {
    assert.throws(
      () => localDayBounds(zone, day),
      (err) => {
        assert.equal(err.name, "FreshnessRequestError");
        assert.match(err.message, /four-digit ISO year range/);
        return true;
      },
      `${zone} ${JSON.stringify(day)}`,
    );
  }

  // One step inside the boundary still answers, and the answer round-trips through the reader.
  const bounds = localDayBounds("UTC", { year: 9999, month: 12, day: 30 });
  assert.equal(bounds.start, "9999-12-30T00:00:00.000Z");
  const result = deriveFreshness(provenance(), { start: bounds.start, end: bounds.end });
  assert.equal(result.covered, false);
});

test("reset: an ANCESTOR swapped mid-traversal is caught, not descended through", () => {
  // I got this one wrong and the reviewer got it right, so the test is written against the
  // mechanism rather than the shape. A frame that re-checks only ITS OWN directory is checking
  // an identity it captured AFTER any ancestor swap that had already happened: the child's very
  // first act is `lstat(parent/child)`, which resolves THROUGH the parent, so a swap landing
  // between the parent's check and that lstat gives the child the substitute's child — which is
  // then perfectly self-consistent on every subsequent check while the traversal empties a tree
  // that was never ours. Every frame now re-proves the whole chain above it.
  //
  // The swap is therefore timed at exactly that instant: the child frame's opening lstat.
  // Timing it later (during a leaf unlink, which is what an earlier version of this test did)
  // exercises a case the per-frame check already covered, and passes against the bug.
  const { fs, authority } = publishedStore();
  fs.mkdirp(`${P.root}/stray/nested`, 0o700);
  fs.put(`${P.root}/stray/nested/a.txt`, "a");
  fs.put(`${P.root}/stray/nested/b.txt`, "b");

  // A decoy holding the same child name, so the substituted prefix resolves rather than ENOENTs.
  fs.mkdirp("/outside/decoy/nested", 0o700);
  fs.put("/outside/decoy/nested/victim.txt", "do not delete me");

  let swapped = false;
  fs.hooks.set("lstat", (path) => {
    if (!swapped && path === `${P.root}/stray/nested`) {
      swapped = true;
      fs.nodes.delete(`${P.root}/stray`);
      fs.symlink(`${P.root}/stray`, "/outside/decoy");
    }
  });
  const result = resetStore(fs, authority, P);
  fs.clearHooks();

  assert.equal(swapped, true, "the swap must actually have been performed");
  assert.equal(
    fs.files.get("/outside/decoy/nested/victim.txt")?.data,
    "do not delete me",
    "nothing outside the store may be deleted through a swapped ancestor",
  );
  assert.ok(
    result.failed.some((p) => p.startsWith(`${P.root}/stray`)),
    "and the subtree is reported as left behind rather than silently skipped",
  );
});

test("classification: a container swapped DURING the pass is not classified as usable", () => {
  // Classification is read-only but LONG — a dozen seam calls, each of which yields — and its
  // verdict is what routes the store to "usable" or to a reset. Every path it inspects resolves
  // through these four directories, so a container swapped partway through means the second
  // half of the verdict describes a different filesystem from the first half. `assertOwnedChain`
  // cannot see it: a substitute 0700 directory full of forged artifacts is AN acceptable
  // directory. Identity is the property a forgery cannot reproduce.
  const { fs } = publishedStore();
  fs.mkdirp("/outside/decoy", 0o700);
  fs.put(`/outside/decoy/gen-1.json`, fs.files.get(`${P.generationsDir}/gen-1.json`).data);

  let reads = 0;
  fs.hooks.set("openRead", (path) => {
    if (path === P.manifest && ++reads === 1) {
      for (const key of [...fs.nodes.keys()]) {
        if (key === P.generationsDir || key.startsWith(`${P.generationsDir}/`)) fs.nodes.delete(key);
      }
      fs.symlink(P.generationsDir, "/outside/decoy");
    }
  });
  const c = classifyStore(fs, P);
  fs.clearHooks();

  assert.equal(c.status, "not-usable");
  assert.equal(c.error.reason, "container-replaced");
});

test("close: a close failure is reported even when it throws the SAME value as the primary", () => {
  // The catch used to tell "the promoted close failure" from "an earlier failure" by comparing
  // `closeError !== err`. That is a guess dressed as a check: the seam may throw ANY value, so
  // two seams sharing one frozen sentinel is enough to make a genuine pair of failures read as
  // one, and the close failure vanished from the report.
  const { fs, authority } = freshStore();
  const shared = Object.freeze(errno("EIO", "shared sentinel"));
  // The primary must fail BEFORE the close, so the close failure is a genuinely independent
  // second failure rather than the promoted one.
  fs.failOn("write", "staging/generation.json", shared);
  fs.failOn("close", null, shared);

  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 1 }), { live: null }),
    (err) => {
      assert.equal(err.name, "SnapshotCommitFailure", "both failures must be preserved");
      assert.equal(err.primaryError, shared);
      assert.equal(err.closeError, shared);
      return true;
    },
  );
  fs.clearHooks();
});

test("classification: a FIFO at an artifact name is refused on the DESCRIPTOR", () => {
  // Two claims live here and only one of them is the kernel's. That `openRead` does not block
  // on a FIFO is answered in snapshot-realfs.test.mjs with a real `mkfifo`. What this asks is
  // the part the store owns: having got a descriptor, it refuses it for not being a regular
  // file BEFORE any bytes are read. Until this round the fake reported every descriptor as
  // `isFile: true`, so that refusal could have been deleted and this suite would have stayed
  // green — the fake agreeing with the bug.
  const { fs } = publishedStore();
  fs.nodes.delete(P.manifest);
  fs.mkfifo(P.manifest);

  const c = classifyStore(fs, P);
  assert.equal(c.status, "not-usable");
  assert.equal(c.error.reason, "artifact-not-a-regular-file");
  // The bytes were never read, asserted on the TRACE rather than on the failure a read would
  // have produced. A non-blocking FIFO with no writer reads EOF — zero bytes — so a store that
  // reached `readAll` here would get an empty string and refuse it as unparsable: the same
  // `not-usable` status, from a completely different check. Counting the calls is the only
  // assertion that can tell those two apart.
  assert.equal(fs.calls.filter((call) => call.op === "readAll" && call.path === P.manifest).length, 0);

  assert.equal(readSnapshot(fs, P).status, "no-snapshot");
});

test("classification: a DIRECTORY opened at an artifact name is refused on the descriptor too", () => {
  // Same refusal, different non-regular type — and this one is reachable without a special
  // node type, which is why its absence was easy to miss: `openRead` succeeds on a directory
  // (O_RDONLY on a directory is legal), so only the descriptor check stands between the store
  // and a read that would fail much later with EISDIR.
  const { fs } = publishedStore();
  fs.nodes.delete(P.manifest);
  fs.mkdirp(P.manifest, 0o600);

  const c = classifyStore(fs, P);
  assert.equal(c.status, "not-usable");
  assert.equal(c.error.reason, "artifact-not-a-regular-file");
});

// ---------------------------------------------------------------------------------------
// Round 6, chunk 5 — the reset's ANCESTOR, and what "exact keys" actually compares
// ---------------------------------------------------------------------------------------

test("reset: the root is re-proven immediately before the manifest unlink, not once at the top", () => {
  // `resetStore` proved the root at entry and then trusted it for the rest of the function.
  // But `paths.manifest` is not a file — it is a NAME, re-resolved from `paths.root` on every
  // syscall that mentions it, and a reset is dozens of seam calls long. Swapping the root for
  // a symlink anywhere in that stretch pointed the manifest unlink out of the store entirely:
  // the reset became a deletion primitive aimed by whoever performed the swap.
  const { fs, authority } = publishedStore();
  fs.put("/decoy/manifest.json", "a file that belongs to someone else");

  let swapped = false;
  fs.hooks.set("lstat", (path) => {
    // After the root has been proven, before the manifest is unlinked through it.
    if (!swapped && path === P.manifest) {
      swapped = true;
      fs.symlink(P.root, "/decoy");
    }
  });
  const result = resetStore(fs, authority, P);
  fs.clearHooks();

  assert.equal(swapped, true, "the test must actually have performed the swap");
  assert.equal(
    fs.nodes.get("/decoy/manifest.json")?.type,
    "file",
    "the reset must not delete a file outside the store through a swapped root",
  );
  // And it is the visibility boundary, so it is a hard stop rather than absorbed residue.
  assert.equal(result.stoppedAtManifest, true);
  assert.deepEqual(result.failed, [P.manifest]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(callsOutside(fs), [], "no seam call may address a path outside the root");
});

test("reset: a root that turns real between the observation and the unlink is refused, not rebuilt into", () => {
  // The branch is entered because the root is NOT a directory, and the unlink is then refused
  // because a re-proof finds that it has become one. Refusing the unlink was already right; the
  // defect was what came next — the function fell through to `rebuildSkeleton`, which reopens
  // and `fchmod`s the root and creates three directories inside it. So a directory this
  // function had just declined to touch, on the grounds that it could not account for it, was
  // chmodded and populated anyway, and the result read as a completed reset.
  // Built from nothing rather than from `publishedStore()`, so that the three skeleton
  // directories are the ONLY thing that could appear under the root. Starting from a populated
  // store, `listDir` returns its existing children and the assertion below would report them
  // whether or not a rebuild ran — measuring the fixture instead of the behaviour.
  const fs = new FakeFs();
  fs.mkdirp(STATE);
  fs.mkdirp("/decoy");
  fs.symlink(P.root, "/decoy");
  const authority = new FakeAuthority(fs);

  let seen = 0;
  fs.hooks.set("lstat", (path) => {
    if (path !== P.root) return;
    seen += 1;
    // Hooks fire BEFORE their operation, so swapping on the second call is what the SECOND
    // lstat observes — the re-proof — while the first still sees the symlink that routes the
    // reset into this branch at all.
    if (seen === 2) {
      fs.nodes.delete(P.root);
      fs.mkdirp(P.root);
    }
  });
  const result = resetStore(fs, authority, P);
  fs.clearHooks();

  assert.ok(seen >= 2, "the re-proof must actually have run");
  assert.deepEqual(result.failed, [P.root], "the root it refused to remove must be reported");
  assert.deepEqual(result.removed, [], "nothing was removed");
  // THE FINDING: nothing may have been created inside it. A rebuild would leave generations/,
  // pins/ and staging/ here.
  assert.deepEqual(
    fs.listDir(P.root),
    [],
    "the reset must not build a skeleton inside a root it refused to unlink",
  );
});

test("reset: the skeleton rebuild will not create a directory under a swapped root", () => {
  // The rebuild that ENDS every reset is itself a sequence of mutations through the root:
  // ensure the root, then create three directories inside it. Between those, the root can
  // move — and `ensureDir` would then mkdir `generations/` inside the substitute and chmod it
  // 0700 there.
  const { fs, authority } = freshStore();
  fs.nodes.delete(P.generationsDir);
  fs.mkdirp("/decoy");

  fs.hooks.set("lstat", (path) => {
    if (path === P.generationsDir && fs.nodes.get(P.root)?.type === "dir") {
      fs.symlink(P.root, "/decoy");
    }
  });
  assert.throws(() => startWriter(fs, authority, P), /prefix that changed/);
  fs.clearHooks();

  assert.equal(
    fs.nodes.has("/decoy/generations"),
    false,
    "no store directory may be created outside the root",
  );
});

test("manifest: publishedAt is held to the SAME instant rule as every other timestamp", () => {
  // The generation and pin validators both required an instant with an explicit offset; the
  // manifest checked only `typeof === "string"`. A checksum-valid manifest carrying
  // `"whenever"` therefore classified as USABLE — and `"2026-01-01T00:00:00"`, which the spec
  // reads as LOCAL time, meant a different instant on every machine that read the same store.
  for (const bad of ["whenever", "2026-01-01T00:00:00", "2026-02-30T00:00:00Z", ""]) {
    const { fs } = publishedStore();
    const body = JSON.parse(fs.files.get(P.manifest).data).body;
    fs.put(P.manifest, encodeEnvelope("manifest", { ...body, publishedAt: bad }));

    const c = classifyStore(fs, P);
    assert.equal(c.status, "not-usable", bad);
    assert.equal(c.error.reason, "manifest-invariants", bad);
    assert.equal(readSnapshot(fs, P).status, "no-snapshot", bad);
  }
});

test("documents: an exact key SET is compared as a set, not as a joined string", () => {
  // `Object.keys(v).sort().join(",")` compares a RENDERING of a key set, and the rendering is
  // not injective: a key set is not a string, and flattening it loses exactly the boundaries
  // the check is about. Both bodies below render to the manifest's expected key string while
  // carrying none, or only some, of its actual fields.
  const expected = ["activeGenerationId", "publishedAt", "retainedGenerationIds", "sourceVersion"];
  const forgeries = [
    // One key that IS the joined expected list.
    { [expected.join(",")]: "everything at once" },
    // Two real fields plus one key that merges the other two across the comma.
    {
      activeGenerationId: "g",
      "publishedAt,retainedGenerationIds": "merged",
      sourceVersion: {},
    },
  ];
  for (const body of forgeries) {
    assert.throws(
      () => assertManifestInvariants(body, P.manifest),
      (err) =>
        err.reason === "manifest-invariants" &&
        // The KEY SET is what must be rejected. Before the fix these died one check later on
        // an `undefined` field — the downstream validators covering for this one, which holds
        // only while every field of every document happens to be individually read.
        /keys are/.test(err.message),
      JSON.stringify(body),
    );
  }

  // And the honest negative: the real key set still passes.
  assert.doesNotThrow(() =>
    assertManifestInvariants(
      {
        activeGenerationId: "g",
        retainedGenerationIds: ["g"],
        publishedAt: "2026-01-31T00:00:00Z",
        sourceVersion: {},
      },
      P.manifest,
    ),
  );
});

test("documents: a forged Symbol.hasInstance cannot turn a reset diagnostic into a caller error", () => {
  // `checkDocumentId` was the one place left reading `instanceof` instead of the private tag.
  // `SnapshotIdError` is EXPORTED and `Symbol.hasInstance` is writable, so anyone holding the
  // module could make that test answer false — and the id error would then escape classification
  // as a caller-facing `SnapshotIdError` instead of becoming the reset the one rule requires.
  const { fs } = publishedStore();
  const body = {
    activeGenerationId: "../../etc/passwd",
    retainedGenerationIds: ["../../etc/passwd"],
    publishedAt: "2026-01-31T00:00:00Z",
    sourceVersion: {},
  };
  fs.put(P.manifest, encodeEnvelope("manifest", body));

  const had = Object.getOwnPropertyDescriptor(SnapshotIdError, Symbol.hasInstance);
  Object.defineProperty(SnapshotIdError, Symbol.hasInstance, {
    value: () => false,
    configurable: true,
  });
  try {
    assert.equal(SnapshotIdError[Symbol.hasInstance](new SnapshotIdError("k", "v", "d")), false);
    const c = classifyStore(fs, P);
    assert.equal(c.status, "not-usable");
    assert.equal(c.error.reason, "manifest-invariants");
    assert.match(c.error.message, /id is unusable/);
  } finally {
    if (had === undefined) delete SnapshotIdError[Symbol.hasInstance];
    else Object.defineProperty(SnapshotIdError, Symbol.hasInstance, had);
  }
});

// ---------------------------------------------------------------------------------------
// Round 6, chunk 6 — generation ids are single-use, GC's entry rule, and `attempts`
// ---------------------------------------------------------------------------------------

test("publish: a generation id is single-use, so a commit never overwrites a live generation", () => {
  // `commitArtifact` refuses a symlink at the target and then renames straight over whatever
  // regular file is there. Dominance compares VERSIONS, not names, so republishing the active
  // id with higher offsets was permitted — and the rename replaced the file the LIVE manifest
  // points at, before the new manifest committed. A failure in that window leaves the prior
  // manifest live and serving content it never referenced: the exact corruption the
  // generation-before-manifest order exists to make unreachable.
  const { fs, authority } = publishedStore();
  const live = JSON.parse(fs.files.get(P.manifest).data).body;
  const genPath = `${P.generationsDir}/gen-1.json`;
  const before = fs.snapshotBytes();

  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 99 }), { live }),
    (err) => err.name === "SnapshotPathError" && /single-use/.test(err.message),
  );

  // Byte-identical, and refused before anything was staged.
  assert.equal(fs.files.has(stagingPath(P, "generation")), false, "no staging residue");
  const after = fs.snapshotBytes();
  assert.equal(after.get(genPath), before.get(genPath), "the live generation is untouched");
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [path, bytes] of before) assert.equal(after.get(path), bytes, path);

  // An UNREFERENCED orphan at that name blocks reuse too — an orphan is an anticipated
  // post-crash state, not a free name — and it converges, because GC removes it.
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live });
  const live2 = JSON.parse(fs.files.get(P.manifest).data).body;
  fs.put(`${P.generationsDir}/orphan.json`, fs.files.get(`${P.generationsDir}/gen-2.json`).data);
  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("orphan", { claude: 30 }), { live: live2 }),
    (err) => /single-use/.test(err.message),
  );
  collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");
  assert.equal(fs.files.has(`${P.generationsDir}/orphan.json`), false, "GC frees the name");
});

for (const dirName of ["pins", "generations"]) {
  test(`gc: a foreign entry in ${dirName}/ is LEFT for classification, never collected`, () => {
    // GC was the one place in the store that deleted foreign state. Every entry whose guarded
    // read returned null — a symlink, a wrong-mode file, a name this grammar could never
    // produce — read as "unusable artifact" and was unlinked, while `checkArtifactDir` says
    // that same set of observations means something other than this protocol wrote here and
    // routes it to a reset. Two functions in one module disagreeing about one file, with the
    // destructive one winning because it ran first.
    const dir = dirName === "pins" ? P.pinsDir : P.generationsDir;
    const foreign = [
      [`${dir}/link.json`, () => fs.symlink(`${dir}/link.json`, "/outside/target")],
      [`${dir}/wrong-mode.json`, () => fs.put(`${dir}/wrong-mode.json`, "{}", 0o644)],
      [`${dir}/.hidden.json`, () => fs.put(`${dir}/.hidden.json`, "{}")],
      [`${dir}/${"x".repeat(200)}.json`, () => fs.put(`${dir}/${"x".repeat(200)}.json`, "{}")],
    ];

    let fs, authority;
    for (const [path, seed] of foreign) {
      ({ fs, authority } = publishedStore());
      fs.put("/outside/target", "someone else's file");
      seed();

      const swept = collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z");

      assert.ok(fs.nodes.has(path), `${path} must survive the sweep`);
      assert.equal(swept.removedPins.includes(path), false, `${path} must not be collected`);
      assert.equal(
        swept.removedGenerations.includes(path),
        false,
        `${path} must not be collected`,
      );
      assert.equal(fs.nodes.get("/outside/target")?.type, "file", "no escape through the link");
      // And the disposition it DOES get: classification refuses the store, so the next start
      // resets it. That is what converges — deleting it here erases the only evidence
      // classification has.
      const c = classifyStore(fs, P);
      assert.equal(c.status, "not-usable", path);

      startWriter(fs, authority, P);
      assert.equal(classifyStore(fs, P).status, "first-run", `${path} must converge`);
    }
  });
}

test("read: the attempts bound is validated, so it cannot silently disable every read", () => {
  // Exported parameter, so "callers pass 3" is not a property of this function. `NaN`/0 makes
  // `attempt < attempts` false on the first test and every read returns "no snapshot" while
  // the store is healthy — a silent wrong answer. `Infinity` is a hang. And an object with a
  // `valueOf` runs caller code inside the loop condition, in a function whose whole discipline
  // is that caller code does not run during validation.
  const { fs } = publishedStore();
  assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1");

  let coerced = 0;
  const bad = [NaN, 0, -1, 1.5, Infinity, "3", null, { valueOf() { coerced += 1; return 3; } }];
  for (const attempts of bad) {
    assert.throws(
      () => readSnapshot(fs, P, attempts),
      (err) => err.name === "SnapshotPathError" && /attempts must be an integer/.test(err.message),
      String(attempts),
    );
  }
  assert.equal(coerced, 0, "a valueOf must never be invoked by the validation");

  // The honest negative: a legitimate bound still works.
  assert.equal(readSnapshot(fs, P, 1).view.generation.generationId, "gen-1");
});

// ---------------------------------------------------------------------------------------
// Round 6, chunk 7 — the apparatus itself: a hook that cannot fire is worse than no hook
// ---------------------------------------------------------------------------------------

test("apparatus: the authority GATE is hookable, and an undispatched hook name is refused", () => {
  // Both halves are about the same failure mode, which is SILENCE. A hook registered under a
  // name nothing dispatches is accepted, never fires, and the test that arranged it reports
  // success for a race it never ran. That is not hypothetical: the gate-swap test above was
  // caught doing exactly this, and a typo (`chmod` for `fchmod`) reproduces it exactly.
  const fs = new FakeFs();
  fs.mkdirp(P.stagingDir);
  const authority = new FakeAuthority(fs);

  let gated = 0;
  fs.hooks.set("assertHeld", () => {
    gated += 1;
  });
  authority.assertHeld();
  assert.equal(gated, 1, "a hook on the gate must actually fire");
  // ...and the trace entry is still recorded, so the ordering proofs are unaffected.
  assert.equal(fs.calls.at(-1).op, "assertHeld");
  assert.deepEqual(fs.calls.at(-1).paths, [], "every trace entry keeps the same shape");

  // A name nothing dispatches fails LOUDLY, at registration.
  for (const op of ["chmod", "readdir", "stat", "assertheld", ""]) {
    assert.throws(
      () => fs.hooks.set(op, () => {}),
      (err) => /dispatches no hook/.test(err.message),
      op,
    );
  }
  // Including through `failOn`, which is the same registry.
  assert.throws(() => fs.failOn("chmod", null, errno("EIO")), /dispatches no hook/);

  // The honest negative: every op the seam really does dispatch is still accepted.
  for (const op of FakeFs.HOOKABLE_OPS) {
    assert.doesNotThrow(() => fs.hooks.set(op, () => {}), op);
  }
  fs.clearHooks();
});

// ---------------------------------------------------------------------------------------
// Round 7 — findings from the seventh review round, each pinned by the case that produced it
// ---------------------------------------------------------------------------------------

test("freshness: a getter on Object.prototype cannot answer for a field nobody owns", () => {
  // The prototype check refuses a CUSTOM prototype, and `Object.prototype` is not custom — it
  // is the one every plain object has, and it is writable by anything in the process. So a
  // getter installed there owns no descriptor on the value, passes every check, and then runs
  // on each read. The effect is worse than "caller code ran": a provenance with NO own
  // `timezone` was ACCEPTED, and the inherited value decided the comparison that invalidates
  // the entire answer.
  let reads = 0;
  Object.defineProperty(Object.prototype, "timezone", {
    get() {
      reads += 1;
      return "America/Vancouver";
    },
    configurable: true,
  });
  try {
    const p = provenance();
    delete p.timezone;
    assert.equal(Object.hasOwn(p, "timezone"), false, "the premise — nothing owns the field");
    assert.equal(p.timezone, "America/Vancouver", "the premise — the polluted read answers");
    reads = 0;
    assert.throws(
      () => deriveFreshness(p, { start: "2026-01-01", end: "2026-02-01" }),
      (err) => {
        assert.equal(err.name, "FreshnessRequestError");
        assert.match(err.message, /provenance\.timezone is missing/);
        return true;
      },
    );
    assert.equal(reads, 0, "validation must not have read the inherited getter at all");
  } finally {
    delete Object.prototype.timezone;
  }

  // The same on the REQUEST side, where the polluted field is the range itself — a request
  // that named no start was answered about a range the caller never asked for.
  let starts = 0;
  Object.defineProperty(Object.prototype, "start", {
    get() {
      starts += 1;
      return "2026-01-01";
    },
    configurable: true,
  });
  try {
    assert.throws(
      () => deriveFreshness(provenance(), { end: "2026-02-01" }),
      (err) => {
        assert.match(err.message, /request\.start is missing/);
        return true;
      },
    );
    assert.equal(starts, 0, "nor here — every interval owns its own bounds");
  } finally {
    delete Object.prototype.start;
  }

  // And on `day`, whose fields feed the calendar arithmetic.
  Object.defineProperty(Object.prototype, "year", { get: () => 2026, configurable: true });
  try {
    assert.throws(
      () => localDayBounds("UTC", { month: 3, day: 8 }),
      (err) => {
        assert.match(err.message, /day\.year is missing/);
        return true;
      },
    );
  } finally {
    delete Object.prototype.year;
  }
});

test("freshness: a stored interval that ends at or before it starts is refused, not walked", () => {
  // `gapsFor` sorts by start and advances a cursor to each interval's end, which assumes
  // `end > start`. Given `[01-09, 01-05)` against a `[01-01, 01-10)` question the cursor moved
  // BACKWARDS and the function emitted `[01-01, 01-09)` and `[01-05, 01-10)` — overlapping, out
  // of order, and not a set of gaps at all. A zero-length interval is subtler and still wrong:
  // it cannot advance the cursor past itself, so it SPLITS the one gap it sits inside into two
  // adjacent ones. Both are refused at the boundary, where they are still distinguishable.
  for (const [label, bad] of [
    ["inverted", { start: "2026-01-09", end: "2026-01-05" }],
    ["zero-length", { start: "2026-01-05", end: "2026-01-05" }],
  ]) {
    assert.throws(
      () =>
        deriveFreshness(provenance({ coverage: [bad] }), {
          start: "2026-01-01",
          end: "2026-01-10",
        }),
      (err) => {
        assert.equal(err.name, "FreshnessRequestError");
        assert.match(err.message, /provenance\.coverage\[0\] ends at or before it starts/);
        return true;
      },
      label,
    );
    // fieldCoverage is held to exactly the same rule, and names its own path.
    assert.throws(
      () =>
        deriveFreshness(provenance({ fieldCoverage: { cost: [bad] } }), {
          start: "2026-01-01",
          end: "2026-01-10",
          fields: ["cost"],
        }),
      (err) => {
        assert.match(err.message, /provenance\.fieldCoverage\."cost"\[0\] ends at or before/);
        return true;
      },
      label,
    );
  }

  // The honest negative: a well-formed interval in the same position still answers.
  const ok = deriveFreshness(provenance({ coverage: [{ start: "2026-01-05", end: "2026-01-09" }] }), {
    start: "2026-01-05",
    end: "2026-01-09",
  });
  assert.equal(ok.covered, true, "a one-millisecond-wide interval is legal; a zero-wide one is not");

  // And the WRITE side agrees, which is the whole point — a generation cannot be published in a
  // shape the reader will refuse, because that turns a write-time defect into a query-time
  // crash on a document accepted days earlier.
  const { fs, authority } = freshStore();
  for (const bad of [
    { start: "2026-01-09", end: "2026-01-05" },
    { start: "2026-01-05", end: "2026-01-05" },
  ]) {
    assert.throws(
      () =>
        publishSnapshot(
          fs,
          authority,
          P,
          candidate("gen-bad", { claude: 10 }, { provenance: provenance({ coverage: [bad] }) }),
          { live: null },
        ),
      (err) => {
        assert.match(err.message, /ends at or before it starts/);
        return true;
      },
      JSON.stringify(bad),
    );
  }
});

test("freshness: a source timestamp is an instant, not any string that gets echoed back", () => {
  // `result.sourceTimestamps` is what a caller reads to decide how old the data is, so junk here
  // is not inert — it is a wrong answer wearing the shape of a right one. `"whenever"` was
  // copied straight through and returned beside `covered: true`.
  for (const bad of ["whenever", "2026-01-31T00:00:00", "2026-02-30T00:00:00Z", ""]) {
    assert.throws(
      () =>
        deriveFreshness(provenance({ sourceTimestamps: { claude: bad } }), {
          start: "2026-01-01",
          end: "2026-02-01",
        }),
      (err) => {
        assert.equal(err.name, "FreshnessRequestError");
        assert.match(err.message, /provenance\.sourceTimestamps\."claude"/);
        return true;
      },
      JSON.stringify(bad),
    );
  }
  const ok = deriveFreshness(
    provenance({ sourceTimestamps: { claude: "2026-01-31T00:00:00Z" } }),
    { start: "2026-01-01", end: "2026-02-01" },
  );
  assert.equal(ok.sourceTimestamps.claude, "2026-01-31T00:00:00Z");
});

test("freshness: a timezone that does not exist is refused, not reported as a mismatch", () => {
  // Two nonexistent zones compared as STRINGS agreed, so a snapshot stamped `Mars/Olympus`
  // answered a `Mars/Olympus` query as fully covered with the zone check reporting no problem
  // at all. And a nonexistent QUERY zone against a real snapshot came back
  // `timezoneMismatch: true`, which reads as "your snapshot is bucketed by a different zone" —
  // a diagnosis that is simply false when the requested zone is not a zone.
  assert.throws(
    () =>
      deriveFreshness(provenance({ timezone: "Mars/Olympus" }), {
        start: "2026-01-01",
        end: "2026-02-01",
        timezone: "Mars/Olympus",
      }),
    (err) => {
      assert.equal(err.name, "FreshnessRequestError");
      assert.match(err.message, /unknown timezone: Mars\/Olympus/);
      return true;
    },
    "both sides junk, and equal",
  );
  assert.throws(
    () =>
      deriveFreshness(provenance(), {
        start: "2026-01-01",
        end: "2026-02-01",
        timezone: "Mars/Olympus",
      }),
    (err) => {
      assert.match(err.message, /unknown timezone: Mars\/Olympus/);
      return true;
    },
    "query side junk only",
  );
  // And with NO query timezone at all, which is the only shape where the stored side is the one
  // doing the refusing — the two checks are independent, and a test that never separates them
  // would pass with either of them deleted.
  assert.throws(
    () =>
      deriveFreshness(provenance({ timezone: "Mars/Olympus" }), {
        start: "2026-01-01",
        end: "2026-02-01",
      }),
    (err) => {
      assert.match(err.message, /unknown timezone: Mars\/Olympus/);
      return true;
    },
    "stored side only",
  );
  // The honest negative: two REAL zones that differ are still an ordinary mismatch, answered
  // rather than thrown — the check must not have swallowed the case it sits next to.
  const mismatch = deriveFreshness(provenance(), {
    start: "2026-01-01",
    end: "2026-02-01",
    timezone: "UTC",
  });
  assert.equal(mismatch.timezoneMismatch, true);
  assert.equal(mismatch.covered, false);
});

test("freshness: a missing required field is NAMED, and an optional one may simply be absent", () => {
  for (const key of ["coverage", "fieldCoverage", "sourceTimestamps", "timezone"]) {
    const p = provenance();
    delete p[key];
    assert.throws(
      () => deriveFreshness(p, { start: "2026-01-01", end: "2026-02-01" }),
      (err) => {
        assert.equal(err.name, "FreshnessRequestError");
        assert.match(err.message, new RegExp(`provenance\\.${key} is missing`));
        return true;
      },
      key,
    );
  }
  for (const key of ["start", "end"]) {
    const request = { start: "2026-01-01", end: "2026-02-01" };
    delete request[key];
    assert.throws(
      () => deriveFreshness(provenance(), request),
      (err) => {
        assert.match(err.message, new RegExp(`request\\.${key} is missing`));
        return true;
      },
      key,
    );
  }
  // An interval names its own missing bound rather than reporting a type error about undefined.
  assert.throws(
    () =>
      deriveFreshness(provenance({ coverage: [{ start: "2026-01-01" }] }), {
        start: "2026-01-01",
        end: "2026-02-01",
      }),
    /provenance\.coverage\[0\]\.end is missing/,
  );
  // `fields` and `timezone` are OPTIONAL: absent is not missing, and neither is present-and-
  // undefined — a caller building a request with `{ timezone: maybeUndefined }` means the same
  // thing as one that left the key out.
  for (const [label, request] of [
    ["absent", { start: "2026-01-01", end: "2026-02-01" }],
    ["undefined", { start: "2026-01-01", end: "2026-02-01", fields: undefined, timezone: undefined }],
  ]) {
    const ok = deriveFreshness(provenance(), request);
    assert.deepEqual(Object.keys(ok.fields), [], label);
    assert.equal(ok.timezoneMismatch, false, label);
    assert.equal(ok.covered, true, label);
  }
});

test("freshness: one freeze policy across every branch that builds a gap", () => {
  // The timezone-mismatch branch froze its intervals and the four other places this module
  // builds a gap did not, so `result.gaps[0]` was writable after a covered query and frozen
  // after a mismatched one. A caller normalizing the result in place worked until the day the
  // zones differed — which is the day it would be hardest to explain.
  const mismatch = deriveFreshness(provenance(), {
    start: "2026-01-01",
    end: "2026-02-01",
    fields: ["cost"],
    timezone: "UTC",
  });
  const partial = deriveFreshness(provenance(), {
    start: "2026-01-01",
    end: "2026-03-01",
    fields: ["tokens", "nothing-recorded"],
  });
  const samples = [
    ["mismatch summary", mismatch.gaps[0]],
    ["mismatch field", mismatch.fields.cost.gaps[0]],
    ["coverage summary", partial.gaps[0]],
    ["field coverage", partial.fields.tokens.gaps[0]],
    ["unrecorded field", partial.fields["nothing-recorded"].gaps[0]],
  ];
  for (const [label, interval] of samples) {
    assert.ok(interval !== undefined, `${label}: the premise — this branch must produce a gap`);
    assert.equal(Object.isFrozen(interval), false, `${label}: one policy, every branch`);
  }
});

test("freshness: a fields array whose prototype was replaced is refused, iterator and all", () => {
  // `Array.isArray` reads an internal slot, so it is true for a subclass and for an array whose
  // prototype was swapped outright — and both were accepted here while `normalizeIntervals`
  // refused the identical shape two functions down. Nothing dispatches to a method on `fields`
  // today, so this closes no live hole; it is a consistency fix in a defence-in-depth boundary,
  // and it makes the neighbouring test's name true, because "read through descriptors, never
  // iterated" was permitting an array whose `Symbol.iterator` had been overridden.
  class Fields extends Array {}
  const subclass = Fields.from(["cost"]);
  assert.equal(Array.isArray(subclass), true, "the premise — isArray still says yes");
  assert.throws(
    () =>
      deriveFreshness(provenance(), { start: "2026-01-01", end: "2026-02-01", fields: subclass }),
    (err) => {
      assert.equal(err.name, "FreshnessRequestError");
      assert.match(err.message, /fields has an unexpected prototype/);
      return true;
    },
    "subclass",
  );

  let iterated = 0;
  const swapped = ["cost"];
  Object.setPrototypeOf(
    swapped,
    Object.assign(Object.create(Array.prototype), {
      [Symbol.iterator]() {
        iterated += 1;
        return Array.prototype[Symbol.iterator].call(this);
      },
    }),
  );
  assert.equal(Array.isArray(swapped), true, "the premise — isArray still says yes");
  assert.throws(
    () =>
      deriveFreshness(provenance(), { start: "2026-01-01", end: "2026-02-01", fields: swapped }),
    /fields has an unexpected prototype/,
    "replaced prototype",
  );
  assert.equal(iterated, 0, "the overridden iterator must never run");

  // The honest negative: a plain array is still accepted.
  const ok = deriveFreshness(provenance(), {
    start: "2026-01-01",
    end: "2026-02-01",
    fields: ["cost"],
  });
  assert.deepEqual(Object.keys(ok.fields), ["cost"]);
});

test("freshness: sub-millisecond precision is refused rather than truncated into a lie", () => {
  // The grammar took 1..9 fractional digits and every comparison here is a MILLISECOND number,
  // so `.000000000Z` and `.000000001Z` — two different instants — collapsed to the same value.
  // The consequence is not a rounding nicety: the nanosecond range between them became
  // `end <= start`, which `gapsFor` answers as "no gaps", so a range the store holds no data for
  // at all was reported COVERED with an empty gap list.
  const nanos = {
    start: "2026-01-01T00:00:00.000000000Z",
    end: "2026-01-01T00:00:00.000000001Z",
  };
  assert.notEqual(nanos.start, nanos.end, "the premise — these name two different instants");
  assert.throws(
    () => deriveFreshness(provenance(), nanos),
    (err) => {
      assert.equal(err.name, "FreshnessRequestError");
      assert.match(err.message, /must be a real date or an instant with an explicit UTC offset/);
      return true;
    },
  );

  // Zero sub-millisecond digits name a millisecond this module CAN represent, so they are kept
  // — the rule is "refuse precision that would have to be lied about", not "refuse long
  // fractions". Anything with a non-zero digit past the third is refused.
  assert.equal(isExplicitInstant("2026-01-01T00:00:00.123Z"), true);
  assert.equal(isExplicitInstant("2026-01-01T00:00:00.123000000Z"), true);
  assert.equal(isExplicitInstant("2026-01-01T00:00:00.1234Z"), false);
  assert.equal(isExplicitInstant("2026-01-01T00:00:00.000000001Z"), false);

  // And the WRITE side refuses it at publish rather than at query time, because it applies the
  // reader's grammar through this same function.
  const { fs, authority } = freshStore();
  assert.throws(
    () =>
      publishSnapshot(
        fs,
        authority,
        P,
        candidate("gen-ns", { claude: 10 }, {
          provenance: provenance({
            coverage: [{ start: "2026-01-01T00:00:00.000000001Z", end: "2026-02-01" }],
          }),
        }),
        { live: null },
      ),
    /not an instant with an explicit UTC offset/,
  );
});

test("envelope: negative zero is refused rather than silently stored as 0", () => {
  // `JSON.stringify(-0)` is `"0"` — the one number JSON quietly changes. So `-0` and `0`
  // canonicalized to the same bytes and produced the same checksum while `Object.is(-0, 0)` is
  // false: two different documents, one digest, which is the single failure canonicalization
  // exists to prevent. Nothing downstream caught it either, because a body containing `-0` was
  // WRITTEN as `0` and the round-trip check then compared the normalized value with itself.
  assert.equal(Object.is(-0, 0), false, "the premise — these are two different values");
  assert.equal(JSON.stringify(-0), "0", "the premise — JSON.stringify is the one that lies");

  for (const [label, body] of [
    ["bare", -0],
    ["in an object", { total: -0 }],
    ["in an array", [1, -0]],
    ["nested", { a: { b: [{ c: -0 }] } }],
  ]) {
    assert.throws(
      () => canonicalize(body),
      (err) => {
        assert.equal(err.name, "NonCanonicalValueError");
        assert.match(err.message, /negative zero/);
        return true;
      },
      label,
    );
  }
  // Positive zero is ordinary data and must still be accepted — the check must refuse the sign,
  // not the value.
  assert.equal(canonicalize({ total: 0 }), '{"total":0}');
  assert.equal(canonicalize(0), "0");

  // And it is refused at PUBLISH, not discovered later: the writer is the only place that can
  // still tell the caller which field it was.
  const { fs, authority } = freshStore();
  assert.throws(
    () =>
      publishSnapshot(fs, authority, P, candidate("gen-nz", { claude: 10 }, { payload: { total: -0 } }), {
        live: null,
      }),
    (err) => {
      // Same shape as above: the publish-time refusal names the document, and the reason the
      // canonicalizer gave rides along as the cause instead of being flattened into the text.
      assert.match(err.message, /not canonicalizable/);
      assert.match(err.cause.message, /negative zero/);
      return true;
    },
  );
});

test("envelope: the exact-key check compares keys, not a string they were joined into", () => {
  // `Object.keys(env).sort().join(",")` is not an injective picture of a key set, because a key
  // may itself contain a comma. A single key literally named `body,checksum,kind,schemaVersion`
  // renders as the expected string, as does the pair `body,checksum` + `kind,schemaVersion`.
  // Neither could go on to pass the field checks, so nothing wrong was ever ACCEPTED — but the
  // refusal was reported by the wrong guard, with a diagnostic naming the wrong defect.
  const forgeries = [
    ['one key that spells the whole set', { "body,checksum,kind,schemaVersion": 1 }],
    ["two keys that join to it", { "body,checksum": 1, "kind,schemaVersion": 2 }],
  ];
  for (const [label, env] of forgeries) {
    assert.equal(
      Object.keys(env).sort().join(","),
      "body,checksum,kind,schemaVersion",
      `${label}: the premise — the joined form is indistinguishable`,
    );
    assert.throws(
      () => decodeEnvelope("manifest", "/store/manifest.json", `${JSON.stringify(env)}\n`),
      (err) => {
        assert.equal(err.name, "SnapshotStoreResetError");
        assert.equal(err.reason, "manifest-unparsable");
        assert.match(err.message, /envelope keys are/, `${label}: the KEY check must be the one that refuses`);
        return true;
      },
      label,
    );
  }
  // The honest negative: the real key set is still accepted.
  const good = encodeEnvelope("manifest", { activeGenerationId: "gen-1" });
  assert.deepEqual(decodeEnvelope("manifest", "/store/manifest.json", good), {
    activeGenerationId: "gen-1",
  });
});

test("envelope: a malformed checksum is unparsable, not a checksum MISMATCH", () => {
  // `*-checksum-mismatch` says something specific: a well-formed digest disagreed with the
  // body. A checksum of `"zzz"`, or an uppercase one, is a field this protocol could not have
  // written — structurally wrong, which is what `*-unparsable` names. Proving only
  // `typeof === "string"` and letting the comparison below fail reported the wrong fact.
  const body = { activeGenerationId: "gen-1" };
  const realSum = checksumOf(body);
  const malformed = [
    ["not hex", "z".repeat(64)],
    ["too short", realSum.slice(0, 63)],
    ["too long", `${realSum}0`],
    ["uppercase", realSum.toUpperCase()],
    ["empty", ""],
  ];
  for (const [label, checksum] of malformed) {
    const raw = `${JSON.stringify({ body, checksum, kind: "manifest", schemaVersion: SCHEMA_VERSION })}\n`;
    assert.throws(
      () => decodeEnvelope("manifest", "/store/manifest.json", raw),
      (err) => {
        assert.equal(err.reason, "manifest-unparsable", `${label} must be unparsable`);
        assert.match(err.message, /64-character lowercase hex digest/);
        return true;
      },
      label,
    );
  }
  // A WELL-FORMED digest that disagrees is the case `checksum-mismatch` is for, and it must
  // still be reported that way — otherwise this fix would have swallowed the reason it exists
  // to protect.
  const wrongButWellFormed = checksumOf({ activeGenerationId: "gen-2" });
  assert.notEqual(wrongButWellFormed, realSum, "the premise — a different body, a valid digest");
  const raw = `${JSON.stringify({ body, checksum: wrongButWellFormed, kind: "manifest", schemaVersion: SCHEMA_VERSION })}\n`;
  assert.throws(
    () => decodeEnvelope("manifest", "/store/manifest.json", raw),
    (err) => {
      assert.equal(err.reason, "manifest-checksum-mismatch");
      return true;
    },
  );
});

test("envelope: a body the writer could never have produced resets the store, not the process", () => {
  // Self-found. `checksumOf(body)` canonicalizes the body at depth 0; `encodeEnvelope`
  // canonicalizes it NESTED inside the envelope, at depth 1. A body whose deepest leaf sits at
  // exactly the depth limit therefore passes the checksum step and then threw a raw
  // `NonCanonicalValueError` out of `decodeEnvelope` — past every catch in the store, which
  // classifies `SnapshotStoreResetError` and nothing else. A corrupt file that must reset the
  // derived cache crashed the reader instead.
  //
  // This is the module's own recurring defect: a value proven to have one property, then used
  // as though a different property had been proven.
  let body = 1;
  for (let i = 0; i < 64; i++) body = { a: body };
  assert.doesNotThrow(() => checksumOf(body), "the premise — the body checksums on its own");
  assert.throws(
    () => encodeEnvelope("manifest", body),
    /nesting exceeds/,
    "the premise — the same body cannot be wrapped, so it could never have been written",
  );

  const raw = `{"body":${canonicalize(body)},"checksum":${JSON.stringify(checksumOf(body))},` +
    `"kind":"manifest","schemaVersion":${SCHEMA_VERSION}}\n`;
  assert.throws(
    () => decodeEnvelope("manifest", "/store/manifest.json", raw),
    (err) => {
      assert.equal(err.name, "SnapshotStoreResetError", "must be the store's own reset error");
      assert.equal(err.reason, "manifest-unparsable");
      assert.match(err.message, /could not have written it/);
      return true;
    },
  );
});

test("errors: the seam's error code is read as a descriptor, so no accessor runs at the boundary", () => {
  // This is the ONE place the store may inspect a native error, and the permission is to read a
  // field — not to run whatever a getter decides to do. `cause` arrives from a `catch`, so an
  // adapter can be handed a value it did not create; a throwing or hanging accessor at `.code`
  // would replace the classification being computed with an arbitrary failure at the exact seam
  // that exists to prevent one.
  let getterCalls = 0;
  const hostile = Object.defineProperty(new Error("x"), "code", {
    get() {
      getterCalls += 1;
      throw new Error("trap");
    },
    configurable: true,
  });
  const classified = classifyFsError("readFile", "/x", hostile);
  assert.equal(getterCalls, 0, "the accessor must never run");
  assert.equal(snapshotFsErrorKind(classified), "other", "an accessor is not a code");

  // A PROXY, which is the same hazard one level up and was reintroduced by the fix above.
  // `Object.getOwnPropertyDescriptor` is not trap-free: it invokes the proxy's own handler.
  //
  // The trap must not run AT ALL, which is stronger than "a throwing trap is contained" and is
  // the property that matters: a handler returning normally still executes arbitrary code and
  // side effects inside the one function permitted to inspect a native error. Containment alone
  // only covers the half that throws. `node:util.types.isProxy` answers on the internal type
  // without invoking anything, including for a revoked proxy.
  let trapCalls = 0;
  const trapped = new Proxy(new Error("x"), {
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      return { value: "ENOENT", configurable: true, enumerable: true, writable: true };
    },
  });
  assert.equal(
    snapshotFsErrorKind(classifyFsError("readFile", "/x", trapped)),
    "other",
    "a proxy carries no errno this boundary may read",
  );
  assert.equal(trapCalls, 0, "no trap may run inside the classifier, throwing or not");

  // ...and a trap that THROWS is refused by the same identity check, so it never reaches the
  // descriptor read either.
  const throwingTrap = new Proxy(new Error("x"), {
    getOwnPropertyDescriptor() { throw new Error("trap"); },
  });
  assert.equal(snapshotFsErrorKind(classifyFsError("readFile", "/x", throwingTrap)), "other");

  // And a REVOKED proxy, which throws on the operation itself rather than from a handler, so it
  // needs no cooperating code at all. This is the shape that gets a caught value past the one
  // boundary permitted to inspect it.
  const { proxy, revoke } = Proxy.revocable(new Error("x"), {});
  revoke();
  assert.equal(
    snapshotFsErrorKind(classifyFsError("readFile", "/x", proxy)),
    "other",
    "a revoked proxy must classify as other, not throw out of the classifier",
  );

  // INHERITED is not own: a `code` on the prototype describes a different object.
  const inherited = Object.create({ code: "ENOENT" });
  assert.equal(inherited.code, "ENOENT", "the premise — a plain read would find it");
  assert.equal(snapshotFsErrorKind(classifyFsError("readFile", "/x", inherited)), "other");

  // A non-string own `code` is not a code either.
  assert.equal(
    snapshotFsErrorKind(classifyFsError("readFile", "/x", { code: ["ENOENT"] })),
    "other",
  );

  // The honest negative: a real native error still classifies, or this test would pass against
  // a classifier that had simply stopped working.
  const native = Object.assign(new Error("gone"), { code: "ENOENT" });
  assert.equal(snapshotFsErrorKind(classifyFsError("readFile", "/x", native)), "not-found");
  for (const [code, kind] of [["EEXIST", "exists"], ["ELOOP", "symlink"], ["ENOTDIR", "symlink"], ["EFBIG", "too-large"]]) {
    assert.equal(
      snapshotFsErrorKind(classifyFsError("op", "/x", Object.assign(new Error("e"), { code }))),
      kind,
      code,
    );
  }
});

test("authority: an inner that is not an authority is refused at construction, not reported as a LOSS", () => {
  // `onLost` was validated in the constructor and `inner` was not, so
  // `createWriteAuthority(null, handler)` produced a frozen, registered, guarded-looking
  // authority and the defect surfaced at the first `assertHeld()` — as a TypeError, caught by
  // the loss handler. That is not a poor message, it is the wrong EVENT: under AC 8 the loss
  // handler terminates the process or irreversibly disables publishing, so a constructor
  // argument that was never an authority was reported as a lock this process had held and lost.
  for (const [label, bad] of [
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a bare object", {}],
    ["assertHeld is not callable", { assertHeld: "yes" }],
  ]) {
    let handlerRuns = 0;
    assert.throws(
      () => createWriteAuthority(bad, () => { handlerRuns += 1; return TERMINATED; }),
      (err) => {
        assert.equal(err.name, "AuthorityHandlerContractError");
        assert.match(err.message, /inner authority with an assertHeld/);
        return true;
      },
      label,
    );
    assert.equal(handlerRuns, 0, `${label}: no loss happened, so no loss handler may run`);
  }

  // The honest negative: `assertHeld` on a PROTOTYPE is the legitimate shape (a PortLock is a
  // class instance), so the check must not have been written as an own-property test.
  class PortLock {
    assertHeld() {}
  }
  const guard = createWriteAuthority(new PortLock(), () => TERMINATED);
  assert.doesNotThrow(() => guard.assertHeld());
  assert.equal(guard.lost, false);
});

test("authority: a misbehaving handler does not discard the lock loss that triggered it", () => {
  // The contract violation is the more urgent failure and is rightly the one thrown — but
  // `assertHeld`'s `throw cause` is then unreachable, so the loss that started it all was
  // dropped entirely. The operator saw "the handler returned without taking terminal action"
  // and nothing about what was lost. This module already owns the opposite policy for exactly
  // this shape: `SnapshotCommitFailure` keeps both failures and interprets neither.
  const lost = new Error("the port lock moved to another process");
  const guard = createWriteAuthority(
    { assertHeld() { throw lost; } },
    () => "i did nothing",
  );
  assert.throws(
    () => guard.assertHeld(),
    (err) => {
      assert.equal(err.name, "AuthorityHandlerContractError");
      assert.equal(err.lockLossCause, lost, "the cause must travel with it, by reference");
      return true;
    },
  );
  assert.equal(guard.lost, true, "and the latch still holds");

  // A handler that THROWS is taking a blessed terminal action, so its error propagates
  // untouched — this module never writes onto a value someone else threw.
  const handlerError = new Error("terminating now");
  const thrower = createWriteAuthority(
    { assertHeld() { throw lost; } },
    () => { throw handlerError; },
  );
  assert.throws(() => thrower.assertHeld(), (err) => {
    assert.equal(err, handlerError, "the handler's own error, unmodified");
    assert.equal(Object.hasOwn(err, "lockLossCause"), false, "and nothing bolted onto it");
    return true;
  });
});

test("dominance: a negative-zero offset is refused where the source can still be named", () => {
  // `Number.isSafeInteger(-0)` is true and `-0 < 0` is false, so -0 passed both existing
  // checks — and then `canonicalize` refused it at publish, because JSON.stringify would store
  // it as `0` and give two different documents one checksum. One function producing exactly
  // what another refuses is the defect; refusing it here is what lets the message name the
  // source instead of a path inside an envelope.
  assert.throws(
    () => canonicalSourceVersion({ claude: -0 }),
    (err) => {
      assert.equal(err.name, "SourceVersionManifestError");
      assert.match(err.message, /"claude" offset is negative zero/);
      return true;
    },
  );
  // Positive zero is a legitimate offset — the check must refuse the sign, not the value.
  assert.deepEqual({ ...canonicalSourceVersion({ claude: 0 }) }, { claude: 0 });

  // And the publish path refuses it too, so the two sides agree rather than one rescuing the
  // other. (Reaching canonicalize would mean the manifest check above had been bypassed.)
  assert.throws(() => canonicalize({ sourceVersion: { claude: -0 } }), /negative zero/);
});

test("dominance: a re-prototyped exotic is refused, not canonicalized into an empty manifest", () => {
  // The prototype check declared the exotic case "unreachable instead of merely unlikely", and
  // it is not: a prototype is a settable pointer. A re-prototyped Map, Date, Set, boxed
  // primitive or typed array satisfies `getPrototypeOf(x) === Object.prototype`, has no own
  // enumerable properties, and canonicalizes to `{}` — a source-version manifest claiming NO
  // offsets, published as the version record for a snapshot whose real offsets are gone.
  // `ownKeys` is the number of own enumerable keys a descriptor walk WOULD see. It is zero for
  // most of these — the whole payload lives in internal slots — and three for the typed array,
  // whose elements are indices but whose buffer, byteOffset and element type are not. Carried
  // per row rather than asserted uniformly, because a premise that is false for one row is a
  // premise that was never checked.
  const exotics = [
    ["Map", new Map([["claude", 10]]), 0],
    ["Set", new Set([1, 2]), 0],
    ["Date", new Date(0), 0],
    ["boxed number", Object(7), 0],
    ["typed array", new Uint8Array([1, 2, 3]), 3],
    ["ArrayBuffer", new ArrayBuffer(8), 0],
  ];
  for (const [label, exotic, ownKeys] of exotics) {
    Object.setPrototypeOf(exotic, Object.prototype);
    assert.equal(
      Object.getPrototypeOf(exotic),
      Object.prototype,
      `${label}: the premise — the prototype check now passes`,
    );
    assert.equal(
      Object.keys(exotic).length,
      ownKeys,
      `${label}: the premise — what a descriptor walk sees is not this value's state`,
    );
    assert.throws(
      () => canonicalSourceVersion(exotic),
      (err) => {
        assert.equal(err.name, "SourceVersionManifestError");
        assert.match(err.message, /whose state is not own properties/);
        return true;
      },
      label,
    );
  }

  // The same predicate now answers for freshness's containers, so all three modules agree on
  // "is this value's state its own properties?" rather than each arguing it separately.
  const provenanceExotic = Object.setPrototypeOf(new Map(), Object.prototype);
  assert.throws(
    () => deriveFreshness(provenanceExotic, { start: "2026-01-01", end: "2026-02-01" }),
    (err) => {
      assert.equal(err.name, "FreshnessRequestError");
      assert.match(err.message, /whose state is not own properties/);
      return true;
    },
  );

  // The honest negative: an ordinary manifest and an ordinary provenance still pass, or this
  // would be refusing every object rather than the exotic ones.
  assert.deepEqual({ ...canonicalSourceVersion({ claude: 10 }) }, { claude: 10 });
  assert.equal(deriveFreshness(provenance(), { start: "2026-01-01", end: "2026-02-01" }).covered, true);
});

// ---------------------------------------------------------------------------------------
// Round 7 chunk 4 — the store core: proof and use must be of the SAME thing
// ---------------------------------------------------------------------------------------

test("publish: a candidate mutated from inside a seam hook cannot change what is committed", () => {
  // Inertness is proven ONCE, at entry, and nothing freezes the caller's objects. Between that
  // proof and the reads that build the document sit seam calls — and the seam is
  // caller-supplied. A hook fired inside one of them can redefine `payload` as an accessor, so
  // the artifact committed was not the artifact that was checked: the exact guarantee the
  // inertness check exists to provide, defeated through the window after it.
  const { fs, authority } = freshStore();
  const cand = candidate("gen-1", { claude: 10 }, { payload: { total: 1 } });

  let swaps = 0;
  let accessorReads = 0;
  // `readGuarded` on the manifest is the FIRST seam call publishSnapshot makes after proving
  // the arguments inert, which is what makes this window reachable at all.
  fs.hooks.set("openRead", (path) => {
    if (path !== P.manifest || swaps > 0) return;
    swaps += 1;
    Object.defineProperty(cand, "payload", {
      get() {
        accessorReads += 1;
        return { total: 999999 };
      },
      configurable: true,
    });
    Object.defineProperty(cand, "publishedAt", {
      get() {
        accessorReads += 1;
        return "2099-01-01T00:00:00Z";
      },
      configurable: true,
    });
  });

  const result = publishSnapshot(fs, authority, P, cand, { live: null });
  fs.clearHooks();
  assert.equal(swaps, 1, "the premise — the hook must have fired inside a seam call");
  assert.equal(accessorReads, 0, "the swapped-in accessors must never be read");
  assert.equal(result.status, "published");

  const stored = JSON.parse(fs.files.get(`${P.generationsDir}/gen-1.json`).data).body;
  assert.deepEqual(stored.payload, { total: 1 }, "the payload that was VALIDATED is the one stored");
  assert.equal(stored.publishedAt, "2026-01-31T00:00:00Z");
  const manifest = JSON.parse(fs.files.get(P.manifest).data).body;
  assert.equal(manifest.publishedAt, "2026-01-31T00:00:00Z");

  // And the copy is deep: a mutation one level down, inside the nested provenance, is equally
  // out of reach — a shallow copy would leave those trees shared with the caller.
  const { fs: fs2, authority: a2 } = freshStore();
  const cand2 = candidate("gen-2", { claude: 10 });
  fs2.hooks.set("openRead", (path) => {
    if (path === P.manifest) cand2.provenance.timezone = "Mars/Olympus";
  });
  publishSnapshot(fs2, a2, P, cand2, { live: null });
  fs2.clearHooks();
  const stored2 = JSON.parse(fs2.files.get(`${P.generationsDir}/gen-2.json`).data).body;
  assert.equal(stored2.provenance.timezone, "America/Vancouver", "nested state is copied too");
});

test("publish: an immutable artifact appearing at the target before the rename is refused", () => {
  // The single-use rule was enforced by an `lstat` in publishSnapshot, a dozen seam calls
  // before the rename that relies on it — and `rename(2)` REPLACES. A regular file appearing at
  // the target in between was therefore overwritten silently; if that file is the generation
  // the LIVE manifest points at, the prior manifest is left serving content it never
  // referenced, which is the corruption the generation-before-manifest order exists to prevent.
  const { fs, authority } = freshStore();
  const target = `${P.generationsDir}/gen-1.json`;

  // Appears LATE: after publishSnapshot's own existence check, during the commit.
  let planted = false;
  fs.hooks.set("fchmod", () => {
    if (planted) return;
    planted = true;
    fs.files.set(target, { data: "someone else's generation" });
  });
  assert.throws(
    () => publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 10 }), { live: null }),
    (err) => {
      assert.match(err.message, /single-use and a rename would replace it/);
      return true;
    },
  );
  fs.clearHooks();
  assert.equal(planted, true, "the premise — the file must have appeared inside the window");
  assert.equal(
    fs.files.get(target).data,
    "someone else's generation",
    "and the refusal must leave it byte-identical",
  );

  // The honest negative: the MANIFEST is the one artifact a commit is meant to replace, so
  // the same guard must not have broken republishing.
  const { fs: fs2, authority: a2 } = freshStore();
  assert.equal(
    publishSnapshot(fs2, a2, P, candidate("gen-1", { claude: 10 }), { live: null }).status,
    "published",
  );
  const live = JSON.parse(fs2.files.get(P.manifest).data).body;
  assert.equal(
    publishSnapshot(fs2, a2, P, candidate("gen-2", { claude: 20 }), { live }).status,
    "published",
    "a second publish must still replace the manifest",
  );
});

test("classification: a tagged error's message is never read out of the catch", () => {
  // `.message` is an ordinary mutable property on a value this function CAUGHT, and these
  // constructors are exported — so a seam able to throw a genuinely tagged error can redefine
  // `message` as a getter and run its code inside the catch that exists to contain the failure.
  // The whole reason classification reads a private WeakMap instead of `instanceof` is to avoid
  // asking a caught value anything; asking it for a string one line later gave that back.
  const { fs } = publishedStore();
  let getterCalls = 0;
  const hostile = new SnapshotPathError("benign-looking");
  Object.defineProperty(hostile, "message", {
    get() {
      getterCalls += 1;
      return "attacker text";
    },
    configurable: true,
  });
  fs.hooks.set("openRead", (path) => {
    if (path === P.manifest) throw hostile;
  });

  const verdict = classifyStore(fs, P);
  fs.clearHooks();
  assert.equal(verdict.status, "not-usable", "the failure is still converted to a reset");
  assert.equal(getterCalls, 0, "the accessor on the caught value must never run");
  assert.equal(verdict.error.reason, "mode-violation");
  assert.doesNotMatch(verdict.error.message, /attacker text/, "no caught text may reach the message");
  assert.equal(verdict.error.cause, hostile, "the original travels by reference, uninspected");
});

test("gc: a pin read through a substituted pins/ cannot silently protect a generation", () => {
  // The DELETION branch re-proves the container before every unlink; the RETENTION branch read
  // the same file for the opposite decision and was exempt. A pin from a directory that is not
  // the store's cannot delete anything — but it can add an id to `protectedIds`, so the sweep
  // retains generations on the strength of it and then reports success. A verdict assembled
  // across two filesystems is ambiguous, and ambiguous is not something to report as done.
  const { fs, authority, manifest } = publishedStore();
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
  const live2 = JSON.parse(fs.files.get(P.manifest).data).body;
  publishSnapshot(fs, authority, P, candidate("gen-3", { claude: 30 }), {
    live: live2,
    retain: 1,
  });
  createPin(fs, authority, P, { pinId: "pin-1", generationId: "gen-1", until: "2099-01-01T00:00:00Z" });

  // The pin is read, and DURING that read pins/ becomes a different real 0700 directory.
  let swapped = false;
  const realOpenRead = fs.openRead.bind(fs);
  fs.openRead = (path) => {
    const handle = realOpenRead(path);
    if (!swapped && path === `${P.pinsDir}/pin-1.json`) {
      swapped = true;
      const node = fs.nodes.get(P.pinsDir);
      fs.nodes.set(P.pinsDir, { ...node, ino: node.ino + 1000n });
    }
    return handle;
  };

  // A swapped container is a REFUSAL everywhere else in this function — `assertSameContainer`
  // throws, and the caller resets — so that is the disposition this branch must reach too.
  // `abortedOnManifestChange` is the softer answer, and it is for a manifest that moved.
  assert.throws(
    () => collectGarbage(fs, authority, P, "2026-02-01T00:00:00Z"),
    (err) => {
      assert.equal(err.name, "SnapshotPathError");
      assert.match(err.message, /pins was replaced during the operation/);
      return true;
    },
    "the sweep must refuse rather than retain on a pin it read from somewhere else",
  );
  fs.openRead = realOpenRead;
  assert.equal(swapped, true, "the premise — the container must have been replaced mid-read");
  assert.equal(
    fs.files.has(`${P.generationsDir}/gen-1.json`),
    true,
    "and nothing may have been collected on that verdict",
  );
});

// ---------------------------------------------------------------------------------------
// Round 7 chunk 5 — the FAKE must not be more permissive than the adapter it stands for
// ---------------------------------------------------------------------------------------

test("fake: the seam refuses what the real adapter refuses — handles, bytes, names, umask", () => {
  // A test double that is more forgiving than production is the one defect a test double must
  // not have: every proof the suite builds on it is then a proof about a different seam. Each
  // clause below pins a divergence that existed, and each names the adapter behaviour it now
  // matches (all four are exercised against the real kernel in snapshot-realfs.test.mjs).
  const { fs } = freshStore();
  const path = `${P.generationsDir}/gen-x.json`;
  fs.put(path, "{}");

  // 1. HANDLES ARE CAPABILITIES. A literal with the right brand used to reach a descriptor,
  //    because every method looked up `handle.fd`.
  const handle = fs.openRead(path);
  // The forgery names a LIVE descriptor — this one. A made-up number would be refused by a fake
  // that still trusted `handle.fd`, so the fixture would pass against the defect it is for.
  const liveFd = fs.entryFor(handle).fd;
  const forged = { __brand: "SnapshotFileHandle", fd: liveFd };
  for (const [label, run] of [
    ["readAll", () => fs.readAll(forged, 1024)],
    ["fstat", () => fs.fstat(forged)],
    ["fchmod", () => fs.fchmod(forged, 0o600)],
    ["write", () => fs.write(forged, new TextEncoder().encode("x"), 0)],
    ["close", () => fs.close(forged)],
  ]) {
    assert.throws(run, (err) => {
      assert.equal(err.cause.code, "EBADF", label);
      return true;
    }, label);
  }
  assert.notEqual(fs.entryFor(handle), null, "and the forged close must not have revoked ours");
  assert.equal(fs.readAll(handle, 1024), "{}");
  assert.equal(Object.isFrozen(handle), true, "a real handle carries no fd to edit");
  assert.deepEqual(Object.keys(handle), ["__brand"]);
  fs.close(handle);
  assert.throws(() => fs.readAll(handle, 1024), (err) => err.cause.code === "EBADF", "closed is dead");

  // 2. READS COME FROM THE DESCRIPTOR POSITION and advance it, as the adapter's loop does.
  //    Returning the whole inode every time meant a double-read bug passed only under the fake.
  const twice = fs.openRead(path);
  assert.equal(fs.readAll(twice, 1024), "{}");
  assert.equal(fs.readAll(twice, 1024), "", "a second read is at EOF, not the file again");
  fs.close(twice);

  // 3. INVALID UTF-8 IS REFUSED, not replaced with U+FFFD.
  fs.putBytes(`${P.generationsDir}/bad.json`, Buffer.from([0x7b, 0x80, 0x7d]));
  assert.throws(
    () => fs.readFile(`${P.generationsDir}/bad.json`),
    (err) => {
      assert.equal(err.cause.code, "EILSEQ");
      // And the DECODER's own failure travels underneath, as `decodeUtf8` makes it in the
      // adapter. `readStoreFile` forwards that value into the reset diagnostic, so a fake that
      // never supplied one could not fail when the store stopped forwarding it — the divergence
      // would be invisible from exactly the suite that tests the forwarding.
      assert.notEqual(err.cause.cause, undefined, "the decoder's failure must travel");
      return true;
    },
  );
  const badHandle = fs.openRead(`${P.generationsDir}/bad.json`);
  assert.throws(
    () => fs.readAll(badHandle, 1024),
    (err) => err.cause.code === "EILSEQ" && err.cause.cause !== undefined,
  );
  fs.close(badHandle);

  // 4. AN ENTRY NAME MUST ROUND-TRIP UTF-8. A lone surrogate is a name a JS fixture can hold
  //    and a filesystem cannot, so the adapter refuses it and the fake used to hand it over.
  //
  //    EBADMSG, not EILSEQ, and the two codes carry two DISPOSITIONS rather than two spellings.
  //    EILSEQ classifies as `invalid-content`, which `readStoreFile` turns into an unusable
  //    artifact and the store resets on. A bad entry NAME must not reset: the store cannot
  //    address such a name to delete it, so a reset would report work it could not perform, and
  //    production lets it propagate instead (ISS-069). This assertion is what keeps the fake on
  //    the production side of that split — while it said EILSEQ, a fixture here would have
  //    driven the store to RESET at exactly the point production propagates.
  fs.put(`${P.pinsDir}/lone-\ud800.json`, "{}");
  assert.throws(
    () => fs.listDir(P.pinsDir),
    (err) => {
      assert.equal(err.cause.code, "EBADMSG");
      return true;
    },
  );

  // 5. THE RAW MODE, including the file-type bits. `SnapshotStat.mode` is documented as the raw
  //    mode and the adapter returns `Number(stat.mode)`, which carries S_IFMT. Returning
  //    permission bits alone was a divergence in the direction that HIDES bugs: a store that
  //    compared `stat.mode` against 0o600 or 0o700 directly, with no mask, passed every test in
  //    this file and rejected every real file and directory on disk.
  fs.mkfifo(`${P.stagingDir}/pipe`);
  for (const [what, at, typeBit, perms] of [
    ["a regular file", path, 0o100000, 0o600],
    ["a directory", P.generationsDir, 0o040000, 0o700],
    ["a fifo", `${P.stagingDir}/pipe`, 0o010000, 0o600],
  ]) {
    const st = fs.lstat(at);
    assert.equal(st.mode & 0o170000, typeBit, `${what}: file-type bits`);
    assert.equal(st.mode & 0o7777, perms, `${what}: permission bits`);
  }
  fs.symlink(`${P.stagingDir}/link`, "/elsewhere");
  assert.equal(fs.lstat(`${P.stagingDir}/link`).mode & 0o170000, 0o120000, "a symlink's type bits");
  const dirHandle = fs.openDir(P.generationsDir);
  assert.equal(fs.fstat(dirHandle).mode & 0o170000, 0o040000, "fstat carries them too");
  fs.close(dirHandle);

  // 6. ACCESS MODE is enforced, because the adapter's descriptors have one. `openRead` and
  //    `openDir` are O_RDONLY and `openExclusive` is `wx` (O_WRONLY | O_CREAT | O_EXCL), so a
  //    write through the first or a read through the last is EBADF on a real filesystem. The
  //    fake used to allow both, which would leave a store that mixed up its handles green here.
  const ro = fs.openRead(path);
  assert.throws(
    () => fs.write(ro, Buffer.from("x"), 0),
    (err) => err.cause.code === "EBADF",
    "a write through O_RDONLY must be refused",
  );
  fs.close(ro);
  const wo = fs.openExclusive(`${P.stagingDir}/write-only.json`);
  assert.throws(
    () => fs.readAll(wo, 16),
    (err) => err.cause.code === "EBADF",
    "a read through O_WRONLY must be refused",
  );
  // ...and `fchmod` and `fstat` still work on both, because neither needs an access mode.
  assert.doesNotThrow(() => fs.fchmod(wo, 0o600));
  assert.doesNotThrow(() => fs.fstat(wo));
  fs.close(wo);

  // 7. A NON-BLOCKING FIFO WITH NO WRITER READS EOF, not EAGAIN. EAGAIN is what a reader gets
  //    when a writer is open and nothing is buffered — a state no fixture here creates — so
  //    raising it would have the fake produce a failure the kernel cannot produce at this point.
  const fifoHandle = fs.openRead(`${P.stagingDir}/pipe`);
  assert.equal(fs.readAll(fifoHandle, 16), "", "a writerless FIFO reads EOF");
  fs.close(fifoHandle);

  // 8. THE HANDLE MAP GOES THROUGH THE PINNED INTRINSICS, as the adapter's does. A dynamic
  //    `WeakMap.prototype.get` here would resolve a forged handle under exactly the global
  //    patch that production now survives — a fake weaker than the thing it stands in for
  //    cannot falsify the thing it stands in for.
  const forgedHandle = Object.freeze({ __brand: "SnapshotFileHandle" });
  const savedGet = WeakMap.prototype.get;
  let fakeThrew = null;
  try {
    WeakMap.prototype.get = () => ({ fd: 1, node: { type: "file", bytes: Buffer.from("x") }, path: "/", position: 0, readable: true });
    try {
      fs.readAll(forgedHandle, 16);
    } catch (err) {
      fakeThrew = err;
    }
  } finally {
    WeakMap.prototype.get = savedGet;
  }
  assert.notEqual(fakeThrew, null, "the fake resolved a forged handle through a patched global");
  assert.equal(fakeThrew.cause.code, "EBADF");

  // 9. A UMASK THE ADAPTER REFUSES AT CONSTRUCTION cannot be configured here either.
  const clean = new FakeFs();
  for (const bad of [0o400, 0o500, 0o700]) {
    assert.throws(
      () => { clean.umaskBits = bad; },
      /removes owner READ/,
      bad.toString(8),
    );
  }
  for (const ok of [0o000, 0o022, 0o077, 0o200, 0o300]) {
    assert.doesNotThrow(() => { clean.umaskBits = ok; }, ok.toString(8));
  }
});

test("fake: the close hook fires BEFORE the close, and the descriptor is consumed either way", () => {
  // The fd was released before the hook dispatched, which modelled close(2) correctly and broke
  // the suite's other rule — every hook fires before its operation, and every close-window
  // fixture is written against that boundary. Observers were landing AFTER the close they were
  // placed to observe. Both rules hold now: hook first, revoke in `finally`.
  const { fs } = freshStore();
  fs.put(`${P.generationsDir}/gen-x.json`, "{}");

  let liveAtHook = null;
  const handle = fs.openRead(`${P.generationsDir}/gen-x.json`);
  fs.hooks.set("close", () => {
    liveAtHook = fs.entryFor(handle) !== null;
  });
  fs.close(handle);
  fs.clearHooks();
  assert.equal(liveAtHook, true, "the hook must observe the descriptor still open");
  assert.equal(fs.entryFor(handle), null, "and it is gone once close returns");

  // An INJECTED close failure still consumes the descriptor — close(2) does, EIO included, so a
  // fake that handed it back would quietly weaken every close-exactly-once assertion.
  const second = fs.openRead(`${P.generationsDir}/gen-x.json`);
  fs.failOn("close", null, errno("EIO"));
  assert.throws(() => fs.close(second), (err) => err.cause.code === "EIO");
  fs.clearHooks();
  assert.equal(fs.entryFor(second), null, "the descriptor is gone despite the failure");
  assert.throws(() => fs.close(second), (err) => err.cause.code === "EBADF", "closing again is EBADF");
});

// ---------------------------------------------------------------------------------------
// readGeneration (T-025 item 2) — pinned reads that do not follow the manifest
// ---------------------------------------------------------------------------------------

test("readGeneration: a retained id is served, bound to the requested id", () => {
  const { fs } = publishedStore();
  const r = readGeneration(fs, P, "gen-1");
  assert.equal(r.status, "ok");
  assert.equal(r.generation.generationId, "gen-1");
});

test("readGeneration: does NOT follow the manifest — the old id still serves after a publish", () => {
  const { fs, authority, manifest } = publishedStore();
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
  const current = readSnapshot(fs, P);
  assert.equal(current.view.generation.generationId, "gen-2");
  const pinned = readGeneration(fs, P, "gen-1");
  assert.equal(pinned.status, "ok");
  assert.equal(pinned.generation.generationId, "gen-1");
});

test("readGeneration: a pinned-but-unreferenced id is served through the pin scan", () => {
  const { fs, authority, manifest } = publishedStore();
  createPin(fs, authority, P, { pinId: "pin-1", generationId: "gen-1", until: "2099-01-01" });
  // retain: 1 evicts gen-1 from the manifest; only the pin authorizes it now.
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), {
    live: manifest,
    retain: 1,
  });
  const m = JSON.parse(fs.files.get(P.manifest).data).body;
  assert.deepEqual(m.retainedGenerationIds, ["gen-2"], "gen-1 must really be unreferenced");
  const r = readGeneration(fs, P, "gen-1");
  assert.equal(r.status, "ok");
  assert.equal(r.generation.generationId, "gen-1");
});

test("readGeneration: an id nothing authorizes is not-retained, and never touches the file", () => {
  const { fs, authority, manifest } = publishedStore();
  // A REAL generation file that is neither retained nor pinned must still refuse: presence
  // on disk is not authorization. Manufacture one by evicting gen-1 without pinning it.
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), {
    live: manifest,
    retain: 1,
  });
  assert.equal(fs.files.has(`${P.generationsDir}/gen-1.json`), true, "file must exist unreferenced");
  assert.equal(readGeneration(fs, P, "gen-1").status, "not-retained");
  assert.equal(readGeneration(fs, P, "gen-9").status, "not-retained");
});

test("readGeneration: a malformed or hostile id is not-retained, not a throw", () => {
  const { fs } = publishedStore();
  for (const bad of ["", "../gen-1", "a/b", ".", "gen 1"]) {
    assert.equal(readGeneration(fs, P, bad).status, "not-retained", JSON.stringify(bad));
  }
});

test("readGeneration: an authorized id whose file is missing is gone, not no-snapshot", () => {
  const { fs } = publishedStore();
  fs.files.delete(`${P.generationsDir}/gen-1.json`);
  assert.equal(readGeneration(fs, P, "gen-1").status, "gone");
});

test("readGeneration: a checksum-valid DIFFERENT generation wearing the filename is gone", () => {
  const { fs, authority, manifest } = publishedStore();
  publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
  // Substitute gen-2's complete, checksum-valid file under gen-1's name. Only the
  // id-binding inside assertGenerationInvariants can object now.
  const g2 = fs.files.get(`${P.generationsDir}/gen-2.json`);
  fs.files.set(`${P.generationsDir}/gen-1.json`, { ...g2 });
  assert.equal(readGeneration(fs, P, "gen-1").status, "gone");
});

test("readGeneration: attempts is validated with readSnapshot's rule", () => {
  const { fs } = publishedStore();
  for (const bad of [0, -1, 17, NaN, 2.5]) {
    assert.throws(() => readGeneration(fs, P, "gen-1", bad));
  }
});

test("readGeneration: no usable manifest means no-snapshot even for a plausible id", () => {
  const { fs } = publishedStore();
  fs.files.delete(P.manifest);
  assert.equal(readGeneration(fs, P, "gen-1").status, "no-snapshot");
});
