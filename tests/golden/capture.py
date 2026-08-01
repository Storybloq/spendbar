#!/usr/bin/env python3
"""Golden capture — records the Python CLI's exact behavior for the TS port.

Runs every case that tests/golden/cases.json marks `storedGolden` against the REAL usage.py,
under the deterministic fixture environment (fake_ccusage.py + fixture-config.json + a
synthetic CODEX_HOME), and stores {argv, mode, extra_env, capture_anchor, exit, stdout,
stderr} as one JSON file under goldens/.

This file DEFINES no cases. It used to own a `CASES` table that restated what
tests-ts/harness/cases.mjs also described, and the two could disagree without either
noticing; cases.json is now the one definition and both sides read it (T-005).

Every case runs through tests/harness/usage-wrapper.py at its own `captureAnchor`, never
against usage.py directly. `dual_run_only` is gone: relative-date cases used to be captured
for the record and excluded from comparison because their output embedded "today", which
meant two goldens nothing ever checked. Pinning the clock makes them ordinary comparable
goldens instead.

Machine note: project keys derive from $HOME (HOME_ENC), so goldens are valid on the
machine that captured them. The differential harness re-captures Python live and is
machine-independent; stored goldens exist so pure-TS CI can still assert against a
committed reference from the capture machine.

Write mode is all-or-nothing: it stages every file and swaps the directory wholesale only
after each observed exit has matched the one cases.json declares. A per-case write would
accept an authored/observed disagreement at exactly the moment the artifact is regenerated.

Run: python3 tests/golden/capture.py            # writes goldens/*.json + manifest.json
     python3 tests/golden/capture.py --check    # re-runs Python and diffs vs stored
"""
import importlib.util, json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
FAKE = os.path.join(TESTS, "fake_ccusage.py")
FIXTURE_CONFIG = os.path.join(TESTS, "fixture-config.json")
GOLDENS = os.path.join(HERE, "goldens")
CASES_JSON = os.path.join(HERE, "cases.json")
HARNESS = os.path.join(TESTS, "harness")
PARITY_ENV = os.path.join(HARNESS, "parity-env.json")
# The anchored entrypoint. usage.py is never invoked directly from here — see run_case.
WRAPPER = os.path.join(HARNESS, "usage-wrapper.py")

# ---------------------------------------------------------------- fixtures + pinned env
# The synthetic CODEX_HOME and HOME live in tests/harness/fixtures.py so that this capture
# and the Node parity harness build them from one definition instead of two that drift.
_fspec = importlib.util.spec_from_file_location("parity_fixtures", os.path.join(HARNESS, "fixtures.py"))
fixtures = importlib.util.module_from_spec(_fspec); _fspec.loader.exec_module(fixtures)
build_codex_home = fixtures.build_codex_home

with open(PARITY_ENV) as _fh:
    ENV_CONTRACT = json.load(_fh)


def child_env(fixture_home, extra):
    """Every child's environment, CONSTRUCTED rather than inherited.

    An ambient TZ or LANG on a developer's shell must not be able to change what the
    goldens mean, so only the pinned keys, the declared passthroughs and the per-case keys
    reach the child. tests-ts/parity.mjs builds the identical environment from the same
    contract file; manifest.json records it so a stale capture is detectable."""
    env = dict(ENV_CONTRACT["pinned"])
    for k in ENV_CONTRACT["passthrough"]:
        if k in os.environ:
            env[k] = os.environ[k]
    env["HOME"] = fixture_home
    env.update(extra)
    return env

# ---------------------------------------------------------------- case registry
# The matrix used to live here as a `CASES` table, duplicated again in
# tests-ts/harness/cases.mjs. Two descriptions of one thing is how they drift, so both now
# read tests/golden/cases.json. This file DEFINES nothing about the matrix any more; it only
# executes the stored half of it.
with open(CASES_JSON) as _fh:
    REGISTRY = json.load(_fh)

# Only cases that HAVE a golden. A differential-only case has no file to write or check, and
# carries no captureAnchor to run at - it is asserted by running both implementations live.
STORED = [c for c in REGISTRY["cases"] if c["storedGolden"]]


