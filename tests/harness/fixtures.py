#!/usr/bin/env python3
"""Synthetic filesystem fixtures shared by the golden capture and the parity harness.

Both `tests/golden/capture.py` and `tests-ts/parity.mjs` need the *same* synthetic
CODEX_HOME and the *same* synthetic HOME. Defining them twice is how the two sides drift,
so they are defined once here: capture.py imports this module, and the Node harness shells
out to `python3 tests/harness/fixtures.py --build`, which prints the paths as JSON.

The caller owns cleanup — `--build` deliberately does not register an atexit hook, because
the Node harness needs the directories to outlive this process.

Run: python3 tests/harness/fixtures.py --build    # prints {"codexHome":..., ...} and exits
"""
import calendar, time
import importlib.util, json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
FAKE = os.path.join(TESTS, "fake_ccusage.py")


def _load_fake():
    """The fake ccusage module, loaded by path so its CODEX_SESSIONS table is the one and
    only description of the fixture corpus."""
    spec = importlib.util.spec_from_file_location("fake_ccusage_fixture", FAKE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _expand_home(path, fixture_home):
    """`os.path.expanduser` against an explicit home rather than the ambient one."""
    if path == "~":
        return fixture_home
    if path.startswith("~/"):
        return os.path.join(fixture_home, path[2:])
    return path


def build_codex_home(fixture_home):
    """A synthetic CODEX_HOME built from fake_ccusage.CODEX_SESSIONS.

    Returns (codex_home, outside). `outside` holds the symlink target that lives beyond
    CODEX_HOME, which usage.py's realpath containment check is supposed to reject; it is
    returned separately so the caller can delete it.

    `fixture_home` is required, not defaulted to the ambient HOME: the session `_cwd`
    values are written with `~` already expanded, and usage.py maps those paths back to
    project keys through HOME_ENC, computed from the HOME *the child runs under*. Expanding
    against a different HOME than the child sees silently changes three codex goldens.
    """
    fake = _load_fake()
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
                cwd = _expand_home(s["_cwd"], fixture_home)
                fh.write(json.dumps({"type": "session_meta", "payload": {"cwd": cwd}}) + "\n")
                fh.write(json.dumps({"type": "event_msg", "payload": {}}) + "\n")
    return codex_home, outside


def build_fixture_home():
    """A synthetic $HOME: empty, but with the two directories usage.py reaches into.

    `~/.claude/projects` is what cmd_hourly globs (usage.py:619) and `~/.codex` is the
    default CODEX_HOME (usage.py:197). Creating them empty means the harness measures a
    known-empty corpus instead of whatever transcripts happen to be on the machine.
    `.claude/projects` then gets the synthetic hourly corpus (see build_hourly_corpus).
    """
    home = tempfile.mkdtemp(prefix="parity-home-")
    os.makedirs(os.path.join(home, ".claude", "projects"))
    os.makedirs(os.path.join(home, ".codex"))
    build_hourly_corpus(home)
    return home


def _rec(ts, model, tokens, req="ABSENT", mid="ABSENT", usage=None):
    """One transcript line. `tokens` is split across the four usage fields."""
    q = tokens // 4
    e = {"timestamp": ts, "message": {"model": model,
         "usage": {"input_tokens": q, "output_tokens": q,
                   "cache_creation_input_tokens": q, "cache_read_input_tokens": tokens - 3 * q}
         if usage is None else usage}}
    if req != "ABSENT":
        e["requestId"] = req
    if mid != "ABSENT":
        e["message"]["id"] = mid
    return json.dumps(e)


def _write(path, lines):
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")


def build_hourly_corpus(home):
    """Synthetic ~/.claude/projects transcripts for `hourly` on 2026-01-01 local.

    ENTIRELY FABRICATED. Real transcripts carry prompts, source code, tool arguments,
    environment data and account identifiers, none of which may enter this repo or the
    published tarball, so nothing here is copied from a real session.

    Timestamps are written as UTC so the fixture states the instant rather than an offset;
    under the pinned TZ=America/Vancouver (UTC-8 in January) a timezone regression shows up
    as records landing in the wrong bucket instead of silently agreeing.

    Every line DISCRIMINATES a specific behaviour — remove any one and a real bug stops
    being detectable:

      * a duplicate (requestId, message.id) whose token count differs wildly, so a broken
        dedupe changes the numbers instead of merely repeating a value;
      * two records with `"requestId": null` and NO message.id, which Python's `.get()`
        renders as the pair (None, None) and therefore does NOT dedupe — coalescing only
        `undefined` would collapse them into one and undercount;
      * `"usage": {}`, which is FALSY in Python and so is skipped like a missing one;
      * a truncated JSON line that still contains `"usage"`, taking the bare `except` —
        without it the run dies instead of continuing;

    One line is present for coverage rather than discrimination, and is labelled as such
    instead of being described as a test: the record with no `"usage"` substring exercises
    usage.py's pre-parse fast path, but removing that fast path changes no output, because
    the line is then parsed and dropped by the `not u` check one step later.

    The remaining discriminating lines:
      * a record on the adjacent day, excluded by the date match;
      * a record in a second project directory, proving the glob spans directories;
      * a whole FILE whose mtime predates the target day, skipped before it is ever opened
        — its record would otherwise land in a bucket, so the filter is observable.
    """
    root = os.path.join(home, ".claude", "projects")
    proj_a = os.path.join(root, "-Users-fixture-Developer-alpha")
    proj_b = os.path.join(root, "-Users-fixture-Developer-beta")
    os.makedirs(proj_a)
    os.makedirs(proj_b)

    F, O = "claude-fable-5", "claude-opus-4-8"
    _write(os.path.join(proj_a, "session-a.jsonl"), [
        # 17:15Z = 09:15 local -> bucket "09:00"
        _rec("2026-01-01T17:15:00.000Z", F, 12, req="req-1", mid="msg-1"),
        # same key, absurd count: only a WORKING dedupe keeps this out of the total
        _rec("2026-01-01T17:16:00.000Z", F, 9999, req="req-1", mid="msg-1"),
        # 17:20Z = 09:20 local -> same bucket, different family
        _rec("2026-01-01T17:20:00.000Z", O, 40, req="req-2", mid="msg-2"),
        # 17:45Z/17:46Z = 09:45/09:46 local -> bucket "09:30". Both must count.
        _rec("2026-01-01T17:45:00.000Z", F, 3, req=None),
        _rec("2026-01-01T17:46:00.000Z", F, 3, req=None),
        # 19:10Z = 11:10 local: deliberately the ONLY record in that half hour, so treating
        # `{}` as truthy adds a visible all-zero 11:00 row rather than changing nothing.
        _rec("2026-01-01T19:10:00.000Z", F, 0, req="req-empty", mid="msg-empty", usage={}),
        json.dumps({"type": "summary", "text": "no token record on this line"}),
        '{"timestamp": "2026-01-01T17:55:00.000Z", "message": {"usage": ',
        _rec("2026-01-02T17:15:00.000Z", F, 500, req="req-nextday", mid="msg-nextday"),
    ])

    # 22:05Z = 14:05 local -> bucket "14:00", and in a SECOND project directory
    _write(os.path.join(proj_b, "session-b.jsonl"), [
        _rec("2026-01-01T22:05:00.000Z", O, 100, req="req-3", mid="msg-3"),
        # The SAME (requestId, message.id) as session-a's first record, in a DIFFERENT file.
        # Dedupe has to be global — that is the actual requirement, since the duplicate this
        # guards against comes from resuming a session into a new transcript. A per-file
        # `seen` set would pass on the intra-file duplicate alone (code review R1) but
        # double-counts this one into bucket 09:00. Identical token count to session-a's, so
        # either directory order yields the same oracle output.
        _rec("2026-01-01T17:15:00.000Z", F, 12, req="req-1", mid="msg-1"),
    ])

    # Stale file: mtime a day before the target, so usage.py skips it unopened.
    stale = os.path.join(proj_b, "session-stale.jsonl")
    _write(stale, [_rec("2026-01-01T22:30:00.000Z", O, 777, req="req-stale", mid="msg-stale")])
    old = calendar.timegm(time.strptime("2025-12-31T12:00:00", "%Y-%m-%dT%H:%M:%S"))
    os.utime(stale, (old, old))


def main():
    if "--build" not in sys.argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    home = build_fixture_home()
    codex_home, outside = build_codex_home(home)
    json.dump({"codexHome": codex_home, "codexOutside": outside, "home": home},
              sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
