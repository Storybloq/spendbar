#!/usr/bin/env python3
"""Prove that build.py --check and verify.py can actually fail.

Both of those scripts pass. That on its own says nothing: a check that cannot fail passes too,
and the failure mode is silent — the suite stays green while the thing it guards rots. So every
claim they make is damaged here on purpose, in a COPY, and the check must report that specific
damage. A mutation that survives is a hole in the check, and is reported as a failure of this
file rather than quietly tolerated.

Each mutation names the substring the tool is expected to emit. Matching on the specific
message, not merely on a non-zero exit, is what stops a mutation from being credited to an
unrelated failure that happened to fire at the same time.

Run: python3 tests/oracle/mutation_check.py
"""
import base64
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build.py")
VERIFY = os.path.join(HERE, "verify.py")
INVENTORY = os.path.join(HERE, "inventory.json")
RESPONSES = os.path.join(HERE, "responses")


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


# ------------------------------------------------------------------- inventory check mutations


INVENTORY_MUTATIONS = [
    ("compare declared as TWO instances calls",
     lambda i: i["commands"]["compare"].__setitem__("calls", ["instances", "instances"]),
     "argv_rel_day1_day2"),
    ("codex drops the unconditional codexDaily",
     lambda i: i["commands"]["codex"].__setitem__("calls", ["codexSessions"]),
     "codex_empty"),
    ("codex call order swapped",
     lambda i: i["commands"]["codex"].__setitem__("calls", ["codexDaily", "codexSessions"]),
     "codex_bad_cost"),
    ("hourly declared as making no calls",
     lambda i: i["commands"]["hourly"].__setitem__("calls", []),
     "argv_hourly"),
    ("instances shape loses --breakdown",
     lambda i: i["shapes"]["instances"].__setitem__(
         "argv", ["claude", "daily", "--instances", "--json"]),
     "matches no declared shape"),
    ("blocks shape gains an --until it never passes",
     lambda i: i["shapes"]["blocks"].__setitem__("windowArgs", ["--since", "--until"]),
     "shape blocks declares --until"),
    ("share --vs second call removed",
     lambda i: i["commands"]["share"].pop("callsWithVs"),
     "argv_rel_vs"),
    ("help flags no longer exempt",
     lambda i: i.__setitem__("helpFlags", []),
     "argv_help_after_option"),
    ("stale allowlist entry for an arg that IS observed",
     lambda i: i["unexercised"].append(
         {"shape": "instances", "arg": "--since", "issue": "x", "why": []}),
     "still exempts instances/--since"),
    ("defaultAnchor changed without re-recording",
     lambda i: i.__setitem__("defaultAnchor", "2027-05-05"),
     "recorded at an anchor that no longer matches"),
    # RETIRED: "allowlist entry deleted while the gap remains". ISS-029 exercised all four
    # windowed args and emptied `unexercised`, so there is no entry to delete and the
    # mutation became a no-op that always SURVIVED (ISS-059). Its detector — a declared arg
    # with no observation and no entry — is still observed by the "--until" mutation above;
    # the entry-hygiene direction is now observed by the mutation below instead.
    ("allowlist entry names a shape no inventory declares",
     lambda i: i["unexercised"].append(
         {"shape": "bogus", "arg": "--since", "issue": "x", "why": []}),
     "exempts nothing"),
]


def mutate_inventory(base):
    results = []
    for name, fn, expect in INVENTORY_MUTATIONS:
        inv = copy.deepcopy(base)
        fn(inv)
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            json.dump(inv, fh)
        try:
            code, out = run([sys.executable, BUILD, "--check", "--inventory", path])
            results.append((name, code == 1 and expect in out, expect, out))
        finally:
            os.unlink(path)
    return results


# ---------------------------------------------------------------------- verifier mutations


def _first_response(root):
    """The lowest-numbered response file, so the mutation lands somewhere deterministic."""
    index = json.load(open(os.path.join(root, "index.json")))
    return index["responses"][0], index


def m_corrupt_stdout(root):
    rec, _ = _first_response(root)
    p = os.path.join(root, rec["file"])
    doc = json.load(open(p))
    doc["stdoutBase64"] = base64.b64encode(b"tampered").decode()
    json.dump(doc, open(p, "w"))


def m_corrupt_digest(root):
    _, index = _first_response(root)
    index["responses"][0]["stdoutSha256"] = "0" * 64
    json.dump(index, open(os.path.join(root, "index.json"), "w"))