def run_case(case, codex_home, fixture_home):
    """One case, through the ANCHORED entrypoint.

    Never `usage.py` directly. A relative-date case is only reproducible against a pinned
    wall clock, and the wrapper makes `--anchor` mandatory precisely so that injection cannot
    quietly stop being load-bearing: a capture that forgot to pass one would crash rather
    than silently record today's date into a golden that then rots overnight.

    Routing only the relative cases through the wrapper would leave two entry paths that
    differ on traceback-producing cases, so every stored case takes this one.
    """
    extra = {"CCUSAGE_CMD": f"{sys.executable} {FAKE}",
             "FAKE_MODE": case["mode"],
             "USAGE_CONFIG": FIXTURE_CONFIG}
    if case["codexFixture"]:
        extra["CODEX_HOME"] = codex_home
    extra.update(case["extraEnv"])
    argv = [sys.executable, WRAPPER, "--anchor", case["captureAnchor"], "--", *case["argv"]]
    p = subprocess.run(argv, capture_output=True, text=True,
                       env=child_env(fixture_home, extra))
    # Assert against the CONSTRUCTED command, not against a separately remembered value:
    # logging the anchor we meant to use would prove intent, and the failure this guards
    # against is exactly the one where intent and argv disagree.
    #
    # The recorded anchor is read back out of the argv that was SPAWNED, not copied from the
    # case a second time. Both spellings look identical today, because `argv` is built from
    # `case["captureAnchor"]` a few lines up with nothing in between — code review R2 was
    # right that a comparison between the two proves almost nothing, and that the old version
    # then went on to record the intent anyway, which is the value a comparison would have
    # been defending against.
    #
    # The golden records what ran, so if the two ever diverge the artifact reports the truth,
    # and `--check` and the parity harness both compare that recorded value against cases.json
    # — two readers that reach it independently rather than one assertion standing next to the
    # argv it is checking.
    #
    # The comparison stays anyway. R2 was right that it is weak; R3 was right that removing it
    # entirely was an over-correction, because this is the WRITE path: a construction
    # regression would capture at the wrong date, install 45 goldens successfully, and only be
    # caught by a later run of a different tool — after the committed artifacts had already
    # been replaced. A weak check on the generator is worth more than a strong check that
    # arrives once the damage is on disk. Raised, not asserted: `python3 -O` strips `assert`.
    spawned_anchor = argv[argv.index("--anchor") + 1]
    if spawned_anchor != case["captureAnchor"]:
        raise RuntimeError(
            f"{case['name']}: spawned with anchor {spawned_anchor!r}, "
            f"case declares {case['captureAnchor']!r}; refusing to record either")
    return {"name": case["name"], "argv": case["argv"], "mode": case["mode"],
            "codex_fixture": case["codexFixture"], "extra_env": case["extraEnv"],
            "capture_anchor": spawned_anchor,
            "exit": p.returncode, "stdout": p.stdout, "stderr": p.stderr}


def golden_names_on_disk(directory):
    if not os.path.isdir(directory):
        return set()
    return {f[:-len(".json")] for f in os.listdir(directory)
            if f.endswith(".json") and f != "manifest.json"}


def registry_disk_problems(directory=None):
    """Exact set equality between stored cases and golden files, in BOTH directions.

    Adding a case without capturing is caught by the missing file. DELETING one leaves an
    orphan golden that nothing ever opens again, still carrying stale contract data - and no
    grep finds that, because an orphan file is not a second matrix, just a lie nobody reads.

    Returns problems instead of raising so `recover_interrupted_swap` can ASK whether a
    directory is complete without dying on the answer. That distinction is what lets recovery
    tell "the swap was interrupted" from "this set is simply out of date".
    """
    declared = {c["name"] for c in STORED}
    on_disk = golden_names_on_disk(GOLDENS if directory is None else directory)
    problems = [f"case {n} has no golden file" for n in sorted(declared - on_disk)]
    problems += [f"orphan golden {n}.json: no case in cases.json claims it"
                 for n in sorted(on_disk - declared)]
    return problems


def assert_registry_matches_disk():
    problems = registry_disk_problems()
    if problems:
        raise SystemExit("cases.json and goldens/ disagree:\n  - " + "\n  - ".join(problems))


