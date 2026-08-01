#!/usr/bin/env python3
"""Crash-recovery and swap-safety tests for capture.py.

Why this file exists: the recovery code was written, reasoned about carefully, and shipped
with no test at all. A code review then found a data-loss path through it — a directory that
installed but failed validation left the bad copy in place and the good backup beside it, and
the NEXT run treated "GOLDENS has some JSON in it" as proof the swap had completed and
deleted the backup. Every intermediate state had been walked on paper. The one that mattered
was walked wrongly, and nothing was watching.

So the states are enumerated here instead. Each test builds a goldens directory by hand,
drives the REAL functions from capture.py, and asserts what survives on disk. Nothing is
reimplemented locally: a test that models the swap rather than running it would agree with
whatever the model said, which is exactly how the original reasoning passed.

Run: python3 tests/golden/test_capture_recovery.py   (exits non-zero on failure)
"""
import importlib.util, json, os, shutil, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))

_spec = importlib.util.spec_from_file_location("capture", os.path.join(HERE, "capture.py"))
capture = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(capture)

failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  [OK ] {name}")
    else:
        print(f"  [FAIL] {name}  {detail}")
        failures.append(name)


class Sandbox:
    """Point capture.py's module-level paths at a scratch tree, and restore them after.

    The functions under test read module globals rather than taking a directory, which is
    fine for a script with one real target but means a test has to redirect them. Restoring in
    __exit__ matters: a leaked GOLDENS would send the next test — or a later `--check` in the
    same process — at the real committed artifacts.
    """

    def __init__(self, declared):
        self.declared = declared

    def __enter__(self):
        self.root = tempfile.mkdtemp(prefix="capture-recovery-")
        self._saved = (capture.GOLDENS, capture.HERE, capture.STORED)
        capture.GOLDENS = os.path.join(self.root, "goldens")
        capture.HERE = self.root
        capture.STORED = [{"name": n} for n in self.declared]
        return self

    def __exit__(self, *exc):
        capture.GOLDENS, capture.HERE, capture.STORED = self._saved
        shutil.rmtree(self.root, ignore_errors=True)
        return False

    def make(self, path, names, marker=None):
        os.makedirs(path, exist_ok=True)
        for n in names:
            with open(os.path.join(path, n + ".json"), "w") as fh:
                json.dump({"name": n, "marker": marker}, fh)
        return path

    def goldens(self, names, marker=None):
        return self.make(capture.GOLDENS, names, marker)

    def backup(self, names, marker=None):
        return self.make(capture.GOLDENS + ".previous", names, marker)

    def marker_of(self, name):
        with open(os.path.join(capture.GOLDENS, name + ".json")) as fh:
            return json.load(fh)["marker"]

    def names(self):
        return capture.golden_names_on_disk(capture.GOLDENS)

    def backup_exists(self):
        return os.path.isdir(capture.GOLDENS + ".previous")


# ---------------------------------------------------------------- recover_interrupted_swap

print("recover_interrupted_swap")

with Sandbox(["a", "b"]) as s:
    # The state a kill between the two renames leaves: GOLDENS gone, backup holding the only
    # complete copy.
    s.backup(["a", "b"], marker="good")
    capture.recover_interrupted_swap()
    check("restores the backup when nothing is installed",
          s.names() == {"a", "b"} and s.marker_of("a") == "good" and not s.backup_exists())

with Sandbox(["a", "b"]) as s:
    # An empty GOLDENS is not an installed set. `os.makedirs(exist_ok=True)` from a previous
    # aborted run can leave one, and treating it as complete would delete the real copy.
    s.goldens([])
    s.backup(["a", "b"], marker="good")
    capture.recover_interrupted_swap()
    check("treats an EMPTY goldens directory as nothing installed",
          s.names() == {"a", "b"} and s.marker_of("a") == "good" and not s.backup_exists())

with Sandbox(["a", "b"]) as s:
    s.goldens(["a", "b"], marker="new")
    s.backup(["a", "b"], marker="old")
    capture.recover_interrupted_swap()
    check("discards the backup once a COMPLETE set is installed",
          s.marker_of("a") == "new" and not s.backup_exists())

with Sandbox(["a", "b"]) as s:
    # THE REGRESSION. An installed-but-invalid directory (case 'b' never made it) beside a
    # good backup. The old two-outcome logic saw JSON in GOLDENS, called it intact, and
    # deleted the last known-good copy.
    s.goldens(["a"], marker="bad")
    s.backup(["a", "b"], marker="good")
    capture.recover_interrupted_swap()
    check("KEEPS the backup when the installed set is incomplete",
          s.backup_exists(), "the last known-good copy was deleted")
    check("leaves the invalid installed set alone rather than guessing",
          s.names() == {"a"} and s.marker_of("a") == "bad")

with Sandbox(["a"]) as s:
    # The mirror image: an ORPHAN golden that no case claims. Also invalid, also ambiguous —
    # it is what a legitimate cases.json deletion looks like mid-flight.
    s.goldens(["a", "removed_case"], marker="bad")
    s.backup(["a"], marker="good")
    capture.recover_interrupted_swap()
    check("KEEPS the backup when the installed set has an orphan", s.backup_exists())

