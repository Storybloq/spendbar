#!/usr/bin/env python3
"""usage — a CLI over ccusage for per-project Claude Code / Codex cost tracking.

Wraps `ccusage` and applies your project grouping/renames (from usage-config.json next to this
script, or $USAGE_CONFIG), then answers the questions we keep asking:

  usage projects [--since D] [--until D]   Per-project × model table (+ Fable cost)
  usage daily    [--since D] [--until D]   Per-day cost, split by model family
  usage share    [--since D] [--vs D]      % of spend per project; --vs adds a 2nd window
  usage compare  --day1 D --day2 D         Two calendar days, per project, side by side
  usage blocks   [--since D]               Billing blocks + $/hour burn rate
  usage hourly   [--date D]                Half-hour cost histogram from raw logs (burst finder)
  usage alltime                            Every project's cost to date + first/last active

Dates: YYYYMMDD or YYYY-MM-DD, or relative like -3d / -30d (trailing window from today).

Accuracy notes:
  * Per-project/per-day numbers use `ccusage claude daily --instances`, which buckets by
    real calendar date. Do NOT use `ccusage session --since` for windows — it stamps a whole
    session on its last-activity date, pulling earlier days' tokens across the boundary.
  * `--instances` is Claude Code ONLY — Codex/GPT sessions are absent entirely (NOT folded into
    `misc`), so projects/share/alltime undercount total spend. `misc` is only Claude runs from the
    home dir / ~/Developer root. Use `usage daily`/`blocks` for Codex-inclusive totals.
  * Every command verifies its aggregation against ccusage's own grand totals and prints the check.
"""
import argparse, json, os, glob, subprocess, sys, datetime, re
from collections import defaultdict

# Config lives next to this script. realpath resolves the ~/.local/bin/usage symlink back to the
# real file, so the default is found no matter where the tool is invoked from. Override with USAGE_CONFIG.
_SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
CONFIG_PATH = os.environ.get("USAGE_CONFIG", os.path.join(_SCRIPT_DIR, "usage-config.json"))
CCUSAGE = os.environ.get("CCUSAGE_CMD", "npx --yes ccusage@latest").split()

# ccusage encodes a project's absolute path into a directory name by replacing every
# non-alphanumeric character with a dash. Encoding the home dir the same way yields the
# prefix to strip, so project display names work for any user / OS (no hardcoded username).
def encode_path(p):
    return re.sub(r"[^A-Za-z0-9]", "-", p)

HOME_ENC = encode_path(os.path.expanduser("~"))

# ---------------------------------------------------------------- config / helpers
def load_config():
    """Return (renames, workspace_roots, legacy_groups).
    renames: bare-project-name -> display name. workspace_roots: dir names under ~ whose
    children display as bare project names (personal convention, not OS-derivable).
    legacy_groups: old full-encoded-path -> display keys, honored for back-compat."""
    try:
        with open(CONFIG_PATH) as fh:
            cfg = json.load(fh)
    except FileNotFoundError:
        return {}, ["Developer"], {}
    except (json.JSONDecodeError, OSError) as e:
        print(f"warning: could not read {CONFIG_PATH} ({e}); using defaults", file=sys.stderr)
        return {}, ["Developer"], {}
    return (cfg.get("renames", {}),
            cfg.get("workspace_roots", ["Developer"]),
            cfg.get("groups", {}))

RENAMES, WORKSPACE_ROOTS, LEGACY_GROUPS = load_config()

def clean_name(raw):
    if raw in LEGACY_GROUPS:                    # back-compat: explicit full-path key
        return LEGACY_GROUPS[raw]
    if raw == HOME_ENC:                         # the home dir itself
        bare = "~"
    elif raw.startswith(HOME_ENC + "-"):        # something under home
        rest = raw[len(HOME_ENC) + 1:]
        bare = None
        for root in WORKSPACE_ROOTS:
            if rest == root:                    # a workspace root with no project under it
                bare = "~/" + rest; break
            if rest.startswith(root + "-"):     # ~/Developer/<name> -> <name>
                bare = rest[len(root) + 1:]; break
        if bare is None:                        # other home subpath -> ~/<rest>
            bare = "~/" + rest
    else:                                       # outside home (rare)
        bare = raw
    return RENAMES.get(bare, bare)              # user rename, else the bare name