def recover_interrupted_swap():
    """Finish, or undo, a swap that a previous run was killed in the middle of.

    The install is two renames, so a kill between them leaves GOLDENS absent and
    `goldens.previous` holding the only complete copy. Without this, the next run would
    happily create an empty GOLDENS and then delete that backup - destroying the last good
    artifacts to make room for a directory it had not yet validated.

    Runs before anything else touches the directory, in BOTH modes: --check must not silently
    report 45 missing goldens when a complete set is sitting in the backup.

    Three outcomes, not two. The two-outcome version asked only "does GOLDENS contain any
    JSON?" and deleted the backup if so — which meant ANY non-empty directory, including a
    half-installed or invalid one, was enough to destroy the last known-good copy (code review
    R1). A backup is now discarded only against a set that is actually complete.
    """
    backup = GOLDENS + ".previous"
    if not os.path.isdir(backup):
        return
    if not golden_names_on_disk(GOLDENS):
        # Nothing installed: the swap died between the two renames, and the backup is the only
        # complete copy there is.
        #
        # "Nothing installed" counts CASE goldens only, so a directory holding just
        # manifest.json qualifies and that manifest is deleted with it. Deliberate: a manifest
        # describing a set of goldens that are not there is not a partial success worth
        # keeping, and the backup supplies both.
        shutil.rmtree(GOLDENS, ignore_errors=True)
        os.rename(backup, GOLDENS)
        print(f"  recovered {os.path.relpath(GOLDENS)} from an interrupted swap")
        return
    problems = registry_disk_problems()
    if not problems:
        # The swap completed and what it installed is complete; this is cleanup leftover.
        shutil.rmtree(backup, ignore_errors=True)
        return
    # Ambiguous, so nothing is deleted and nothing is restored. "The install went wrong" and
    # "cases.json changed and these goldens need regenerating" look identical from here, and
    # they want opposite repairs — restoring would bury a legitimate registry edit under an
    # older set. Both copies are left on disk and the operator is told which is which.
    print(f"  WARNING: {os.path.relpath(GOLDENS)} is installed but does not match cases.json:")
    for p in problems:
        print(f"    - {p}")
    print(f"  A previous copy is being kept at {os.path.relpath(backup)}; neither was touched.")
    print("  Re-run without --check to regenerate, or restore that directory by hand.")


# A staging directory this much older than now cannot belong to a live run: a full capture is
# 45 subprocesses and finishes in seconds. Generous by three orders of magnitude, because the
# cost of waiting is a stale directory and the cost of being wrong is deleting another
# process's work in progress.
STAGING_ORPHAN_AGE_S = 3600


def clear_orphan_staging():
    """Remove staging directories a KILLED run left behind, without touching a live one.

    `finally` does not run when a process is killed, so a hard stop mid-capture strands a
    half-written .staging-* next to the goldens. Found by the crash-recovery test itself,
    which uses os._exit and duly left one on disk — and one of those orphans reached `git add`
    before it was caught, hence the gitignore entry as well.

    Age, not just the name prefix: deleting every .staging-* unconditionally would let one run
    destroy another's directory mid-capture. That said, two concurrent captures are unsupported
    for a more basic reason - they race on the goldens swap itself - so this is about not
    actively corrupting a neighbour, not about making concurrency work.
    """
    now = time.time()
    for name in os.listdir(HERE):
        path = os.path.join(HERE, name)
        if not name.startswith(".staging-") or not os.path.isdir(path):
            continue
        try:
            age = now - os.stat(path).st_mtime
        except OSError:
            continue  # vanished under us; whoever owns it is dealing with it
        if age < STAGING_ORPHAN_AGE_S:
            print(f"  leaving recent staging directory {name} alone ({age:.0f}s old)")
            continue
        shutil.rmtree(path, ignore_errors=True)
        print(f"  removed orphaned staging directory {name} ({age / 3600:.1f}h old)")


