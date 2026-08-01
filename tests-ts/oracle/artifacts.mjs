/**
 * Read the committed oracle artifacts and rebuild the world they describe — with no Python.
 *
 * tests/oracle/ holds a byte-exact recording of every ccusage call usage.py makes and of the
 * filesystem tree it runs against (see tests/oracle/README.md). This module is the consumer:
 * it materializes that tree, and answers `(mode, argv) -> recorded bytes` for the replayer.
 *
 * The generator side is Python and stays Python. Nothing here shells out to it, which is the
 * entire point — `npm run test:pure` must work on a machine with no python3 at all.
 */
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ARTIFACTS = resolve(HERE, "../../tests/oracle/responses");

const read = (name) => JSON.parse(readFileSync(join(ARTIFACTS, name), "utf8"));

export const INDEX = read("index.json");
export const TREE = read("tree.json");

/**
 * How fake_ccusage.py encodes a home path into a project key: `re.sub(r"[^A-Za-z0-9]", "-", h)`
 * at tests/fake_ccusage.py:13. Reproduced rather than imported, because importing it would mean
 * running Python — the one thing this module exists to avoid.
 *
 * The `u` flag matters: without it JS matches each UTF-16 code UNIT, so an astral character in
 * the home path would become two dashes where Python's `re` (which iterates code points) emits
 * one. The two encodings would then disagree and no project key would strip.
 */
export const encodeHome = (home) => home.replaceAll(/[^A-Za-z0-9]/gu, "-");

/** The key a response is stored under. Mode and argv both matter; neither alone is unique. */
export const keyOf = (mode, argv) => JSON.stringify([mode, argv]);

const RESPONSES = new Map();
for (const rec of INDEX.responses) {
  const k = keyOf(rec.mode, rec.argv);
  if (RESPONSES.has(k)) {
    throw new Error(
      `tests/oracle/responses/index.json has two records for ${k}. A lookup keyed on ` +
        `(mode, argv) cannot be resolved, so the artifact set is unusable rather than merely ` +
        `imperfect. Regenerate it with tests/oracle/build.py.`,
    );
  }
  RESPONSES.set(k, rec);
}

/**
 * The recorded response for one child call, or a thrown error.
 *
 * Deliberately NO fallback to "normal", and no nearest-match. A missing artifact means the
 * recording does not cover the call the subject just made, and the only honest answer is to
 * stop: serving some other mode's bytes would turn a coverage gap into a plausible wrong
 * answer, which is strictly worse because it looks like a passing test.
 */
export function lookup(mode, argv, home = process.env.HOME) {
  const rec = RESPONSES.get(keyOf(mode, argv));
  if (rec === undefined) {
    const sameMode = INDEX.responses.filter((r) => r.mode === mode).length;
    throw new Error(
      `no recorded ccusage response for mode=${JSON.stringify(mode)} ` +
        `argv=${JSON.stringify(argv)}.\n` +
        `The artifact set has ${INDEX.responses.length} records (${sameMode} for this mode) and ` +
        `none of them is this call.\n` +
        `This is NOT a reason to fall back to another mode — it means the subject asked for ` +
        `something the recording does not cover. Either the subject's argv is wrong, or ` +
        `tests/oracle needs re-recording (record.py then build.py).`,
    );
  }
  const payload = JSON.parse(readFileSync(join(ARTIFACTS, rec.file), "utf8"));
  return {
    stdout: rehome(Buffer.from(payload.stdoutBase64, "base64"), home),
    stderr: rehome(Buffer.from(payload.stderrBase64, "base64"), home),
    termination: payload.termination,
  };
}

/**
 * Rewrite the canonical home out of a recorded payload, in both the forms it appears in.
 *
 * The responses were generated under HOME=/fixture/home, so their project keys read
 * `-fixture-home-Developer-alpha`. The subject runs under a real temp home and derives its own
 * HOME_ENC from that, so it would fail to strip the recorded prefix and render the raw key as
 * the project name instead of `alpha`. This is the response-side twin of the tree manifest's
 * `substituteHome` flag; both exist because the artifacts are canonical and portable, and the
 * machine replaying them is neither.
 */
function rehome(buf, home) {
  if (!home) {
    throw new Error(
      "lookup() needs the home the subject is running under, to rewrite the canonical home out " +
        "of the recorded payload. HOME is unset and none was passed.",
    );
  }
  const canonical = INDEX.canonicalHome;
  // Callback replacements, NOT string ones. `String.replaceAll` interprets `$&`, `$\``, `$'`
  // and `$$` inside a replacement STRING, so a home path containing any of them would be
  // silently mangled. A function replacement is taken literally.
  const out = buf
    .toString("utf8")
    .replaceAll(encodeHome(canonical), () => encodeHome(home))
    .replaceAll(canonical, () => home);
  return Buffer.from(out, "utf8");
}