def model_family(name):
    n = (name or "").lower()
    for fam in ("fable", "opus", "sonnet", "haiku", "gpt"):
        if fam in n:
            return fam
    if "codex" in n:   # OpenAI Codex models not named gpt-* (defensive; today all contain 'gpt')
        return "gpt"
    return "other"

def norm_date(s):
    """Accept YYYYMMDD, YYYY-MM-DD, or relative -Nd. Return YYYYMMDD for ccusage."""
    if s is None:
        return None
    if s.startswith("-") and s.endswith("d"):
        core = s[1:-1]
        if not core.isdigit():
            sys.exit(f"bad relative date {s!r}: expected -Nd, e.g. -3d or -30d")
        d = datetime.date.today() - datetime.timedelta(days=int(core))
        return d.strftime("%Y%m%d")
    return s.replace("-", "")

def run_ccusage(args):
    cmd = CCUSAGE + args
    try:
        out = subprocess.run(cmd, capture_output=True, text=True)
    except OSError:
        # npx/node (or a custom CCUSAGE_CMD) not on PATH — exit cleanly instead of a raw traceback.
        sys.exit(f"'{cmd[0]}' not found. Install Node.js (node + npx), or set CCUSAGE_CMD to your "
                 f"ccusage command (e.g. CCUSAGE_CMD='ccusage'). See README Requirements.")
    if out.returncode != 0 and not out.stdout.strip():
        sys.exit(f"ccusage failed: {out.stderr.strip() or out.returncode}\ncmd: {' '.join(cmd)}")
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        sys.exit(f"could not parse ccusage output.\ncmd: {' '.join(cmd)}\nstderr: {out.stderr[:400]}")

def instances(since=None, until=None):
    """ccusage claude daily --instances -> {project: {date: {...}}}, calendar-accurate."""
    args = ["claude", "daily", "--instances", "--breakdown", "--json"]
    if since: args += ["--since", norm_date(since)]
    if until: args += ["--until", norm_date(until)]
    d = run_ccusage(args)
    return d

def money(x): return f"${x:,.2f}"
def fmt(n): return f"{n:,}"
def pct(part, whole): return (part / whole * 100) if whole else 0.0

def no_data(label):
    print(f"No usage found for {label}.")

def reconcile(project_sum, grand):
    """Assert the tool's per-project cost sum matches ccusage's own grand total.
    This proves the grouping conserves total cost; it does NOT prove the per-project
    or per-model split is correct (ccusage's total is itself that same sum).
    Uses a one-cent tolerance: the tool and ccusage sum the same values in different
    orders, so exact rounded-cent equality can spuriously differ by float noise. A real
    gap (dropped project / corrupted total) is dollars, not sub-cent."""
    diff = project_sum - grand
    ok = abs(diff) < 0.01
    return f"[totals reconcile: {'OK' if ok else f'MISMATCH {money(project_sum)} vs ccusage {money(grand)} (Δ ${diff:+.2f})'}]"

# ---------------------------------------------------------------- aggregation
def agg_projects(since=None, until=None):
    """Return {proj: {tokens, cost, by_model{tok}, by_cost{$}}}, plus grand total cost."""
    d = instances(since, until)
    agg = defaultdict(lambda: {"tokens": 0, "cost": 0.0,
                               "by_model": defaultdict(int),
                               "by_cost": defaultdict(float),
                               "first": "9999-99-99", "last": "0000-00-00"})
    for raw, days in d.get("projects", {}).items():
        proj = clean_name(raw)
        for day in days:
            a = agg[proj]
            a["tokens"] += day["totalTokens"]
            a["cost"] += day["totalCost"]
            a["first"] = min(a["first"], day["date"])
            a["last"] = max(a["last"], day["date"])
            for mb in day["modelBreakdowns"]:
                fam = model_family(mb["modelName"])
                tok = mb["inputTokens"] + mb["outputTokens"] + mb["cacheCreationTokens"] + mb["cacheReadTokens"]
                a["by_model"][fam] += tok
                a["by_cost"][fam] += mb["cost"]
    grand = d.get("totals", {}).get("totalCost", 0.0)
    return agg, grand

# ---------------------------------------------------------------- commands
PROJ_FAMS = ["fable", "opus", "sonnet", "haiku"]