def install_staged(staging):
    """Swap a staged directory into place as GOLDENS, or leave the old one exactly as it was.

    Swap wholesale, so an obsolete golden from a deleted case cannot survive a regeneration by
    simply never being overwritten.

    Deleting GOLDENS and then moving would put the committed artifacts at the mercy of the step
    in between: an interruption or a failed move leaves the directory gone. Two renames
    instead, with the old copy retained until the new one is installed AND validated, so every
    intermediate state is recoverable.

    Validation is inside the rollback block, not after it. Code review R1 found the bug that
    put it outside: a directory that installed but failed to validate stayed installed, the
    good backup stayed beside it, and the next run's `recover_interrupted_swap` saw JSON files
    in GOLDENS, called it intact, and deleted the backup. An all-or-nothing write whose
    "nothing" branch is unreachable is just a slower "all".

    Extracted from `main` so the failure paths can be driven directly. They were previously
    reachable only by killing a real capture at the right microsecond, which is why they were
    reasoned about rather than tested — and the reasoning is what was wrong.
    """
    backup = GOLDENS + ".previous"
    # Two entry states, and the prologue below makes them one. The invariant it protects: at
    # every instant, at least one COMPLETE copy exists on disk.
    #
    #   (a) GOLDENS good, no backup — the ordinary case. Rename it aside; it becomes the
    #       rollback target.
    #
    #   (b) GOLDENS suspect, backup good — the state `recover_interrupted_swap` deliberately
    #       leaves when it cannot tell an interrupted install from a legitimate registry
    #       change. Here `backup` is already the last known-good copy and GOLDENS is the one
    #       it declined to trust, so the SUSPECT is what gets discarded.
    #
    # An earlier fix deleted the backup first and then renamed (code review R3): that made the
    # rename succeed, but for one instant the only good copy was gone, and if the rename then
    # failed, `main`'s finally would remove the staging directory too and leave nothing but
    # the suspect. Having a staged successor is not enough when the failure path discards it.
    #
    # Before either fix, state (b) crashed outright on OSError(ENOTEMPTY) — after all 45
    # captures, on the exact "re-run without --check to regenerate" advice that recovery
    # prints (code review R2).
    if os.path.isdir(backup):
        print(f"  discarding the unvalidated {os.path.relpath(GOLDENS)}; "
              f"{os.path.relpath(backup)} is the copy being kept")
        shutil.rmtree(GOLDENS, ignore_errors=True)
    else:
        os.rename(GOLDENS, backup)
    # Both states are now identical: `backup` holds the only copy worth keeping, and GOLDENS
    # does not exist.
    installed = False
    try:
        os.rename(staging, GOLDENS)
        installed = True
        assert_registry_matches_disk()
    except BaseException:
        if installed:
            shutil.rmtree(GOLDENS, ignore_errors=True)
        if os.path.isdir(GOLDENS):
            # The rmtree above did not take. Renaming onto a directory that still exists would
            # raise a SECOND OSError that masks the real failure and leaves the bad copy
            # installed, so say what is where instead of guessing (code review R2).
            raise RuntimeError(
                f"install failed AND rollback could not proceed: {GOLDENS} still exists.\n"
                f"  The previous goldens are intact at {backup}; restore them by hand.")
        os.rename(backup, GOLDENS)  # put it back exactly as it was
        raise
    else:
        # Only now is the previous copy expendable.
        shutil.rmtree(backup, ignore_errors=True)


