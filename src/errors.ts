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