def _projects_table(agg, tot, metric):
    """Render one per-project table. metric='tokens' -> per-model token columns + total & Fable
    cost (the original view). metric='cost' -> per-model cost columns. Data comes from the same
    agg (by_model tokens + by_cost dollars), so both are just two views of one aggregation."""
    fams = PROJ_FAMS
    if metric == "tokens":
        hdr = f"{'Project':22} {'Tokens':>15} " + " ".join(f"{f.title():>13}" for f in fams) + f" {'Cost':>11} {'Fable$':>10}"
    else:
        hdr = f"{'Project':22} {'Cost':>12} " + " ".join(f"{f.title()+'$':>12}" for f in fams)
    print(hdr); print("-" * len(hdr))
    csum = defaultdict(float)
    for p, v in sorted(agg.items(), key=lambda x: -x[1]["cost"]):
        bm, bc = v["by_model"], v["by_cost"]
        for f in fams:
            csum[f] += bc.get(f, 0)
        if metric == "tokens":
            row = f"{p:22} {fmt(v['tokens']):>15} " + " ".join(f"{fmt(bm.get(f,0)):>13}" for f in fams)
            print(row + f" {money(v['cost']):>11} {money(bc.get('fable',0)):>10}")
        else:
            print(f"{p:22} {money(v['cost']):>12} " + " ".join(f"{money(bc.get(f,0)):>12}" for f in fams))
    print("-" * len(hdr))
    if metric == "tokens":
        print(f"{'TOTAL':22} {'':>15} " + " ".join(f"{'':>13}" for f in fams) + f" {money(tot):>11} {money(csum['fable']):>10}")
    else:
        print(f"{'TOTAL':22} {money(tot):>12} " + " ".join(f"{money(csum[f]):>12}" for f in fams))

def cmd_projects(a):
    agg, grand = agg_projects(a.since, a.until)
    if not agg:
        return no_data(window_label(a.since, a.until))
    tot = sum(v["cost"] for v in agg.values())
    metric = getattr(a, "metric", "tokens")
    print(f"Per-project usage {window_label(a.since, a.until)}   {reconcile(tot, grand)}\n")
    if metric in ("tokens", "both"):
        _projects_table(agg, tot, "tokens")
    if metric == "both":
        print()
    if metric in ("cost", "both"):
        _projects_table(agg, tot, "cost")
    # gpt/other spend is absent from the Claude-only model columns; surface it once, not per-table.
    shown = sum(v["by_cost"].get(f, 0) for v in agg.values() for f in PROJ_FAMS)
    hidden = tot - shown
    if hidden > 0.005 * tot and hidden > 0.01:
        print(f"\nnote: {money(hidden)} ({pct(hidden, tot):.0f}%) is gpt/other spend not shown in the model columns above.")

DAILY_FAMS = ["fable", "opus", "sonnet", "haiku", "gpt"]

def _daily_table(rows, metric):
    """Render one per-day table. metric='cost' -> per-model cost columns + daily total cost (the
    original view). metric='tokens' -> per-model token columns + daily total tokens. Both read the
    same modelBreakdowns, so no extra ccusage call is needed to show either."""
    fams = DAILY_FAMS
    if metric == "cost":
        hdr = f"{'Date':12} {'Cost':>11} {'Tokens':>15} | " + " ".join(f"{f.title()+'$':>9}" for f in fams)
    else:
        hdr = f"{'Date':12} {'Tokens':>15} | " + " ".join(f"{f.title():>15}" for f in fams)
    print(hdr); print("-" * len(hdr))
    csum = defaultdict(float); tsum = defaultdict(int)
    tot_cost = 0.0; tot_tok = 0
    for r in rows:
        fc = defaultdict(float); ft = defaultdict(int)
        for mb in r["modelBreakdowns"]:
            fam = model_family(mb["modelName"])
            fc[fam] += mb["cost"]; csum[fam] += mb["cost"]
            tk = mb["inputTokens"] + mb["outputTokens"] + mb["cacheCreationTokens"] + mb["cacheReadTokens"]
            ft[fam] += tk; tsum[fam] += tk
        tot_cost += r["totalCost"]; tot_tok += r["totalTokens"]
        if metric == "cost":
            print(f"{r['period']:12} {money(r['totalCost']):>11} {fmt(r['totalTokens']):>15} | " +
                  " ".join(f"{fc[f]:>9,.2f}" for f in fams))
        else:
            print(f"{r['period']:12} {fmt(r['totalTokens']):>15} | " +
                  " ".join(f"{fmt(ft[f]):>15}" for f in fams))
    print("-" * len(hdr))
    if metric == "cost":
        print(f"{'TOTAL':12} {money(tot_cost):>11} {'':>15} | " + " ".join(f"{csum[f]:>9,.2f}" for f in fams))
    else:
        print(f"{'TOTAL':12} {fmt(tot_tok):>15} | " + " ".join(f"{fmt(tsum[f]):>15}" for f in fams))

