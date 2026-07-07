#!/usr/bin/env python3
"""Regression suite for usage.py — locked probes from the probe-loop pass (2026-07-04).

Each test runs the REAL CLI (usage.py) via subprocess against a controlled fixture ccusage
(fake_ccusage.py) and asserts the ACTUAL stdout — not a status code. Every test names the
bug-taxonomy category it guards against. Run: python3 test_usage.py  (exits non-zero on failure).

Bug categories guarded here:
  - cross-layer-trust-violation : ccusage omits projects/daily key on empty windows; tool must not crash
  - destructive-edge-case       : empty/zero windows -> div-by-zero, min()/max() on empty, zero-duration block
  - environment-mismatch        : float summation order differs from ccusage -> false reconcile MISMATCH
  - silent-no-op                : gpt/other spend silently dropped from projects columns
  - swallowed-error             : malformed config JSON crashing at import
  - correctness                 : aggregation math, model-family classification, percentages
  - cli-contract                : relative-date argv handling, malformed-date errors
"""
import subprocess, sys, os, importlib.util, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
USAGE = os.path.join(HERE, "..", "usage.py")
FAKE = os.path.join(HERE, "fake_ccusage.py")
FIXTURE_CONFIG = os.path.join(HERE, "fixture-config.json")

failures = []

def run(args, mode="normal", extra_env=None):
    # USAGE_CONFIG points at the deterministic fixture config so tests never depend on the
    # user's real, mutable usage-config.json next to the script.
    env = dict(os.environ, CCUSAGE_CMD=f"{sys.executable} {FAKE}", FAKE_MODE=mode,
               USAGE_CONFIG=FIXTURE_CONFIG)
    if extra_env:
        env.update(extra_env)
    p = subprocess.run([sys.executable, USAGE, *args], capture_output=True, text=True, env=env)
    return p.returncode, p.stdout, p.stderr

def check(name, category, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] ({category}) {name}" + (f" -- {detail}" if not cond and detail else ""))
    if not cond:
        failures.append(name)

# ---- correctness: aggregation math is exact ----
rc, out, err = run(["projects"])
check("projects: alpha aggregates to $18.00", "correctness",
      "alpha" in out and "$18.00" in out, out + err)
check("projects: beta renamed to 'Beta Product' in output", "correctness",
      "Beta Product" in out, out)
check("projects: fable tokens 16, opus 20", "correctness", " 16 " in out and " 20 " in out, out)
check("projects: TOTAL $21.00 and reconcile OK", "correctness",
      "$21.00" in out and "totals reconcile: OK" in out, out)

# ---- silent-no-op: hidden gpt/other spend is surfaced, not dropped ----
check("projects: hidden gpt spend note present", "silent-no-op",
      "gpt/other spend not shown" in out, out)

# ---- correctness: share percentages ----
rc, out, _ = run(["share"])
check("share: 85.7% / 14.3% split", "correctness", "85.7%" in out and "14.3%" in out, out)

# ---- cross-layer: two-window share reconciles BOTH windows ----
rc, out, _ = run(["share", "--vs", "20260101"])
check("share --vs: both A and B reconcile", "cross-layer-trust-violation",
      "A:[totals reconcile: OK]" in out and "B:[totals reconcile: OK]" in out, out)

# ---- correctness: alltime range + compare deltas + daily gpt column ----
rc, out, _ = run(["alltime"])
check("alltime: range 2026-01-01 -> 2026-01-02", "correctness",
      "2026-01-01 -> 2026-01-02" in out, out)
rc, out, _ = run(["compare", "--day1=20260101", "--day2=20260102"])
check("compare: alpha delta -12.00", "correctness", "-12.00" in out, out)
rc, out, _ = run(["daily"])
check("daily: gpt column shows 2.00", "correctness", "2.00" in out and "Gpt$" in out, out)

# ---- feature: --metric closes the per-model tokens/cost display gaps (2026-07-06) ----
# The data (by_cost per project, per-model tokens per day) already existed in the aggregation;
# these probes lock that both metrics can now be *displayed* without reaching to raw ccusage.
# projects --metric cost: per-model COST columns (previously only Fable$ was shown).
rc, out, _ = run(["projects", "--metric", "cost"])
check("projects --metric cost: per-model cost cols, no token col", "correctness",
      "Opus$" in out and "$13.00" in out and "$5.00" in out and "Tokens" not in out, out)
check("projects --metric cost: still reconciles + surfaces hidden gpt", "correctness",
      "totals reconcile: OK" in out and "gpt/other spend not shown" in out, out)
# daily --metric tokens: per-model TOKEN columns (was cost-only -> the main manual-computation gap).
rc, out, _ = run(["daily", "--metric", "tokens"])
check("daily --metric tokens: per-model token cols, not cost", "correctness",
      "Fable$" not in out and " 30 " in out and " 40 " in out and " 20\n" in out and "90" in out, out)
# both: two stacked sections in one command.
rc, out, _ = run(["daily", "--metric", "both"])
check("daily --metric both: cost + token sections", "correctness",
      "Fable$" in out and out.count("Fable") >= 2, out)
rc, out, _ = run(["projects", "--metric", "both"])
check("projects --metric both: token + cost sections", "correctness",
      "Opus$" in out and "Tokens" in out, out)
# invalid metric is a clean argparse error, not a traceback.
rc, out, err = run(["daily", "--metric", "bogus"])
check("daily --metric bogus: clean argparse error", "cli-contract",
      rc != 0 and "Traceback" not in err, f"rc={rc} {err!r}")