/** Reject a manifest location that names an unknown root, or escapes the one it names. */
function contain(roots, loc, what) {
  const root = roots[loc.root];
  if (root === undefined) {
    throw new Error(`manifest ${what} names unknown root ${JSON.stringify(loc.root)}`);
  }
  if (loc.path.startsWith("/")) {
    throw new Error(`manifest ${what} ${JSON.stringify(loc.path)} is absolute`);
  }
  const full = resolve(root, loc.path);
  if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) {
    throw new Error(
      `manifest ${what} ${JSON.stringify(loc.path)} escapes its root ${loc.root} ` +
        `(resolves to ${full}). Refusing to materialize outside the tree.`,
    );
  }
}

/** Every path under `root`, relative and slash-joined. Symlinks are listed, never followed. */
function* walk(root, prefix = "") {
  for (const ent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory() && !ent.isSymbolicLink()) {
      // A directory is only itself an entry when the manifest recorded it as one (an empty
      // dir); otherwise it is implied by the files inside it, so recurse without reporting.
      let empty = true;
      for (const child of walk(root, rel)) {
        empty = false;
        yield child;
      }
      if (empty) yield rel;
    } else {
      yield rel;
    }
  }
}

/**
 * Recreate the fixture tree under `dest`, returning the three root paths.
 *
 * The manifest carries content, not just hashes: a digest-only manifest can detect that
 * something changed but cannot rebuild anything, and rebuilding is the whole job here.
 */
export function materializeTree(dest) {
  const roots = {};
  for (const name of TREE.roots) roots[name] = join(dest, name);

  // Validate EVERY declared location before creating a single directory. join() happily
  // resolves a `../` inside a manifest path back out of the tree, and materialization writes
  // files and sets mtimes — so a malformed manifest would damage the surrounding filesystem
  // before conformance ever ran. Conformance is an after-the-fact check and cannot undo a
  // write, which is why this is a precondition rather than one more assertion.
  for (const e of TREE.entries) {
    contain(roots, e, "entry");
    if (e.kind === "symlink") contain(roots, e.target, "symlink target");
  }

  for (const name of TREE.roots) mkdirSync(roots[name], { recursive: true });

  const abs = (loc) => join(roots[loc.root], loc.path);

  // Three passes, because the order is load-bearing. Files must exist before the symlink that
  // points at one is created, or the realpath containment check in usage.py resolves a dangling
  // link and the case stops testing containment. And mtimes must be applied last: writing a
  // file after setting its mtime silently resets it to now, which would quietly promote the
  // deliberately-stale transcript into a live one.
  for (const e of TREE.entries) {
    if (e.kind === "dir") mkdirSync(abs(e), { recursive: true });
  }
  for (const e of TREE.entries) {
    if (e.kind !== "file") continue;
    let data = Buffer.from(e.contentBase64, "base64");
    if (e.substituteHome) {
      // The artifact stores the canonical literal; this run's home is a real directory
      // somewhere else. usage.py derives project keys from the HOME the child sees, so a
      // session cwd still naming /fixture/home would map through a HOME_ENC that matches
      // nothing and every codex project would land in the `unknown` bucket.
      data = Buffer.from(
        data.toString("utf8").replaceAll(TREE.canonicalHome, () => roots.home),
        "utf8",
      );
    }
    mkdirSync(dirname(abs(e)), { recursive: true });
    writeFileSync(abs(e), data);
  }
  for (const e of TREE.entries) {
    if (e.kind !== "symlink") continue;
    mkdirSync(dirname(abs(e)), { recursive: true });
    symlinkSync(abs(e.target), abs(e));
  }
  for (const e of TREE.entries) {
    if (e.kind !== "file") continue;
    utimesSync(abs(e), e.mtime, e.mtime);
  }

  return roots;
}

/**
 * Assert the artifacts are internally sound and that `dest` now matches them.
 *
 * Called SYNCHRONOUSLY from inside the golden test rather than living in a sibling test file.
 * Node's test runner may execute files independently and concurrently, so a separate file
 * cannot gate this one — "the conformance test will catch it" would be a claim about an
 * ordering the runner does not promise.
 */
