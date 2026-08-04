/**
 * The real `SnapshotFs`, built on node:fs.
 *
 * This is the only file in the snapshot module that performs I/O, matching v0.1's split:
 * the core is pure protocol logic and entrypoints own the filesystem. Everything here is a
 * thin, faithful pass-through — no retries, no fallbacks, no error translation — because
 * the store's failure handling is specified against raw errno codes and a seam that
 * "helps" would hide exactly the failures the suite injects.
 *
 * Deliberately absent: fsync. The snapshot is a derived cache; a power cut costs a
 * recomputation, not data (T-010, and asserted by test).
 */
import * as fs from "node:fs";

import { classifyFsError } from "./errors.js";
import { defineOwn, freeze, weakDelete, weakGet, weakSet } from "./intrinsics.js";
import {
  DIR_MODE,
  OWNER_READ,
  type SnapshotFileHandle,
  type SnapshotFs,
  type SnapshotStat,
} from "./types.js";

/**
 * UTF-8 decoding that REFUSES invalid bytes instead of replacing them.
 *
 * `Buffer.toString("utf8")` substitutes U+FFFD for every invalid sequence, silently. That is
 * not a cosmetic loss here: the store's whole artifact contract is stated in bytes. A file
 * whose raw bytes are not valid UTF-8 decoded into a string that could parse as JSON, checksum
 * correctly, and pass the canonical-bytes comparison — because every one of those checks then
 * ran on the REPLACED string rather than on what the filesystem returned. `manifestIdentity`
 * has the same problem in the direction that matters most: a file containing an invalid byte
 * and a file containing a literal U+FFFD hash identically, so the reader's optimistic
 * transaction cannot see one replaced by the other, which is exactly the ABA detection that
 * function exists to provide.
 *
 * Refused rather than repaired, and classified as a seam failure so it travels the same road
 * as any other unreadable artifact: this protocol only ever writes canonical JSON, so bytes
 * that are not valid UTF-8 are bytes it did not write.
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch (cause) {
    // The decoder's own failure travels as an opaque cause. It is never inspected — that
    // permission belongs to `classifyFsError` alone — but dropping it meant `readFile` and
    // `readAll` destroyed the only account of WHERE the invalid sequence was before anything
    // downstream could see it, and a synthetic EILSEQ with no origin is a poor thing to debug a
    // corrupt artifact with.
    const err = new Error(
      `${what} is not valid UTF-8; this protocol writes canonical JSON, so these are not ` +
        "bytes it produced",
      { cause },
    ) as NodeJS.ErrnoException;
    defineOwn(err, "code", "EILSEQ");
    throw err;
  }
}

/**
 * Classification happens HERE, at the trusted boundary, and nowhere else.
 *
 * This adapter knows it is looking at a native `fs` error, so reading `.code` off it is
 * safe. The core never gets to make that judgement: it would be reading an arbitrary value,
 * and a Proxy or accessor there can run code, mutate state, or hang — which no `try`/`catch`
 * in the core could contain.
 */
function wrap<T>(op: string, path: string, run: () => T): T {
  try {
    return run();
  } catch (cause) {
    throw classifyFsError(op, path, cause);
  }
}

/**
 * Handles are CAPABILITIES, not records that happen to carry a number.
 *
 * `SnapshotFileHandle` is a structural type branded by a string literal, and the adapter used
 * to cast whatever it was handed to `{ fd: number }` and use that number. So
 * `{ __brand: "SnapshotFileHandle", fd: 1 }` was a perfectly good argument to `write`, and it
 * wrote to this process's stdout — the brand proved nothing, because a string literal is
 * something anyone can type. Worse without any forgery at all: a genuine handle stays a
 * plausible-looking object after `close`, and fd numbers are reused, so a stale handle
 * addresses whatever file was opened next.
 *
 * The descriptor therefore lives HERE, keyed by object identity, and is DELETED on close. The
 * returned object is frozen and carries no fd at all, so there is nothing on it to forge, to
 * edit, or to read after it stops being valid. Same argument as `FS_ERROR_KIND` in errors.ts:
 * an identity lookup reads nothing off the value, and a value this adapter never created
 * simply is not a key.
 */
const HANDLE_FD = new WeakMap<object, number>();

function newHandle(fd: number): SnapshotFileHandle {
  const handle = freeze({ __brand: "SnapshotFileHandle" } as const);
  weakSet<object, number>(HANDLE_FD, handle, fd);
  return handle;
}

/**
 * The descriptor for a live handle, or a refusal.
 *
 * A closed handle and a forged one are the same answer here, deliberately: neither names a
 * descriptor this adapter is holding, and guessing which one the caller meant would mean
 * inspecting the value — the thing this whole design exists to avoid.
 */