def m_wrong_termination(root):
    rec, _ = _first_response(root)
    p = os.path.join(root, rec["file"])
    doc = json.load(open(p))
    doc["termination"] = {"kind": "exit", "status": 99}
    json.dump(doc, open(p, "w"))


def m_signal_as_exit(root):
    """A signal death recorded as a plain exit — the collapse the {kind,status} shape exists
    to prevent. Both records claim status 2; only `kind` distinguishes them."""
    rec, index = _first_response(root)
    p = os.path.join(root, rec["file"])
    doc = json.load(open(p))
    doc["termination"] = {"kind": "signal", "status": doc["termination"]["status"]}
    json.dump(doc, open(p, "w"))
    index["responses"][0]["termination"] = doc["termination"]
    json.dump(index, open(os.path.join(root, "index.json"), "w"))


def m_delete_response(root):
    rec, _ = _first_response(root)
    os.unlink(os.path.join(root, rec["file"]))


def m_orphan_file(root):
    json.dump({"mode": "x", "argv": []}, open(os.path.join(root, "999.json"), "w"))


def m_duplicate_key(root):
    _, index = _first_response(root)
    dup = dict(index["responses"][0])
    dup["file"] = index["responses"][1]["file"]
    index["responses"].append(dup)
    json.dump(index, open(os.path.join(root, "index.json"), "w"))


def m_empty_index(root):
    _, index = _first_response(root)
    index["responses"] = []
    json.dump(index, open(os.path.join(root, "index.json"), "w"))


def m_tree_content(root):
    p = os.path.join(root, "tree.json")
    tree = json.load(open(p))
    for e in tree["entries"]:
        if e["kind"] == "file":
            e["contentBase64"] = base64.b64encode(b"tampered\n").decode()
            e["sha256"] = __import__("hashlib").sha256(b"tampered\n").hexdigest()
            break
    json.dump(tree, open(p, "w"))


def m_tree_drop_entry(root):
    p = os.path.join(root, "tree.json")
    tree = json.load(open(p))
    tree["entries"] = [e for e in tree["entries"]
                       if not (e["kind"] == "file" and e["root"] == "codexHome")][:]
    json.dump(tree, open(p, "w"))


def m_tree_drop_symlink(root):
    p = os.path.join(root, "tree.json")
    tree = json.load(open(p))
    tree["entries"] = [e for e in tree["entries"] if e["kind"] != "symlink"]
    json.dump(tree, open(p, "w"))


def m_tree_mtime(root):
    """Backdated file given the canonical mtime. usage.py:620 would then OPEN a transcript it
    is supposed to skip unread, changing the hourly totals."""
    p = os.path.join(root, "tree.json")
    tree = json.load(open(p))
    for e in tree["entries"]:
        if e["kind"] == "file" and e["path"] in tree["explicitMtimeFiles"]:
            e["mtime"] = tree["canonicalMtime"]
    json.dump(tree, open(p, "w"))


def m_tree_explicit_list(root):
    p = os.path.join(root, "tree.json")
    tree = json.load(open(p))
    tree["explicitMtimeFiles"] = []
    json.dump(tree, open(p, "w"))


def m_unflag_substitute(root):
    p = os.path.join(root, "tree.json")
    tree = json.load(open(p))
    for e in tree["entries"]:
        if e.get("substituteHome"):
            del e["substituteHome"]
            break
    json.dump(tree, open(p, "w"))


def m_leak_home(root):
    """The privacy gate: a real home path smuggled into a payload."""
    rec, _ = _first_response(root)
    p = os.path.join(root, rec["file"])
    doc = json.load(open(p))
    doc["stdoutBase64"] = base64.b64encode(b'{"x":"/Users/realperson/Developer/x"}').decode()
    json.dump(doc, open(p, "w"))


def m_leak_tempdir(root):
    p = os.path.join(root, "tree.json")
    tree = json.load(open(p))
    for e in tree["entries"]:
        if e["kind"] == "file":
            blob = b'{"cwd":"/var/folders/ab/parity-home-xyz/Developer/alpha"}\n'
            e["contentBase64"] = base64.b64encode(blob).decode()
            e["sha256"] = __import__("hashlib").sha256(blob).hexdigest()
            break
    json.dump(tree, open(p, "w"))


def m_retarget_symlink(root):
    """The escaping symlink repointed INSIDE codex_home. Still a symlink, still present — but
    it no longer escapes, so usage.py's realpath containment check would have nothing to
    reject and the case would silently stop testing containment."""
    p = os.path.join(root, "tree.json")
    tree = json.load(open(p))
    for e in tree["entries"]:
        if e["kind"] == "symlink":
            e["target"] = {"root": "codexHome", "path": "harmless.jsonl"}
            break
    json.dump(tree, open(p, "w"))


