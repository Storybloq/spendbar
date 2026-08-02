#!/usr/bin/env python3
"""Check the recorded traces against the authored inventory, and build the artifact set.

Two jobs, deliberately in one file because they share the notion of what a "key" is:

  build.py --check     compare tests/oracle/traces.json (observed) against inventory.json
                       (declared). No artifacts written.
  build.py             do the check, then generate tests/oracle/responses/ — one file per
                       distinct (mode, argv) key, each holding the fixture's exact stdout,
                       stderr and termination.

The check exists because instrumentation cannot audit itself. traces.json only says what the
run it watched happened to do; if usage.py silently stopped calling ccusage for `daily`, the
trace would faithfully record zero calls and every artifact test would keep passing against a
smaller, wrong world. inventory.json is read out of the oracle source by hand and says what
SHOULD happen. Disagreement between them is the finding.

Run: python3 tests/oracle/build.py [--check] [--out tests/oracle/responses]
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)

FAKE = os.path.join(TESTS, "fake_ccusage.py")
INVENTORY = os.path.join(HERE, "inventory.json")
TRACES = os.path.join(HERE, "traces.json")
DEFAULT_OUT = os.path.join(HERE, "responses")

# The home every artifact is generated under. fake_ccusage.py derives HOME_ENC from
# os.path.expanduser("~") at import, so its payloads embed the generating machine's home unless
# this is forced. That makes this a privacy gate as much as a determinism one: these files are
# committed and this repo is going public, and a generator that forgot to set it would commit
# the maintainer's real home path into every artifact.
CANONICAL_HOME = "/fixture/home"


# --------------------------------------------------------------------------------------- check


def declared_calls(case, inventory):
    """The shapes a case SHOULD ask for, in order, per the authored inventory.

    A case whose first argv token is not a command name — `--help`, a bare flag, a typo — is
    declared to make no calls at all, which is itself checked rather than skipped.
    """
    argv = case["argv"]
    if not argv:
        return []
    # argparse intercepts -h/--help during parsing and exits 0 before dispatch, so a help argv
    # calls nothing regardless of which command it names. Declared in inventory.helpFlags.
    if any(tok in inventory["helpFlags"] for tok in argv):
        return []
    entry = inventory["commands"].get(argv[0])
    if entry is None:
        return []
    if "--vs" in argv and "callsWithVs" in entry:
        return list(entry["callsWithVs"])
    return list(entry["calls"])


def shape_of(observed_argv, inventory):
    """Which declared shape an observed argv is, or None if it matches no shape.

    Matching is on the base argv plus a window tail: the shape's fixed tokens must be an exact
    prefix, and whatever follows must be `<windowArg> <value>` pairs drawn from that shape's
    declared window args. An argv with an extra flag the inventory never mentions therefore
    matches nothing, and is reported rather than absorbed.
    """
    for name, shape in inventory["shapes"].items():
        base = shape["argv"]
        if list(observed_argv[:len(base)]) != base:
            continue
        tail = list(observed_argv[len(base):])
        ok = True
        while tail:
            if len(tail) < 2 or tail[0] not in shape["windowArgs"]:
                ok = False
                break
            tail = tail[2:]
        if ok:
            return name
    return None


def check(inventory, traces):
    """Compare declared against observed. Returns a list of failure strings."""
    fails = []
    stats = {"exact": 0, "truncated": 0, "none": 0}

    # The traces are only evidence about the anchors they were recorded at: --since -3d resolves
    # against the wall clock, so the same case at a different anchor asks for different argv and
    # therefore a different artifact key. Changing `defaultAnchor` (or a case's captureAnchor)
    # without re-running record.py leaves a trace set that still agrees with the inventory, still
    # regenerates byte-identically, and still passes independent verification — a self-consistent
    # artifact set describing a world the oracle no longer inhabits. Checked here because this is
    # the only place that sees the registry and the inventory at the same time.
    recorded_anchors = traces.get("anchors")
    if recorded_anchors is None:
        fails.append(
            "traces.json predates anchor recording, so nothing ties it to the anchors in "
            "cases.json. Re-run record.py.")
    else:
        stale = []
        for name in traces["cases"]:
            want = CASES[name].get("captureAnchor") or inventory["defaultAnchor"]
            got = recorded_anchors.get(name)
            if got != want:
                stale.append(f"{name}: recorded at {got!r}, should be {want!r}")
        if stale:
            fails.append(
                f"{len(stale)} case(s) were recorded at an anchor that no longer matches "
                f"cases.json / inventory.defaultAnchor, e.g. {stale[:3]}. Re-run record.py; "
                "the artifact keys are anchor-relative and are now describing a stale clock.")

    for name, calls in traces["cases"].items():
        case = CASES[name]
        want = declared_calls(case, inventory)

        got = []
        for i, call in enumerate(calls):
            shape = shape_of(call["argv"], inventory)
            if shape is None:
                fails.append(
                    f"{name}: child call #{i} matches no declared shape: {call['argv']}")
            got.append(shape)

        exit_code = traces["exitCodes"][name]
        if exit_code == 0:
            # A run that completed must have made exactly the declared calls. Nothing to
            # excuse an extra call, a missing one, or a reordering.
            if got != want:
                fails.append(
                    f"{name}: exited 0, so calls must match the inventory exactly.\n"
                    f"    declared: {want}\n    observed: {got}")
            else:
                stats["exact"] += 1
        else:
            # A failing run may stop partway, so the observed calls must be a PREFIX of the
            # declared ones — it got some distance down the list and then died. This still
            # catches an extra call, a wrong shape, and a wrong order; the only thing it
            # forgives is stopping early, which is what a non-zero exit means.
            if got != want[:len(got)]:
                fails.append(
                    f"{name}: exited {exit_code}; calls must be a prefix of the inventory.\n"
                    f"    declared: {want}\n    observed: {got}")
            elif got == want:
                stats["exact"] += 1
            elif got:
                stats["truncated"] += 1
            else:
                stats["none"] += 1

    # windowArgs is used PERMISSIVELY by shape_of — it says which extra args are allowed, so a
    # shape that declares one the oracle never passes is never contradicted by any observation.
    # (Measured: adding "--until" to the blocks shape was the one mutation this check missed.)
    # Close it from the other side: every declared window arg must actually turn up, unless it
    # is named in `unexercised` with a reason.
    exempt = {(u["shape"], u["arg"]) for u in inventory.get("unexercised", [])}
    observed_args = {name: set() for name in inventory["shapes"]}
    for calls in traces["cases"].values():
        for call in calls:
            shape = shape_of(call["argv"], inventory)
            if shape is None:
                continue
            base = len(inventory["shapes"][shape]["argv"])
            observed_args[shape].update(call["argv"][base::2])

    for name, shape in inventory["shapes"].items():
        for arg in shape["windowArgs"]:
            if arg in observed_args[name] or (name, arg) in exempt:
                continue
            fails.append(
                f"shape {name} declares {arg} but no case ever passes it, and it is not listed "
                f"in `unexercised`. Either the declaration is wrong, or this is a coverage gap "
                f"that should be recorded there with an issue reference rather than tolerated.")

    # Also check the allowlist itself is not stale: an entry for an arg that IS now observed
    # would otherwise sit there forever, quietly re-opening the loophole it documents.
    for u in inventory.get("unexercised", []):
        if u["arg"] in observed_args.get(u["shape"], set()):
            fails.append(
                f"`unexercised` still exempts {u['shape']}/{u['arg']}, but cases now exercise "
                f"it. Delete the entry (and close {u.get('issue', 'the linked issue')}).")

    # An entry naming a shape or arg nothing declares exempts NOTHING: the staleness check
    # above reads it through `.get(..., set())` and never objects, so a typo'd or leftover
    # entry would sit in the file looking load-bearing forever (ISS-059).
    for u in inventory.get("unexercised", []):
        shape = inventory["shapes"].get(u["shape"])
        if shape is None or u["arg"] not in shape["windowArgs"]:
            fails.append(
                f"`unexercised` entry {u['shape']}/{u['arg']} names a shape/arg no shape "
                f"declares, so it exempts nothing. Delete or fix the entry.")

    # The prefix rule above is the one loose place in this check, so prove it is not doing all
    # the work: if EVERY non-zero-exit case observed nothing, the rule would be equivalent to
    # "error cases are unchecked" and the inventory would be untested on that whole half.
    nonzero = [n for n in traces["cases"] if traces["exitCodes"][n] != 0]
    reaching = [n for n in nonzero if traces["cases"][n]]
    if nonzero and not reaching:
        fails.append(
            f"the prefix rule is vacuous: all {len(nonzero)} failing cases made zero child "
            "calls, so nothing constrains them. Either the fixtures changed or this check "
            "has stopped testing error paths.")

    return fails, stats


# ----------------------------------------------------------------------------------- generate


def generate(keys, out_dir):
    """Run the fixture once per key under the canonical home; write the artifact set."""
    env = dict(os.environ)
    env["HOME"] = CANONICAL_HOME
    env.pop("USERPROFILE", None)
    # expanduser consults these before $HOME on some platforms; a stray one would silently
    # de-canonicalize the payloads.
    for var in ("HOMEDRIVE", "HOMEPATH"):
        env.pop(var, None)

    records = []
    for i, key in enumerate(keys):
        env["FAKE_MODE"] = key["mode"]
        proc = subprocess.run(
            [sys.executable, FAKE, *key["argv"]],
            capture_output=True, env=env)

        # Termination is recorded as a {kind, status} object, not a bare integer, so a replayer
        # can tell "exited 2" from "killed by signal 2" — subprocess reports the latter as -2
        # and collapsing them would let a crash replay as a clean exit code.
        if proc.returncode < 0:
            termination = {"kind": "signal", "status": -proc.returncode}
        else:
            termination = {"kind": "exit", "status": proc.returncode}

        records.append({
            "mode": key["mode"],
            "argv": key["argv"],
            "file": f"{i:03d}.json",
            # SEPARATE digests. A single digest over stdout+stderr would collide: ("ab", "c")
            # and ("a", "bc") concatenate identically, so a swap across the stream boundary
            # would verify clean.
            "stdoutSha256": _sha(proc.stdout),
            "stderrSha256": _sha(proc.stderr),
            "termination": termination,
        })
        _write_json(os.path.join(out_dir, f"{i:03d}.json"), {
            "mode": key["mode"],
            "argv": key["argv"],
            "stdoutBase64": base64.b64encode(proc.stdout).decode("ascii"),
            "stderrBase64": base64.b64encode(proc.stderr).decode("ascii"),
            "termination": termination,
        })

    return records


# Every fixture file that does not carry a deliberately-set mtime is recorded at this instant
# instead of at generation time. tests/harness/fixtures.py leaves most files at "now", and a
# committed artifact holding "now" would differ on every regeneration — the exact-regeneration
# check would fail daily and mean nothing. Comfortably after the 2026-01-01 hourly target day,
# so the files that must survive usage.py:620's mtime filter still do.
CANONICAL_MTIME = 1780272000  # 2026-06-01T00:00:00Z


def build_tree(out_dir):
    """Serialize the fixture tree that tests/harness/fixtures.py builds.

    The replayer (ISS-019) has to materialize this tree without Python, so it needs the tree
    described rather than constructed. Three things here are load-bearing and easy to drop:

      * mtimes. usage.py:620 skips an hourly transcript whose mtime predates the target day
        WITHOUT opening it, and fixtures.py deliberately backdates one file to exercise that.
        A manifest that omits mtimes materializes a tree where the stale file is suddenly live.
      * the symlink. One codex session is a symlink pointing OUTSIDE codex_home, which
        usage.py's realpath containment check is supposed to reject. Following it while
        serializing would turn the fixture into an ordinary file and silently delete the case.
      * the third root. That symlink's target lives in `codexOutside`, a separate directory, so
        the manifest carries three roots and stores link targets as (root, path) pairs rather
        than as absolute paths from this machine.
    """
    sys.path.insert(0, os.path.join(TESTS, "harness"))
    import fixtures

    started = time.time()
    real_home = os.environ.get("HOME")
    os.environ["HOME"] = CANONICAL_HOME
    try:
        home = fixtures.build_fixture_home()
        # CANONICAL_HOME, not `home`. build_codex_home expands the sessions' `~` cwd values
        # against whatever it is given and writes them ABSOLUTE into the session files, so
        # passing the mkdtemp root would bake this machine's temp path into the committed
        # artifact — measured: "/var/folders/.../parity-home-mioettei/Developer/alpha", which
        # is both a leak and different on every run. Stored canonical instead; entries holding
        # the token are flagged `substituteHome` for the replayer to rewrite at materialization.
        codex_home, outside = fixtures.build_codex_home(CANONICAL_HOME)
    finally:
        if real_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = real_home

    roots = [("home", home), ("codexHome", codex_home), ("codexOutside", outside)]
    entries = []
    explicit = []
    try:
        for root_name, root in roots:
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames.sort()
                rel_dir = os.path.relpath(dirpath, root)
                if not filenames and not dirnames:
                    entries.append({
                        "root": root_name,
                        "path": "" if rel_dir == "." else rel_dir.replace(os.sep, "/"),
                        "kind": "dir",
                    })
                for fn in sorted(filenames):
                    full = os.path.join(dirpath, fn)
                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                    if os.path.islink(full):
                        target = os.path.realpath(full)
                        entries.append({
                            "root": root_name,
                            "path": rel,
                            "kind": "symlink",
                            "target": _locate(target, roots),
                        })
                        continue
                    with open(full, "rb") as fh:
                        data = fh.read()
                    # A file whose mtime predates this run was backdated on purpose; anything
                    # at "now" just inherited the clock. Only the former is real fixture data.
                    st = os.stat(full)
                    if st.st_mtime < started - 5:
                        mtime = int(st.st_mtime)
                        explicit.append(rel)
                    else:
                        mtime = CANONICAL_MTIME
                    entry = {
                        "root": root_name,
                        "path": rel,
                        "kind": "file",
                        "mtime": mtime,
                        "sha256": _sha(data),
                        "contentBase64": base64.b64encode(data).decode("ascii"),
                    }
                    # These files name an absolute path inside the home. A replayer cannot run
                    # under a literal /fixture/home, so it must rewrite the token to wherever it
                    # actually materialized the tree — otherwise usage.py maps the cwd through a
                    # HOME_ENC that does not match and every codex project lands in `unknown`.
                    # Flagged per entry rather than left for the replayer to sniff for.
                    if CANONICAL_HOME.encode() in data:
                        entry["substituteHome"] = True
                    entries.append(entry)
    finally:
        for _, root in roots:
            shutil.rmtree(root, ignore_errors=True)

    entries.sort(key=lambda e: (e["root"], e["path"], e["kind"]))
    _write_json(os.path.join(out_dir, "tree.json"), {
        "$comment": (
            "GENERATED by tests/oracle/build.py — do not hand-edit. The fixture tree that "
            "tests/harness/fixtures.py builds, serialized so a Python-free replayer can "
            f"materialize it. Built under HOME={CANONICAL_HOME}."),
        "version": 1,
        "canonicalHome": CANONICAL_HOME,
        "canonicalMtime": CANONICAL_MTIME,
        "roots": [r for r, _ in roots],
        # Named so a reader can see WHICH files carry a deliberate mtime rather than having to
        # infer it from the numbers; verify.py rederives this list independently and compares.
        "explicitMtimeFiles": sorted(explicit),
        "entries": entries,
    })
    return entries, explicit


def _locate(abs_path, roots):
    """Express an absolute path as (root, path) so the manifest holds no machine-local path.

    Both sides are realpath'd first: the roots come from mkdtemp under /var/folders, macOS
    symlinks /var to /private/var, and the resolved link target therefore never matches the
    root string it is genuinely inside.
    """
    for name, root in roots:
        root = os.path.realpath(root)
        if abs_path == root or abs_path.startswith(root + os.sep):
            return {"root": name, "path": os.path.relpath(abs_path, root).replace(os.sep, "/")}
    raise AssertionError(
        f"{abs_path} lies outside every fixture root, so it cannot be recorded portably. "
        "The fixture builder grew a location this manifest does not model.")


def _sha(data):
    import hashlib
    return hashlib.sha256(data).hexdigest()


def _write_json(path, obj):
    with open(path, "w") as fh:
        json.dump(obj, fh, indent=1, sort_keys=True)
        fh.write("\n")


def key_id(key):
    return (key["mode"], tuple(key["argv"]))


def build_all(keys, out_dir):
    """The complete artifact set: responses, index, tree. One entry point so the regeneration
    check exercises exactly the code path that produced the committed files."""
    records = generate(keys, out_dir)
    entries, explicit = build_tree(out_dir)
    _write_json(os.path.join(out_dir, "index.json"), {
        "$comment": (
            "GENERATED by tests/oracle/build.py — do not hand-edit. One record per distinct "
            "(mode, argv) the oracle asks the ccusage fixture for, captured under "
            f"HOME={CANONICAL_HOME}. Verified independently by tests/oracle/verify.py."),
        "version": 1,
        "canonicalHome": CANONICAL_HOME,
        "responses": records,
    })
    return records, entries, explicit


def regen_check(traces, committed):
    """Regenerate into a temp dir and require the result to be byte-identical to what is
    committed.

    verify.py already re-runs the fixture and rebuilds the tree, so this is not about whether
    the artifacts are correct — it is about whether the GENERATOR is deterministic. Those come
    apart: a build.py that stamped the current time, iterated a set, or inherited an ambient
    HOME would still emit artifacts verify.py accepts, while producing a different diff on
    every run and making the committed set impossible to review.
    """
    tmp = tempfile.mkdtemp(prefix="oracle-regen-")
    try:
        target = os.path.join(tmp, "responses")
        os.makedirs(target)
        build_all(traces["keys"], target)

        diffs = []
        left = set(os.listdir(committed))
        right = set(os.listdir(target))
        for name in sorted(left - right):
            diffs.append(f"{name}: committed but not regenerated")
        for name in sorted(right - left):
            diffs.append(f"{name}: regenerated but not committed")
        for name in sorted(left & right):
            with open(os.path.join(committed, name), "rb") as fh:
                a = fh.read()
            with open(os.path.join(target, name), "rb") as fh:
                b = fh.read()
            if a != b:
                diffs.append(f"{name}: regenerating produces different bytes")

        if diffs:
            sys.stderr.write(
                "\nregeneration is NOT deterministic — rebuilding produced a different "
                f"artifact set ({len(diffs)} difference(s)):\n\n")
            for d in diffs[:20]:
                sys.stderr.write(f"  - {d}\n")
            sys.stderr.write(
                "\nEither the committed artifacts are stale, or the generator depends on "
                "something that varies between runs (the clock, the ambient HOME, set "
                "iteration order). Both are bugs; the second is the worse one.\n")
            return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"regeneration OK: rebuilding reproduces all {len(left)} artifact file(s) byte for "
          "byte")
    return 0


# ---------------------------------------------------------------------------------------- main


def main():
    argv = sys.argv[1:]
    check_only = "--check" in argv
    out_dir = DEFAULT_OUT
    if "--out" in argv:
        out_dir = argv[argv.index("--out") + 1]

    # Overridable so the mutation test can aim the checker at a deliberately doctored inventory
    # and confirm it reports the damage. A check nobody has watched fail is not evidence.
    inv_path = argv[argv.index("--inventory") + 1] if "--inventory" in argv else INVENTORY
    traces_path = argv[argv.index("--traces") + 1] if "--traces" in argv else TRACES

    with open(inv_path) as fh:
        inventory = json.load(fh)
    if not os.path.exists(traces_path):
        sys.stderr.write(
            f"{traces_path} is missing. Run: python3 tests/oracle/record.py\n")
        return 2
    with open(traces_path) as fh:
        traces = json.load(fh)

    global CASES
    with open(os.path.join(TESTS, "golden", "cases.json")) as fh:
        CASES = {c["name"]: c for c in json.load(fh)["cases"]}

    missing = set(CASES) - set(traces["cases"])
    if missing:
        sys.stderr.write(
            f"traces.json is stale: {len(missing)} registry case(s) were never recorded, "
            f"e.g. {sorted(missing)[:3]}. Re-run record.py.\n")
        return 2

    fails, stats = check(inventory, traces)
    if fails:
        sys.stderr.write(
            f"\nthe observed child calls disagree with tests/oracle/inventory.json "
            f"({len(fails)} finding(s)):\n\n")
        for f in fails:
            sys.stderr.write(f"  - {f}\n")
        sys.stderr.write(
            "\ninventory.json is the AUTHORED reading of usage.py and is the side to trust. "
            "If usage.py really did change its call pattern, update the inventory against the "
            "source — never against the trace.\n")
        return 1

    print(f"check OK: {len(traces['cases'])} cases match the inventory "
          f"({stats['exact']} exact, {stats['truncated']} stopped partway, "
          f"{stats['none']} never reached a call)")

    if check_only:
        return 0

    if "--regen-check" in argv:
        return regen_check(traces, out_dir)

    keys = traces["keys"]
    seen = {}
    for k in keys:
        kid = key_id(k)
        if kid in seen:
            sys.stderr.write(
                f"duplicate key {kid}: a replayer lookup would be ambiguous.\n")
            return 1
        seen[kid] = True

    # Build into a temp dir and swap. Writing in place would leave an artifact from a previous
    # key set sitting in the directory after a rename, and a stale file that nothing indexes is
    # exactly the kind of thing a verifier is supposed to be able to trust is absent.
    parent = os.path.dirname(os.path.abspath(out_dir))
    os.makedirs(parent, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix=".responses-", dir=parent)
    try:
        records, entries, explicit = build_all(keys, tmp)
        if os.path.exists(out_dir):
            shutil.rmtree(out_dir)
        os.replace(tmp, out_dir)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"wrote {len(records)} responses and a {len(entries)}-entry tree "
          f"({len(explicit)} file(s) with a deliberate mtime) -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