def cmd_daily(a):
    """Per-day totals incl. Codex, split by family. Uses generic `daily` (all agents)."""
    args = ["daily", "--breakdown", "--json"]
    if a.since: args += ["--since", norm_date(a.since)]
    if a.until: args += ["--until", norm_date(a.until)]
    d = run_ccusage(args)
    rows = d.get("daily", [])
    if not rows:
        return no_data(window_label(a.since, a.until))
    metric = getattr(a, "metric", "cost")
    tot = sum(r["totalCost"] for r in rows)
    print(f"Per-day {window_label(a.since, a.until)}   {reconcile(tot, d.get('totals', {}).get('totalCost', 0.0))}\n")
    if metric in ("tokens", "both"):
        _daily_table(rows, "tokens")
    if metric == "both":
        print()
    if metric in ("cost", "both"):
        _daily_table(rows, "cost")

def cmd_share(a):
    agg1, grand1 = agg_projects(a.since, a.until)
    tot1 = sum(v["cost"] for v in agg1.values())
    twowin = a.vs is not None
    if twowin:
        agg2, grand2 = agg_projects(a.vs, None)
        tot2 = sum(v["cost"] for v in agg2.values())
    if not agg1 and not (twowin and agg2):
        return no_data(window_label(a.since, a.until))
    projs = set(agg1) | (set(agg2) if twowin else set())
    order = sorted(projs, key=lambda p: -(agg2[p]["cost"] if twowin and p in agg2 else agg1.get(p, {"cost": 0})["cost"]))
    line = f"Project share  A={window_label(a.since, a.until)}"
    if twowin:
        line += f"   B=(since {a.vs})"
    line += f"   A:{reconcile(tot1, grand1)}"
    if twowin:
        line += f"   B:{reconcile(tot2, grand2)}"
    print(line + "\n")
    if twowin:
        hdr = f"{'Project':22} {'A $':>11} {'A %':>7} | {'B $':>11} {'B %':>7}"
    else:
        hdr = f"{'Project':22} {'Cost':>11} {'Share':>7}"
    print(hdr); print("-" * len(hdr))
    for p in order:
        c1 = agg1.get(p, {"cost": 0})["cost"]
        if twowin:
            c2 = agg2.get(p, {"cost": 0})["cost"]
            print(f"{p:22} {money(c1):>11} {pct(c1,tot1):>6.1f}% | {money(c2):>11} {pct(c2,tot2):>6.1f}%")
        else:
            print(f"{p:22} {money(c1):>11} {pct(c1,tot1):>6.1f}%")
    print("-" * len(hdr))
    if twowin:
        print(f"{'TOTAL':22} {money(tot1):>11} {'100.0%':>7} | {money(tot2):>11} {'100.0%':>7}")
    else:
        print(f"{'TOTAL':22} {money(tot1):>11} {'100.0%':>7}")

def cmd_compare(a):
    d1, d2 = norm_date(a.day1), norm_date(a.day2)
    iso1 = f"{d1[:4]}-{d1[4:6]}-{d1[6:]}"; iso2 = f"{d2[:4]}-{d2[4:6]}-{d2[6:]}"
    d = instances(min(d1, d2), max(d1, d2))
    by = defaultdict(lambda: {iso1: 0.0, iso2: 0.0, "f1": 0.0, "f2": 0.0, "o1": 0.0, "o2": 0.0})
    for raw, days in d.get("projects", {}).items():
        p = clean_name(raw)
        for day in days:
            if day["date"] not in (iso1, iso2):
                continue
            k = "1" if day["date"] == iso1 else "2"
            by[p][day["date"]] += day["totalCost"]
            for mb in day["modelBreakdowns"]:
                fam = model_family(mb["modelName"])
                if fam == "fable": by[p]["f" + k] += mb["cost"]
                elif fam == "opus": by[p]["o" + k] += mb["cost"]
    if not by:
        return no_data(f"{iso1} / {iso2}")
    t1 = sum(v[iso1] for v in by.values()); t2 = sum(v[iso2] for v in by.values())
    print(f"Compare {iso1} vs {iso2}\n")
    hdr = f"{'Project':22} {iso1:>11} {iso2:>11} {'ΔCost':>10} | {'Fab$ '+iso2[5:]:>9} {'Opus$ '+iso2[5:]:>10}"
    print(hdr); print("-" * len(hdr))
    for p, v in sorted(by.items(), key=lambda x: -x[1][iso2]):
        print(f"{p:22} {money(v[iso1]):>11} {money(v[iso2]):>11} {v[iso2]-v[iso1]:>+10,.2f} | {v['f2']:>9,.2f} {v['o2']:>10,.2f}")
    print("-" * len(hdr))
    print(f"{'TOTAL':22} {money(t1):>11} {money(t2):>11} {t2-t1:>+10,.2f}")

