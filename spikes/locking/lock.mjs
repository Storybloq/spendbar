/**
 * T-008 candidate B — REJECTED. Kept as executable evidence, never as a building block.
 *
 * lock.race.test.mjs reproduces two simultaneous holders against this exact code, plus a release
 * that deletes a successor's live lock. Nothing may import this module except its own tests.
 *
 * THE ONE RULE (which this module tries and ultimately FAILS to uphold — see release()):
 * nothing ever unlinks a file it does not own.
 *
 * The obvious design — stat the lock, decide it is stale, unlink it, create your own — cannot be
 * made correct with the calls Node exposes. `stat` then `unlink` is time-of-check/time-of-use,
 * POSIX offers no inode-conditional delete, and so a contender that "verified" the inode can
 * still delete the lock of a *different* contender that replaced it in the window. Plan review
 * round 1 killed that design; this replaces it.
 *
 * Instead:
 *
 *   create   write a complete record to a private candidate file, fsync it, then `link()` it to
 *            the lock pathname. `link` is atomic and fails EEXIST rather than clobbering, so the
 *            lock pathname NEVER exists holding a partial record. (The earlier design's
 *            open("wx")-then-write left an empty file visible, which a contender would read as
 *            "unparseable, therefore stale" and break — a live lock destroyed on the happy path.)
 *
 *   takeover when the recorded owner is confirmed dead, `rename()` the candidate over the lock.
 *            `rename` is atomic and replaces. Two simultaneous takeovers BOTH return success —
 *            so success is not the answer. The winner was SUPPOSED to be decided by READING THE
 *            LOCK BACK and checking whose token is in it — but read-back does not select one
 *            winner: contenders read back at DIFFERENT TIMES, so each can find its own token in
 *            the window before the next rename, and lock.race.test.mjs proves both then enter.
 *            Read-back tells a process it lost; it cannot tell a process that already won that
 *            it has since been superseded. THIS IS WHY THE MODULE IS REJECTED.
 *
 * What this primitive does NOT do: it cannot make a publish atomic. Between any ownership check
 * and a subsequent write there is a window no filesystem call available to Node closes.
 *
 * The obvious next move — "so validate a fencing token in the store" — was tried and ALSO fails
 * here; see FencedStore at the bottom, which cannot be authoritative with these primitives. The
 * gate's actual conclusion (T-008 §3.5) is different in kind: filesystem ownership checks cannot
 * fence a later write at all. Atomic `rename()` prevents torn snapshots, and semantic ordering
 * comes from every publisher running under the continuously-held port lock — not from a token.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Hooks fired inside the race windows, so tests can act while the window is open. */
const NO_HOOKS = Object.freeze({});

export class LockError extends Error {}

/**
 * The exact `ps` start time for a pid, `null` if the pid is confirmed not to exist.
 *
 * FAILS CLOSED. Only `ps` exiting 1 with no stdout means "no such process". Anything else — a
 * spawn failure, a different exit code, output we cannot parse, a signal death — returns a
 * sentinel that callers must treat as ALIVE. The natural implementation ("exit !== 0 means
 * gone") fails open into two simultaneous lock holders, and every happy-path test still passes.
 */
export async function processStartTime(pid, { exec = execFileAsync } = {}) {
  let res;
  try {
    res = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  } catch (err) {
    // execFile rejects on nonzero exit AND on spawn failure; the two must not be conflated.
    if (err?.code === "ENOENT" || err?.errno !== undefined) return { state: "unknown", why: `ps could not be run: ${err.code ?? err.message}` };
    if (err?.signal) return { state: "unknown", why: `ps died on ${err.signal}` };
    if (err?.code === 1 && !String(err.stdout ?? "").trim()) return { state: "gone" };
    return { state: "unknown", why: `ps exited ${err.code}` };
  }
  const out = String(res.stdout ?? "").trim();
  if (!out) return { state: "unknown", why: "ps exited 0 but printed nothing" };
  // Kept as the raw string. Parsing it as a date would introduce locale and timezone as a second
  // way to be wrong about the same fact, and the value is only ever compared for equality.
  return { state: "alive", startTime: out };
}

export class Lock {
  #path;
  #dir;
  #record = null;
  #hooks;

