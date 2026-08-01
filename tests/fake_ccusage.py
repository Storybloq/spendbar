#!/usr/bin/env python3
"""Fixture ccusage for usage.py regression tests. Emits controlled JSON based on the
subcommand in argv and the FAKE_MODE env var, so tests can assert exact aggregation and
exercise edge cases (empty windows, float-associativity, totals mismatch) deterministically.
Kept alongside test_usage.py so the locked probes survive."""
import sys, os, json, re

MODE = os.environ.get("FAKE_MODE", "normal")
args = sys.argv[1:]

# Build project keys from the RUNNING machine's home, encoded the way ccusage encodes paths.
# This makes the fixture (and the dynamic prefix-stripping it exercises) machine-independent.
HOME_ENC = re.sub(r"[^A-Za-z0-9]", "-", os.path.expanduser("~"))
def pkey(name):
    return f"{HOME_ENC}-Developer-{name}"

def mb(model, cost, i, o, cc, cr):
    return {"modelName": model, "cost": cost, "inputTokens": i, "outputTokens": o,
            "cacheCreationTokens": cc, "cacheReadTokens": cr}

def instances_normal():
    # alpha: fable(10,tok10)+opus(5,tok20) day1, fable(3,tok6) day2 => $18, fable tok16
    # beta -> "Beta Product": sonnet(2,tok4)+gpt(1,tok100) day1 => $3, 100 gpt tokens hidden
    return {"projects": {
        pkey("alpha"): [
            {"date": "2026-01-01", "totalCost": 15.0, "totalTokens": 30,
             "modelBreakdowns": [mb("claude-fable-5", 10.0, 1, 1, 1, 7),
                                 mb("claude-opus-4-8", 5.0, 5, 5, 5, 5)]},
            {"date": "2026-01-02", "totalCost": 3.0, "totalTokens": 6,
             "modelBreakdowns": [mb("claude-fable-5", 3.0, 1, 1, 1, 3)]}],
        pkey("beta"): [
            {"date": "2026-01-01", "totalCost": 3.0, "totalTokens": 104,
             "modelBreakdowns": [mb("claude-sonnet-5", 2.0, 1, 1, 1, 1),
                                 mb("gpt-5.5", 1.0, 25, 25, 25, 25)]}],
    }, "totals": {"totalCost": 21.0, "totalTokens": 140}}

def instances_empty():
    return {"totals": {"totalCost": 0, "totalTokens": 0}}   # ccusage omits "projects" on empty

def instances_mismatch():
    d = instances_normal(); d["totals"]["totalCost"] = 999.0; return d

def instances_float():
    # Three costs that sum forward to 83.995 (->$84.00) but ccusage precomputes the total by
    # summing in reverse to 83.99499999999999 (->$83.99). Probes reconcile()'s float tolerance.
    days = [7.377597, 38.464743, 38.15266]
    proj = [{"date": f"2026-01-0{i+1}", "totalTokens": 100, "totalCost": c,
             "modelBreakdowns": [mb("claude-opus-4-8", c, 1, 1, 0, 0)]} for i, c in enumerate(days)]
    grand = 0.0
    for x in reversed(days): grand += x
    return {"projects": {pkey("foo"): proj},
            "totals": {"totalCost": grand, "totalTokens": 300}}

def daily_normal():
    return {"daily": [
        {"period": "2026-01-01", "totalCost": 5.0, "totalTokens": 50,
         "modelBreakdowns": [mb("claude-fable-5", 3.0, 10, 5, 5, 10), mb("gpt-5.5", 2.0, 5, 5, 5, 5)]},
        {"period": "2026-01-02", "totalCost": 4.0, "totalTokens": 40,
         "modelBreakdowns": [mb("claude-opus-4-8", 4.0, 10, 10, 10, 10)]}],
        "totals": {"totalCost": 9.0, "totalTokens": 90}}

def daily_empty():
    return {"totals": {"totalCost": 0, "totalTokens": 0}}

def blocks_normal():
    return {"blocks": [
        {"startTime": "2026-01-01T00:00:00.000Z", "endTime": "2026-01-01T05:00:00.000Z",
         "actualEndTime": "2026-01-01T02:00:00.000Z", "isActive": False, "isGap": False,
         "costUSD": 100.0, "totalTokens": 1000},
        {"startTime": "2026-01-01T05:00:00.000Z", "actualEndTime": "2026-01-01T05:00:00.000Z",
         "isActive": True, "isGap": False, "costUSD": 0.0, "totalTokens": 0},   # zero-duration
        {"isGap": True}]}

def blocks_empty():
    return {"blocks": []}