def cmd_blocks(a):
    args = ["blocks", "--json"]
    if a.since: args += ["--since", norm_date(a.since)]
    d = run_ccusage(args)
    blocks = d.get("blocks", d)
    print("Billing blocks (5h windows) — times shown in local tz\n")
    hdr = f"{'Start (local)':20} {'End (local)':20} {'Dur':>6} {'Cost':>10} {'$/hr':>9} {'active':>7}"
    print(hdr); print("-" * len(hdr))
    printed = 0
    for b in blocks:
        if not isinstance(b, dict) or b.get("isGap"):
            continue
        start = b.get("startTime"); end = b.get("actualEndTime") or b.get("endTime")
        cost = b.get("costUSD", b.get("totalCost", 0))
        ls = to_local(start); le = to_local(end)
        hrs = ((iso(end) - iso(start)).total_seconds() / 3600) if start and end else 0
        rate = cost / hrs if hrs else 0
        print(f"{ls:20} {le:20} {hrs:>5.1f}h {money(cost):>10} {rate:>8,.0f} {str(b.get('isActive','')):>7}")
        printed += 1
    if not printed:
        print("(no billing blocks in this window)")

def cmd_hourly(a):
    date = a.date or datetime.date.today().strftime("%Y-%m-%d")
    if len(date) == 8:
        date = f"{date[:4]}-{date[4:6]}-{date[6:]}"
    # derive effective $/token per family for that date from ccusage
    d = instances(date.replace("-", ""), date.replace("-", ""))
    fam_cost = defaultdict(float); fam_tok = defaultdict(int)
    for raw, days in d.get("projects", {}).items():
        for day in days:
            if day["date"] != date: continue
            for mb in day["modelBreakdowns"]:
                fam = model_family(mb["modelName"])
                fam_cost[fam] += mb["cost"]
                fam_tok[fam] += mb["inputTokens"]+mb["outputTokens"]+mb["cacheCreationTokens"]+mb["cacheReadTokens"]
    rate = {f: fam_cost[f]/fam_tok[f] for f in fam_cost if fam_tok[f]}
    # scan raw logs, bucket by half hour local. dedupe by (requestId, message.id) like ccusage
    # does, so a usage record repeated across resumed sessions isn't double-counted.
    buckets = defaultdict(lambda: defaultdict(int))
    seen = set()
    target = datetime.date.fromisoformat(date)
    for path in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
        if datetime.date.fromtimestamp(os.path.getmtime(path)) < target:
            continue
        with open(path) as fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try: e = json.loads(line)
                except: continue
                ts = e.get("timestamp"); msg = e.get("message") or {}; u = msg.get("usage")
                if not ts or not u: continue
                key = (e.get("requestId"), msg.get("id"))
                if key != (None, None):
                    if key in seen: continue
                    seen.add(key)
                dt = iso(ts).astimezone()
                if dt.strftime("%Y-%m-%d") != date: continue
                fam = model_family(msg.get("model"))
                tok = u.get("input_tokens",0)+u.get("output_tokens",0)+u.get("cache_creation_input_tokens",0)+u.get("cache_read_input_tokens",0)
                b = dt.strftime("%H:") + ("00" if dt.minute < 30 else "30")
                buckets[b][fam] += tok
    print(f"Half-hour cost histogram for {date} (est. from raw logs; ±10-15%)")
    if not buckets:
        ccu = sum(fam_cost.values())
        print(f"No raw session logs found on disk for {date}" +
              (f" (ccusage reports {money(ccu)} that day — logs may have been rotated)." if ccu else "."))
        return
    print(f"effective $/Mtok: " + "  ".join(f"{f}={r*1e6:.2f}" for f, r in sorted(rate.items())) + "\n")
    hdr = f"{'Local':>7} {'est $':>8}  {'fable tok':>13} {'opus tok':>13}  burst"
    print(hdr); print("-" * len(hdr))
    tot = 0
    for b in sorted(buckets):
        c = sum(buckets[b][f] * rate.get(f, 0) for f in buckets[b])
        tot += c
        print(f"{b:>7} {c:>8,.2f}  {fmt(buckets[b].get('fable',0)):>13} {fmt(buckets[b].get('opus',0)):>13}  " + "#" * int(c/10))
    print("-" * len(hdr))
    print(f"est total {money(tot)}  (ccusage says {money(sum(fam_cost.values()))} for {date})")

