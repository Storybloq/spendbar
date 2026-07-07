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

INST = {"normal": instances_normal, "empty": instances_empty,
        "mismatch": instances_mismatch, "float": instances_float}

if "blocks" in args:
    out = blocks_empty() if MODE == "blocks_empty" else blocks_normal()
elif "--instances" in args:
    out = INST.get(MODE, instances_normal)()
elif "daily" in args:
    out = daily_empty() if MODE == "daily_empty" else daily_normal()
else:
    out = {"totals": {"totalCost": 0, "totalTokens": 0}}

print(json.dumps(out))
