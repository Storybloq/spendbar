/**
 * Core error type. The core is pure: it never calls `process.exit` or `console.*`.
 * Every `sys.exit(msg)` site in usage.py becomes `throw new UsageError(msg)`; the CLI
 * boundary catches it, writes `message` to stderr and exits with `code`.
 *
 * Message text is byte-frozen against the Python original (tests/golden/ALLOWLIST.md) —
 * do not reword these strings.
 */
export class UsageError extends Error {
  readonly code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.name = "UsageError";
    this.code = code;
  }
}

/**
 * CPython's `ValueError`, for the one place usage.py lets one escape uncaught:
 * `cmd_hourly`'s `datetime.date.fromisoformat(a.date)` (ALLOWLIST 19).
 *
 * Extending UsageError keeps `main`'s existing handler in charge, so the OBSERVABLE
 * contract the parity harness checks is preserved exactly — exit 1, empty stdout, non-empty
 * stderr. Only the stderr TEXT differs from the oracle's traceback, which is the sanctioned
 * delta; a traceback is not a useful thing to show a user for a mistyped date.
 */
export class ValueError extends UsageError {
  constructor(message: string) {
    super(`invalid --date: ${message}`, 1);
    this.name = "ValueError";
  }
}