def cmd_alltime(a):
    agg, grand = agg_projects(None, None)
    if not agg:
        return no_data("all time")
    tot = sum(v["cost"] for v in agg.values())
    print(f"All-time per-project cost   range {min(v['first'] for v in agg.values())} -> {max(v['last'] for v in agg.values())}")
    print(f"{reconcile(tot, grand)}   (Claude Code only — Codex/GPT excluded; use 'usage daily' for those)\n")
    hdr = f"{'Project':22} {'First':>11} {'Last':>11} {'Cost':>12} {'Share':>7}"
    print(hdr); print("-" * len(hdr))
    for p, v in sorted(agg.items(), key=lambda x: -x[1]["cost"]):
        print(f"{p:22} {v['first']:>11} {v['last']:>11} {money(v['cost']):>12} {pct(v['cost'],tot):>6.1f}%")
    print("-" * len(hdr))
    print(f"{'TOTAL':22} {'':>11} {'':>11} {money(tot):>12} {'100.0%':>7}")

# ---------------------------------------------------------------- small utils
def iso(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))

def to_local(ts):
    if not ts: return ""
    return iso(ts).astimezone().strftime("%Y-%m-%d %H:%M")

def window_label(since, until):
    def show(s):
        if s and s.startswith("-") and s.endswith("d"):
            return f"{s} (={norm_date(s)})"
        return s
    if not since and not until:
        return "(all time)"
    if since and not until:
        return f"(since {show(since)})"
    return f"({show(since) or 'start'} -> {show(until)})"

# ---------------------------------------------------------------- argparse
def main():
    p = argparse.ArgumentParser(prog="usage", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("projects", help="per-project × model table (tokens/cost/both)")
    sp.add_argument("--since"); sp.add_argument("--until")
    sp.add_argument("--metric", choices=["tokens", "cost", "both"], default="tokens",
                    help="per-model columns: tokens (default), cost, or both")
    sp.set_defaults(func=cmd_projects)

    sp = sub.add_parser("daily", help="per-day by model family, incl. Codex (cost/tokens/both)")
    sp.add_argument("--since"); sp.add_argument("--until")
    sp.add_argument("--metric", choices=["cost", "tokens", "both"], default="cost",
                    help="per-model columns: cost (default), tokens, or both")
    sp.set_defaults(func=cmd_daily)

    sp = sub.add_parser("share", help="%% of spend per project; --vs for a 2nd window")
    sp.add_argument("--since"); sp.add_argument("--until"); sp.add_argument("--vs")
    sp.set_defaults(func=cmd_share)

    sp = sub.add_parser("compare", help="two calendar days side by side")
    sp.add_argument("--day1", required=True); sp.add_argument("--day2", required=True)
    sp.set_defaults(func=cmd_compare)

    sp = sub.add_parser("blocks", help="billing blocks + $/hour burn rate")
    sp.add_argument("--since"); sp.set_defaults(func=cmd_blocks)

    sp = sub.add_parser("hourly", help="half-hour cost histogram (burst finder)")
    sp.add_argument("--date"); sp.set_defaults(func=cmd_hourly)

    sp = sub.add_parser("alltime", help="every project's cost to date")
    sp.set_defaults(func=cmd_alltime)

    a = p.parse_args(rewrite_argv(sys.argv[1:]))
    a.func(a)

DATE_OPTS = {"--since", "--until", "--vs", "--date", "--day1", "--day2"}

def rewrite_argv(argv):
    """Let a relative date follow its option as a separate token: `--since -3d` becomes
    `--since=-3d` so argparse doesn't mistake the leading '-' for a flag."""
    out = []
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok in DATE_OPTS and i + 1 < len(argv) and re.fullmatch(r"-\d+d", argv[i + 1]):
            out.append(f"{tok}={argv[i + 1]}"); i += 2
        else:
            out.append(tok); i += 1
    return out

if __name__ == "__main__":
    main()
