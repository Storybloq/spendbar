#!/usr/bin/env python3
"""TEST-ONLY entrypoint for usage.py with an injected `today`.

The parity harness runs the Python oracle and the TypeScript port sequentially, so the two
can straddle local midnight and disagree for reasons that have nothing to do with the port.
Both sides therefore run under a wrapper that pins the wall clock to one shared anchor.

This wrapper does NOT modify usage.py. It loads it as a module and replaces the single
dependency the CLI has on the clock — `datetime.date.today()`, called at usage.py:107
(relative `--since -Nd`) and usage.py:600 (default `hourly --date`) — with a frozen date.
Everything else in `datetime` still resolves to the real module, so `date.fromisoformat`,
`date.fromtimestamp` and `datetime.fromisoformat` behave normally.

`--anchor` is required on purpose. An optional anchor is exactly the escape hatch that lets
injection quietly stop being load-bearing: a wrapper that ignores the anchor agrees with an
unfrozen run every day except the one where it matters.

Usage: usage-wrapper.py --anchor YYYY-MM-DD -- <argv for usage>
"""
import datetime
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
USAGE_PY = os.path.join(os.path.dirname(HERE), "..", "usage.py")


class _FrozenDate(datetime.date):
    """`datetime.date` with `today()` pinned. Subclassing keeps every other classmethod
    (fromisoformat, fromtimestamp) and all isinstance checks intact."""

    _anchor = None

    @classmethod
    def today(cls):
        a = cls._anchor
        return datetime.date(a.year, a.month, a.day)


class _DatetimeShim:
    """The real `datetime` module with `date` swapped out.

    Bound to the module under test as `usage.datetime`, so the patch is scoped to that one
    module rather than mutating the global `datetime` for the whole interpreter."""

    def __init__(self, date_cls):
        self.date = date_cls

    def __getattr__(self, name):
        return getattr(datetime, name)


def parse_wrapper_args(argv):
    if len(argv) < 3 or argv[0] != "--anchor":
        raise SystemExit(f"usage-wrapper: expected `--anchor YYYY-MM-DD -- <argv>`, got {argv!r}")
    anchor = datetime.date.fromisoformat(argv[1])
    if argv[2] != "--":
        raise SystemExit(f"usage-wrapper: expected `--` after the anchor, got {argv[2]!r}")
    return anchor, argv[3:]


def main():
    anchor, target_argv = parse_wrapper_args(sys.argv[1:])

    spec = importlib.util.spec_from_file_location("usage_under_test", USAGE_PY)
    usage = importlib.util.module_from_spec(spec)
    # usage.py reads USAGE_CONFIG / CCUSAGE_CMD / CODEX_HOME / $HOME at import time, so the
    # environment the harness constructed is already in effect by the time this executes.
    spec.loader.exec_module(usage)

    _FrozenDate._anchor = anchor
    usage.datetime = _DatetimeShim(_FrozenDate)

    sys.argv = ["usage", *target_argv]
    usage.main()


if __name__ == "__main__":
    main()
