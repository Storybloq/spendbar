/**
 * The concrete `CcusageRunner` — the one place a child process is actually spawned.
 *
 * `shell: false` always: a `CCUSAGE_CMD` string is split into executable + argv by
 * `splitCommand` and handed to `spawnSync` as an array, so it is never interpreted by a
 * shell. (`splitCommand` deliberately mirrors Python's `str.split()` so the frozen `cmd:`
 * line in diagnostics stays byte-identical.)
 *
 * Error classification is exhaustive on purpose. `runCcusage` treats ANY `spawnError` as the
 * frozen "'X' not found. Install Node.js…" message, so mapping every failure there would
 * make the tool lie: an EACCES on a non-executable file would be reported as a missing
 * install. Only ENOENT is genuinely "not found"; everything else gets its own message.
 */
import { spawnSync } from "node:child_process";
import { UsageError } from "./errors.js";
import { pyStrip } from "./pystr.js";
import type { CcusageRunner, RunResult } from "./context.js";

/**
 * Capture cap for the child's output.
 *
 * Measured against the pinned binary on a moderately-used machine: `codex session` all-time
 * is 4.25 MB (the others are 304 KB / 178 KB / 127 KB). 64 MiB is ~15x that worst case, so
 * heavier users are not cut off. A 1 MB or 4 MB cap would reject legitimate output.
 *
 * NOTE: `spawnSync` exposes ONE `maxBuffer`, applied to each captured stream — there is no
 * per-stream setting (verified: a 200 KB write to either stream under a 100 KB cap yields
 * ENOBUFS). So stderr may transiently buffer up to this same limit; it is bounded for
 * DIAGNOSTICS separately, below.
 */
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/**
 * Diagnostic-only bound. `runCcusage`'s `ccusage failed:` path embeds stderr in the message,
 * so without this a multi-megabyte stderr would become a multi-megabyte error. This caps the
 * MESSAGE, not the process — a different mechanism from MAX_CAPTURE_BYTES with a different
 * consequence (ALLOWLIST entry 8).
 */
export const MAX_STDERR_DIAGNOSTIC_BYTES = 1024 * 1024;

/** All-time codex scans take tens of seconds; leave generous headroom. */
export const TIMEOUT_MS = 120_000;

const TRUNCATION_MARKER = "\n[… truncated]";

/** Shared empty capture, for a stream `spawnSync` reported as null. */
const EMPTY = Buffer.alloc(0);

/**
 * Truncate to a BYTE budget without splitting a character.
 *
 * `String.prototype.slice` counts UTF-16 code units, so it can both overshoot a byte budget
 * and cut a multibyte sequence or surrogate pair in half. The marker is accounted for inside
 * the limit so the result never exceeds it, and truncation is always visible rather than a
 * silent tail drop.
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  // When the budget cannot even hold the marker, emitting it whole would return MORE bytes
  // than requested — the one thing this function promises not to do. Degrade to the longest
  // character-safe prefix of the marker that fits (code review R1).
  if (maxBytes < markerBytes) return cutOnBoundary(Buffer.from(TRUNCATION_MARKER, "utf8"), maxBytes);

  const budget = maxBytes - markerBytes;
  return cutOnBoundary(buf, budget) + TRUNCATION_MARKER;
}

/**
 * Longest prefix of `buf` that is at most `maxBytes` and ends on a character boundary.
 * Decoding a prefix that ends mid-character yields U+FFFD, so walk back off any
 * continuation byte (0b10xxxxxx) before decoding.
 */