# ---- environment-mismatch: missing node/npx (or bad CCUSAGE_CMD) exits cleanly, not a traceback ----
# On a fresh public machine without node, run_ccusage's subprocess would raise FileNotFoundError.
rc, out, err = run(["alltime"], extra_env={"CCUSAGE_CMD": "/nonexistent/ccusage-binary-xyz"})
check("run_ccusage: missing binary -> clean exit, no traceback", "environment-mismatch",
      rc != 0 and "Traceback" not in err and "not found" in (out + err), f"rc={rc} {err!r}")

# ---- cross-layer-trust-violation: empty windows must NOT crash (was KeyError) ----
for cmd in (["projects"], ["share"], ["alltime"]):
    rc, out, err = run(cmd, mode="empty")
    check(f"{cmd[0]}: empty window exits 0 with no-data msg", "cross-layer-trust-violation",
          rc == 0 and "No usage found" in out, f"rc={rc} out={out!r} err={err!r}")
rc, out, err = run(["compare", "--day1=20270101", "--day2=20270102"], mode="empty")
check("compare: empty days exit 0 no-data", "cross-layer-trust-violation",
      rc == 0 and "No usage found" in out, f"rc={rc} {err!r}")
rc, out, err = run(["hourly", "--date=20270101"], mode="empty")
check("hourly: no-data date exits 0 with log msg", "cross-layer-trust-violation",
      rc == 0 and "No raw session logs" in out, f"rc={rc} {err!r}")
rc, out, err = run(["daily"], mode="daily_empty")
check("daily: empty window exits 0 no-data", "cross-layer-trust-violation",
      rc == 0 and "No usage found" in out, f"rc={rc} {err!r}")

# ---- environment-mismatch: float summation order must NOT trip a false MISMATCH ----
rc, out, _ = run(["projects"], mode="float")
check("reconcile: float-order noise stays OK", "environment-mismatch",
      "totals reconcile: OK" in out, out)

# ---- correctness: a REAL dollar mismatch STILL trips (check not neutered) ----
rc, out, _ = run(["projects"], mode="mismatch")
check("reconcile: genuine $978 gap reports MISMATCH", "correctness",
      "MISMATCH" in out, out)

# ---- destructive-edge-case: zero-duration block, no divide-by-zero ----
rc, out, err = run(["blocks"])
check("blocks: zero-duration block no crash", "destructive-edge-case",
      rc == 0 and "0.0h" in out, f"rc={rc} {err!r}")
rc, out, _ = run(["blocks"], mode="blocks_empty")
check("blocks: empty window shows message", "cli-contract",
      "no billing blocks" in out, out)

# ---- cli-contract: relative date with and without '=' ----
rc, out, err = run(["projects", "--since", "-3d"])
check("projects --since -3d (no '='): works", "cli-contract",
      rc == 0 and "reconcile" in out, f"rc={rc} {err!r}")
rc, out, err = run(["projects", "--since=-xd"])
check("projects --since=-xd: clean error not traceback", "cli-contract",
      rc != 0 and "bad relative date" in (out + err) and "Traceback" not in err,
      f"rc={rc} {err!r}")

# ---- import-level tests: model_family + malformed config (swallowed-error) ----
spec = importlib.util.spec_from_file_location("usage_under_test", os.path.abspath(USAGE))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)

check("model_family: fable/opus/sonnet/haiku/gpt/codex/other", "correctness",
      mod.model_family("claude-fable-5") == "fable" and
      mod.model_family("claude-opus-4-8") == "opus" and
      mod.model_family("claude-sonnet-5") == "sonnet" and
      mod.model_family("claude-haiku-4-5") == "haiku" and
      mod.model_family("gpt-5.1-codex-max") == "gpt" and
      mod.model_family("some-codex-mini") == "gpt" and
      mod.model_family("mystery-model") == "other")

# ---- portability: home-prefix stripping is derived from the RUNNING machine's home ----
# Pin the config-derived globals so this tests the pure path logic, not the user's config.
mod.RENAMES, mod.WORKSPACE_ROOTS, mod.LEGACY_GROUPS = {}, ["Developer"], {}
check("clean_name: dynamic home strip, no cross-user strip", "portability",
      mod.clean_name(f"{mod.HOME_ENC}-Developer-alpha") == "alpha" and   # ~/Developer/x -> x
      mod.clean_name(mod.HOME_ENC) == "~" and                                  # home itself
      mod.clean_name(f"{mod.HOME_ENC}-Desktop-scratch") == "~/Desktop-scratch" and  # other home subpath
      mod.clean_name("-Volumes-ext-Developer-x") == "-Volumes-ext-Developer-x",     # foreign prefix untouched
      f"HOME_ENC={mod.HOME_ENC}")

# ---- swallowed-error: malformed config returns defaults gracefully (not a crash) ----
bad = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
bad.write("{ not valid json ,,, }"); bad.close()
mod.CONFIG_PATH = bad.name
try:
    renames, roots, legacy = mod.load_config()
    check("load_config: malformed config returns defaults gracefully", "swallowed-error",
          renames == {} and roots == ["Developer"] and legacy == {})
finally:
    os.unlink(bad.name)

# ---- summary ----
print()
if failures:
    print(f"FAILED {len(failures)} test(s): {', '.join(failures)}")
    sys.exit(1)
print("All regression probes passed.")