def main():
    check = "--check" in sys.argv
    recover_interrupted_swap()
    clear_orphan_staging()
    fixture_home = fixtures.build_fixture_home()
    codex_home, outside = build_codex_home(fixture_home)
    staging = None
    try:
        os.makedirs(GOLDENS, exist_ok=True)
        if check:
            assert_registry_matches_disk()
        results, diffs, bad_exits = [], [], []
        # Write mode stages everything and swaps at the end. A per-case write would leave the
        # committed goldens half-updated if a later case failed its exit assertion, which is
        # the state a regeneration must never produce: some files from the new run, some from
        # the old, and nothing saying which is which.
        if not check:
            # A SIBLING of GOLDENS, deliberately: the final install is an os.rename, which
            # requires both paths on one filesystem. A system temp dir is often a different
            # mount, where the rename fails or degrades to a copy.
            staging = tempfile.mkdtemp(prefix=".staging-", dir=HERE)

        for case in STORED:
            rec = run_case(case, codex_home, fixture_home)
            path = os.path.join(GOLDENS, rec["name"] + ".json")
            if check:
                with open(path) as fh:
                    stored = json.load(fh)
                same = all(stored[k] == rec[k] for k in ("exit", "stdout", "stderr"))
                # `name` is compared even though the file was OPENED by name: the filename and
                # the record inside it are two separate claims, and a copied or hand-renamed
                # golden keeps the right filename while describing a different case.
                meta = [k for k in ("name", "argv", "mode", "codex_fixture", "extra_env",
                                    "capture_anchor")
                        if stored.get(k) != rec[k]]
                # The AUTHORED contract, checked in this mode too. Comparing only stored
                # against observed compares two recordings of the same run: change
                # expectExit in cases.json and both still agree, so --check stays green
                # while the registry declares something no artifact supports.
                if rec["exit"] != case["expectExit"]:
                    meta.append(f"expectExit (cases.json says {case['expectExit']}, "
                                f"observed {rec['exit']})")
                if meta:
                    # A stale golden can keep the right FILENAME while describing a different
                    # invocation, so the bytes matching proves nothing until the metadata does.
                    diffs.append(f"{rec['name']} (metadata: {', '.join(meta)})")
                elif not same:
                    diffs.append(rec["name"])
                print(f"  [{'OK ' if same and not meta else 'DIFF'}] {rec['name']}")
            else:
                # An authored expectExit that disagrees with reality must not be laundered
                # into a new golden. Recording the observed value would accept the
                # disagreement at exactly the moment the artifact is regenerated, and the
                # later metadata check would then be comparing two copies of the same lie.
                if rec["exit"] != case["expectExit"]:
                    bad_exits.append(
                        f"{rec['name']}: cases.json declares exit {case['expectExit']}, observed {rec['exit']}")
                with open(os.path.join(staging, rec["name"] + ".json"), "w") as fh:
                    json.dump(rec, fh, indent=1, ensure_ascii=False)
                results.append(rec)
                print(f"  captured {rec['name']}  (exit={rec['exit']}, "
                      f"{len(rec['stdout'])}B out, {len(rec['stderr'])}B err)")

        if check:
            if diffs:
                print(f"\nDIFFS in {len(diffs)} case(s): {', '.join(diffs)}"); sys.exit(1)
            print(f"\nAll {len(STORED)} stored goldens match a live Python re-run "
                  f"at their captureAnchor.")
        else:
            if bad_exits:
                print("\nREFUSING to write; committed goldens untouched:\n  - "
                      + "\n  - ".join(bad_exits))
                sys.exit(1)
            manifest = {
                "capturedBy": "tests/golden/capture.py",
                "capturedVia": os.path.relpath(WRAPPER, os.path.dirname(TESTS)),
                "caseRegistry": os.path.relpath(CASES_JSON, os.path.dirname(TESTS)),
                "pythonInterpreter": sys.version.split()[0],
                "caseCount": len(results),
                "captureAnchors": sorted({r["capture_anchor"] for r in results}),
                "env": ENV_CONTRACT["pinned"],
                "envPassthrough": ENV_CONTRACT["passthrough"],
                "notes": [
                    "Byte-equality contract is stdout+stderr+exit vs the TS port, modulo ALLOWLIST.md.",
                    "'env' is the CONSTRUCTED child environment from tests/harness/parity-env.json - nothing else is inherited except 'envPassthrough' and the per-case keys. tests-ts/parity.mjs asserts this block still matches that file, so a golden captured under a stale pin is detectable.",
                    "HOME is a synthetic empty fixture home (tests/harness/fixtures.py), so no capture reads the real ~/.claude/projects or ~/.codex.",
                    "TZ is load-bearing: usage.py:709 formats block labels via astimezone(), so 'blocks' output moves with the zone.",
                    "All captures are non-TTY (subprocess pipes); TTY variants are a harness-level TODO.",
                    "Every case ran through 'capturedVia' with a MANDATORY --anchor, so a relative-date case is reproducible: replay it at its own capture_anchor, never at today. The parity harness asserts that routing from the argv it actually spawned.",
                    "The case matrix is not defined here. 'caseRegistry' is the single definition of every case, stored and differential-only alike.",
                ],
            }
            with open(os.path.join(staging, "manifest.json"), "w") as fh:
                json.dump(manifest, fh, indent=1)
            # No rmtree of any pre-existing backup here: `recover_interrupted_swap` has already
            # dealt with one, and deleting a backup before the replacement is installed is the
            # exact ordering that turns an interruption into data loss.
            install_staged(staging)
            staging = None
            print(f"\nWrote {len(results)} goldens + manifest to {os.path.relpath(GOLDENS)}")
    finally:
        if staging:
            shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(codex_home, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)
        shutil.rmtree(fixture_home, ignore_errors=True)

if __name__ == "__main__":
    main()