def blocks_array():
    """Top-level payload is a LIST, so `d.get` does not exist... but usage.py calls .get on it.

    Included to find out what the oracle actually does rather than to assert a guess."""
    return [{"startTime": "2026-01-01T00:00:00.000Z", "endTime": "2026-01-01T05:00:00.000Z",
             "isGap": False, "costUSD": 3.0, "totalTokens": 30}]

def blocks_str():
    """`blocks` is a STRING: Python iterates its characters, all skipped by isinstance."""
    return {"blocks": "abc"}

def blocks_dict():
    """`blocks` present but a DICT: `d.get("blocks", d)` returns it and Python iterates KEYS."""
    return {"blocks": {"k": {"costUSD": 1.0, "totalTokens": 1}}}

def blocks_null():
    """`blocks` present and null: iterating None is a TypeError."""
    return {"blocks": None}

def blocks_nokey():
    """No `blocks` key at all: the fallback is the PAYLOAD itself, so Python iterates its keys."""
    return {"other": 1}

def blocks_truthiness():
    """Values whose Python truthiness differs from JavaScript's, plus an explicit null.

    `isGap: {}` is FALSY in Python so the row is processed; in JS `{}` is truthy and it would
    be skipped. `actualEndTime: ""` is falsy so Python falls through to `endTime`.
    `isActive: null` is `None` from `.get`, and `str(None)` renders as `None`.
    """
    return {"blocks": [
        {"startTime": "2026-01-01T00:00:00.000Z", "endTime": "2026-01-01T05:00:00.000Z",
         "actualEndTime": "", "isActive": None, "isGap": {}, "costUSD": 10.0,
         "totalTokens": 100}]}

def blocks_malformed():
    """Producer data that no schema validator rejects, because `blocks` has none (ISS-002).

    T-004 does not add one; it only has to avoid CHANGING what malformed data does today, so
    this freezes the current behaviour rather than asserting a desired one. Each field is a
    different way for a producer to go wrong: a numeric field arriving as a string, a null
    where a number is expected, and a block missing the timestamps the label is built from.
    """
    return {"blocks": [
        {"startTime": "2026-01-01T00:00:00.000Z", "endTime": "2026-01-01T05:00:00.000Z",
         "actualEndTime": "2026-01-01T02:00:00.000Z", "isActive": False, "isGap": False,
         "costUSD": "100.0", "totalTokens": None},
        {"isActive": False, "isGap": False, "costUSD": 5.0, "totalTokens": 10}]}

# ---- codex sessions: SHARED with test_usage.py (imported), which builds the matching
# rollout fixture files under a temp CODEX_HOME from the _cwd/_loc fields. Keys without
# an underscore are emitted verbatim as the ccusage `codex session --json` row.
# _loc: dated = CODEX_HOME/sessions/<date>/, archived = flat archived_sessions/,
#       missing = no file on disk, malformed = file exists but head lines are not JSON,
#       symlink = validly-named link in the dated dir pointing OUTSIDE CODEX_HOME.
def _uuid(n):
    return f"019c0000-0000-7000-8000-{n:012x}"

