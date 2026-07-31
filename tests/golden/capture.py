#!/usr/bin/env python3
"""T-002 golden capture — records the Python CLI's exact behavior for the TS port.

For every case in the matrix, runs the REAL usage.py under the deterministic fixture
environment (fake_ccusage.py + fixture-config.json + a synthetic CODEX_HOME) and stores
{argv, mode, extra_env, exit, stdout, stderr} as one JSON file under goldens/.

The stored goldens are the parity oracle for the TS port (byte-equality modulo the
published allowlist in ALLOWLIST.md). Cases marked dual_run_only are captured for the
matrix record but must be asserted by running BOTH implementations at the same moment
(relative dates embed "today"); their stored stdout is informational.

Machine note: project keys derive from $HOME (HOME_ENC), so goldens are valid on the
machine that captured them. The dual-run harness re-captures Python live and is
machine-independent; stored goldens exist so pure-TS CI can still assert against a
committed reference from the capture machine.

Run: python3 tests/golden/capture.py            # writes goldens/*.json + manifest.json
     python3 tests/golden/capture.py --check    # re-runs Python and diffs vs stored
"""
import importlib.util, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
USAGE = os.path.join(TESTS, "..", "usage.py")
FAKE = os.path.join(TESTS, "fake_ccusage.py")
FIXTURE_CONFIG = os.path.join(TESTS, "fixture-config.json")
GOLDENS = os.path.join(HERE, "goldens")

# ---------------------------------------------------------------- codex fixture home
# Mirrors the builder in test_usage.py, from the SAME CODEX_SESSIONS table the fake
# ccusage emits, so the two sides cannot drift.
def build_codex_home():
    fspec = importlib.util.spec_from_file_location("fake_ccusage_fixture", FAKE)
    fake = importlib.util.module_from_spec(fspec); fspec.loader.exec_module(fake)
    codex_home = tempfile.mkdtemp(prefix="golden-codex-home-")
    outside = tempfile.mkdtemp(prefix="golden-codex-outside-")
    for s in fake.CODEX_SESSIONS:
        loc = s["_loc"]
        if loc == "missing":
            continue
        if loc == "archived":
            d = os.path.join(codex_home, "archived_sessions")
        else:
            date = s["sessionFile"][8:18].split("T")[0]
            d = os.path.join(codex_home, "sessions", *date.split("-"))
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, s["sessionFile"] + ".jsonl")
        if loc == "symlink":
            target = os.path.join(outside, "escaped.jsonl")
            with open(target, "w") as fh:
                fh.write(json.dumps({"type": "session_meta", "payload": {"cwd": s["_cwd"]}}) + "\n")
            os.symlink(target, path)
            continue
        with open(path, "w") as fh:
            if loc == "malformed":
                fh.write("not json at all\n")
                fh.write(json.dumps({"type": "event_msg", "payload": {"cwd": "/decoy/project"}}) + "\n")
            else:
                cwd = os.path.expanduser(s["_cwd"])
                fh.write(json.dumps({"type": "session_meta", "payload": {"cwd": cwd}}) + "\n")
                fh.write(json.dumps({"type": "event_msg", "payload": {}}) + "\n")
    return codex_home, outside

# ---------------------------------------------------------------- case matrix
def C(name, argv, mode="normal", codex=False, env=None, dual_run_only=False):
    return {"name": name, "argv": argv, "mode": mode, "codex": codex,
            "env": env or {}, "dual_run_only": dual_run_only}