function cutOnBoundary(buf: Buffer, maxBytes: number): string {
  let end = Math.max(0, Math.min(maxBytes, buf.length));
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Strict UTF-8, matching `STRICT_UTF8` in codex.ts:214 — same options, same reason.
 *
 * `ignoreBOM: true` means "do not STRIP the BOM", so a leading U+FEFF survives into the text
 * exactly as it does in Python's text mode (ALLOWLIST entry 12).
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Decode a captured stream, REFUSING malformed UTF-8 rather than papering over it.
 *
 * `spawnSync`'s `encoding: "utf8"` — what this used to pass — substitutes U+FFFD for every
 * invalid byte. That is the precise leniency ALLOWLIST entry 12 already rejects for rollout
 * files ("`Buffer.toString("utf8")` would substitute U+FFFD and hand back a
 * corrupted-but-trusted cwd"), and it is worse here: replacement can turn malformed stdout
 * into *parseable* JSON, so the port would consume altered numbers and print a clean table
 * where Python exits nonzero. usage.py:114 uses `subprocess.run(..., text=True)`, whose
 * decoding is `errors='strict'`, so malformed output raises UnicodeDecodeError there —
 * uncaught by `run_ccusage`'s `except OSError`, hence a traceback and exit 1.
 *
 * The port exits 1 too, with a clean one-line message instead of a traceback — the
 * allowance already granted by the uncaught-Python-crash scope (code review R7).
 */
/**
 * CPython's UNIVERSAL NEWLINES, which `text=True` applies and a bare decode does not.
 *
 * `subprocess.run(..., text=True)` wraps each pipe in a `TextIOWrapper` with `newline=None`,
 * so `\r\n` and a lone `\r` both become `\n` in the captured string. Neither
 * `encoding: "utf8"` nor a `TextDecoder` does this, so the port carried the raw bytes
 * through into `ccusage failed: {stderr}` — a message that comes from usage.py and is
 * therefore byte-frozen (code review R8; measured: a child writing `E1\r\nE2\rE3` yields
 * `'E1\nE2\nE3'` in Python and `"E1\r\nE2\rE3"` here).
 *
 * Safe on stdout too: a raw CR cannot appear inside a JSON string literal, so translation
 * can only touch whitespace between tokens.
 */
function universalNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

function decodeStream(buf: Buffer, stream: string, cmd: () => string): string {
  // A fatal `TextDecoder` throws TypeError for malformed bytes AND for a non-BufferSource
  // argument, so without this an injected string fake would be reported as "the child
  // produced invalid UTF-8" — a diagnostic about the subprocess that is really about our own
  // wiring. Fail as what it is instead.
  if (!Buffer.isBuffer(buf)) {
    throw new Error(`internal: ${stream} was not captured as bytes (got ${typeof buf})`);
  }
  try {
    return universalNewlines(STRICT_UTF8.decode(buf));
  } catch {
    throw new UsageError(
      `ccusage produced ${stream} that is not valid UTF-8.\ncmd: ${cmd()}`,
    );
  }
}

/** The slice of `spawnSync`'s result this module reads. Injectable so error classification
 *  is testable on every platform — the real EACCES path needs POSIX permission bits, which
 *  Windows (an advertised supported platform) does not have (code review R1).
 *
 *  Streams are BUFFERS, not strings: decoding is this module's job (see `decodeStream`), and
 *  typing them as strings would push it back into `spawnSync`'s lenient path. */
export interface SpawnResultLike {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer | null;
  stderr: Buffer | null;
  error?: Error;
}

export type SpawnImpl = (
  exe: string,
  args: string[],
  opts: { maxBuffer: number; timeout: number },
) => SpawnResultLike;

export interface RunnerOptions {
  maxCaptureBytes?: number;
  timeoutMs?: number;
  /** Injected for tests; defaults to the real `spawnSync`. */
  spawn?: SpawnImpl;
}

/**
 * Build a runner. Limits are injectable so byte-boundary tests run on kilobytes instead of
 * allocating 64 MiB per case; production values are the exported constants.
 */
export function createRunner(opts: RunnerOptions = {}): CcusageRunner {
  const maxBuffer = opts.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  const spawn: SpawnImpl =
    opts.spawn ??
    ((exe, args, o) =>
      spawnSync(exe, args, {
        shell: false,
        // NOT "utf8" — see `decodeStream`. `maxBuffer` is a BYTE limit either way, so the
        // capture cap is unaffected by capturing buffers.
        encoding: "buffer",
        maxBuffer: o.maxBuffer,
        timeout: o.timeout,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }));

  return (exe: string, args: string[]): RunResult => {
    const cmd = () => [exe, ...args].join(" ");

    // Defence in depth: createDeps already refuses an empty exe, but this module is the
    // process boundary and must not depend on a caller's validation.
    if (exe === "") {
      throw new UsageError("could not run ccusage: no executable was configured.");
    }

    // spawnSync can throw SYNCHRONOUSLY, before any result exists — an empty or otherwise
    // invalid argument raises ERR_INVALID_ARG_VALUE rather than returning `error`. Without
    // this it escapes as a raw Node exception, contradicting the exhaustive-classification
    // claim above (code review R1).
    let res: SpawnResultLike;
    try {
      res = spawn(exe, args, { maxBuffer, timeout });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new UsageError(
        `could not run ccusage (${code ?? (e as Error).message}).\ncmd: ${cmd()}`,
      );
    }

    // Kept as BYTES until the process outcome has been classified. A spawn that failed
    // outright has no meaningful output to decode, and a decode failure must not be allowed
    // to mask the real reason the process did not run.
    const outBuf = res.stdout ?? EMPTY;
    const errBuf = res.stderr ?? EMPTY;
    const err = res.error as NodeJS.ErrnoException | undefined;

    if (err) {
      // ONLY ENOENT may travel as spawnError — runCcusage renders that as the frozen
      // "not found" text, which would be a lie for any other failure.
      if (err.code === "ENOENT") {
        // NOT decoded. The executable was never found, so the child never ran and these
        // streams carry nothing — Python does not even have a result object to inspect on
        // this path (`subprocess.run` raises, and `except OSError` at usage.py:115 exits
        // without touching stdout/stderr). Decoding them would let a malformed byte
        // sequence throw "not valid UTF-8" INSTEAD of the frozen "'X' not found" message,
        // masking the real diagnosis with an artefact of output that does not exist
        // (code review R7).
        return {
          status: res.status,
          stdout: "",
          stderr: "",
          spawnError: err,
        };
      }
      if (err.code === "ETIMEDOUT") {
        throw new UsageError(
          `ccusage timed out after ${Math.round(timeout / 1000)}s.\ncmd: ${cmd()}`,
        );
      }
      if (err.code === "ENOBUFS") {
        throw new UsageError(
          `ccusage produced more than ${maxBuffer} bytes of output, which exceeds the limit.` +
            `\ncmd: ${cmd()}`,
        );
      }
      throw new UsageError(
        `could not run ccusage (${err.code ?? "unknown error"}).` +
          `\ncmd: ${cmd()}`,
      );
    }

    // Decoded HERE: after spawn-level classification, but before the missing-status decision
    // below, which needs stdout to make Python's choice. Python decodes even earlier — inside
    // `subprocess.run` — so a malformed stream raises there regardless of returncode; keeping
    // ENOENT/ETIMEDOUT/ENOBUFS/EACCES ahead of this only affects port-only diagnostics whose
    // text is not frozen (ALLOWLIST 15), and stops a truncated capture from masking them.
    const stdout = decodeStream(outBuf, "stdout", cmd);
    const stderr = truncateUtf8(decodeStream(errBuf, "stderr", cmd), MAX_STDERR_DIAGNOSTIC_BYTES);

    // A null status means no exit code was observed — the child was signalled, or spawnSync
    // reported neither. Python always HAS a returncode (a signal shows up as `-N`), and its
    // rule at usage.py:118 is `returncode != 0 AND not stdout.strip()`. So a missing status
    // is only fatal when stdout is blank; when the child produced output before dying,
    // Python parses it and exits 0.
    //
    // Throwing unconditionally here — as this did until code review R8 — flipped the exit
    // code on exactly that case. Measured: a child that writes a complete JSON payload and
    // is then SIGKILLed makes usage.py print the table and exit 0, while the port exited 1
    // with "terminated by signal SIGKILL". Exit codes are byte-frozen, and no ALLOWLIST
    // entry sanctions that flip. R5 added the no-status guard on the reasoning that such a
    // result "would be accepted as a successful run"; that is what Python does, so the guard
    // was right to exist and wrong to be unconditional.
    //
    // `pyStrip` rather than `.trim()`, matching the blankness test ccusage.ts applies: both
    // sites ask Python's question, so both must use Python's whitespace set. They were moved
    // together (ISS-015) precisely because agreeing with each other is half the requirement —
    // agreeing with the oracle is the other half.
    if (res.status === null && pyStrip(stdout) === "") {
      throw new UsageError(
        res.signal
          ? `ccusage was terminated by signal ${res.signal}.\ncmd: ${cmd()}`
          : `ccusage exited without an exit status.\ncmd: ${cmd()}`,
      );
    }

    return { status: res.status, stdout, stderr };
  };
}

/** The production runner. */
export const runner: CcusageRunner = createRunner();
