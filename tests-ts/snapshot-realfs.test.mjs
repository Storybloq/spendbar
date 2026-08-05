// T-010 against the REAL filesystem.
//
// Everything else in this ticket's suite runs on `FakeFs`, which is what makes the failure
// matrix injectable. But three of the store's claims are claims about the kernel, and a fake
// cannot testify about the kernel:
//
//   - the umask window (AC 9): `mkdir(2)` masks the mode it is given, so whether a directory
//     is ever group-readable is a question about umask arithmetic in a real process;
//   - symlink traversal: whether `listDir` follows a link, and whether `unlink` removes the
//     link or its target, is the kernel's answer, and the store's containment depends on it;
//   - errno parity: the fake's faults are only meaningful if the real seam raises the same
//     codes in the same situations.
//
// So this file runs the real adapter in temp directories, and pins the fake to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nfs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";

import { FakeFs, FakeAuthority } from "./snapshot-fakefs.mjs";
import { createWriteAuthority, TERMINATED } from "../dist/snapshot/authority.js";
import { createNodeSnapshotFs, assertRequiredOpenFlags, assertUmaskAllowsOwnerModes } from "../dist/snapshot/node-fs.js";
import { storePaths, classifyStore, collectGarbage, createPin, resetStore, startWriter, publishSnapshot, readSnapshot } from "../dist/snapshot/store.js";

const DIST = new URL("../dist/snapshot/", import.meta.url).href;
// A real latching authority that never loses the lock. It cannot be a bare
// `{ assertHeld() {} }` any more: the store's entry points require an authority produced by
// `createWriteAuthority`, checked nominally at compile time and by membership in a
// module-private WeakSet at runtime (`instanceof` is forgeable via Object.create).
const HELD = createWriteAuthority({ assertHeld() {} }, () => TERMINATED);

/** The first `mkfifo` that actually exists. Absent everywhere is a hard failure, not a skip. */
function mkfifoBinary() {
  for (const candidate of ["/usr/bin/mkfifo", "/bin/mkfifo", "/usr/local/bin/mkfifo"]) {
    if (nfs.existsSync(candidate)) return candidate;
  }
  throw new Error("no mkfifo binary found; this test cannot be silently skipped");
}

const CREATED_DIRS = [];

function tempDir(prefix) {
  const dir = nfs.mkdtempSync(`${os.tmpdir()}/spendbar-${prefix}-`);
  CREATED_DIRS.push(dir);
  // macOS resolves /var -> /private/var; the store refuses "." and ".." components, and a
  // symlinked prefix would make every containment assertion here ambiguous.
  return nfs.realpathSync(dir);
}

// Every root this file creates is removed when the suite finishes. Without it each run —
// including each successful one — left a complete store tree behind under the system temp
// directory, forever, on every developer machine and every CI worker.
process.on("exit", () => {
  for (const dir of CREATED_DIRS) {
    try {
      nfs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort at exit; a leaked temp dir must never fail a green suite.
    }
  }
});

function provenance() {
  return {
    coverage: [{ start: "2026-01-01", end: "2026-02-01" }],
    fieldCoverage: { cost: [{ start: "2026-01-01", end: "2026-02-01" }] },
    sourceTimestamps: { claude: "2026-01-31T00:00:00Z" },
    refreshTier: "slow",
    ccusageVersion: "17.1.3",
    ccusageInvokedAt: "2026-01-31T00:00:00Z",
    timezone: "America/Vancouver",
    dayBoundaryPolicy: "local-midnight",
  };
}