CASES = [
    # projects x modes x metrics
    C("projects_normal",        ["projects"]),
    C("projects_cost",          ["projects", "--metric", "cost"]),
    C("projects_both",          ["projects", "--metric", "both"]),
    C("projects_empty",         ["projects"], mode="empty"),
    C("projects_mismatch",      ["projects"], mode="mismatch"),
    C("projects_float",         ["projects"], mode="float"),
    # daily
    C("daily_normal",           ["daily"]),
    C("daily_tokens",           ["daily", "--metric", "tokens"]),
    C("daily_both",             ["daily", "--metric", "both"]),
    C("daily_empty",            ["daily"], mode="daily_empty"),
    # share / compare / alltime
    C("share_normal",           ["share"]),
    C("share_vs",               ["share", "--vs", "20260101"]),
    C("share_empty",            ["share"], mode="empty"),
    C("compare_normal",         ["compare", "--day1=20260101", "--day2=20260102"]),
    C("compare_empty",          ["compare", "--day1=20270101", "--day2=20270102"], mode="empty"),
    C("alltime_normal",         ["alltime"]),
    C("alltime_empty",          ["alltime"], mode="empty"),
    # blocks / hourly
    C("blocks_normal",          ["blocks"]),
    C("blocks_empty",           ["blocks"], mode="blocks_empty"),
    C("hourly_nodata",          ["hourly", "--date=20270101"], mode="empty"),
    # codex / combined (need the synthetic CODEX_HOME)
    C("codex_since",            ["codex", "--since", "20260101"], codex=True),
    C("codex_unwindowed",       ["codex"], codex=True),
    C("codex_empty",            ["codex"], mode="codex_empty", codex=True),
    C("codex_bad_cost",         ["codex"], mode="codex_bad", codex=True),
    C("combined_since",         ["combined", "--since", "20260101"], codex=True),
    C("combined_empty",         ["combined"], mode="codex_empty", codex=True),
    # cli-contract / error surfaces
    C("err_bad_metric",         ["daily", "--metric", "bogus"]),
    C("err_bad_reldate",        ["projects", "--since=-xd"]),
    C("err_missing_binary",     ["alltime"], env={"CCUSAGE_CMD": "/nonexistent/ccusage-binary-xyz"}),
    C("err_no_subcommand",      []),
    C("err_unknown_subcommand", ["frobnicate"]),
    # relative dates: today-dependent -> dual-run only (stored stdout informational)
    C("rel_projects_since_3d",  ["projects", "--since", "-3d"], dual_run_only=True),
    C("rel_daily_since_7d",     ["daily", "--since", "-7d"], dual_run_only=True),
]

# ---------------------------------------------------------------- capture / check
def run_case(case, codex_home):
    env = dict(os.environ,
               CCUSAGE_CMD=f"{sys.executable} {FAKE}",
               FAKE_MODE=case["mode"],
               USAGE_CONFIG=FIXTURE_CONFIG)
    if case["codex"]:
        env["CODEX_HOME"] = codex_home
    env.update(case["env"])
    p = subprocess.run([sys.executable, USAGE, *case["argv"]],
                       capture_output=True, text=True, env=env)
    return {"name": case["name"], "argv": case["argv"], "mode": case["mode"],
            "codex_fixture": case["codex"], "extra_env": case["env"],
            "dual_run_only": case["dual_run_only"],
            "exit": p.returncode, "stdout": p.stdout, "stderr": p.stderr}

def main():
    check = "--check" in sys.argv
    codex_home, outside = build_codex_home()
    try:
        os.makedirs(GOLDENS, exist_ok=True)
        results, diffs = [], []
        for case in CASES:
            rec = run_case(case, codex_home)
            path = os.path.join(GOLDENS, rec["name"] + ".json")
            if check:
                with open(path) as fh:
                    stored = json.load(fh)
                same = all(stored[k] == rec[k] for k in ("exit", "stdout", "stderr"))
                if not same and not rec["dual_run_only"]:
                    diffs.append(rec["name"])
                print(f"  [{'OK ' if same or rec['dual_run_only'] else 'DIFF'}] {rec['name']}")
            else:
                with open(path, "w") as fh:
                    json.dump(rec, fh, indent=1, ensure_ascii=False)
                results.append(rec)
                marker = "dual-run" if rec["dual_run_only"] else f"exit={rec['exit']}"
                print(f"  captured {rec['name']}  ({marker}, {len(rec['stdout'])}B out, {len(rec['stderr'])}B err)")
        if check:
            if diffs:
                print(f"\nDIFFS in {len(diffs)} case(s): {', '.join(diffs)}"); sys.exit(1)
            print("\nAll stored goldens match a live Python re-run.")
        else:
            manifest = {
                "capturedBy": "tests/golden/capture.py",
                "pythonInterpreter": sys.version.split()[0],
                "caseCount": len(results),
                "dualRunOnly": [r["name"] for r in results if r["dual_run_only"]],
                "notes": [
                    "Byte-equality contract is stdout+stderr+exit vs the TS port, modulo ALLOWLIST.md.",
                    "Goldens are machine-scoped: project keys derive from $HOME (HOME_ENC).",
                    "All captures are non-TTY (subprocess pipes); TTY variants are a harness-level TODO.",
                    "dual_run_only cases embed 'today' (relative dates) - assert them by running both implementations at the same moment, never against stored bytes.",
                ],
            }
            with open(os.path.join(GOLDENS, "manifest.json"), "w") as fh:
                json.dump(manifest, fh, indent=1)
            print(f"\nWrote {len(results)} goldens + manifest to {os.path.relpath(GOLDENS)}")
    finally:
        shutil.rmtree(codex_home, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)

if __name__ == "__main__":
    main()