CODEX_SESSIONS = [
    # plain dated session -> alpha
    {"sessionFile": f"rollout-2026-01-01T10-00-00-{_uuid(1)}", "directory": "2026/01/01",
     "costUSD": 10.0, "totalTokens": 100, "models": {"gpt-5.5": {"totalTokens": 100}},
     "_cwd": "~/Developer/alpha", "_loc": "dated"},
    # renamed project (fixture config: beta -> Beta Product)
    {"sessionFile": f"rollout-2026-01-02T10-00-00-{_uuid(2)}", "directory": "2026/01/02",
     "costUSD": 5.0, "totalTokens": 50,
     "models": {"gpt-5.5": {"totalTokens": 30}, "gpt-5.4-mini": {"totalTokens": 20}},
     "_cwd": "~/Developer/beta", "_loc": "dated"},
    # archived (flat dir) -> alpha
    {"sessionFile": f"rollout-2026-01-01T11-00-00-{_uuid(3)}", "directory": "2026/01/01",
     "costUSD": 2.0, "totalTokens": 20, "models": {"gpt-5.5": {"totalTokens": 20}},
     "_cwd": "~/Developer/alpha", "_loc": "archived"},
    # rollout log missing on disk -> unknown bucket, cost conserved
    {"sessionFile": f"rollout-2026-01-02T11-00-00-{_uuid(4)}", "directory": "2026/01/02",
     "costUSD": 3.0, "totalTokens": 30, "models": {"gpt-5.5": {"totalTokens": 30}},
     "_cwd": None, "_loc": "missing"},
    # rollout log exists but head lines are garbage -> unknown
    {"sessionFile": f"rollout-2026-01-02T12-00-00-{_uuid(5)}", "directory": "2026/01/02",
     "costUSD": 1.0, "totalTokens": 10, "models": {"gpt-5.5": {"totalTokens": 10}},
     "_cwd": None, "_loc": "malformed"},
    # started before the --since 20260101 window (filename date) -> bleed note
    {"sessionFile": f"rollout-2025-12-30T10-00-00-{_uuid(6)}", "directory": "2025/12/30",
     "costUSD": 4.0, "totalTokens": 40, "models": {"gpt-5.6-sol": {"totalTokens": 40}},
     "_cwd": "~/Developer/alpha", "_loc": "dated"},
    # nested cwd -> displays as alpha-tools (cwd-granularity contract)
    {"sessionFile": f"rollout-2026-01-03T10-00-00-{_uuid(7)}", "directory": "2026/01/03",
     "costUSD": 6.0, "totalTokens": 60, "models": {"gpt-5.5": {"totalTokens": 60}},
     "_cwd": "~/Developer/alpha/tools", "_loc": "dated"},
    # traversal-looking sessionFile: must never be opened -> unknown (empty models
    # also exercises the 'unclassified' token bucket in the model footer)
    {"sessionFile": "../../etc/passwd", "directory": "2026/01/03",
     "costUSD": 0.5, "totalTokens": 5, "models": {}, "_cwd": None, "_loc": "missing"},
    # directory field absent -> resolved via the filename-embedded date
    {"sessionFile": f"rollout-2026-01-04T10-00-00-{_uuid(9)}", "directory": None,
     "costUSD": 2.5, "totalTokens": 25, "models": {"gpt-5.5": {"totalTokens": 25}},
     "_cwd": "~/Developer/alpha", "_loc": "dated"},
    # agent-scratchpad cwd -> collapsed into "(agent scratchpads)"
    {"sessionFile": f"rollout-2026-01-04T11-00-00-{_uuid(10)}", "directory": "2026/01/04",
     "costUSD": 0.9, "totalTokens": 9, "models": {"gpt-5.5": {"totalTokens": 9}},
     "_cwd": "/private/tmp/claude-501/scratch/scratchpad", "_loc": "dated"},
    # symlink escaping CODEX_HOME: realpath containment must refuse it -> unknown
    {"sessionFile": f"rollout-2026-01-05T10-00-00-{_uuid(11)}", "directory": "2026/01/05",
     "costUSD": 0.6, "totalTokens": 6, "models": {"gpt-5.5": {"totalTokens": 6}},
     "_cwd": "/outside/evil-project", "_loc": "symlink"},
    # ordinary /tmp project (NOT a claude scratchpad) keeps its own attribution
    {"sessionFile": f"rollout-2026-01-05T11-00-00-{_uuid(12)}", "directory": "2026/01/05",
     "costUSD": 0.7, "totalTokens": 7, "models": {"gpt-5.5": {"totalTokens": 7}},
     "_cwd": "/tmp/legitimate-project", "_loc": "dated"},
]

def codex_normal():
    rows = [{k: v for k, v in s.items() if not k.startswith("_")} for s in CODEX_SESSIONS]
    return {"sessions": rows,
            "totals": {"costUSD": sum(s["costUSD"] for s in rows),
                       "totalTokens": sum(s["totalTokens"] for s in rows)}}

def codex_empty():
    return {"sessions": [], "totals": {"costUSD": 0, "totalTokens": 0}}

def codex_daily_normal():
    # Calendar-accurate per-day Codex anchor. Totals are tuned to equal the START-date-windowed
    # kept sum for the --since 20260101 test ($31.70 / 317 tok: all sessions except the
    # 2025-12-30 bleed ($4.00) and the undated ../../etc/passwd session ($0.50, 5 tok)), so the
    # cross-check reports Δ $+0.00 and no token-mismatch note. Rows are illustrative only —
    # cmd_codex/cmd_combined read `totals`, not the per-day rows.
    return {"daily": [
        {"date": "2026-01-01", "costUSD": 12.0, "totalTokens": 120,
         "models": {"gpt-5.5": {"totalTokens": 120}}},
        {"date": "2026-01-02", "costUSD": 4.0, "totalTokens": 40,
         "models": {"gpt-5.5": {"totalTokens": 40}}}],
        "totals": {"costUSD": 31.70, "totalTokens": 317}}

def codex_daily_empty():
    return {"daily": [], "totals": {"costUSD": 0, "totalTokens": 0}}

def codex_bad():
    d = codex_normal()
    d["sessions"][0]["costUSD"] = True   # bool must be rejected, not summed as 1
    return d

