#!/usr/bin/env python3
"""Independently verify the committed artifact set in tests/oracle/responses/.

This file deliberately imports NOTHING from build.py, record.py or trace.py, and does not read
inventory.json or traces.json. It re-derives every claim from the two things the artifacts are
supposed to be a recording OF:

  * tests/fake_ccusage.py, invoked as a subprocess, for the response bytes;
  * tests/harness/fixtures.py --build, invoked as a subprocess, for the tree.

The point is that a generator bug cannot hide here. If build.py and verify.py shared a helper
that computed a key, a digest, or a canonical path, they would agree about a mistake in it and
the "verification" would be a restatement. They share only the two artifacts under test and the
canonical constants, which are asserted rather than imported.

Run: python3 tests/oracle/verify.py [--dir tests/oracle/responses]
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
FAKE = os.path.join(TESTS, "fake_ccusage.py")
FIXTURES = os.path.join(TESTS, "harness", "fixtures.py")


def sha(b):
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------------------------- responses


def verify_responses(index, root, canonical_home):
    """Re-run the fixture for every recorded key and compare bytes, digests and termination."""
    fails = []
    seen = {}

    for rec in index["responses"]:
        key = (rec["mode"], tuple(rec["argv"]))
        if key in seen:
            fails.append(
                f"duplicate key {key} in records {seen[key]} and {rec['file']}: a replayer "
                "lookup keyed on (mode, argv) would be ambiguous.")
            continue
        seen[key] = rec["file"]

        path = os.path.join(root, rec["file"])
        if not os.path.exists(path):
            fails.append(f"{rec['file']}: indexed but missing from disk.")
            continue
        with open(path) as fh:
            stored = json.load(fh)

        if stored["mode"] != rec["mode"] or stored["argv"] != rec["argv"]:
            fails.append(
                f"{rec['file']}: the record's own (mode, argv) disagrees with the index entry. "
                f"file={stored['mode']} {stored['argv']}  index={rec['mode']} {rec['argv']}")
            continue

        out = base64.b64decode(stored["stdoutBase64"])
        err = base64.b64decode(stored["stderrBase64"])

        # The digests must describe the payload actually stored, not the payload the generator
        # meant to store. Checked BEFORE re-running, so a corrupted file is reported as
        # corruption rather than as a fixture disagreement.
        if sha(out) != rec["stdoutSha256"]:
            fails.append(f"{rec['file']}: stored stdout does not match its indexed sha256.")
        if sha(err) != rec["stderrSha256"]:
            fails.append(f"{rec['file']}: stored stderr does not match its indexed sha256.")
        if stored["termination"] != rec["termination"]:
            fails.append(f"{rec['file']}: termination disagrees with the index entry.")

        env = dict(os.environ)
        env["HOME"] = canonical_home
        for var in ("USERPROFILE", "HOMEDRIVE", "HOMEPATH"):
            env.pop(var, None)
        env["FAKE_MODE"] = rec["mode"]
        proc = subprocess.run(
            [sys.executable, FAKE, *rec["argv"]], capture_output=True, env=env)

        if proc.stdout != out:
            fails.append(
                f"{rec['file']}: the fixture no longer produces the recorded stdout for "
                f"mode={rec['mode']} argv={rec['argv']} "
                f"(recorded {len(out)} bytes, now {len(proc.stdout)}).")
        if proc.stderr != err:
            fails.append(
                f"{rec['file']}: the fixture no longer produces the recorded stderr for "
                f"mode={rec['mode']} argv={rec['argv']}.")

        want = ({"kind": "signal", "status": -proc.returncode} if proc.returncode < 0
                else {"kind": "exit", "status": proc.returncode})
        if want != stored["termination"]:
            fails.append(
                f"{rec['file']}: termination changed — recorded {stored['termination']}, "
                f"fixture now {want}.")

    # An index that lists nothing would pass every loop above without executing one comparison.
    if not index["responses"]:
        fails.append("the index contains no responses at all; nothing was verified.")

    orphans = (set(os.listdir(root)) - {r["file"] for r in index["responses"]}
               - {"index.json", "tree.json"})
    if orphans:
        fails.append(
            f"{len(orphans)} file(s) on disk are not in the index, e.g. {sorted(orphans)[:3]}. "
            "A replayer would never read them, so they are stale output from an older key set.")

    return fails


# --------------------------------------------------------------------------------------- tree


def _locate(abs_path, roots):
    """Express an absolute path as the manifest's {root, path} pair.

    Deliberately re-implemented rather than imported from build.py. If both sides called the
    same function, a bug in it would produce the same wrong pair twice and compare equal — the
    comparison would be testing that the code is consistent with itself, which it always is.

    Both sides are realpath'd first: the roots come from mkdtemp under /var/folders and macOS
    symlinks /var to /private/var, so a resolved target never matches the raw root string.
    """
    for name, root in roots:
        root = os.path.realpath(root)
        if abs_path == root or abs_path.startswith(root + os.sep):
            return {"root": name, "path": os.path.relpath(abs_path, root).replace(os.sep, "/")}
    return {"root": "<outside every fixture root>", "path": abs_path}


def verify_tree(tree, canonical_home):
    """Rebuild the fixture tree via the fixtures CLI and compare it to the manifest."""
    fails = []
    proc = subprocess.run(
        [sys.executable, FIXTURES, "--build"], capture_output=True, text=True)
    if proc.returncode != 0:
        return [f"tests/harness/fixtures.py --build failed ({proc.returncode}): {proc.stderr}"]
    built = json.loads(proc.stdout)
    roots = [("home", built["home"]),
             ("codexHome", built["codexHome"]),
             ("codexOutside", built["codexOutside"])]

    now = time.time()
    try:
        actual = {}
        explicit = []
        for root_name, root in roots:
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames.sort()
                if not filenames and not dirnames:
                    rel_dir = os.path.relpath(dirpath, root)
                    actual[(root_name, "" if rel_dir == "." else rel_dir.replace(os.sep, "/"))] \
                        = ("dir", None, None)
                for fn in sorted(filenames):
                    full = os.path.join(dirpath, fn)
                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                    if os.path.islink(full):
                        # The manifest stores the target as a (root, path) pair. Re-derive the
                        # same pair here and compare it: recording the link's EXISTENCE without
                        # its target would let a generator repoint the escaping fixture at some
                        # harmless path inside CODEX_HOME, and the containment case this
                        # symlink exists to exercise would quietly stop testing containment.
                        actual[(root_name, rel)] = ("symlink", _locate(os.path.realpath(full), roots), None)
                        continue
                    with open(full, "rb") as fh:
                        data = fh.read()
                    # fixtures.py expands the sessions' `~` against the temp home it just made,
                    # so a freshly built tree names THIS machine's temp dir where the manifest
                    # names the canonical home. Normalizing here — in the verifier, on the live
                    # build — is the whole reason the manifest can be canonical and portable.
                    data = data.replace(built["home"].encode(), canonical_home.encode())
                    mtime = os.stat(full).st_mtime
                    actual[(root_name, rel)] = ("file", data, mtime)
                    # A file the builder just created carries the current clock; one that is
                    # materially older was backdated on purpose. usage.py:620 skips an hourly
                    # transcript whose mtime predates the target day without opening it, so
                    # which files those are is fixture data, not incidental metadata.
                    if mtime < now - 3600:
                        explicit.append((rel, int(mtime)))

        # Directories are kept, not skipped. build_fixture_home creates an EMPTY ~/.codex, and
        # that emptiness is the fixture: it is the default CODEX_HOME (usage.py:197), so a
        # replayer that materialized only files would leave usage.py resolving a path that does
        # not exist.
        recorded = {(e["root"], e["path"]): e for e in tree["entries"]}

        missing = sorted(set(recorded) - set(actual))
        extra = sorted(set(actual) - set(recorded))
        if missing:
            fails.append(
                f"{len(missing)} manifest entr(ies) no longer exist in a fresh build, e.g. "
                f"{missing[:3]}.")
        if extra:
            fails.append(
                f"{len(extra)} file(s) in a fresh build are absent from the manifest, e.g. "
                f"{extra[:3]}. A replayer would materialize an incomplete tree.")

        for key in sorted(set(recorded) & set(actual)):
            rec = recorded[key]
            kind, data, mtime = actual[key]
            if rec["kind"] != kind:
                fails.append(f"{key}: manifest says {rec['kind']}, fresh build has {kind}.")
                continue
            if kind == "symlink":
                if rec.get("target") != data:
                    fails.append(
                        f"{key}: manifest symlink target {rec.get('target')} but a fresh build "
                        f"points at {data}.")
                continue
            if kind != "file":
                continue
            stored = base64.b64decode(rec["contentBase64"])
            if sha(stored) != rec["sha256"]:
                fails.append(f"{key}: stored content does not match its own recorded sha256.")
            if stored != data:
                fails.append(
                    f"{key}: manifest content differs from a fresh build "
                    f"({len(stored)} bytes vs {len(data)}).")
            if rec.get("substituteHome") and canonical_home.encode() not in stored:
                fails.append(
                    f"{key}: flagged substituteHome but contains no {canonical_home} token, so "
                    "a replayer would rewrite nothing.")
            if canonical_home.encode() in stored and not rec.get("substituteHome"):
                fails.append(
                    f"{key}: contains the {canonical_home} token but is NOT flagged "
                    "substituteHome, so a replayer would leave an unusable absolute path.")
            # A backdated file must carry its real mtime; everything else must carry the
            # canonical one, or the committed manifest would change on every regeneration.
            backdated = mtime < now - 3600
            want = int(mtime) if backdated else tree["canonicalMtime"]
            if rec["mtime"] != want:
                fails.append(
                    f"{key}: manifest mtime {rec['mtime']} but a fresh build says {want} "
                    f"({'deliberately backdated' if backdated else 'inherited the clock'}).")
    finally:
        for _, root in roots:
            shutil.rmtree(root, ignore_errors=True)

    got = sorted(r for r, _ in explicit)
    if got != sorted(tree["explicitMtimeFiles"]):
        fails.append(
            f"explicitMtimeFiles disagrees with a fresh build: manifest "
            f"{sorted(tree['explicitMtimeFiles'])}, rebuilt {got}.")
    if not got:
        fails.append(
            "no file in a fresh build carries a deliberate mtime, but fixtures.py backdates "
            "one to exercise usage.py:620's skip-unopened path. Either that fixture is gone or "
            "the mtime is no longer being set.")

    if not tree["entries"]:
        fails.append("the tree manifest is empty; nothing was verified.")
    if not any(e["kind"] == "symlink" for e in tree["entries"]):
        fails.append(
            "the manifest records no symlink. fixtures.py builds one that escapes CODEX_HOME "
            "on purpose, to exercise usage.py's realpath containment check; if serializing "
            "followed it into an ordinary file, that case is silently gone.")
    return fails


# ------------------------------------------------------------------------------------ privacy


def verify_privacy(root, canonical_home):
    """No committed artifact may name a real home directory or a machine-local temp path.

    These files ship in a public repo. The generator forces HOME to the canonical value, but
    that is the generator asserting its own correctness; this checks the bytes on disk.
    """
    fails = []
    enc = re.sub(r"[^A-Za-z0-9]", "-", canonical_home)
    blob = []
    for name in sorted(os.listdir(root)):
        with open(os.path.join(root, name)) as fh:
            doc = json.load(fh)
        blob.append(json.dumps(doc))
        for field in ("stdoutBase64", "stderrBase64"):
            if field in doc:
                blob.append(base64.b64decode(doc[field]).decode("utf8", "replace"))
        for e in doc.get("entries", []):
            if "contentBase64" in e:
                blob.append(base64.b64decode(e["contentBase64"]).decode("utf8", "replace"))
    text = "\n".join(blob)

    # Every home-shaped path must be the canonical one, in either slash or encoded form. The
    # literal "-Users-testuser" prefix is hardcoded in fixtures.py:152 as a synthetic project
    # key and names no real account.
    for m in re.finditer(r"(?:/(?:Users|home)/|-(?:Users|home)-)[A-Za-z0-9_.]+", text):
        s = m.group(0)
        ctx = text[max(0, m.start() - 12):m.end()]
        if canonical_home in ctx or enc in ctx or s.startswith("-Users-fixture"):
            continue
        fails.append(f"non-canonical home path in the artifacts: {ctx!r}")

    for pat in (r"/var/folders/", r"/private/var/", r"/tmp/[A-Za-z0-9_.-]*(?:home|codex)"):
        for m in re.finditer(pat, text):
            fails.append(
                f"machine-local temp path in the artifacts: "
                f"{text[max(0, m.start() - 10):m.end() + 30]!r}")

    return sorted(set(fails))[:20]


# --------------------------------------------------------------------------------------- main


def main():
    argv = sys.argv[1:]
    root = argv[argv.index("--dir") + 1] if "--dir" in argv else os.path.join(HERE, "responses")

    if not os.path.isdir(root):
        sys.stderr.write(
            f"{root} does not exist. Generate it with: python3 tests/oracle/build.py\n")
        return 2
    with open(os.path.join(root, "index.json")) as fh:
        index = json.load(fh)
    with open(os.path.join(root, "tree.json")) as fh:
        tree = json.load(fh)

    home = index["canonicalHome"]
    if tree["canonicalHome"] != home:
        sys.stderr.write(
            f"index.json and tree.json disagree about the canonical home "
            f"({home} vs {tree['canonicalHome']}); they were not generated together.\n")
        return 1
    if not home.startswith("/") or ".." in home:
        sys.stderr.write(f"canonicalHome {home!r} is not a plain absolute path.\n")
        return 1

    groups = [
        ("responses", verify_responses(index, root, home)),
        ("tree", verify_tree(tree, home)),
        ("privacy", verify_privacy(root, home)),
    ]
    fails = [(g, f) for g, fs in groups for f in fs]

    if fails:
        sys.stderr.write(
            f"\nindependent verification FAILED ({len(fails)} finding(s)):\n\n")
        for group, f in fails:
            sys.stderr.write(f"  [{group}] {f}\n")
        sys.stderr.write(
            "\nThis check re-derives everything from fake_ccusage.py and fixtures.py directly. "
            "It disagreeing with the committed artifacts means the artifacts are stale or "
            "wrong — regenerate with tests/oracle/build.py and inspect the diff.\n")
        return 1

    print(f"independent verification OK: {len(index['responses'])} responses re-run against "
          f"fake_ccusage.py, {len(tree['entries'])} tree entries rebuilt from fixtures.py, "
          f"no non-canonical paths")
    return 0


if __name__ == "__main__":
    sys.exit(main())