export function assertConformance(dest, roots) {
  const fail = (msg) => {
    throw new Error(`oracle artifact conformance: ${msg}`);
  };

  if (INDEX.responses.length === 0) fail("the index lists no responses; nothing can be replayed.");
  if (TREE.entries.length === 0) fail("the tree manifest is empty; nothing was materialized.");
  if (INDEX.canonicalHome !== TREE.canonicalHome) {
    fail(`index (${INDEX.canonicalHome}) and tree (${TREE.canonicalHome}) disagree about the ` +
      `canonical home, so they were not generated together.`);
  }

  const abs = (loc) => join(roots[loc.root], loc.path);

  for (const e of TREE.entries) {
    const p = abs(e);
    if (!existsSync(p)) fail(`${e.kind} ${e.root}/${e.path} was not materialized.`);

    // lstat EVERY entry, not just the symlinks. readFileSync and statSync both FOLLOW links,
    // so a declared file swapped for a symlink to identical bytes elsewhere would satisfy the
    // content and mtime checks completely — and a declared directory replaced by a file would
    // pass on existence alone. The kind is part of what the manifest asserts, so it is checked
    // for every entry rather than only where a link is expected.
    const st = lstatSync(p);
    const actualKind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
    if (actualKind !== e.kind) {
      fail(`${e.root}/${e.path} is a ${actualKind} but the manifest declares a ${e.kind}.`);
    }
    if (e.kind !== "file") continue;

    const onDisk = readFileSync(p);
    // The manifest's own digest covers the CANONICAL bytes, so compare against those rather
    // than against what landed on disk — the home substitution legitimately changes the file.
    const stored = Buffer.from(e.contentBase64, "base64");
    if (createHash("sha256").update(stored).digest("hex") !== e.sha256) {
      fail(`${e.root}/${e.path}: the manifest's stored content does not match its own sha256.`);
    }
    const want = e.substituteHome
      ? Buffer.from(stored.toString("utf8").replaceAll(TREE.canonicalHome, () => roots.home), "utf8")
      : stored;
    if (!onDisk.equals(want)) {
      fail(`${e.root}/${e.path}: materialized bytes differ from the manifest ` +
        `(${onDisk.length} on disk vs ${want.length} expected).`);
    }
    if (onDisk.includes(TREE.canonicalHome)) {
      fail(`${e.root}/${e.path}: still contains the literal ${TREE.canonicalHome} after ` +
        `materialization, so the home substitution did not happen. usage.py would map every ` +
        `session cwd through a HOME_ENC that matches nothing.`);
    }
    const mtime = Math.floor(statSync(p).mtimeMs / 1000);
    if (mtime !== e.mtime) {
      fail(`${e.root}/${e.path}: mtime is ${mtime}, manifest says ${e.mtime}. usage.py:620 ` +
        `decides whether to open an hourly transcript on exactly this value.`);
    }
  }

  // Walk the DISK too, not just the manifest. Checking only that every manifest entry exists
  // is one-directional: a tree carrying an extra transcript would satisfy it completely, while
  // usage.py:619 globs `~/.claude/projects/*/*.jsonl` and would happily read the stranger into
  // the hourly totals. The manifest must describe the tree exactly, in both directions.
  const declared = new Set(TREE.entries.map((e) => `${e.root}/${e.path}`));
  for (const [name, root] of Object.entries(roots)) {
    for (const found of walk(root)) {
      const rel = `${name}/${found}`;
      if (!declared.has(rel)) {
        fail(`${rel} exists on disk but is not in the manifest. The tree must match the ` +
          `manifest exactly — usage.py globs these directories, so an undeclared file is one ` +
          `the oracle would read.`);
      }
    }
  }

  // The escaping symlink is the containment fixture; if materialization followed it into an
  // ordinary file, the case survives as a green test that no longer tests containment.
  const links = TREE.entries.filter((e) => e.kind === "symlink");
  if (links.length === 0) fail("the manifest records no symlink; the containment case is gone.");
  for (const e of links) {
    const p = abs(e);
    // The EXACT declared target, not merely "somewhere under the right root". A prefix test
    // accepts any other file in that root — repointing the containment fixture at a different
    // codexOutside file would pass — and a raw `startsWith` additionally accepts a sibling
    // root whose name merely shares the prefix (codexOutside2). realpath both sides because
    // the roots are mkdtemp paths under /var/folders and macOS symlinks /var to /private/var.
    const target = realpathSync(p);
    const want = realpathSync(abs(e.target));
    if (target !== want) {
      fail(`${e.root}/${e.path} resolves to ${target}, but the manifest declares ` +
        `${e.target.root}/${e.target.path} (${want}).`);
    }
  }
}
