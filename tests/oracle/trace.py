#!/usr/bin/env python3
"""A recording stand-in for `fake_ccusage.py`: logs the invocation, then becomes it.

usage.py splits `CCUSAGE_CMD` on whitespace and spawns it, so pointing that at
`python3 tests/oracle/trace.py` puts this file exactly where the fixture normally sits. It
appends one JSON line per child call to `$SPENDBAR_TRACE_OUT` and then `execv`s the real
fixture.

`execv` rather than `subprocess.run`: the recorder must be invisible. Re-emitting captured
bytes would risk changing them (encoding, newline translation, a truncated stream on a large
payload) and would have to reconstruct the exit status by hand — and this file exists to
observe the boundary, not to participate in it. After `execv` there is no Python left to get
that wrong.

The append is a single `write` of one line opened O_APPEND, which POSIX keeps atomic for
writes under PIPE_BUF, so concurrent children interleave lines rather than corrupting them.

This is instrumentation, and instrumentation is NOT the source of truth for what usage.py
calls: it only ever sees the invocations that the run it observed happened to make. The
authored declaration in `inventory.json` is the source of truth; this is what gets compared
against it (see `check_traces` in build.py).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE = os.path.join(os.path.dirname(HERE), "fake_ccusage.py")


def main():
    out = os.environ.get("SPENDBAR_TRACE_OUT")
    if not out:
        sys.stderr.write(
            "trace.py: SPENDBAR_TRACE_OUT is unset. This shim only makes sense under the\n"
            "recorder; if you meant to run the fixture, run fake_ccusage.py directly.\n")
        return 2

    record = {
        # FAKE_MODE's default lives in fake_ccusage.py; mirroring it here would be a second
        # description of the same default. "normal" is that default, and the pair is asserted
        # by the vocabulary check rather than trusted.
        "mode": os.environ.get("FAKE_MODE", "normal"),
        "argv": sys.argv[1:],
    }
    with open(out, "a") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")

    os.execv(sys.executable, [sys.executable, FAKE, *sys.argv[1:]])


if __name__ == "__main__":
    sys.exit(main())