  constructor(dir, name, { namespace = "writer", hooks = NO_HOOKS } = {}) {
    this.#dir = dir;
    // The namespace is in the FILENAME as well as the record, so a writer lease and a reader
    // computation lease (T-013) are different files and cannot contend with each other.
    this.#path = join(dir, `${name}.${namespace}.lock`);
    this.#hooks = hooks;
    this.namespace = namespace;
  }

  get path() { return this.#path; }
  get record() { return this.#record; }
  /**
   * The rejected experiment's non-authoritative counter. NOT a fencing token: lock.race.test.mjs
   * shows two contenders minting the same value from the same predecessor, and FencedStore below
   * shows why validating it in the store does not rescue it either.
   */
  get generation() { return this.#record?.generation ?? null; }

  async #hook(name) {
    // Reads the property twice — type-check then invoke — which is the double-read defect fixed in
    // portlock.mjs, publish.mjs, auth.mjs and probe.mjs. DELIBERATELY LEFT, like the umask-unsafe
    // creation below it, under this file's standing rule: this module is the recorded evidence of
    // the REJECTED lockfile design, and its value is being the artefact the race tests actually
    // characterized. Repairing it would change the thing the evidence is about, and it has no
    // production callers to protect. Noted rather than silently kept, because an unexplained
    // instance of a class fixed everywhere else reads as an oversight (review round 15).
    if (typeof this.#hooks[name] === "function") await this.#hooks[name](this);
  }

  #writeCandidate(record) {
    mkdirSync(this.#dir, { recursive: true });
    const candidate = `${this.#path}.${record.token}.tmp`;
    const fd = openSync(candidate, "wx", 0o600);
    try {
      // Loop: writeSync may legally write short, and a truncated record published via link() is
      // then read as malformed -> treated as permanently LIVE, which would make this rejected
      // prototype fail its own evidence tests for an unrelated reason.
      const buf = Buffer.from(JSON.stringify(record));
      for (let off = 0; off < buf.length;) {
        const n = writeSync(fd, buf, off, buf.length - off);
        if (!(n > 0)) throw new LockError(`write made no progress at offset ${off}`);
        off += n;
      }
      // fsync before publishing: the lock pathname must never become visible pointing at a
      // record the filesystem has not committed.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return candidate;
  }

  /**
   * One non-blocking attempt. Returns true if this process now holds the lock.
   *
   * Deliberately not retrying. A retry loop turns "exactly one winner" into "everyone wins
   * eventually", which is the shape that makes a contention test look green while proving
   * nothing about mutual exclusion.
   */
  async tryAcquire({ now = () => new Date().toISOString() } = {}) {
    const token = randomBytes(32).toString("hex");
    const self = await processStartTime(process.pid);
    if (self.state !== "alive") {
      throw new LockError(`cannot determine this process's own start time (${self.why}); refusing to take a lock whose staleness nobody could later judge`);
    }

    const existing = this.#read();
    await this.#hook("afterRecordRead");

    let mode = "create";
    if (existing !== null) {
      const live = await this.#isLive(existing);
      await this.#hook("afterLivenessDecision");
      if (live) return false;              // never touch a live owner's lock
      mode = "takeover";
    }

    const record = {
      pid: process.pid,
      startTime: self.startTime,
      token,
      namespace: this.namespace,
      generation: (existing?.generation ?? 0) + 1,
      acquiredAt: now(),
    };
    const candidate = this.#writeCandidate(record);

    try {
      await this.#hook("beforePublish");
      if (mode === "create") {
        try {
          linkSync(candidate, this.#path);
        } catch (err) {
          if (err.code === "EEXIST") return false;   // someone created it first; not ours to fix
          throw err;
        }
      } else {
        // Atomic replace. Both simultaneous takeovers "succeed", so this proves nothing yet.
        renameSync(candidate, this.#path);
      }
    } finally {
      // Only ever our own candidate.
      try { rmSync(candidate, { force: true }); } catch { /* candidate already renamed away */ }
    }

    // THE decision. Whoever's token survives in the file is the holder; a syscall that returned
    // without error is not evidence of anything when the operation replaces.
    const after = this.#read();
    if (after === null || after.token !== token) return false;
    this.#record = record;
    return true;
  }

  #read() {
    let raw;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    try {
      const r = JSON.parse(raw);
      if (typeof r?.pid !== "number" || typeof r?.token !== "string" || typeof r?.startTime !== "string") return { malformed: true, raw };
      return r;
    } catch {
      return { malformed: true, raw };
    }
  }

  async #isLive(existing) {
    // A malformed record is treated as LIVE, not stale. It cannot happen through this class —
    // `link`/`rename` publish only complete records — so if one appears, something outside this
    // protocol wrote it, and guessing is how a live owner gets evicted.
    if (existing.malformed) return true;
    const owner = await processStartTime(existing.pid);
    if (owner.state === "gone") return false;
    if (owner.state === "unknown") return true;          // fail closed
    // Same pid, different start time => the original owner exited and the pid was reused.
    return owner.startTime === existing.startTime;
  }

  /**
   * Advisory only, and the advice it gives is "you have already lost", never "you still hold it".
   * The window between this returning true and the caller's next write is not closed by it. Do
   * NOT read this as "so put the fence in the store" — that is FencedStore below, which does not
   * work either. See the header: the adopted design does not fence and does not need to, because
   * atomic rename supplies structural integrity and the continuously held port lock supplies
   * normal-case writer ordering.
   */
  stillOwnedAdvisory() {
    if (this.#record === null) return false;
    const cur = this.#read();
    return cur !== null && !cur.malformed && cur.token === this.#record.token;
  }

  /**
   * Release. TRIES to only unlink a lock whose record still carries OUR token — and cannot:
   * the read-then-unlink below is itself a TOCTOU. A takeover landing between #read() and
   * unlinkSync means we delete the SUCCESSOR'S live lock, violating the one rule this file is
   * built around. There is no atomic inode-conditional unlink to close the window with. This is
   * a SECOND, independent reason candidate B is rejected (review round 1 of T-008 code review);
   * lock.race.test.mjs drives the window via afterReleaseRead and proves the deletion.
   */
  async release() {
    if (this.#record === null) return false;
    await this.#hook("beforeRelease");
    const cur = this.#read();
    await this.#hook("afterReleaseRead");
    if (cur === null || cur.malformed || cur.token !== this.#record.token) {
      // We were taken over. Deleting now would remove the CURRENT owner's lock — the exact bug
      // the one rule exists to prevent.
      this.#record = null;
      return false;
    }
    unlinkSync(this.#path);
    this.#record = null;
    return true;
  }
}

/**
 * REJECTED TOY — retained only because the round-2 plan review used it to articulate why
 * fencing must live in the store. It does NOT show what T-010 must do: #lastGeneration is
 * process-local (two processes each construct one and accept the same generation; a restart
 * resets it to zero) and the compare-then-write below is not atomic. An authoritative fence
 * needs persistent, atomic conditional commit, which no wrapper over these calls provides —
 * that conclusion is precisely why T-010 uses atomic rename and needs no fence (plan §3.5).
 */
export class FencedStore {
  #file;
  #lastGeneration = 0;
  constructor(file) { this.#file = file; }
  get lastGeneration() { return this.#lastGeneration; }

  /**
   * THE HYPOTHESIS THIS TOY DISPROVES. The idea was: validate at the write, so a holder that lost
   * its lock carries a superseded generation and is refused even while believing it is the writer.
   *
   * It does not work. `#lastGeneration` is process-local, so two processes each construct a store
   * and accept the SAME generation; a restart resets it to zero; and the compare-then-write below
   * is not atomic anyway. An authoritative fence needs persistent atomic conditional commit,
   * which nothing built on these calls provides — which is why the adopted design does NOT fence
   * and does not need to: atomic rename supplies structural integrity, and the continuously held
   * port lock supplies normal-case ordering (T-008 §3.5). The earlier wording here said it
   * "fences nothing and needs to", which asserts the opposite of the conclusion it was summarising.
   */
  publish(generation, payload) {
    if (typeof generation !== "number" || generation <= this.#lastGeneration) {
      throw new LockError(`refusing publish at generation ${generation}; the store has already accepted ${this.#lastGeneration}. A newer writer has taken over.`);
    }
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, JSON.stringify({ generation, payload }));
    this.#lastGeneration = generation;
    return true;
  }
}

export const _internals = { statSync };