def m_drop_directory(root):
    """The empty ~/.codex dropped. It is the default CODEX_HOME (usage.py:197), so a replayer
    that skipped it would resolve a path that does not exist."""
    p = os.path.join(root, "tree.json")
    tree = json.load(open(p))
    tree["entries"] = [e for e in tree["entries"] if e["kind"] != "dir"]
    json.dump(tree, open(p, "w"))


def m_home_disagreement(root):
    p = os.path.join(root, "tree.json")
    tree = json.load(open(p))
    tree["canonicalHome"] = "/somewhere/else"
    json.dump(tree, open(p, "w"))


VERIFY_MUTATIONS = [
    ("response stdout tampered", m_corrupt_stdout, "does not match its indexed sha256"),
    ("indexed digest wrong", m_corrupt_digest, "does not match its indexed sha256"),
    ("termination status changed", m_wrong_termination, "termination"),
    ("signal death recorded as a plain exit", m_signal_as_exit, "termination"),
    ("indexed response file deleted", m_delete_response, "missing from disk"),
    ("unindexed file left on disk", m_orphan_file, "not in the index"),
    ("duplicate (mode, argv) key", m_duplicate_key, "duplicate key"),
    ("index emptied", m_empty_index, "no responses at all"),
    ("tree file content tampered", m_tree_content, "differs from a fresh build"),
    ("tree entry dropped", m_tree_drop_entry, "absent from the manifest"),
    ("escaping symlink dropped", m_tree_drop_symlink, "records no symlink"),
    ("backdated mtime canonicalized", m_tree_mtime, "manifest mtime"),
    ("explicitMtimeFiles emptied", m_tree_explicit_list, "explicitMtimeFiles disagrees"),
    ("substituteHome flag removed", m_unflag_substitute, "NOT flagged"),
    ("real home path smuggled in", m_leak_home, "non-canonical home path"),
    ("machine-local temp path smuggled in", m_leak_tempdir, "machine-local temp path"),
    ("escaping symlink repointed inside codex_home", m_retarget_symlink,
     "manifest symlink target"),
    ("empty ~/.codex directory entry dropped", m_drop_directory,
     "absent from the manifest"),
    ("index and tree disagree on canonical home", m_home_disagreement,
     "disagree about the canonical home"),
]


def mutate_verify():
    results = []
    for name, fn, expect in VERIFY_MUTATIONS:
        tmp = tempfile.mkdtemp(prefix="oracle-mut-")
        root = os.path.join(tmp, "responses")
        shutil.copytree(RESPONSES, root)
        try:
            fn(root)
            code, out = run([sys.executable, VERIFY, "--dir", root])
            results.append((name, code == 1 and expect in out, expect, out))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return results


# ---------------------------------------------------------------------------------------- main


def main():
    if not os.path.isdir(RESPONSES):
        sys.stderr.write("tests/oracle/responses is missing; run build.py first.\n")
        return 2

    # Sanity: the unmutated artifacts must PASS both tools. Otherwise every mutation below
    # would be "caught" by a failure that was already there, and this file would report
    # perfect coverage while testing nothing.
    for label, cmd in (("build.py --check", [sys.executable, BUILD, "--check"]),
                       ("verify.py", [sys.executable, VERIFY])):
        code, out = run(cmd)
        if code != 0:
            sys.stderr.write(
                f"baseline {label} already fails, so mutation results would be meaningless:\n"
                f"{out}\n")
            return 2

    with open(INVENTORY) as fh:
        base = json.load(fh)

    groups = [("build.py --check", mutate_inventory(base)), ("verify.py", mutate_verify())]

    survivors = []
    total = 0
    for group, results in groups:
        print(f"\n{group}")
        for name, caught, expect, out in results:
            total += 1
            print(f"  {'caught ' if caught else 'SURVIVED'}  {name}")
            if not caught:
                survivors.append((group, name, expect, out))

    print()
    if survivors:
        sys.stderr.write(
            f"{len(survivors)} of {total} mutation(s) SURVIVED — the check does not actually "
            "test what it claims to:\n\n")
        for group, name, expect, out in survivors:
            sys.stderr.write(f"  [{group}] {name}\n")
            sys.stderr.write(f"      expected output to contain: {expect!r}\n")
            sys.stderr.write(f"      got: {out.strip()[:300]}\n\n")
        return 1

    print(f"all {total} mutations caught — both checks fail when the thing they guard breaks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