function fdOf(handle: SnapshotFileHandle, op: string): number {
  if (typeof handle !== "object" || handle === null) {
    throw badHandle(op);
  }
  const fd = weakGet(HANDLE_FD, handle);
  if (fd === undefined) {
    throw badHandle(op);
  }
  return fd;
}

function badHandle(op: string): Error {
  const err = new Error(
    `${op} needs a live handle from this adapter; the value given was never opened here, ` +
      "or has already been closed",
  ) as NodeJS.ErrnoException;
  defineOwn(err, "code", "EBADF");
  return err;
}

/**
 * Stats are taken with `{ bigint: true }` throughout.
 *
 * Not a style choice: `dev`/`ino` are 64-bit, and XFS and btrfs issue inode numbers above
 * 2^53 in ordinary use. Read as doubles they lose precision, so two different files can
 * compare EQUAL — and every use of these fields is an identity check whose whole job is to
 * notice that two files are different. `mode` is narrowed back to a number because it is a
 * 16-bit field that callers mask and compare against octal literals.
 */
function toStat(stat: fs.BigIntStats): SnapshotStat {
  return {
    mode: Number(stat.mode),
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
    dev: stat.dev,
    ino: stat.ino,
  };
}

/**
 * The open flags this adapter's guarantees rest on, proven present ONCE, at construction.
 *
 * `O_RDONLY | undefined` is `O_RDONLY`. So on any platform where Node does not define
 * `O_NOFOLLOW`, the bitwise-or silently drops it and `openRead` starts FOLLOWING
 * final-component symlinks — the single primitive the whole descriptor-based read is built on,
 * absent, with no error and no observable difference until something exploits it. A security
 * flag that degrades by platform is worse than one that is missing, because the code above it
 * goes on claiming the guarantee. This fails closed instead.
 */
export interface RequiredOpenFlags {
  O_NOFOLLOW: number;
  O_NONBLOCK: number;
  O_DIRECTORY: number;
}

/**
 * Exported so the check itself can be exercised: `fs.constants` is non-configurable, so a test
 * cannot remove a flag from the real object, and an unfalsifiable guard is one this ticket has
 * already learned not to trust.
 */
export function assertRequiredOpenFlags(constants: Record<string, unknown>): RequiredOpenFlags {
  const read = (name: keyof RequiredOpenFlags): number => {
    const value = constants[name];
    // `> 0`, not `!== 0`: an open flag is a bit in a mask, so no legitimate constant is
    // negative, and `-1` is exactly the shape a stub or a mock produces when it means "not
    // available". Accepting it would let the fail-closed guard pass with a flag that turns
    // `O_RDONLY | -1` into every bit set.
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `snapshot store requires fs.constants.${name}; this platform does not provide it`,
      );
    }
    return value;
  };
  return {
    O_NOFOLLOW: read("O_NOFOLLOW"),
    O_NONBLOCK: read("O_NONBLOCK"),
    O_DIRECTORY: read("O_DIRECTORY"),
  };
}

/** Owner read — the one bit `mkdir` must survive with for the descriptor repair to be reachable. */

/**
 * The process umask must leave OWNER READ on a 0700 directory.
 *
 * `mkdir(2)`'s mode is a umask-filtered request, and this store's answer to that is to reopen
 * the new directory and `fchmod` the descriptor. The repair therefore has a precondition the
 * seam's own documentation does not mention: it must be able to OPEN what it just created.
 * Under umask 0400 `mkdir(path, 0o700)` produces mode 300, `openDir` fails EACCES, and the
 * sequence documented as establishing 0700 establishes nothing — the store cannot start, and
 * says so as an opaque EACCES on a path the caller never named.
 *
 * OWNER READ specifically, measured rather than assumed. Masks that strip owner write or
 * execute are fine and are not refused: 0100, 0200 and 0300 create 600, 500 and 400, every one
 * of which opens, and `fchmod` then restores 0700. `fchmod` needs ownership, not permission.
 * Only 0400 and above on the owner triad — which removes read — makes the repair unreachable.
 * (The suite exercises 0200 end to end, which a coarser "no owner bit may be masked" rule
 * would have refused outright.)
 *
 * Checked ONCE, at construction, for the reason `assertRequiredOpenFlags` sits a few lines up:
 * a guarantee that degrades quietly is worse than one that fails closed.
 */