with Sandbox(["a"]) as s:
    s.goldens(["a"], marker="only")
    capture.recover_interrupted_swap()
    check("does nothing when there is no backup at all",
          s.names() == {"a"} and s.marker_of("a") == "only")

# ---------------------------------------------------------------- registry_disk_problems

print("registry_disk_problems")

with Sandbox(["a", "b"]) as s:
    s.goldens(["a", "b"])
    check("reports nothing for an exact match", capture.registry_disk_problems() == [])

with Sandbox(["a", "b"]) as s:
    s.goldens(["a"])
    check("reports a missing golden",
          any("b has no golden file" in p for p in capture.registry_disk_problems()))

with Sandbox(["a"]) as s:
    s.goldens(["a", "stale"])
    check("reports an orphan golden",
          any("orphan golden stale.json" in p for p in capture.registry_disk_problems()))

with Sandbox(["a"]) as s:
    # manifest.json is not a case and must never be mistaken for an orphan.
    s.goldens(["a"])
    with open(os.path.join(capture.GOLDENS, "manifest.json"), "w") as fh:
        json.dump({}, fh)
    check("does not count manifest.json as a case", capture.registry_disk_problems() == [])

# ---------------------------------------------------------------- clear_orphan_staging

print("clear_orphan_staging")

with Sandbox([]) as s:
    fresh = os.path.join(capture.HERE, ".staging-fresh")
    os.makedirs(fresh)
    capture.clear_orphan_staging()
    check("leaves a RECENT staging directory alone", os.path.isdir(fresh),
          "a concurrent run's work in progress was deleted")

with Sandbox([]) as s:
    stale = os.path.join(capture.HERE, ".staging-stale")
    os.makedirs(stale)
    old = time.time() - capture.STAGING_ORPHAN_AGE_S - 60
    os.utime(stale, (old, old))
    capture.clear_orphan_staging()
    check("removes a staging directory older than the orphan threshold", not os.path.isdir(stale))

with Sandbox([]) as s:
    keep = os.path.join(capture.HERE, "goldens.previous")
    os.makedirs(keep)
    old = time.time() - capture.STAGING_ORPHAN_AGE_S - 60
    os.utime(keep, (old, old))
    capture.clear_orphan_staging()
    check("never touches a directory that is not a .staging-* sibling", os.path.isdir(keep),
          "the backup directory was swept up by the staging cleanup")

# ---------------------------------------------------------------- install_staged

print("install_staged")

with Sandbox(["a", "b"]) as s:
    s.goldens(["a", "b"], marker="old")
    staged = s.make(os.path.join(s.root, ".staging-x"), ["a", "b"], marker="new")
    capture.install_staged(staged)
    check("installs a complete staged set and drops the backup",
          s.marker_of("a") == "new" and not s.backup_exists() and not os.path.isdir(staged))

with Sandbox(["a", "b"]) as s:
    # THE ROLLBACK. A staged set missing case 'b' must not survive: it installs, fails
    # validation, and has to be undone. Before the review fix this left the bad directory in
    # place with the good one beside it — and the next run then deleted the good one.
    s.goldens(["a", "b"], marker="old")
    staged = s.make(os.path.join(s.root, ".staging-x"), ["a"], marker="new")
    raised = None
    try:
        capture.install_staged(staged)
    except BaseException as e:
        raised = e
    check("an incomplete staged set is REJECTED, not installed", raised is not None)
    check("the previous goldens are restored byte-for-byte",
          s.names() == {"a", "b"} and s.marker_of("a") == "old",
          f"on disk: {sorted(s.names())}")
    check("no backup directory is left behind to confuse the next run", not s.backup_exists())

with Sandbox(["a"]) as s:
    # Same rollback, driven by an orphan rather than a gap, so the branch is not proven by one
    # shape of failure alone.
    s.goldens(["a"], marker="old")
    staged = s.make(os.path.join(s.root, ".staging-x"), ["a", "stale"], marker="new")
    try:
        capture.install_staged(staged)
    except BaseException:
        pass
    check("an orphan in the staged set also rolls back",
          s.names() == {"a"} and s.marker_of("a") == "old" and not s.backup_exists())

with Sandbox(["a"]) as s:
    # The FIRST rename succeeded, the second failed. GOLDENS does not exist at that instant,
    # so the rollback must restore rather than assume something is installed.
    s.goldens(["a"], marker="old")
    missing = os.path.join(s.root, "never-created")
    try:
        capture.install_staged(missing)
    except BaseException:
        pass
    check("a failed install rolls back when nothing was installed",
          s.names() == {"a"} and s.marker_of("a") == "old" and not s.backup_exists())

print()
if failures:
    print(f"FAILED {len(failures)}: {', '.join(failures)}")
    sys.exit(1)
print("All capture-recovery tests passed.")
