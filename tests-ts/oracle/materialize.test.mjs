/**
 * Prove `assertConformance` actually rejects a wrong tree.
 *
 * Every mutation here damages the MATERIALIZED TREE — the files on disk — and never the
 * manifest. Mutating the manifest would change the very document conformance compares against,
 * so both sides would move together and agree; the check would pass and the "test" would have
 * demonstrated nothing. Damaging only the disk side is what makes the manifest a fixed
 * reference and the comparison meaningful.
 *
 * The permission-bits question is settled at the bottom of this file rather than left as an
 * unasserted prerequisite.
 */
import assert from "node:assert/strict";
import {
  appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { assertConformance, materializeTree, TREE } from "./artifacts.mjs";

function expectRejected(name, mutate, expected) {
  test(name, () => {
    const root = mkdtempSync(join(tmpdir(), "spendbar-mut-"));
    try {
      const roots = materializeTree(root);
      assertConformance(root, roots);
      mutate(roots);
      assert.throws(
        () => assertConformance(root, roots),
        (err) => {
          assert.match(
            err.message,
            expected,
            `conformance failed, but not for the expected reason.\ngot: ${err.message}`,
          );
          return true;
        },
        `conformance ACCEPTED a damaged tree: ${name}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const firstFile = () => TREE.entries.find((e) => e.kind === "file");
const staleFile = () =>
  TREE.entries.find((e) => e.kind === "file" && TREE.explicitMtimeFiles.includes(e.path));
const link = () => TREE.entries.find((e) => e.kind === "symlink");
const dir = () => TREE.entries.find((e) => e.kind === "dir");
const abs = (roots, e) => join(roots[e.root], e.path);

describe("materialized-tree conformance rejects a damaged tree", () => {
  expectRejected(
    "a single altered byte",
    (roots) => {
      const e = firstFile();
      const p = abs(roots, e);
      const buf = readFileSync(p);
      buf[0] ^= 0x01; // one bit, so this is not detectable by length alone
      writeFileSync(p, buf);
      utimesSync(p, e.mtime, e.mtime); // keep the mtime honest so THIS is the only damage
    },
    /materialized bytes differ from the manifest/,
  );

  expectRejected(
    "content appended",
    (roots) => {
      const e = firstFile();
      appendFileSync(abs(roots, e), "\n");
      utimesSync(abs(roots, e), e.mtime, e.mtime);
    },
    /materialized bytes differ from the manifest/,
  );

  expectRejected(
    "a required file removed",
    (roots) => unlinkSync(abs(roots, firstFile())),
    /was not materialized/,
  );

  expectRejected(
    "the escaping symlink replaced by a regular file, without following it",
    (roots) => {
      // Replaced, not followed: the point of this fixture is that usage.py's realpath
      // containment check has something to reject. A tree where it became an ordinary file
      // still reads fine and still produces output — it just stops testing containment.
      const p = abs(roots, link());
      unlinkSync(p);
      writeFileSync(p, "not a link\n");
    },
    /is a file but the manifest declares a symlink/,
  );

  expectRejected(
    "the escaping symlink repointed at a different DECLARED file",
    (roots) => {
      const e = link();
      const p = abs(roots, e);
      // Repointed at a file the manifest ALREADY declares, so the only damage is the target.
      // Creating a fresh file would additionally trip the undeclared-path check and the
      // mutation would be credited to the wrong branch. This is also the case a containment
      // check cannot catch: a "does it still escape the root" test passes happily when the
      // link is aimed at some OTHER file, which is why the target is compared exactly.
      const declared = TREE.entries.find(
        (x) => x.kind === "file" && x.root === "codexHome" && x.path !== e.path,
      );
      unlinkSync(p);
      symlinkSync(abs(roots, declared), p);
    },
    /but the manifest declares/,
  );

  expectRejected(
    "the deliberately stale mtime bumped to now",
    (roots) => {
      // usage.py:620 skips an hourly transcript whose mtime predates the target day WITHOUT
      // opening it. Bumping this one silently promotes a file the fixture means to exclude
      // into the corpus, which changes the hourly totals and nothing else — the quietest
      // possible corruption, and the reason mtime is in the manifest at all.
      const now = Math.floor(Date.now() / 1000);
      utimesSync(abs(roots, staleFile()), now, now);
    },
    /mtime is \d+, manifest says/,
  );

  expectRejected(
    "a required directory removed",
    (roots) => rmSync(abs(roots, dir()), { recursive: true }),
    /was not materialized/,
  );

  expectRejected(
    "a declared FILE replaced by a symlink to identical bytes",
    (roots) => {
      // readFileSync and statSync both follow links, so the content and mtime checks would be
      // satisfied by the target. Only an lstat on the entry itself notices.
      const e = firstFile();
      const p = abs(roots, e);
      const decoy = join(roots.codexOutside, "decoy.jsonl");
      writeFileSync(decoy, readFileSync(p));
      utimesSync(decoy, e.mtime, e.mtime);
      unlinkSync(p);
      symlinkSync(decoy, p);
    },
    /is a symlink but the manifest declares a file/,
  );

  expectRejected(
    "a declared DIRECTORY replaced by a regular file",
    (roots) => {
      const e = dir();
      rmSync(abs(roots, e), { recursive: true });
      writeFileSync(abs(roots, e), "");
    },
    /is a file but the manifest declares a dir/,
  );

  expectRejected(
    "an unexpected extra file added to the tree",
    (roots) => {
      // usage.py:619 globs `~/.claude/projects/*/*.jsonl`, so a stranger here is a file the
      // oracle would actually read into the hourly totals. Checking only that every manifest
      // entry EXISTS would miss it entirely — the manifest must describe the tree in both
      // directions, which is why conformance walks the disk as well.
      writeFileSync(join(roots.home, ".claude/projects/-Users-fixture-Developer-alpha/x.jsonl"), "{}\n");
    },
    /exists on disk but is not in the manifest/,
  );

  expectRejected(
    "an extra EMPTY directory added to the tree",
    (roots) => mkdirSync(join(roots.home, ".claude/projects/-Users-fixture-Developer-ghost")),
    /exists on disk but is not in the manifest/,
  );
});

describe("permission bits", () => {
  test("are NOT part of the fixture contract, and no fixture file relies on them", () => {
    // DECISION (ISS-019 asked for one rather than an unasserted prerequisite): permission bits
    // are dropped from the manifest schema, not recorded and not restored.
    //
    // The reasoning is that nothing reads them. usage.py opens fixture files for reading and
    // has no permission-denied branch — `with open(path)` at usage.py:622 would raise, and no
    // case in the registry exercises that. So a mode is not contract-relevant: recording it
    // would add a field that no behaviour depends on, and the Python builder inherits the
    // umask anyway, so the recorded value would describe the generating machine rather than
    // the fixture.
    //
    // The decision is made self-enforcing here instead of just written down: every file must
    // be readable and none may carry a special bit. If a future fixture deliberately uses a
    // mode to exercise a permission path, this fails and the decision gets revisited on
    // purpose rather than by omission.
    const root = mkdtempSync(join(tmpdir(), "spendbar-perm-"));
    try {
      const roots = materializeTree(root);
      let checked = 0;
      for (const e of TREE.entries) {
        if (e.kind !== "file") continue;
        const mode = statSync(join(roots[e.root], e.path)).mode & 0o7777;
        assert.ok(mode & 0o400, `${e.root}/${e.path} is not owner-readable (mode ${mode.toString(8)})`);
        assert.equal(
          mode & 0o7000,
          0,
          `${e.root}/${e.path} carries a setuid/setgid/sticky bit (mode ${mode.toString(8)}); ` +
            "the manifest does not model that, so it would be lost on materialization.",
        );
        checked++;
      }
      assert.ok(checked > 0, "no files were checked, so this assertion proved nothing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no manifest entry carries a mode field at all", () => {
    // The direct statement of the decision, replacing an earlier test that materialized twice
    // and asserted the modes DIFFERED. That was environment-dependent: under a hardened
    // umask of 077 writeFileSync already produces 0600, so chmod'ing to 0600 changed nothing
    // and the assertion failed even though modes are correctly absent from the schema. It also
    // did not actually demonstrate the schema — two trees having equal modes is what you would
    // expect either way.
    for (const e of TREE.entries) {
      assert.ok(
        !("mode" in e),
        `${e.root}/${e.path} carries a mode field; the schema deliberately does not model one, ` +
          "so materialization would silently drop it.",
      );
    }
  });
});
