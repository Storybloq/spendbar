/**
 * Running a subject process and capturing EVERYTHING that distinguishes one run from
 * another: raw stdout bytes, raw stderr bytes, and the complete termination result.
 *
 * "Exit status" alone is not the termination result. A process that exits 0 and a process
 * that dies on SIGPIPE both report a status of `null`-or-0 depending on which field you
 * read, and a process that never started at all reports neither. Those are three different
 * outcomes and the harness has to be able to tell them apart, because the EPIPE work in
 * the plan's section 7.2 turns on exactly that distinction.
 */
import { spawnSync } from "node:child_process";

/** Big enough that no fixture output can silently truncate; overflow surfaces as ENOBUFS. */
export const MAX_BUFFER = 64 * 1024 * 1024;

const EMPTY = Buffer.alloc(0);

/**
 * @returns {{stdout: Buffer, stderr: Buffer, termination: Termination}}
 * where Termination is one of
 *   {kind: "exit",        status: number, signal: null,   code: null}
 *   {kind: "signal",      status: null,   signal: string, code: null}
 *   {kind: "spawn-error", status: null,   signal: null,   code: string}
 */
export function runProcess(file, args, { env, cwd, input = EMPTY } = {}) {
  const r = spawnSync(file, args, {
    env,
    cwd,
    input,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return {
    // spawnSync yields null for either stream when the spawn itself failed.
    stdout: r.stdout ?? EMPTY,
    stderr: r.stderr ?? EMPTY,
    termination: classify(r),
  };
}

function classify(r) {
  if (r.error) {
    // `code` is the stable part (ENOENT, EACCES, ENOBUFS); `message` embeds machine paths
    // and would make an otherwise-identical pair of runs look different.
    return { kind: "spawn-error", status: null, signal: null, code: r.error.code ?? r.error.name };
  }
  if (r.signal != null) {
    return { kind: "signal", status: null, signal: r.signal, code: null };
  }
  return { kind: "exit", status: r.status, signal: null, code: null };
}

/** Human-readable one-liner for reports. */
export function describeTermination(t) {
  if (t.kind === "exit") return `exit ${t.status}`;
  if (t.kind === "signal") return `killed by ${t.signal}`;
  return `spawn failed (${t.code})`;
}