function candidate(id, sourceVersion) {
  return {
    generationId: id,
    sourceVersion,
    provenance: provenance(),
    payload: { total: 1 },
    publishedAt: "2026-01-31T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------------------
// AC 9 — the child-process umask matrix
// ---------------------------------------------------------------------------------------

const UMASK_CHILD = `
import * as nfs from "node:fs";
const [maskOct, stateDir, distUrl] = process.argv.slice(2);
process.umask(parseInt(maskOct, 8));

const { createNodeSnapshotFs } = await import(distUrl + "node-fs.js");
const { storePaths, startWriter, publishSnapshot } = await import(distUrl + "store.js");
const { createWriteAuthority, TERMINATED } = await import(distUrl + "authority.js");

const seam = createNodeSnapshotFs();
const observed = [];
// The window under test is between mkdir(2) returning and the store's chmod landing. It is
// observed by stat-ing INSIDE the seam, synchronously after the real mkdir returns — which is
// the only place that interval exists.
const watched = {
  ...seam,
  mkdir(path, mode) {
    seam.mkdir(path, mode);
    observed.push(["mkdir", path, nfs.lstatSync(path).mode & 0o7777]);
  },
  // FILE creation is watched too. Wrapping only mkdir meant a regression that made
  // openExclusive request 0666 would leave every snapshot artifact world-readable under umask
  // 022 for the whole interval until fchmod — and this matrix, named for exactly that class of
  // window, would have reported it clean.
  //
  // The OPERATION is recorded alongside the mode, because the parent has to be able to tell
  // that this observer ran at all. An untagged list is satisfied by the four mkdirs on its
  // own, so deleting this wrapper entirely left the matrix green — the file-creation window
  // was added and was not itself falsifiable.
  openExclusive(path) {
    const handle = seam.openExclusive(path);
    observed.push(["openExclusive", path, seam.fstat(handle).mode & 0o7777]);
    return handle;
  },
};

const P = storePaths(stateDir);
const authority = createWriteAuthority({ assertHeld() {} }, () => TERMINATED);
startWriter(watched, authority, P);
publishSnapshot(watched, authority, P, {
  generationId: "gen-1",
  sourceVersion: { claude: 1 },
  provenance: {
    coverage: [], fieldCoverage: {}, sourceTimestamps: {},
    refreshTier: "slow", ccusageVersion: "17.1.3", ccusageInvokedAt: "2026-01-31T00:00:00Z",
    timezone: "UTC", dayBoundaryPolicy: "local-midnight",
  },
  payload: { total: 1 },
  publishedAt: "2026-01-31T00:00:00Z",
}, { live: null });

const final = {};
for (const path of [P.root, P.generationsDir, P.pinsDir, P.stagingDir, P.manifest]) {
  final[path] = nfs.lstatSync(path).mode & 0o7777;
}
// ...and every artifact the publish actually wrote. Checking only manifest.json meant a
// kind-specific regression leaving GENERATION files at the wrong mode passed a test whose
// name is about exact file modes.
for (const dir of [P.generationsDir, P.pinsDir, P.stagingDir]) {
  for (const entry of nfs.readdirSync(dir)) {
    const p = dir + "/" + entry;
    final[p] = nfs.lstatSync(p).mode & 0o7777;
  }
}
process.stdout.write(JSON.stringify({ observed, final }));
`;

for (const mask of ["022", "0200", "077"]) {
  test(`privacy: under umask ${mask} the store is never group- or world-accessible, even briefly`, () => {
    const work = tempDir(`umask-${mask}`);
    const script = `${work}/child.mjs`;
    nfs.writeFileSync(script, UMASK_CHILD);
    const stateDir = `${work}/state`;
    nfs.mkdirSync(stateDir, { mode: 0o700 });

    const out = execFileSync(process.execPath, [script, mask, stateDir, DIST], {
      encoding: "utf8",
    });
    const { observed, final } = JSON.parse(out);

    // Both observers must have FIRED, named individually. `observed.length >= 4` was satisfied
    // by the four directory creations alone, so removing the openExclusive wrapper — the file
    // half of the very window this matrix is named for — left the test green. A count is not a
    // coverage assertion; these are.
    const dirs = observed.filter(([op]) => op === "mkdir").map(([, path]) => path);
    const files = observed.filter(([op]) => op === "openExclusive").map(([, path]) => path);
    assert.deepEqual(
      [...new Set(dirs)].sort(),
      [`${stateDir}/store-v1`, `${stateDir}/store-v1/generations`,
       `${stateDir}/store-v1/pins`, `${stateDir}/store-v1/staging`].sort(),
      `umask ${mask}: the store did not create the directories this matrix watches`,
    );
    // The publish stages a generation and a manifest; each is created by openExclusive, and
    // each is a file that exists at some mode before fchmod runs.
    assert.deepEqual(
      files.sort(),
      [`${stateDir}/store-v1/staging/generation.json`,
       `${stateDir}/store-v1/staging/manifest.json`].sort(),
      `umask ${mask}: the file-creation window was never observed`,
    );

    for (const [op, path, mode] of observed) {
      // 022 is the failure this exists for: without a mode passed to mkdir(2), Node requests
      // 0777, the umask trims it to 0755, and the directory is world-traversable for the
      // whole interval until the chmod. A window is a violation of "exactly 0700, always".
      assert.equal(
        mode & 0o077,
        0,
        `umask ${mask}: ${path} was ${mode.toString(8)} immediately after mkdir — a real window`,
      );
    }

    for (const [path, mode] of Object.entries(final)) {
      const expected = path.endsWith(".json") ? 0o600 : 0o700;
      // 0200 is the other failure: a umask that masks the OWNER's write bit must still end at
      // 0700, or the writer creates a store it cannot use and cannot repair.
      assert.equal(mode, expected, `umask ${mask}: ${path} settled at ${mode.toString(8)}`);
    }
  });
}

// ---------------------------------------------------------------------------------------
// Containment, against the kernel's own symlink semantics
// ---------------------------------------------------------------------------------------

/** Builds a store skeleton with one owned directory replaced by a symlink to a victim tree. */
function storeWithSymlinkedPrefix(which, { relative = false } = {}) {
  const work = tempDir(`symlink-${which}`);
  const stateDir = `${work}/state`;
  const victim = `${work}/victim`;
  nfs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  nfs.mkdirSync(victim, { mode: 0o700 });
  nfs.writeFileSync(`${victim}/precious.txt`, "do not delete me", { mode: 0o600 });
  nfs.mkdirSync(`${victim}/nested`, { mode: 0o700 });
  nfs.writeFileSync(`${victim}/nested/also-precious.txt`, "nor me", { mode: 0o600 });

  const P = storePaths(stateDir);
  nfs.mkdirSync(P.root, { recursive: true, mode: 0o700 });
  for (const dir of [P.generationsDir, P.pinsDir, P.stagingDir]) {
    if (`${P.root}/${which}` === dir) continue;
    nfs.mkdirSync(dir, { mode: 0o700 });
  }

  const linkPath = which === "root" ? P.root : `${P.root}/${which}`;
  if (which === "root") nfs.rmSync(P.root, { recursive: true });
  // A RELATIVE target is the common form and resolves through "..", which is the case a
  // literal-path fake could not model at all.
  const target = relative
    ? `${"../".repeat(linkPath.replace(`${work}/`, "").split("/").length - 1)}victim`
    : victim;
  nfs.symlinkSync(target, linkPath);
  return { work, stateDir, victim, P };
}

/**
 * The victim's own file, for the populated fixture (which also copies store artifacts in).
 *
 * Flat on purpose. The nested directory this used to carry sorted ahead of everything else and
 * made a containment-less GC throw on EISDIR before it could delete anything — so the tree that
 * was supposed to raise the stakes was in fact what protected the victim.
 */
function victimIntact2(victim) {
  assert.equal(nfs.readFileSync(`${victim}/precious.txt`, "utf8"), "do not delete me");
  assert.equal(nfs.lstatSync(victim).mode & 0o7777, 0o700);
}

function victimIntact(victim) {
  assert.deepEqual(nfs.readdirSync(victim).sort(), ["nested", "precious.txt"]);
  assert.equal(nfs.readFileSync(`${victim}/precious.txt`, "utf8"), "do not delete me");
  assert.equal(nfs.readFileSync(`${victim}/nested/also-precious.txt`, "utf8"), "nor me");
  // chmod(2) follows symlinks, so "repairing the mode" through a link would land here too.
  assert.equal(nfs.lstatSync(victim).mode & 0o7777, 0o700);
}

for (const which of ["root", "generations", "pins", "staging"]) {
  for (const relative of [false, true]) {
    const shape = relative ? "relative" : "absolute";
    test(`containment: a ${shape}-symlinked ${which} is never followed by reset (real fs)`, () => {
      const { victim, P } = storeWithSymlinkedPrefix(which, { relative });
      const fs = createNodeSnapshotFs();

      assert.equal(classifyStore(fs, P).status, "not-usable", which);
      const reset = resetStore(fs, HELD, P);
      assert.equal(reset.stoppedOnAuthorityLoss, false);

      victimIntact(victim);

      // ...and the store converges: the link is gone, a real directory is back.
      const linkPath = which === "root" ? P.root : `${P.root}/${which}`;
      assert.equal(nfs.lstatSync(linkPath).isSymbolicLink(), false, which);
      startWriter(fs, HELD, P);
      assert.equal(classifyStore(fs, P).status, "first-run", which);
      publishSnapshot(fs, HELD, P, candidate("gen-1", { claude: 1 }), { live: null });
      assert.equal(readSnapshot(fs, P).view.generation.generationId, "gen-1");
      victimIntact(victim);
    });
  }
}

for (const which of ["root", "generations", "pins", "staging"]) {
  test(`startup: a symlinked ${which} is reported and reset, never silently replaced (real fs)`, () => {
    // `startWriter` is the entry point production uses, and it is where this defect lived: it
    // ensures the skeleton BEFORE it classifies, and the ensure used to unlink a symlink at a
    // container's name and create a real directory there. Classification then saw a clean
    // skeleton and answered `first-run` — the store destroyed and reported as never having
    // existed, with no reset reason and nothing in `resetError` for an operator to read. The
    // tests above drive `classifyStore` and `resetStore` by hand, which skips precisely the
    // step that was wrong; only this one goes through it.
    const { victim, P } = storeWithSymlinkedPrefix(which);
    const fs = createNodeSnapshotFs();

    const started = startWriter(fs, HELD, P);
    assert.equal(started.status, "not-usable", which);
    assert.equal(started.resetError.reason, "unknown-entry", which);
    assert.equal(started.reset.stoppedOnAuthorityLoss, false, which);
    assert.deepEqual(started.sweptStaging, [], which);

    // The kernel's own semantics, not a fake's: the link was removed, its target was not.
    victimIntact(victim);
    const linkPath = which === "root" ? P.root : `${P.root}/${which}`;
    const now = nfs.lstatSync(linkPath);
    assert.equal(now.isSymbolicLink(), false, which);
    assert.equal(now.isDirectory(), true, which);
    assert.equal(now.mode & 0o7777, 0o700, which);
    assert.equal(classifyStore(fs, P).status, "first-run", which);
  });
}

/**
 * A REAL, populated store — manifest, generations, the lot — with one owned directory then
 * diverted to a symlink pointing at a victim tree.
 *
 * This exists because the skeleton fixture above could not test the reader or GC at all. Both
 * of them read the manifest FIRST and stop when there is not one: the reader returns
 * `no-snapshot` and GC returns `noUsableManifest` having decided nothing and deleted nothing.
 * So a containment test built on an empty skeleton passes against a store with no containment
 * whatsoever — it never reaches the code it names. The victim files were never in danger, and
 * `victimIntact` was asserting that nothing happened in a scenario where nothing could.
 *
 * Here the manifest is real and stays in the un-diverted root, so the plan GC forms and the
 * generations the reader goes looking for are both genuine. The only thing standing between
 * the victim's files and deletion is the containment check.
 */
function populatedStoreDivertedTo(which, { generations = 3 } = {}) {
  const work = tempDir(`divert-${which}`);
  const stateDir = `${work}/state`;
  const victim = `${work}/victim`;
  nfs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const P = storePaths(stateDir);
  const fs = createNodeSnapshotFs();

  startWriter(fs, HELD, P);
  let live = null;
  for (let i = 1; i <= generations; i++) {
    const result = publishSnapshot(fs, HELD, P, candidate(`gen-${i}`, { claude: i }), {
      live,
      retain: 1,
    });
    assert.equal(result.status, "published", `gen-${i}`);
    live = JSON.parse(nfs.readFileSync(P.manifest, "utf8")).body;
  }

  // A REAL, COLLECTABLE pin, so the pins scenario has something GC actually wants to delete.
  //
  // Without it the pins fixture was empty and the victim's only entries were an ordinary file
  // and a nested directory — and `nested` sorts first, so a containment-less GC read it,
  // failed on EISDIR, and threw. The old assertion accepted any `SnapshotFsError`, the victim
  // was still byte-identical because nothing had been deleted yet, and the test passed against
  // a build with no containment at all. The pin below is expired against the sweep clock, so a
  // GC that resolves the link has a specific file it is entitled to unlink and will.
  createPin(fs, HELD, P, {
    pinId: "collectable-pin",
    generationId: "gen-1",
    until: "2026-01-01T00:00:00Z",
  });

  // The victim inherits the diverted directory's real contents, so the names GC and the reader
  // will look for are actually there — a decoy that is byte-identical to the real thing.
  const diverted = `${P.root}/${which}`;
  nfs.mkdirSync(victim, { mode: 0o700 });
  nfs.writeFileSync(`${victim}/precious.txt`, "do not delete me", { mode: 0o600 });
  for (const entry of nfs.readdirSync(diverted)) {
    nfs.copyFileSync(`${diverted}/${entry}`, `${victim}/${entry}`);
    nfs.chmodSync(`${victim}/${entry}`, 0o600);
  }
  nfs.rmSync(diverted, { recursive: true });
  nfs.symlinkSync(victim, diverted);

  return { work, stateDir, victim, P, fs, live };
}

for (const which of ["generations", "pins"]) {
  test(`containment: collectGarbage refuses a symlinked ${which} with a real plan (real fs)`, () => {
    const { victim, P, fs } = populatedStoreDivertedTo(which);

    // The manifest is real and unreachable by the symlink, so GC forms a genuine plan: with
    // retain 1, gen-1 and gen-2 are unreferenced, and the pin is expired. Following the link
    // would unlink the victim's copies of exactly those names.
    const beforeVictim = nfs.readdirSync(victim).sort();
    const bait = which === "pins" ? "collectable-pin.json" : "gen-1.json";
    assert.ok(
      beforeVictim.includes(bait),
      `the victim must hold a name GC wants to collect: ${beforeVictim}`,
    );
    // Every entry is a plain file, so nothing in the victim can raise before GC reaches a
    // deletion. If containment is removed, the failure mode is a DELETION, not an EISDIR.
    for (const entry of beforeVictim) {
      assert.ok(nfs.lstatSync(`${victim}/${entry}`).isFile(), `${entry} must be a plain file`);
    }

    // The outcome is CAPTURED rather than asserted inline, so the victim can be checked before
    // the error is. Asserted the other way round, a build that followed the link and deleted
    // the bait failed with "Missing expected exception" — true, and not the thing that went
    // wrong. The harm is the deletion; the failure message should say so.
    let raised = null;
    try {
      collectGarbage(fs, HELD, P, "2026-02-01T00:00:00Z");
    } catch (err) {
      raised = err;
    }

    assert.ok(nfs.existsSync(`${victim}/${bait}`), `GC collected ${bait} through the link`);
    assert.deepEqual(nfs.readdirSync(victim).sort(), beforeVictim, "GC deleted through the link");
    victimIntact2(victim);

    // ...and only then, that the refusal was about THIS container being a symlink, rather than
    // an incidental filesystem error raised somewhere along the way.
    assert.ok(raised, "collectGarbage returned normally through a symlinked container");
    assert.equal(raised.name, "SnapshotPathError", raised.message);
    assert.match(raised.message, new RegExp(`${P.root}/${which} is a symlink`));
  });
}

test("containment: the reader never serves a generation through a symlinked prefix (real fs)", () => {
  const { P, victim } = populatedStoreDivertedTo("generations");
  const fs = createNodeSnapshotFs();

  // The victim holds a byte-identical copy of the very generation the live manifest names, so
  // a reader that resolves through the link finds a VALID, checksum-correct, correctly-named
  // document and serves it. That is the whole point: containment here cannot be demonstrated
  // by planting something invalid, because invalidity alone would explain the refusal.
  const live = JSON.parse(nfs.readFileSync(P.manifest, "utf8")).body;
  assert.equal(
    nfs.existsSync(`${victim}/${live.activeGenerationId}.json`),
    true,
    "the decoy must be the generation the manifest points at",
  );

  const read = readSnapshot(fs, P);
  assert.equal(read.status, "no-snapshot", `served ${JSON.stringify(read)}`);
});

test("containment: an unsafe generation id never reaches the filesystem (real fs)", () => {
  const work = tempDir("traversal");
  const stateDir = `${work}/state`;
  nfs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const P = storePaths(stateDir);
  const fs = createNodeSnapshotFs();
  startWriter(fs, HELD, P);

  assert.throws(
    () => publishSnapshot(fs, HELD, P, candidate("../../../pwned", { claude: 1 }), { live: null }),
    (err) => err.name === "SnapshotIdError",
  );
  // Nothing at the EXACT destination the id would have resolved to — computed rather than
  // guessed, and INSIDE this test's own root.
  //
  // Three components, not four, and that is a safety fix rather than a cosmetic one: from
  // `<work>/state/store-v1/generations`, four levels up lands OUTSIDE `work` — in the shared
  // system temp directory. So if the id grammar were ever mutated away, this test would create
  // a file beyond its own cleanup scope, on a path another process could also be using. Three
  // levels resolves to `<work>/pwned.json`, which is asserted below and removed at exit.
  const escaped = nodePath.resolve(P.generationsDir, "../../../pwned.json");
  assert.ok(
    escaped.startsWith(`${work}/`),
    `the traversal target must stay inside this test's root: ${escaped}`,
  );
  assert.equal(nfs.existsSync(escaped), false, escaped);
  assert.deepEqual(nfs.readdirSync(P.generationsDir), []);
});

// ---------------------------------------------------------------------------------------
// Conformance — the fake raises what the kernel raises
// ---------------------------------------------------------------------------------------

/**
 * Runs one scenario against both implementations and requires the same outcome.
 *
 * Without this, every fault the suite injects is a guess about the kernel, and every symlink
 * assertion is a property of the fake. `code` comparison uses the branded error's `.cause`,
 * which is where the adapter keeps the native errno.
 */
function conform(label, seed, run) {
  test(`conformance: ${label}`, () => {
    const outcomes = [];

    const work = tempDir("conform");
    nfs.mkdirSync(`${work}/base`, { mode: 0o700 });
    seed({
      mkdir: (p, mode = 0o700) => nfs.mkdirSync(`${work}/base${p}`, { mode }),
      file: (p, data = "x") => nfs.writeFileSync(`${work}/base${p}`, data, { mode: 0o600 }),
      symlink: (p, target) => nfs.symlinkSync(target.startsWith("/") ? `${work}/base${target}` : target, `${work}/base${p}`),
    });
    const real = createNodeSnapshotFs();
    outcomes.push(capture(() => run(real, (p) => `${work}/base${p}`)));

    const fake = new FakeFs();
    fake.mkdirp("/base");
    seed({
      mkdir: (p, mode = 0o700) => fake.mkdirp(`/base${p}`, mode),
      file: (p, data = "x") => fake.put(`/base${p}`, data),
      symlink: (p, target) => fake.symlink(`/base${p}`, target.startsWith("/") ? `/base${target}` : target),
    });
    outcomes.push(capture(() => run(fake, (p) => `/base${p}`)));

    assert.deepEqual(outcomes[1], outcomes[0], `${label}: fake and kernel disagree`);
  });
}

function capture(run) {
  try {
    const value = run();
    return { ok: true, value: Array.isArray(value) ? [...value].sort() : value };
  } catch (err) {
    // BOTH the native code and the KIND. The kind is what the store actually branches on
    // (`isNotFound`, the `symlink`/`too-large` cases), so a fake that raised a plausible errno
    // which classified differently would diverge in exactly the way that matters while the code
    // comparison stayed green. The code is kept as well, because it is the finer-grained of the
    // two and catches divergence the classifier collapses.
    return {
      ok: false,
      code: err?.cause?.code ?? err?.name ?? "unknown",
      kind: err?.kind ?? null,
    };
  }
}

conform(
  "openExclusive on an existing file is EEXIST",
  (s) => s.file("/a.json"),
  (fs, at) => fs.openExclusive(at("/a.json")),
);

conform(
  "openExclusive on an existing DIRECTORY is EEXIST, not a silent overwrite",
  (s) => s.mkdir("/a.json"),
  (fs, at) => fs.openExclusive(at("/a.json")),
);

conform(
  "mkdir with a missing parent is ENOENT",
  () => {},
  (fs, at) => fs.mkdir(at("/missing/child"), 0o700),
);

conform(
  "mkdir where the parent is a FILE is ENOTDIR",
  (s) => s.file("/notadir"),
  (fs, at) => fs.mkdir(at("/notadir/child"), 0o700),
);

conform(
  "rmdir on a non-empty directory is ENOTEMPTY",
  (s) => { s.mkdir("/d"); s.file("/d/x"); },
  (fs, at) => fs.rmdir(at("/d")),
);

conform(
  "rmdir on a missing directory is ENOENT",
  () => {},
  (fs, at) => fs.rmdir(at("/gone")),
);

conform(
  "unlink on a directory fails rather than removing it",
  (s) => s.mkdir("/d"),
  (fs, at) => fs.unlink(at("/d")),
);

conform(
  "rename into a missing parent is ENOENT",
  (s) => s.file("/a.json"),
  (fs, at) => fs.rename(at("/a.json"), at("/missing/b.json")),
);

conform(
  "listDir on a file is ENOTDIR",
  (s) => s.file("/f"),
  (fs, at) => fs.listDir(at("/f")),
);

conform(
  "listDir FOLLOWS a symlink to a directory",
  (s) => { s.mkdir("/target"); s.file("/target/inside.txt"); s.symlink("/link", "/target"); },
  (fs, at) => fs.listDir(at("/link")),
);

conform(
  "a symlink IS listed among a directory's entries",
  (s) => { s.mkdir("/d"); s.mkdir("/t"); s.symlink("/d/link", "/t"); },
  (fs, at) => fs.listDir(at("/d")),
);

conform(
  "lstat does NOT follow the final component",
  (s) => { s.mkdir("/t"); s.symlink("/link", "/t"); },
  (fs, at) => {
    const stat = fs.lstat(at("/link"));
    return { isSymbolicLink: stat.isSymbolicLink, isDirectory: stat.isDirectory };
  },
);

conform(
  "unlink removes the LINK, never its target",
  (s) => { s.mkdir("/t"); s.file("/t/keep.txt"); s.symlink("/link", "/t"); },
  (fs, at) => {
    fs.unlink(at("/link"));
    return fs.listDir(at("/t"));
  },
);

conform(
  "readFile follows an intermediate symlink",
  (s) => { s.mkdir("/t"); s.file("/t/x.txt", "through the link"); s.symlink("/link", "/t"); },
  (fs, at) => fs.readFile(at("/link/x.txt")),
);

// Split in two, because one case named two properties and exercised one. `readFile` throws, so
// a body that lstats first and then reads discards the lstat and compares only the throw — the
// two halves cannot share a body without one of them becoming decorative. Separate cases keep
// the thrown-error comparison intact for the read AND compare the link's own stat, which is the
// half that matters to classification: a dangling link must be visible AS a link rather than
// reported as a missing file, or reset would look for something that is not there.
conform(
  "a dangling symlink lstats as a link, not as a missing file",
  (s) => s.symlink("/dangling", "/nowhere"),
  (fs, at) => {
    const named = fs.lstat(at("/dangling"));
    return `link=${named.isSymbolicLink} file=${named.isFile} dir=${named.isDirectory}`;
  },
);

conform(
  "reading through a dangling symlink is ENOENT",
  (s) => s.symlink("/dangling", "/nowhere"),
  (fs, at) => fs.readFile(at("/dangling")),
);

test("conformance: the fake and the kernel agree on a short-write round trip", () => {
  // The fake stores raw bytes at the descriptor's position. If it decoded each chunk as UTF-8
  // and concatenated strings, a chunk boundary inside a multi-byte character would insert
  // U+FFFD — so this compares the bytes on disk against the fake's, one byte per write.
  const work = tempDir("shortwrite");
  const text = "日本語 — naïve café 🎉\\n";
  const bytes = new TextEncoder().encode(text);

  const real = createNodeSnapshotFs();
  const realPath = `${work}/real.txt`;
  const handle = real.openExclusive(realPath);
  let written = 0;
  while (written < bytes.length) written += real.write(handle, bytes, written);
  real.close(handle);

  const fake = new FakeFs();
  fake.mkdirp("/w");
  fake.shortWriteLimit = 1;
  const fakeHandle = fake.openExclusive("/w/fake.txt");
  written = 0;
  while (written < bytes.length) written += fake.write(fakeHandle, bytes, written);
  fake.close(fakeHandle);

  assert.equal(nfs.readFileSync(realPath, "utf8"), text);
  assert.equal(fake.bytesAt("/w/fake.txt").toString("hex"), Buffer.from(bytes).toString("hex"));
  assert.equal(fake.files.get("/w/fake.txt").data, text);
});

test("conformance: a full publish/read cycle behaves identically on both implementations", () => {
  // End to end, not just per-call: the same sequence of store operations must produce the
  // same observable store on the kernel and on the fake.
  const work = tempDir("cycle");
  const stateDir = `${work}/state`;
  nfs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const realP = storePaths(stateDir);
  const real = createNodeSnapshotFs();

  const fake = new FakeFs();
  fake.mkdirp("/state");
  const fakeP = storePaths("/state");

  const results = [];
  for (const [fs, P] of [[real, realP], [fake, fakeP]]) {
    const authority = fake === fs ? new FakeAuthority(fs) : HELD;
    startWriter(fs, authority, P);
    const first = publishSnapshot(fs, authority, P, candidate("gen-1", { claude: 10 }), { live: null });
    const manifest = JSON.parse(fs.readFile(P.manifest)).body;
    const second = publishSnapshot(fs, authority, P, candidate("gen-2", { claude: 20 }), { live: manifest });
    const read = readSnapshot(fs, P);
    results.push({
      first: first.status,
      second: second.status,
      served: read.view.generation.generationId,
      status: read.status,
      generations: fs.listDir(P.generationsDir).sort(),
      manifestBytes: fs.readFile(P.manifest),
    });
  }
  assert.deepEqual(results[1], results[0]);
});

// ---------------------------------------------------------------------------------------
// Conformance, second pass: the semantics the remaining proofs actually lean on
// ---------------------------------------------------------------------------------------

conform(
  "an intermediate RELATIVE symlink resolves through ..",
  (s) => { s.mkdir("/target"); s.file("/target/inside.txt", "reached"); s.mkdir("/a"); s.mkdir("/a/b"); s.symlink("/a/b/link", "../../target"); },
  (fs, at) => fs.readFile(at("/a/b/link/inside.txt")),
);

conform(
  "a multi-level relative symlink target resolves",
  (s) => { s.mkdir("/x"); s.mkdir("/x/y"); s.file("/x/y/deep.txt", "deep"); s.mkdir("/p"); s.symlink("/p/link", "../x/y"); },
  (fs, at) => fs.listDir(at("/p/link")),
);

conform(
  "a dangling RELATIVE symlink lstats as a link",
  (s) => s.symlink("/rel-dangling", "../nowhere/at/all"),
  (fs, at) => {
    const stat = fs.lstat(at("/rel-dangling"));
    return { isSymbolicLink: stat.isSymbolicLink, isFile: stat.isFile };
  },
);

conform(
  "a symlink loop through relative targets is bounded",
  (s) => { s.mkdir("/loop"); s.symlink("/loop/a", "b"); s.symlink("/loop/b", "a"); },
  (fs, at) => fs.readFile(at("/loop/a")),
);

conform(
  "a descriptor keeps writing to its inode after the NAME is unlinked",
  (s) => s.mkdir("/d"),
  (fs, at) => {
    const handle = fs.openExclusive(at("/d/f.json"));
    const before = fs.fstat(handle);
    const bytes = new TextEncoder().encode("after-unlink");
    fs.unlink(at("/d/f.json"));
    let written = 0;
    let calls = 0;
    while (written < bytes.length) {
      written += fs.write(handle, bytes, written);
      calls += 1;
    }
    const after = fs.fstat(handle);
    fs.close(handle);
    // The name is gone and the write still SUCCEEDED — and it is the same inode throughout,
    // which is the property the staging-swap defence rests on. The earlier version returned
    // only `isFile` and the directory listing, so it would have passed against a seam that
    // silently dropped every byte, or one that re-resolved the pathname on each write and
    // quietly created a new file. Both are exactly what this case exists to rule out.
    return {
      wroteEverything: written === bytes.length,
      calls: calls > 0,
      sameInodeAfterUnlink: before.dev === after.dev && before.ino === after.ino,
      isFile: after.isFile,
      entries: fs.listDir(at("/d")),
    };
  },
);

conform(
  "a descriptor does NOT follow a replacement at the same name",
  (s) => s.mkdir("/d"),
  (fs, at) => {
    const handle = fs.openExclusive(at("/d/f.json"));
    fs.unlink(at("/d/f.json"));
    // A different file takes the name. The descriptor must not write into it — this is the
    // exact arrangement the staging-swap defence is about, and a path-keyed fake modelled the
    // OPPOSITE of the kernel here.
    const other = fs.openExclusive(at("/d/f.json"));
    fs.close(other);
    const bytes = new TextEncoder().encode("into the original inode");
    let written = 0;
    while (written < bytes.length) written += fs.write(handle, bytes, written);
    fs.close(handle);
    return fs.readFile(at("/d/f.json"));
  },
);

conform(
  "a descriptor survives its name being renamed",
  (s) => s.mkdir("/d"),
  (fs, at) => {
    const handle = fs.openExclusive(at("/d/f.json"));
    fs.rename(at("/d/f.json"), at("/d/g.json"));
    const bytes = new TextEncoder().encode("still the same inode");
    let written = 0;
    while (written < bytes.length) written += fs.write(handle, bytes, written);
    fs.close(handle);
    return fs.readFile(at("/d/g.json"));
  },
);

conform(
  "closing a descriptor twice is EBADF",
  (s) => s.mkdir("/d"),
  (fs, at) => {
    const handle = fs.openExclusive(at("/d/f.json"));
    fs.close(handle);
    fs.close(handle);
    return "should not reach here";
  },
);

test("conformance: lstat and fstat agree on identity, and disagree after a swap", () => {
  // This is the pair the commit's staging check compares. If a fake reported identity that
  // did not move when the file did, the check would look effective while proving nothing.
  const work = tempDir("identity");
  const real = createNodeSnapshotFs();
  const path = `${work}/f.json`;

  const handle = real.openExclusive(path);
  const open = real.fstat(handle);
  const named = real.lstat(path);
  // The KERNEL's own answer, read straight through node:fs rather than the adapter, because
  // every assertion below is otherwise self-referential: the adapter is the thing under test
  // and cannot also be the oracle.
  const native = nfs.lstatSync(path, { bigint: true });

  // The TYPES, not only the equality. Equality alone is satisfied by an adapter that reverts
  // to Number-valued dev/ino consistently — every assertion in this test would still pass
  // while 64-bit inodes silently collapsed onto shared doubles, which is the entire reason
  // these fields are bigint. `mode` is asserted the other way, because it is deliberately
  // narrowed back to a number for masking against octal literals.
  for (const [label, stat] of [["fstat", open], ["lstat", named]]) {
    assert.equal(typeof stat.dev, "bigint", `${label}.dev must be bigint`);
    assert.equal(typeof stat.ino, "bigint", `${label}.ino must be bigint`);
    assert.equal(typeof stat.mode, "number", `${label}.mode must be a number`);
    // ...and the VALUES are the kernel's. Types plus internal agreement is exactly what an
    // adapter returning a pair of frozen constants satisfies, and that adapter would make the
    // staging identity check compare two numbers that never move.
    assert.equal(stat.dev, native.dev, `${label}.dev must be the kernel's dev`);
    assert.equal(stat.ino, native.ino, `${label}.ino must be the kernel's ino`);
  }
  assert.equal(named.dev, open.dev);
  assert.equal(named.ino, open.ino);

  // Replace the name with a different file: same path, different inode.
  //
  // The original descriptor is CLOSED first, which is what production does now — the commit
  // closes before it checks the pathname. Holding it open would have pinned the inode and
  // guaranteed the replacement could not reuse it, so the old shape of this test excluded the
  // one case worth worrying about. The kernel MAY hand the number back; the assertion below is
  // therefore about what the store must tolerate, not about a guarantee the kernel gives.
  real.close(handle);
  // The replacement is created at a SECOND name while the original still exists, and then
  // renamed over it. Unlinking first and re-creating at the same name lets the kernel hand back
  // the very inode it just freed — legal, and on some filesystems ordinary — which left the
  // whole "disagree after a swap" claim resting on a branch whose only assertion was
  // `assert.ok(true)`: the test proved nothing precisely in the case worth testing, and did so
  // silently. Two files cannot share an inode while both exist, so the identities below are
  // guaranteed to differ and the assertion can be unconditional. The window this models is
  // unchanged: production closes the descriptor before it checks the pathname, and a rename
  // over the name is exactly the substitution the staging identity check exists to catch.
  const spare = `${work}/f.replacement.json`;
  const other = real.openExclusive(spare);
  real.close(other);
  real.rename(spare, path);
  const replaced = real.lstat(path);
  const nativeReplaced = nfs.lstatSync(path, { bigint: true });
  assert.equal(replaced.dev, nativeReplaced.dev, "lstat.dev must track the kernel after a swap");
  assert.equal(replaced.ino, nativeReplaced.ino, "lstat.ino must track the kernel after a swap");

  // Distinctness is now guaranteed by construction, so this is checked against the KERNEL first
  // and then asserted unconditionally. Reading it off the adapter alone would be circular: an
  // adapter returning two frozen constants reports identical identities, which is the exact
  // failure that would make the staging identity check compare a pair of values that can never
  // differ, and it is the reading the old conditional accepted as "inode reuse".
  assert.notEqual(
    `${nativeReplaced.dev}:${nativeReplaced.ino}`,
    `${native.dev}:${native.ino}`,
    "the fixture must produce a genuinely different inode — two live files cannot share one",
  );
  assert.notEqual(replaced.ino, open.ino, "identity must move when the file at the name does");

  // Inode reuse after a close remains a real, tolerated ambiguity — the kernel may hand a freed
  // number straight back, and an identity check performed after a close cannot see it. It is
  // documented on `assertStagingIdentity` and bounded by the single-writer invariant. What
  // changed is that the residual is no longer expressed as a branch this test takes instead of
  // asserting anything.

  // The fake must behave the same way — and in the same ORDER. The fake half used to hold its
  // original descriptor open across the unlink and the replacement, which is not what the real
  // half above does and not what production does; an open descriptor pins the inode, so the
  // fake was being asked an easier question than the kernel was.
  const fake = new FakeFs();
  fake.mkdirp("/w");
  const fh = fake.openExclusive("/w/f.json");
  const fopen = fake.fstat(fh);
  assert.equal(fake.lstat("/w/f.json").ino, fopen.ino);
  fake.close(fh);
  fake.unlink("/w/f.json");
  const fother = fake.openExclusive("/w/f.json");
  fake.close(fother);
  assert.notEqual(fake.lstat("/w/f.json").ino, fopen.ino);
});

// Run in a CHILD, so a regression is a bounded failure instead of a wedged suite.
//
// `open(2)` on a FIFO in READ mode blocks until a writer arrives, and `openSync` is a
// SYNCHRONOUS call: it does not yield, so no test-runner timer can fire while it is stuck. In
// this process a lost O_NONBLOCK therefore hangs the whole file — every later test included —
// until something outside Node gives up, and what CI reports is "the suite timed out", not
// "the FIFO guard regressed". The child gets its own `timeout`, so the same regression comes
// back as a killed process this test can name.
const FIFO_CHILD = `
import * as nfs from "node:fs";
const [stateDir, distUrl] = process.argv.slice(2);
const { createNodeSnapshotFs } = await import(distUrl + "node-fs.js");
const { storePaths, classifyStore, readSnapshot, resetStore } = await import(distUrl + "store.js");
const { createWriteAuthority, TERMINATED } = await import(distUrl + "authority.js");

const fs = createNodeSnapshotFs();
const paths = storePaths(stateDir);
const authority = createWriteAuthority({ assertHeld() {} }, () => TERMINATED);

// NO startWriter here. The parent already built the store and then placed the FIFO; calling it
// again would classify-and-reset the FIFO away before the classification below ever saw it,
// which is how the first version of this child reported a clean "first-run" store.
const classification = classifyStore(fs, paths);
const read = readSnapshot(fs, paths).status;
resetStore(fs, authority, paths);
process.stdout.write(JSON.stringify({
  status: classification.status,
  reason: classification.error?.reason ?? null,
  read,
  manifestGone: !nfs.existsSync(paths.manifest),
  afterReset: classifyStore(fs, paths).status,
}));
`;

test("kernel: a FIFO at an artifact name is refused, and does not block the process", () => {
  // This one can only be asked of the kernel. The store's "not a regular file" refusal runs on
  // the descriptor AFTER the open, so without O_NONBLOCK it is unreachable: the process wedges
  // inside `openSync` and never gets a descriptor to reject.
  const work = tempDir("fifo");
  const stateDir = `${work}/state`;
  nfs.mkdirSync(stateDir, { mode: 0o700 });
  const paths = storePaths(stateDir);
  const script = `${work}/child.mjs`;
  nfs.writeFileSync(script, FIFO_CHILD);

  // The store's own directories, created here so the child's first act can be the classify.
  const fs = createNodeSnapshotFs();
  startWriter(fs, HELD, paths);

  // Resolved by ABSOLUTE path, not through PATH. `test:pure` runs this suite under a PATH
  // stripped to a node-only directory to prove the file has no python3 dependency, and a
  // bare "mkfifo" is then ENOENT — which would have turned a kernel-behaviour test into a
  // PATH test. The binary is still on disk; only the lookup was removed.
  execFileSync(mkfifoBinary(), [paths.manifest]);
  assert.ok(nfs.lstatSync(paths.manifest).isFIFO(), "the fixture must actually be a FIFO");

  let out;
  try {
    out = execFileSync(process.execPath, [script, stateDir, DIST], {
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    // THE regression, named. `execFileSync` reports a timeout kill as ETIMEDOUT or as a
    // `signal`, depending on platform and on whether the process died before the report.
    if (err.code === "ETIMEDOUT" || err.signal) {
      assert.fail(
        "opening a FIFO blocked: O_NONBLOCK is not reaching openRead, so the " +
          "not-a-regular-file refusal is unreachable",
      );
    }
    throw err;
  }

  const result = JSON.parse(out);
  assert.equal(result.status, "not-usable");
  assert.equal(result.reason, "artifact-not-a-regular-file");
  assert.equal(result.read, "no-snapshot");
  // ...and the store converges: the reset removes it rather than meeting it again forever.
  assert.equal(result.manifestGone, true);
  assert.notEqual(result.afterReset, "not-usable");
});

// In a CHILD, for the same reason the FIFO case is: a regression here is about a read that
// does not stop, and a wedged parent reports "the suite timed out" rather than naming it.
//
// The SOURCE is finite, and that is the fix for a real hazard rather than a detail. This used
// to read `/dev/zero`, which is endless: under the very regression the test exists to catch,
// the child allocated 64 KiB buffers without end and the only bound was a 20-second timeout.
// `--max-old-space-size` does not help — `Buffer.allocUnsafe` allocates outside V8's old space
// — and `ulimit -v` is unavailable on darwin, so on a fast machine a deliberately broken build
// could reach many gigabytes and threaten the host before anything stopped it. A test whose
// failure mode endangers the machine running it is not a test anyone will keep enabled.
//
// A FIFO gives the same distinguishing power with none of that. It reports `size` 0, exactly
// like `/dev/zero`, so a size-based implementation still concludes the file is comfortably
// under any bound — but it delivers a fixed 8 KiB and then EOF, so BOTH readings terminate
// immediately and the wrong one is caught by what it returned rather than by a resource limit.
//
// The ordering below is what makes it race-free, which was `/dev/zero`'s one real advantage:
// the reader is opened FIRST (the adapter's own O_NONBLOCK open, which succeeds with no writer
// present), then a writer is opened, filled, and CLOSED. By the time the read runs, the bytes
// are already buffered and the write end is gone — so there is no timing to lose and no
// EAGAIN to trip over.
const FINITE_CHILD = `
import * as nfs from "node:fs";
const [fifo, distUrl] = process.argv.slice(2);
const { createNodeSnapshotFs } = await import(distUrl + "node-fs.js");
const fs = createNodeSnapshotFs();

const handle = fs.openRead(fifo);
const wfd = nfs.openSync(fifo, "w");
nfs.writeSync(wfd, Buffer.alloc(8192, 0x61));
nfs.closeSync(wfd);

let out;
try {
  const data = fs.readAll(handle, 4096);
  out = { outcome: "returned", length: data.length };
} catch (err) {
  out = { outcome: "threw", name: err?.name, kind: err?.kind };
} finally {
  fs.close(handle);
}
process.stdout.write(JSON.stringify(out));
`;

test("kernel: the read bound is enforced on bytes that ARRIVE, not on a reported size", () => {
  // The distinguishing case, and the reason it is a FIFO rather than a regular file.
  //
  // The oversized-file case below does not actually establish this claim: a 1000-byte file read
  // with a bound of 999 is refused just as well by an implementation that stats the file once
  // and compares `size`. Both readings pass it, so it could not tell them apart, and the
  // comment asserting "bytes that arrive" was doing work the assertions were not.
  //
  // A FIFO reports `size` 0 and then yields 8 KiB. A size-based check sees 0, concludes the
  // file is under any bound, reads everything and RETURNS it — which is the wrong answer and is
  // what the assertion below catches. Only a check that counts what arrives refuses.
  const work = tempDir("finite");
  const script = `${work}/child.mjs`;
  nfs.writeFileSync(script, FINITE_CHILD);
  const fifo = `${work}/endless.fifo`;
  execFileSync(mkfifoBinary(), [fifo]);
  assert.equal(nfs.statSync(fifo).size, 0, "the premise: a size-based check sees 0");

  let out;
  try {
    // The timeout is a backstop, not the bound: the source is finite, so a correct build AND a
    // size-based one both return in milliseconds. If this ever fires, the read is not stopping
    // on EOF either, which is a different and worse regression than the one under test.
    out = execFileSync(process.execPath, [script, fifo, DIST], {
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    assert.fail(
      "reading a finite 8 KiB source under a 4 KiB bound did not terminate " +
        `(${err.code ?? err.signal ?? "unknown"}): the read is not stopping at EOF`,
    );
  }

  const result = JSON.parse(out);
  // Named explicitly, because the failing shape is the informative one: `returned` with 8192
  // bytes IS the size-based implementation, having read four times its own bound.
  assert.equal(
    result.outcome,
    "threw",
    `a source reporting size 0 was read to ${result.length} bytes under a 4096-byte bound`,
  );
  assert.equal(result.name, "SnapshotFsError");
  assert.equal(result.kind, "too-large");
});

test("kernel: a read is bounded, and the bound is exact", () => {
  const root = tempDir("bounded");
  const fs = createNodeSnapshotFs();
  const path = `${root}/artifact`;
  nfs.writeFileSync(path, "x".repeat(1000), { mode: 0o600 });

  const handle = fs.openRead(path);
  try {
    assert.throws(
      () => fs.readAll(handle, 999),
      (err) => {
        assert.equal(err.name, "SnapshotFsError");
        assert.equal(err.kind, "too-large");
        return true;
      },
    );
  } finally {
    fs.close(handle);
  }

  const handle2 = fs.openRead(path);
  try {
    assert.equal(fs.readAll(handle2, 1000).length, 1000, "exactly at the bound is allowed");
  } finally {
    fs.close(handle2);
  }
});

test("kernel: a directory's mode is repaired through a descriptor, never a pathname", () => {
  // `openDir` is O_NOFOLLOW | O_DIRECTORY, so the kernel refuses a symlink and refuses a
  // non-directory before a descriptor exists — which is what makes `fchmod` unredirectable.
  const root = tempDir("dirfd");
  const fs = createNodeSnapshotFs();
  const dir = `${root}/real`;
  const victim = `${root}/victim`;
  nfs.mkdirSync(dir, { mode: 0o755 });
  // 0o711, NOT 0o700 — the mode this test then asks `fchmod` to SET. The victim used to be
  // created at 0700 already, so "the victim is untouched" compared 0700 against 0700 and held
  // whether or not the repair had hit it: an assertion that cannot fail either way.
  nfs.mkdirSync(victim, { mode: 0o711 });
  const link = `${root}/link`;
  nfs.symlinkSync(victim, link);

  assert.throws(() => fs.openDir(link), (err) => {
    assert.equal(err.kind, "symlink", "a symlinked directory must be refused at open");
    return true;
  });
  assert.throws(() => fs.openDir(`${root}/nope`), (err) => {
    assert.equal(err.kind, "not-found");
    return true;
  });
  nfs.writeFileSync(`${root}/plain`, "x");
  assert.throws(() => fs.openDir(`${root}/plain`), (err) => {
    assert.equal(err.kind, "symlink", "ENOTDIR is classified with the prefix/link family");
    return true;
  });

  // THE SUBSTITUTION, which is what makes this test about the descriptor rather than about the
  // outcome. Without it, an adapter that recorded the PATHNAME at `openDir` and then called
  // pathname-based `chmod` passed every assertion here — the directory ends up at 0700 either
  // way, so the test's name described a mechanism nothing was checking.
  //
  // After the open, the opened directory is renamed aside and a symlink to `victim` is put at
  // the name it used to have. A pathname-based repair now resolves that symlink and chmods the
  // victim; a descriptor-based one cannot be redirected, because the descriptor already refers
  // to the inode and no name is consulted again.
  const handle = fs.openDir(dir);
  const moved = `${root}/real-moved`;
  nfs.renameSync(dir, moved);
  nfs.symlinkSync(victim, dir);
  try {
    fs.fchmod(handle, 0o700);
    assert.equal(fs.fstat(handle).mode & 0o7777, 0o700, "the OPENED directory must be repaired");
  } finally {
    fs.close(handle);
  }
  // The inode that was opened — reached by its current name, since the old one is now a symlink.
  assert.equal(nfs.lstatSync(moved).mode & 0o7777, 0o700, "the repair must land on the descriptor");
  // ...and nothing followed the symlink that replaced the original name.
  assert.equal(
    nfs.lstatSync(victim).mode & 0o7777,
    0o711,
    "a pathname-based repair would have followed the symlink and chmodded the victim",
  );
});

test("adapter: a missing open flag fails closed rather than degrading silently", () => {
  // `O_RDONLY | undefined` is `O_RDONLY`. So on a platform without O_NOFOLLOW the bitwise-or
  // drops it and `openRead` starts FOLLOWING final-component symlinks — the primitive the whole
  // descriptor-based read rests on, absent, with no error and no observable difference until
  // something exploits it. `fs.constants` is non-configurable, which is why the check is
  // exported: a guard that cannot be exercised is one this ticket has learned not to trust.
  const complete = { O_NOFOLLOW: 256, O_NONBLOCK: 4, O_DIRECTORY: 1048576 };
  assert.deepEqual(assertRequiredOpenFlags(complete), complete);

  for (const missing of ["O_NOFOLLOW", "O_NONBLOCK", "O_DIRECTORY"]) {
    // -1 is in this list because it is what a stub or a shim produces when it means "this
    // platform does not have the flag", and `value !== 0` accepted it — after which
    // `O_RDONLY | -1` is every bit set, which is not a fail-closed guard.
    for (const bad of [undefined, 0, -1, -256, "256", 1.5, 2 ** 53, null]) {
      const constants = { ...complete, [missing]: bad };
      assert.throws(
        () => assertRequiredOpenFlags(constants),
        new RegExp(`requires fs.constants.${missing}`),
        `${missing} = ${String(bad)}`,
      );
    }
  }

  // And the real platform provides all three, so the store is actually usable here.
  assert.doesNotThrow(() => createNodeSnapshotFs());

  // THE WIRING. Everything above proves the guard works when called; none of it proves the
  // adapter calls it, and deleting the call from `createNodeSnapshotFs` left every assertion in
  // this test green — the guard would then be dead code protecting nothing, under a test name
  // that says the ADAPTER fails closed.
  //
  // Checked statically rather than behaviourally, and the reason is a property of the thing
  // being guarded: `fs.constants` is non-configurable, so there is no way to hand the real
  // factory a bad constants object from inside this process. A child process with a patched
  // loader could do it, but it would be testing the loader as much as the adapter. This asserts
  // the one fact that is actually in question — that the call site exists in the built factory
  // — and says plainly that it is the weaker of the two available proofs. The umask guard, whose
  // input CAN be changed, is proven behaviourally instead.
  const built = nfs.readFileSync(new URL("../dist/snapshot/node-fs.js", import.meta.url), "utf8");
  const factory = built.slice(built.indexOf("export function createNodeSnapshotFs"));
  assert.match(
    factory.slice(0, factory.indexOf("\n}")),
    /assertRequiredOpenFlags\s*\(/,
    "createNodeSnapshotFs must invoke assertRequiredOpenFlags, or the guard protects nothing",
  );
});

test("kernel: the read BOUND is itself validated, so NaN cannot silently unbound the read", () => {
  // `total > maxBytes` is false for NaN and false for Infinity. A bound that is never exceeded
  // is not a bound, so passing either one through this seam restored the unbounded read the
  // chunked loop exists to prevent — and `SnapshotFs` is reachable from JavaScript, where the
  // `maxBytes: number` annotation is a comment.
  //
  // The divergence mattered as much as the hole: FakeFs already refused these with EINVAL, so
  // the fake and the adapter disagreed about what the seam accepts. Every proof carried by the
  // fake suite is worth exactly as much as that agreement.
  const dir = tempDir("readbound");
  const path = `${dir}/artifact`;
  nfs.writeFileSync(path, "x".repeat(4096), { mode: 0o600 });
  const real = createNodeSnapshotFs();

  for (const bad of [Number.NaN, Infinity, -Infinity, -1, 1.5, 2 ** 53, "4096", null, undefined]) {
    const handle = real.openRead(path);
    try {
      assert.throws(
        () => real.readAll(handle, bad),
        (err) => {
          // A named error from this module, not an incidental TypeError. The KIND is `other`
          // and deliberately so: the store's kinds are filesystem conditions it branches on,
          // and an invalid bound is a caller bug with no recovery — so the discriminator is the
          // preserved cause, which is what distinguishes this from a genuine EFBIG refusal.
          assert.equal(err.name, "SnapshotFsError", `${String(bad)}: ${err.name}`);
          assert.equal(err.kind, "other", `${String(bad)}: kind ${err.kind}`);
          assert.equal(err.cause?.code, "EINVAL", `${String(bad)}: ${err.cause?.code}`);
          return true;
        },
        `readAll accepted ${String(bad)} as a byte bound`,
      );
    } finally {
      real.close(handle);
    }
  }

  // A real bound still works, and still refuses a file over it — so the validation above did
  // not simply break the seam.
  const ok = real.openRead(path);
  try {
    assert.equal(real.readAll(ok, 4096).length, 4096);
  } finally {
    real.close(ok);
  }
  const tight = real.openRead(path);
  try {
    assert.throws(() => real.readAll(tight, 4095), /failed \(too-large\)/);
  } finally {
    real.close(tight);
  }
});

// ---------------------------------------------------------------------------------------
// Round 7 chunk 3 — the adapter never silently transforms what the kernel returned
// ---------------------------------------------------------------------------------------

test("adapter: invalid UTF-8 in an artifact is refused, not replaced with U+FFFD", () => {
  // `Buffer.toString("utf8")` substitutes U+FFFD for every invalid sequence, silently — so a
  // file whose raw bytes are not valid UTF-8 decoded into a string that could parse as JSON,
  // checksum correctly, and pass the canonical-bytes comparison, because all three then ran on
  // the REPLACED string. `manifestIdentity` is the worst of it: a file holding an invalid byte
  // and a file holding a literal U+FFFD hash identically, so the reader's optimistic
  // transaction cannot tell one from the other — the exact ABA detection it exists to provide.
  const dir = tempDir("bad-utf8");
  const real = createNodeSnapshotFs();

  const lone = nodePath.join(dir, "lone-continuation");
  nfs.writeFileSync(lone, Buffer.from([0x7b, 0x80, 0x7d])); // "{" 0x80 "}"
  assert.equal(
    nfs.readFileSync(lone).toString("utf8"),
    "{�}",
    "the premise — the lossy decoder produces a clean-looking string",
  );
  for (const [label, read] of [
    ["readFile", () => real.readFile(lone)],
    ["readAll", () => {
      const handle = real.openRead(lone);
      try { return real.readAll(handle, 1024); } finally { real.close(handle); }
    }],
  ]) {
    assert.throws(read, (err) => {
      assert.equal(err.name, "SnapshotFsError", label);
      assert.match(err.cause.message, /not valid UTF-8/, label);
      // The DECODER's own failure travels underneath, unread. It used to be dropped, so a
      // corrupt artifact arrived as a synthetic EILSEQ with no account of where the invalid
      // sequence was — the one detail that makes such a file diagnosable.
      assert.notEqual(err.cause.cause, undefined, `${label}: the decoder's failure must travel`);
      return true;
    }, label);
  }

  // The honest negative: a real U+FFFD, written as valid UTF-8, is ordinary content and must
  // still be readable — otherwise this would be refusing the character rather than the bytes.
  const legit = nodePath.join(dir, "real-replacement-char");
  nfs.writeFileSync(legit, "{�}", "utf8");
  assert.equal(real.readFile(legit), "{�}");
});

test("adapter: a non-round-tripping entry name never reaches the store mis-addressed", (t) => {
  // On POSIX a filename is bytes. `readdirSync` with a string encoding replaces invalid
  // sequences, so the store received a name that does not address the file: classification sees
  // a foreign entry, reset unlinks the replaced name, gets ENOENT, believes it is gone — and
  // classification finds it again next pass. A reset loop that cannot converge, invisibly.
  //
  // The property is about the STORE's end state, and there are two ways a platform can deliver
  // it: the filesystem refuses to create such a name (APFS, HFS+), or it allows the name and the
  // adapter refuses to list it (ext4 and friends). Both are real and both are assertable, so
  // this test asserts whichever one applies rather than skipping where it cannot build the
  // fixture. That matters here beyond tidiness: this suite's runner counts a skip as a FAILURE,
  // on the same reasoning as the mkfifo probe above — a test that reports neither pass nor
  // failure is a hole, and an environment-shaped hole is still a hole. Naming the test after the
  // end state instead of after one mechanism is what lets both platforms prove something.
  const dir = tempDir("bad-entry");
  const real = createNodeSnapshotFs();
  const badName = Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0xff])]);

  let refusal = null;
  try {
    nfs.writeFileSync(badName, "x");
  } catch (err) {
    refusal = err.code;
  }

  if (refusal !== null) {
    // The filesystem delivered the property. Asserted, not assumed: the create has to have
    // failed for being unrepresentable, and the directory has to be genuinely clean afterwards
    // — a create that failed for some unrelated reason would prove nothing about either.
    assert.ok(
      ["EILSEQ", "EINVAL", "ENOENT"].includes(refusal),
      `the name was refused, but for an unrelated reason: ${refusal}`,
    );
    assert.deepEqual(real.listDir(dir), [], "the refused name must not have been partly created");
    t.diagnostic(`this filesystem refuses the name outright (${refusal}); the adapter's own refusal is exercised on filesystems that allow it`);
  } else {
    // The filesystem allowed it, so the adapter is the thing that has to deliver the property.
    assert.throws(
      () => real.listDir(dir),
      (err) => {
        assert.equal(err.name, "SnapshotFsError");
        assert.match(err.cause.message, /does not round-trip UTF-8|not valid UTF-8/);
        return true;
      },
      "a name the adapter cannot address must fail loudly, not silently mis-address",
    );
    t.diagnostic("this filesystem allows the name; the adapter's round-trip refusal is what held");
    nfs.unlinkSync(badName);
  }
});

// Split out of the test above rather than left inside it: that one takes a different branch per
// platform, and this half needs no fixture and must run identically everywhere. Left where it
// was, the guarantee that the check refuses BYTES rather than non-ASCII would be entangled with
// a branch that has nothing to do with it.
test("adapter: non-ASCII entry names still list — the refusal is of unrepresentable BYTES", () => {
  const dir = tempDir("good-entries");
  const real = createNodeSnapshotFs();
  nfs.writeFileSync(nodePath.join(dir, "gen-1.json"), "{}");
  nfs.writeFileSync(nodePath.join(dir, "café-π.json"), "{}");
  assert.deepEqual(real.listDir(dir).sort(), ["café-π.json", "gen-1.json"]);
});

test("adapter: a handle is a capability — forged and closed ones are both refused", () => {
  // `SnapshotFileHandle` is branded by a string literal, which is something anyone can type,
  // and the adapter used to cast whatever it was given to `{ fd: number }` and use the number.
  // So `{ __brand: "SnapshotFileHandle", fd: 1 }` was a valid argument to `write` — and it
  // wrote to this process's stdout. No forgery is needed for the other half: a genuine handle
  // stays plausible-looking after close, and fd numbers are reused.
  const dir = tempDir("handles");
  const real = createNodeSnapshotFs();
  const file = nodePath.join(dir, "artifact.json");
  nfs.writeFileSync(file, "{}");

  // Captured BEFORE the forged calls, so the check afterwards is a comparison rather than an
  // observation. fd 1 is deliberately the target: it is this process's stdout, so an adapter
  // that trusted `.fd` would write "pwned" into the test runner's own output and `close` it.
  const stdoutBefore = nfs.fstatSync(1, { bigint: true });
  const forged = { __brand: "SnapshotFileHandle", fd: 1 };
  for (const [label, run] of [
    ["readAll", () => real.readAll(forged, 16)],
    ["write", () => real.write(forged, Buffer.from("pwned\n"), 0)],
    ["fchmod", () => real.fchmod(forged, 0o600)],
    ["fstat", () => real.fstat(forged)],
    ["close", () => real.close(forged)],
  ]) {
    assert.throws(run, (err) => {
      assert.equal(err.name, "SnapshotFsError", label);
      assert.match(err.cause.message, /live handle from this adapter/, label);
      return true;
    }, label);
  }
  // fd 1 is still this process's stdout, which is the point of naming it above.
  //
  // This was `assert.equal(nfs.fstatSync(1).isFile() || true, true)`. `x || true` is `true` for
  // every value of `x`, so the assertion held for any outcome the call could produce and held
  // just as well if the descriptor had been replaced — it could only have failed by throwing,
  // which is the one thing it was not written to check.
  //
  // Still OPEN: had the forged `close` reached the descriptor, this throws EBADF.
  assert.doesNotThrow(() => nfs.fstatSync(1), "a forged close must not reach fd 1");
  // ...and still the SAME open file, not a different one that inherited the number.
  const stdoutAfter = nfs.fstatSync(1, { bigint: true });
  assert.equal(stdoutAfter.dev, stdoutBefore.dev, "fd 1 must still be the same stream");
  assert.equal(stdoutAfter.ino, stdoutBefore.ino, "fd 1 must still be the same stream");

  // A GENUINE handle stops working the moment it is closed — the mapping is revoked, so a
  // later reuse of the same fd number cannot be reached through the stale object.
  const handle = real.openRead(file);
  assert.equal(real.readAll(handle, 16), "{}");
  real.close(handle);
  for (const [label, run] of [
    ["readAll after close", () => real.readAll(handle, 16)],
    ["fstat after close", () => real.fstat(handle)],
    ["close twice", () => real.close(handle)],
  ]) {
    assert.throws(run, (err) => {
      assert.match(err.cause.message, /already been closed|never opened here/, label);
      return true;
    }, label);
  }
  // And nothing on the object exposes a descriptor to edit in the first place.
  assert.equal(Object.isFrozen(handle), true);
  assert.deepEqual(Object.keys(handle), ["__brand"]);
});

test("adapter: patching WeakMap.prototype.get does not resolve a forged handle to a descriptor", () => {
  // The capability above rests on an IDENTITY lookup in a module-private WeakMap — and the
  // adapter read `get` off `WeakMap.prototype` on every call, which is an ordinary inherited
  // property of a global any code in the realm can write to. `WeakMap.prototype.get = () => 1`
  // after import made every forged object resolve to fd 1, so `write` wrote to this process's
  // stdout: exactly the capability forgery the WeakMap exists to prevent, reached around it
  // rather than through it. The lookup now goes through an intrinsic captured at module load.
  const real = createNodeSnapshotFs();
  const forged = { __brand: "SnapshotFileHandle" };
  const stdoutBefore = nfs.fstatSync(1, { bigint: true });

  // `fstat`, not `write`. Both go through the same `fdOf`, so the proof is identical — and if
  // the pin ever regressed, a `write` here would inject bytes into the test runner's own TAP
  // stream and the failure would be unreadable. A read-only op fails cleanly.
  const saved = WeakMap.prototype.get;
  let thrown = null;
  try {
    WeakMap.prototype.get = () => 1;
    try {
      real.fstat(forged);
    } catch (err) {
      thrown = err;
    }
  } finally {
    WeakMap.prototype.get = saved;
  }

  assert.notEqual(thrown, null, "the forged handle resolved to a descriptor");
  assert.equal(thrown.name, "SnapshotFsError");
  assert.match(thrown.cause.message, /live handle from this adapter/);
  const stdoutAfter = nfs.fstatSync(1, { bigint: true });
  assert.equal(stdoutAfter.dev, stdoutBefore.dev, "fd 1 must still be the same stream");
  assert.equal(stdoutAfter.ino, stdoutBefore.ino, "fd 1 must still be the same stream");
});

test("adapter: a umask that removes owner READ is refused at construction, not at the first mkdir", () => {
  // `mkdir(2)`'s mode is a umask-filtered request and the repair is to reopen the directory and
  // fchmod the descriptor — which has a precondition the seam's docs never stated: it must be
  // able to OPEN what it just created. Under umask 0400 mkdir(0700) yields 300, openDir fails
  // EACCES, and the sequence documented as establishing 0700 establishes nothing.
  //
  // The boundary is owner READ specifically, and it is measured rather than assumed: masks that
  // strip owner write or execute still open and still repair.
  for (const mask of [0o000, 0o022, 0o077, 0o100, 0o200, 0o300]) {
    assert.doesNotThrow(
      () => assertUmaskAllowsOwnerModes(mask),
      `umask ${mask.toString(8)} leaves owner read, so the repair is reachable`,
    );
  }
  for (const mask of [0o400, 0o500, 0o600, 0o700]) {
    assert.throws(
      () => assertUmaskAllowsOwnerModes(mask),
      (err) => {
        assert.match(err.message, /leaves owner READ intact/);
        return true;
      },
      `umask ${mask.toString(8)} removes owner read`,
    );
  }

  // The claim is about the KERNEL, so it is checked against the kernel rather than restated:
  // every mask this guard accepts must really produce a directory that opens and repairs, and
  // every mask it refuses must really fail to.
  const probe = tempDir("umask-boundary");
  for (const mask of [0o300, 0o400]) {
    // `previous` must be what the umask ACTUALLY was. This read `nfs.constants === undefined ? 0
    // : process.umask(mask)`, a condition that is never true — `node:fs` always exports
    // `constants` — so the branch was dead. Dead in the direction that matters, though: had it
    // ever been taken, the `finally` below would have restored umask 0 rather than the real
    // previous value, silently relaxing the mode of every file created by every test that ran
    // afterwards, in the one suite whose subject is file modes.
    const previous = process.umask(mask);
    const target = nodePath.join(probe, `m${mask.toString(8)}`);
    let opens = false;
    try {
      nfs.mkdirSync(target, { mode: 0o700 });
      try {
        const fd = nfs.openSync(target, nfs.constants.O_RDONLY | nfs.constants.O_DIRECTORY);
        nfs.fchmodSync(fd, 0o700);
        nfs.closeSync(fd);
        opens = true;
      } catch { opens = false; }
    } finally {
      process.umask(previous);
    }
    let guardAccepts = true;
    try { assertUmaskAllowsOwnerModes(mask); } catch { guardAccepts = false; }

    // ROOT bypasses permission checks, so a root kernel opens a 0300 directory happily and this
    // comparison would report a false FAILURE — the guard correctly refusing a mask the kernel
    // did not stop. That is a real configuration: container CI routinely runs as uid 0. The
    // property being checked genuinely differs by uid, so each case asserts its own, rather than
    // one of them being asserted and the other quietly inherited.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      assert.equal(opens, true, `umask ${mask.toString(8)}: root is not stopped by mode bits`);
    } else {
      assert.equal(opens, guardAccepts, `umask ${mask.toString(8)}: the guard must match the kernel`);
    }
  }

  // THE WIRING, which is what "at construction" means and what nothing here was checking.
  // Every assertion above calls `assertUmaskAllowsOwnerModes` directly, so deleting its call
  // from `createNodeSnapshotFs` left this whole test green while the adapter happily built
  // itself under a umask it documents as unusable.
  const before = process.umask(0o400);
  try {
    assert.throws(
      () => createNodeSnapshotFs(),
      /leaves owner READ intact/,
      "the adapter must refuse to construct under a umask it cannot satisfy",
    );
  } finally {
    process.umask(before);
  }
  // ...and it constructs again once the umask is back, so the refusal above was the umask and
  // not some unrelated breakage that would make the assertion pass for the wrong reason.
  assert.doesNotThrow(() => createNodeSnapshotFs());
});