def instances_tied():
    """Two projects with EXACTLY equal cost, for the set-iteration tiebreak (plan section 12).

    usage.py sorts over a Python *set* in `share`/`combined`, and `sorted` is stable, so tied
    keys fall back to hash-based set iteration order. Python is therefore nondeterministic
    here, not merely different from JS — so the port defines the tiebreak (primary key, then
    project name) and the ALLOWLIST records that byte-parity is UNDEFINED rather than broken.
    Names are chosen so the tiebreak is observable: alphabetical order is not insertion order.
    """
    day = lambda c: [{"date": "2026-01-01", "totalCost": c, "totalTokens": 10,
                      "modelBreakdowns": [mb("claude-fable-5", c, 1, 1, 1, 7)]}]
    return {"projects": {pkey("zulu"): day(5.0), pkey("alpha"): day(5.0),
                         pkey("mike"): day(5.0)},
            "totals": {"totalCost": 15.0, "totalTokens": 30}}

INST = {"normal": instances_normal, "empty": instances_empty,
        "mismatch": instances_mismatch, "float": instances_float,
        "tied": instances_tied}

CODEX = {"codex_empty": codex_empty, "codex_bad": codex_bad}
BLOCKS = {"blocks_empty": blocks_empty, "blocks_malformed": blocks_malformed,
          "blocks_dict": blocks_dict, "blocks_null": blocks_null,
          "blocks_nokey": blocks_nokey, "blocks_truthiness": blocks_truthiness,
          "blocks_array": blocks_array, "blocks_str": blocks_str}

# Every dispatch used to be a `.get(MODE, <default>)`, so an unknown mode silently produced
# the DEFAULT fixture. A case naming `blocks_truthinesss` ran `blocks_normal`, both
# implementations agreed on it perfectly, and the case read as covered while asserting nothing
# about the fixture it named — measured end to end in code review R2 with the whole suite
# green. Fixtures are chosen by name; a name that matches nothing is a typo, not a request for
# the default.
#
# Validating against one GLOBAL vocabulary was the first fix and it was not enough (code
# review R3): it proved a mode existed somewhere, not that THIS branch understood it, so
# `blocks_empty` on the --instances branch still fell back to `instances_normal`. The tables
# are per-branch and indexed directly, so every branch refuses a mode it does not implement.
#
# The exception is real and has to be declared rather than papered over. `combined` queries
# BOTH providers under a single FAKE_MODE, so a codex-side mode legitimately reaches the
# Claude branch and must yield the ordinary Claude fixture. That is a deliberate widening with
# a name, not a fallback: a mode outside both the branch's table and its tolerance list is an
# error, and the message tells the next author to widen it on purpose.
CODEX_DAILY = {"normal": codex_daily_normal, "codex_empty": codex_daily_empty}
CODEX = {"normal": codex_normal, **CODEX}
BLOCKS = {"normal": blocks_normal, **BLOCKS}
DAILY = {"normal": daily_normal, "daily_empty": daily_empty}
CLAUDE_ONLY = frozenset(INST)                     # normal, empty, mismatch, float, tied
CODEX_ONLY = frozenset(CODEX) - {"normal"}        # codex_empty, codex_bad


def dispatch(branch, table, tolerated=frozenset(), fallback=None):
    if MODE in table:
        return table[MODE]()
    if MODE in tolerated:
        # The other provider's mode, under `combined`. This branch has nothing special to say
        # about it, so it serves its ordinary fixture — deliberately, and only for the modes
        # named above.
        return fallback()
    sys.stderr.write(
        f"fake_ccusage: FAKE_MODE {MODE!r} is not a '{branch}' mode\n"
        f"  {branch} implements: {', '.join(sorted(table))}\n"
        f"  and tolerates from the other provider: {', '.join(sorted(tolerated)) or '(none)'}\n"
        f"  A mode that matches nothing is a typo. If this combination is intended, add it to\n"
        f"  the table or the tolerance list in tests/fake_ccusage.py, on purpose.\n")
    sys.exit(2)


if __name__ == "__main__":
    if "codex" in args:
        if "daily" in args:
            out = dispatch("codex daily", CODEX_DAILY, CLAUDE_ONLY - {"normal"}, codex_daily_normal)
        else:
            out = dispatch("codex", CODEX, CLAUDE_ONLY - {"normal"}, codex_normal)
    elif "blocks" in args:
        out = dispatch("blocks", BLOCKS)
    elif "--instances" in args:
        out = dispatch("instances", INST, CODEX_ONLY, instances_normal)
    elif "daily" in args:
        out = dispatch("daily", DAILY, CODEX_ONLY, daily_normal)
    else:
        # No subcommand this fixture models; the payload does not depend on MODE at all.
        out = {"totals": {"totalCost": 0, "totalTokens": 0}}

    print(json.dumps(out))