export function assertUmaskAllowsOwnerModes(mask: number): void {
  const granted = DIR_MODE & ~mask;
  if ((granted & OWNER_READ) === 0) {
    throw new Error(
      `snapshot store requires a umask that leaves owner READ intact: umask ` +
        `${mask.toString(8).padStart(4, "0")} would create a ${DIR_MODE.toString(8)} directory ` +
        `as ${granted.toString(8).padStart(3, "0")}, which cannot then be opened to repair it`,
    );
  }
}

export function createNodeSnapshotFs(): SnapshotFs {
  const { O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = assertRequiredOpenFlags(
    fs.constants as unknown as Record<string, unknown>,
  );
  // The argument-less form READS the mask; it does not set one. (The setter form is the
  // thread-unsafe one, and this never calls it.)
  assertUmaskAllowsOwnerModes(process.umask());
  // O_NONBLOCK is not a performance knob here. `open(2)` on a FIFO in read mode BLOCKS until a
  // writer arrives, and the store opens artifacts by name — so a FIFO left at `manifest.json`
  // wedges the process inside `openSync`, before the core ever gets a descriptor to fstat and
  // reject. The non-regular-file refusal is real but unreachable without this: it runs after
  // the open. On a regular file the flag has no effect on reads.
  return {
    readFile(path) {
      return wrap("readFile", path, () => decodeUtf8(fs.readFileSync(path), path));
    },
    openRead(path) {
      // O_NOFOLLOW makes the kernel refuse a final-component symlink instead of resolving it,
      // which is what turns "check then read" into "open then check". The store validates the
      // mode and type on the returned descriptor, so the name it proved and the bytes it reads
      // are the same inode by construction.
      return wrap("openRead", path, () => {
        return newHandle(fs.openSync(path, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
      });
    },
    openDir(path) {
      // O_DIRECTORY makes the kernel refuse anything that is not a directory, O_NOFOLLOW
      // refuses a final-component symlink, and the pair is what lets the caller apply a mode
      // with `fchmod` on a descriptor instead of `chmod` on a name that can be swapped.
      return wrap("openDir", path, () => {
        return newHandle(
          fs.openSync(path, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_DIRECTORY),
        );
      });
    },
    readAll(handle, maxBytes) {
      // Read in bounded chunks and count what actually ARRIVES, rather than trusting a size
      // from `fstat`: the two are different questions, because the file can grow between the
      // stat and the last read. `readFileSync(fd)` would allocate whatever the file turns out
      // to be, which for a name anything can replace is an unbounded allocation driven by
      // someone else's file.
      return wrap("readAll", "<fd>", () => {
        // The BOUND is validated before it is used as one. `total > maxBytes` is never true for
        // NaN and never true for Infinity, so either value silently restores the unbounded read
        // this loop exists to prevent — and this seam is reachable from JavaScript, where the
        // parameter type is a suggestion. FakeFs already refused both with EINVAL, so leaving
        // it out here also meant the fake and the adapter disagreed about what the seam accepts,
        // which is the divergence that makes a fake-suite proof worth less than it looks.
        if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
          const bad = new Error("readAll needs a byte bound") as NodeJS.ErrnoException;
          defineOwn(bad, "code", "EINVAL");
          throw bad;
        }
        const fd = fdOf(handle, "readAll");
        const CHUNK = 64 * 1024;
        const parts: Buffer[] = [];
        let total = 0;
        for (;;) {
          const buf = Buffer.allocUnsafe(CHUNK);
          const n = fs.readSync(fd, buf, 0, CHUNK, null);
          if (n === 0) break;
          total += n;
          if (total > maxBytes) {
            const err = new Error(`read exceeded ${maxBytes} bytes`) as NodeJS.ErrnoException;
            defineOwn(err, "code", "EFBIG");
            throw err;
          }
          parts.push(n === CHUNK ? buf : buf.subarray(0, n));
        }
        return decodeUtf8(Buffer.concat(parts, total), "<fd>");
      });
    },
    listDir(path) {
      // Entry names are BYTES on POSIX, and `readdirSync` with a string encoding replaces
      // invalid sequences with U+FFFD — so the store received a name that does not address the
      // file. That is not a cosmetic problem for this store: classification would see a foreign
      // entry, reset would try to `unlink` the replaced name, get ENOENT, believe the entry was
      // already gone, and classification would find it again on the next pass. A reset loop
      // that cannot converge, silently, forever — the exact defect class MAX_ARTIFACT_BYTES is
      // symmetric to avoid.
      //
      // So the names are read as bytes and each one must ROUND-TRIP. A name that does not is
      // refused loudly, naming the directory, because a store the adapter cannot address is a
      // condition a human can fix in one command and a loop is a condition nobody can see.
      //
      // Carrying such names faithfully end to end (Buffer-valued entries through classification,
      // unlink and rmdir) is the complete fix and is tracked separately; this converts an
      // invisible non-convergence into a named, actionable failure.
      return wrap("listDir", path, () => {
        const raw = fs.readdirSync(path, { encoding: "buffer" });
        return raw.map((entry) => {
          // Decoded through a converter, not `decodeUtf8` directly, because that throws EILSEQ
          // and EILSEQ now means `invalid-content` — which `readStoreFile` turns into an
          // unusable artifact and the store RESETS on. A name that is outright invalid UTF-8
          // reached that path BEFORE the round-trip check below could raise EBADMSG, so the
          // separation those two codes exist to make was defeated for exactly the input it was
          // written for: the store would reset on a name it cannot address, reporting work it
          // could not perform. Both failures of a NAME are EBADMSG; the decoder's own failure
          // travels underneath as a cause.
          let name: string;
          try {
            name = decodeUtf8(entry, `an entry name in ${path}`);
          } catch (cause) {
            const err = new Error(
              `an entry name in ${path} is not valid UTF-8, so this adapter cannot address ` +
                "the file it names",
              { cause },
            ) as NodeJS.ErrnoException;
            defineOwn(err, "code", "EBADMSG");
            throw err;
          }
          if (!Buffer.from(name, "utf8").equals(entry)) {
            const err = new Error(
              `an entry name in ${path} does not round-trip UTF-8, so this adapter cannot ` +
                "address the file it names",
            ) as NodeJS.ErrnoException;
            // EBADMSG, NOT EILSEQ, and the difference is the disposition rather than the
            // spelling. Artifact CONTENT that is not valid UTF-8 classifies as
            // `invalid-content` and resets the derived cache; an entry NAME that does not
            // round-trip cannot be addressed to delete it, so a reset would report work it
            // did not do. That one propagates (ISS-069), which is what `other` gives it.
            defineOwn(err, "code", "EBADMSG");
            throw err;
          }
          return name;
        });
      });
    },
    lstat(path) {
      return wrap("lstat", path, () => toStat(fs.lstatSync(path, { bigint: true })));
    },
    openExclusive(path) {
      // "wx" is the exclusive create the store relies on; the mode argument is a
      // umask-filtered request, so the store sets and verifies the mode on the fd instead.
      return wrap("openExclusive", path, () => {
        return newHandle(fs.openSync(path, "wx", 0o600));
      });
    },
    write(handle, bytes, offset) {
      // ONE syscall. Short writes are real, and the retry loop lives in the core so each
      // retry carries its own authority assertion — a loop here would keep writing after a
      // lock transfer.
      return wrap("write", "<fd>", () =>
        fs.writeSync(fdOf(handle, "write"), bytes, offset, bytes.length - offset),
      );
    },
    fchmod(handle, mode) {
      wrap("fchmod", "<fd>", () => fs.fchmodSync(fdOf(handle, "fchmod"), mode));
    },
    fstat(handle) {
      return wrap("fstat", "<fd>", () =>
        toStat(fs.fstatSync(fdOf(handle, "fstat"), { bigint: true })),
      );
    },
    close(handle) {
      wrap("close", "<fd>", () => {
        const fd = fdOf(handle, "close");
        // Revoked BEFORE the syscall, and unconditionally. `closeSync` can throw (EIO on some
        // filesystems) with the descriptor nevertheless released, so a mapping kept until
        // "close succeeded" is a mapping that outlives its fd — and the next open reuses the
        // number. A handle is dead the moment close is attempted, whatever close reports.
        weakDelete(HANDLE_FD, handle);
        fs.closeSync(fd);
      });
    },
    rename(from, to) {
      wrap("rename", from, () => fs.renameSync(from, to));
    },
    unlink(path) {
      wrap("unlink", path, () => fs.unlinkSync(path));
    },
    mkdir(path, mode) {
      // One level, never recursive: recursive mkdir modes are umask-filtered and can leave
      // a directory the writer cannot use and cannot repair.
      //
      // The mode is passed to mkdir(2) rather than applied only by the chmod that follows.
      // Omitting it means Node requests 0777, so under the ordinary umask 022 the directory
      // exists as 0755 — group- and world-traversable — for the whole interval until the
      // chmod lands. For a store whose privacy contract is "exactly 0700, always", a window
      // is a violation, not a rounding error. The mode here is still a umask-filtered
      // REQUEST, which is why the caller's chmod stays: this closes the permissive direction
      // (022), the chmod closes the restrictive one (0200).
      wrap("mkdir", path, () => fs.mkdirSync(path, { mode }));
    },
    rmdir(path) {
      wrap("rmdir", path, () => fs.rmdirSync(path));
    },
  };
}
