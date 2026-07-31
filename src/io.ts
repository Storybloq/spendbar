/**
 * The process boundary: the only module in `src/` that touches `process`.
 *
 * Both entry points — the shipped `dist/cli.js` and the parity harness's wrapper — go
 * through `runCli` so the write path cannot drift between what ships and what is tested.
 * They differ only in the `prog` and `today` they inject.
 *
 * Three rules, each measured rather than assumed (plan section 7.1):
 *
 *  1. `process.stdout.write`, never `console.log`. The latter applies its own formatting and
 *     newline rules, and the renderers already carry their exact bytes.
 *  2. `process.exitCode`, never `process.exit()`. Node's stdout to a PIPE is asynchronous, so
 *     exiting right after a write truncates output — silently, and only when piped, which is
 *     precisely how a test harness invokes a CLI.
 *  3. A broken stdout pipe exits 120, matching CPython (ALLOWLIST 20).
 */
import { main, type MainOptions } from "./main.js";

/**
 * CPython's exit status when stdout dies mid-write: BrokenPipeError escapes, and the
 * interpreter's shutdown handler turns it into 120. Measured against `head -1` and an
 * early-closing reader over ~24 MB of output; Node's untended default is 1.
 */
export const EPIPE_EXIT = 120;

/** The slice of a writable stream the guard needs, so tests can supply a failing one. */
export interface GuardStream {
  write(chunk: string): unknown;
  on(event: "error", handler: (err: NodeJS.ErrnoException) => void): unknown;
}

export interface GuardTarget {
  stdout: GuardStream;
  stderr: GuardStream;
  setExitCode(code: number): void;
  prog: string;
}

export interface PipeGuard {
  /** Write to a stream, or do nothing once the pipe is known broken. */
  write(stream: GuardStream, chunk: string): void;
  /** True once a broken pipe has been observed. */
  isBroken(): boolean;
}

/**
 * Detect a dead stdout and turn it into CPython's exit status.
 *
 * Extracted from `runCli` so it can be tested by injecting streams that fail on demand.
 * Proving this through a subprocess alone would mean the error branches — a broken stderr,
 * a non-EPIPE error, a repeated event — are only reachable by contriving rare OS states.
 */
export function createPipeGuard(target: GuardTarget): PipeGuard {
  let broken = false;

  /**
   * Enter the broken-pipe state once, no matter how many times the event fires — a stream
   * with several writes in flight emits one `'error'` per failed write, and a diagnostic
   * repeated per queued chunk would be worse than the traceback it replaces.
   *
   * CPython is not silent here (it prints a BrokenPipeError traceback), and neither is this:
   * stderr is normally still attached when stdout is piped, so saying nothing would leave a
   * truncated report looking like a complete one. The text is free — ALLOWLIST 20 freezes the
   * exit code and the stream, not the words — so it is one line instead of two tracebacks.
   */
  const breakPipe = (): void => {
    if (broken) return;
    broken = true;
    target.setExitCode(EPIPE_EXIT);
    try {
      target.stderr.write(`${target.prog}: stdout closed before all output was written (broken pipe)\n`);
    } catch {
      // stderr is gone as well; the exit status is the only channel left.
    }
  };

  // A broken pipe surfaces on stdout as an asynchronous `'error'` event, not a thrown
  // exception, because Node writes to a pipe asynchronously. Left unhandled that is a fatal
  // unhandled `'error'` with a stack dump and exit 1. Handling it is what makes 120 happen.
  target.stdout.on("error", (err) => {
    if (err.code !== "EPIPE") throw err;
    breakPipe();
  });

  // If stderr is gone too there is nowhere left to complain, and an unhandled 'error' there
  // would replace a clean exit 120 with a crash. Swallowing is the only available behaviour.
  target.stderr.on("error", () => {});

  return {
    isBroken: () => broken,
    /**
     * Writes stop once the pipe is known broken. CPython unwinds on the first
     * BrokenPipeError and writes nothing further; continuing to buffer megabytes into a dead
     * pipe would differ in how long the process lives, which is observable even when the
     * bytes are not.
     *
     * The synchronous try/catch is not redundant with the `'error'` handler: when stdout is a
     * regular file or `/dev/null` Node writes synchronously, and a closed descriptor throws
     * (EBADF) right here instead of emitting an event.
     */
    write(stream, chunk) {
      if (broken) return;
      try {
        stream.write(chunk);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "EPIPE" && err.code !== "EBADF") throw err;
        breakPipe();
      }
    },
  };
}

export type EntrypointOptions = Pick<MainOptions, "argv" | "prog" | "today" | "env">;

export function runCli(o: EntrypointOptions): void {
  const guard = createPipeGuard({
    stdout: process.stdout,
    stderr: process.stderr,
    setExitCode: (code) => {
      process.exitCode = code;
    },
    prog: o.prog,
  });

  const status = main({
    ...o,
    stdout: (chunk) => guard.write(process.stdout, chunk),
    stderr: (chunk) => guard.write(process.stderr, chunk),
  });

  // A broken pipe outranks whatever the command itself would have returned: the output the
  // caller asked for never arrived, so reporting success would be a lie.
  if (!guard.isBroken()) process.exitCode = status;
}
