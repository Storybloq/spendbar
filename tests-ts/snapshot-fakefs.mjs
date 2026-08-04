// In-memory SnapshotFs with failure injection, shared by the T-010 suites.
//
// The store's whole failure story is specified against injected faults at named boundaries,
// so the fake is the test apparatus, not a convenience: every seam call is recorded (which is
// how the "zero mutating seam calls" and "assertHeld immediately before" assertions are made,
// rather than asserted about prose), and any call can be made to fail with a real errno code.
//
// FIDELITY IS THE POINT. A fake that diverges from the kernel in the store's favour turns the
// suite decorative: the earlier version modelled symlinks as a set of paths that were also
// files, never listed them in a directory, could not remove one, and followed nothing — so
// every symlink and reset-convergence proof written against it was proving a property of the
// fake. Paths here resolve like paths: one node per name, intermediate symlinks followed,
// final component followed or not according to the call, parents checked for existence and
// type, and the errno the kernel would raise raised here.
//
// It is not a filesystem simulator. Hard links, permission ENFORCEMENT (modes are recorded
// and checked, never enforced against the caller), atime/mtime, and partial-page writes are
// all absent, and no test may depend on them. Where a proof needs the real thing — the
// umask window, symlink traversal end to end — the suite runs against `createNodeSnapshotFs`
// in a temp directory instead, and a conformance test pins the two implementations together.

import { createWriteAuthority, TERMINATED } from "../dist/snapshot/authority.js";
import { classifyFsError } from "../dist/snapshot/errors.js";
import { freeze, weakDelete, weakGet, weakSet } from "../dist/snapshot/intrinsics.js";

/**
 * File-type bits, because `SnapshotStat.mode` is documented as the RAW mode and the adapter
 * returns `Number(stat.mode)` — which carries S_IFMT. Returning permission bits alone made this
 * fake disagree with the kernel in a direction that hides bugs: a store that compared
 * `stat.mode` against `0o600` or `0o700` DIRECTLY, with no mask, passed every test in this suite
 * and rejected every real file and directory on disk.
 */
const TYPE_BITS = {
  file: 0o100000,
  dir: 0o040000,
  symlink: 0o120000,
  fifo: 0o010000,
};

/** The raw mode the kernel would report for a node. */
function rawMode(node) {
  return node.mode | (TYPE_BITS[node.type] ?? 0);
}

/**
 * An injected fault. Deliberately BRANDED through the same seam-boundary classifier the real
 * adapter uses — the fake is a `SnapshotFs` implementation, so it owes the core the same
 * contract: the core classifies by brand, never by reading a thrown value.
 */
export function errno(code, message = code, cause = undefined) {
  const native = cause === undefined ? new Error(message) : new Error(message, { cause });
  native.code = code;
  return classifyFsError("injected", "<injected>", native);
}

const MAX_SYMLINK_DEPTH = 32;

function splitPath(path) {
  return path.split("/").filter((part) => part !== "");
}

function joinPath(parts) {
  return `/${parts.join("/")}`;
}

/** Collapses "." and ".." the way path resolution does, without escaping the root. */
function normalize(path) {
  const out = [];
  for (const part of splitPath(path)) {
    if (part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return joinPath(out);
}

/**
 * A relative path is REFUSED, not silently rooted at "/".
 *
 * The fake has no working directory, so `foo/bar` would resolve as `/foo/bar` — which the real
 * adapter resolves against `process.cwd()`, somewhere else entirely. Every path the store
 * builds is absolute by construction, so a relative one reaching this seam is a bug in a
 * fixture, and quietly answering about a different path is the worst available response: the
 * test passes, against a filesystem the store will never see.
 */
function assertAbsolute(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(
      `FakeFs models no working directory, so it takes absolute paths only; got ${JSON.stringify(path)}`,
    );
  }
}

/** A hook registry that refuses a name nothing dispatches. See `FakeFs.HOOKABLE_OPS`. */
class HookMap extends Map {
  set(op, fn) {
    if (!FakeFs.HOOKABLE_OPS.has(op)) {
      throw new Error(
        `FakeFs dispatches no hook for ${JSON.stringify(op)}; a hook here would never fire. ` +
          `Hookable: ${[...FakeFs.HOOKABLE_OPS].sort().join(", ")}`,
      );
    }
    return super.set(op, fn);
  }
}

export class FakeFs {
  constructor() {
    // Every node carries an identity, because the store compares a live descriptor against a
    // name to decide whether the staging file was swapped. A fake without identity cannot
    // model that question, let alone answer it the way the kernel does.
    //
    // BigInt, and starting ABOVE 2^53, on purpose. Real inode numbers are 64-bit and XFS and
    // btrfs hand out values in this range routinely; the store read them as `Number` until
    // this round, which silently collapsed distinct files onto one value. Small counters
    // could never have caught that — the fake would have agreed with the bug. Identities are
    // also never REUSED after a delete, which matches the guarantee the store actually relies
    // on (an identity is stable for the life of a comparison) without pretending the kernel
    // never recycles an inode, since nothing here depends on it not doing so.
    this.nextIno = 9007199254740993n; // 2^53 + 1: the first integer a double cannot represent
    /**
     * The device new nodes are created on. Assignable, because identity is `(dev, ino)` and a
     * fake where every node shares one device cannot fail if production compares `ino` alone —
     * an entry replaced by a file on ANOTHER device with a coincidentally equal inode number
     * would then be accepted, which is precisely what the pair exists to reject. Fixtures set
     * this to mint a node on a different device.
     */
    this.nextDev = 1n;
    /** Absolute path -> node. Exactly one node per name, as on a real filesystem. */
    this.nodes = new Map([["/", this.#node({ type: "dir", mode: 0o755 })]]);
    /** Every seam call, in order: { op, path }. */
    this.calls = [];
    /** op -> (path) => void ; throw from here to inject a fault. */
    this.hooks = new HookMap();
    this.nextFd = 1;
    this.open = new Map();
    // A umask the real adapter refuses at construction must not be configurable here either.
    // `assertUmaskAllowsOwnerModes` rejects any mask removing owner READ, because the
    // create-then-fchmod repair has to reopen the directory it just made. A fixture running
    // under a mask production refuses is a fixture proving something about a configuration that
    // cannot exist.
    this._umaskBits = 0;
  }

  /**
   * Seam methods that CHANGE the store, used by the gating assertions.
   *
   * The three sets below partition `SnapshotFs` exhaustively, and a conformance test asserts
   * that they do — so a seam method added without being classified fails the suite instead of
   * silently escaping the "assertHeld immediately before every mutation" check.
   */
  static MUTATING_OPS = new Set([
    "openExclusive",
    "write",
    "fchmod",
    "rename",
    "unlink",
    "mkdir",
    "rmdir",
  ]);

  /** Pure observation: safe to run without authority, and never gated. */
  static READ_OPS = new Set([
    "readFile",
    "openRead",
    "openDir",
    "readAll",
    "listDir",
    "lstat",
    "fstat",
  ]);

  /**
   * Resource cleanup. `close` releases a descriptor: it publishes nothing, removes nothing,
   * and renames nothing, so it is deliberately NOT authority-gated and must run even after
   * authority is lost — gating it would leak the fd until the process exited.
   */
  static CLEANUP_OPS = new Set(["close"]);

  /**
   * Every name `#record` (or `recordAuthorityAssertion`) actually dispatches.
   *
   * Guarded on `set` rather than merely documented, because the failure mode is silence: a hook
   * registered under a name nothing dispatches is accepted, never fires, and the test that
   * arranged it reports success for a race it did not run. That is not a hypothetical — it is
   * the defect this class was just fixed for, and a typo (`"chmod"` for `"fchmod"`) reproduces
   * it exactly. A fixture that asks for an impossible hook now finds out immediately.
   */
  static get HOOKABLE_OPS() {
    return new Set([
      ...FakeFs.MUTATING_OPS,
      ...FakeFs.READ_OPS,
      ...FakeFs.CLEANUP_OPS,
      "assertHeld",
    ]);
  }

  /** Emits short writes, so the core's retry loop — and its per-retry gate — is exercised. */
  shortWriteLimit = Infinity;

  mutations() {
    return this.calls.filter((c) => FakeFs.MUTATING_OPS.has(c.op));
  }

  // ---------------------------------------------------------------------------------------
  // Path resolution
  // ---------------------------------------------------------------------------------------

  /**
   * Walks `path` one component at a time, following intermediate symlinks.
   *
   * `followFinal` is the whole distinction between `stat` and `lstat`, and between `unlink`
   * (removes the link) and `chmod` (changes the target). Getting it wrong in a fake is how a
   * symlink defence comes to be "proved" by a test that never had a symlink in the way.
   */
  #resolve(path, { followFinal, depth = 0 }) {
    if (depth > MAX_SYMLINK_DEPTH) throw errno("ELOOP", `too many symlinks: ${path}`);
    assertAbsolute(path);
    const parts = splitPath(path);
    let current = "";

    for (let i = 0; i < parts.length; i++) {
      const isFinal = i === parts.length - 1;
      current = `${current}/${parts[i]}`;
      const node = this.nodes.get(current);

      if (node === undefined) {
        if (isFinal) return { path: current, node: null };
        throw errno("ENOENT", `no such path: ${current}`);
      }

      if (node.type === "symlink" && (!isFinal || followFinal)) {
        // A relative target is spliced against the LINK's directory and then normalized, dot
        // and dot-dot included. Without the normalization a target like `../../victim`
        // resolved as a literal path containing ".." — which matched nothing, so the common
        // form of the escape this suite exists to catch was silently unmodellable while the
        // absolute form passed.
        const target = node.target.startsWith("/")
          ? node.target
          : `${current.slice(0, current.lastIndexOf("/"))}/${node.target}`;
        const rest = parts.slice(i + 1);
        const spliced = rest.length === 0 ? target : `${target}/${rest.join("/")}`;
        return this.#resolve(normalize(spliced), { followFinal, depth: depth + 1 });
      }

      if (!isFinal && node.type !== "dir") {
        throw errno("ENOTDIR", `not a directory: ${current}`);
      }

      if (isFinal) return { path: current, node };
    }

    return { path: "/", node: this.nodes.get("/") };
  }

  /** Resolves the PARENT of `path`, requiring it to exist and be a directory. */
  #resolveParent(path) {
    // The SAME check as #resolve, and it has to be here too: creation paths
    // (openExclusive, mkdir, and a rename DESTINATION) never reach #resolve at all, so
    // guarding only that one left the exact behaviour this refusal was added to remove —
    // a relative destination silently rooted at "/".
    assertAbsolute(path);
    const parts = splitPath(path);
    const name = parts[parts.length - 1];
    const parentPath = parts.length <= 1 ? "/" : joinPath(parts.slice(0, -1));
    const parent = this.#resolve(parentPath, { followFinal: true });
    if (parent.node === null) throw errno("ENOENT", `no such directory: ${parentPath}`);
    if (parent.node.type !== "dir") throw errno("ENOTDIR", `not a directory: ${parentPath}`);
    return { dir: parent.path, name, full: parent.path === "/" ? `/${name}` : `${parent.path}/${name}` };
  }

  #childNames(dirPath) {
    const prefix = dirPath === "/" ? "/" : `${dirPath}/`;
    const names = new Set();
    for (const key of this.nodes.keys()) {
      if (key === dirPath || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.length === 0) continue;
      names.add(rest.split("/")[0]);
    }
    return [...names].sort();
  }

  /** Stamps a fresh identity onto a new node. `dev` is constant: one fake device. */
  #node(fields) {
    return { dev: this.nextDev, ino: this.nextIno++, ...fields };
  }

  /**
   * Records one seam call.
   *
   * `paths` carries EVERY pathname operand, not just the first. `rename` takes two, and a
   * trace that kept only the source made an inside-to-outside rename invisible to any
   * containment assertion built on the trace — the destination is precisely the operand that
   * would leave the root. `path` stays as the primary operand because hooks and the existing
   * assertions are keyed on it.
   */
  /**
   * Records the AUTHORITY GATE and dispatches its hook.
   *
   * `assertHeld` is not a filesystem operation, so it does not belong in `#record`'s seam
   * dispatch — but it is the single most interesting point in the store's timeline, because it
   * is the one place caller-supplied code is guaranteed to run between a check and the mutation
   * it guards. A fixture that wants to swap a directory "during the gate" is describing exactly
   * that instant, and until now the only way to express it was to hand-roll an inner authority:
   * the gate entry was pushed straight onto `calls`, so `hooks.set("assertHeld", ...)` was
   * accepted and then never called. One test had already been caught passing vacuously that
   * way. This makes the gate hookable like any other op; `HOOKABLE_OPS` below makes the
   * silent-no-op impossible for every other name.
   */
  recordAuthorityAssertion() {
    this.#record("assertHeld", null);
  }

  get umaskBits() {
    return this._umaskBits;
  }

  set umaskBits(mask) {
    if ((0o700 & ~mask & 0o400) === 0) {
      throw new Error(
        `FakeFs refuses umask ${mask.toString(8).padStart(4, "0")} for the same reason the real ` +
          `adapter does: it removes owner READ from a 0700 directory, so the create-then-fchmod ` +
          `repair cannot reopen what it created`,
      );
    }
    this._umaskBits = mask;
  }

  #record(op, path, alsoPaths = []) {
    this.calls.push({
      op,
      path,
      paths: [...(path === null ? [] : [path]), ...alsoPaths],
    });
    const hook = this.hooks.get(op);
    if (hook) hook(path);
  }

  // ---------------------------------------------------------------------------------------
  // Fixture construction (not seam calls — these bypass hooks and recording on purpose)
  // ---------------------------------------------------------------------------------------

  mkdirp(path, mode = 0o700) {
    const parts = splitPath(path);
    let current = "";
    for (const part of parts) {
      current = `${current}/${part}`;
      if (!this.nodes.has(current)) this.nodes.set(current, this.#node({ type: "dir", mode }));
    }
  }

  put(path, data, mode = 0o600) {
    const parts = splitPath(path);
    this.mkdirp(joinPath(parts.slice(0, -1)));
    this.nodes.set(path, this.#node({ type: "file", mode, bytes: Buffer.from(data, "utf8") }));
  }

  /**
   * A file whose contents are RAW BYTES rather than a JS string.
   *
   * `put` takes a string, so before this there was no way to build a fixture holding bytes that
   * are not valid UTF-8 — which is exactly the input the fatal decoder above exists to refuse.
   * A guard with no reachable fixture is a guard the suite cannot falsify.
   */
  putBytes(path, bytes, mode = 0o600) {
    const parts = splitPath(path);
    this.mkdirp(joinPath(parts.slice(0, -1)));
    this.nodes.set(path, this.#node({ type: "file", mode, bytes: Buffer.from(bytes) }));
  }

  /** A real symlink: an entry that HOLDS a target, is listed, and can be unlinked. */
  symlink(path, target) {
    this.nodes.set(path, this.#node({ type: "symlink", mode: 0o777, target }));
  }

  /**
   * A FIFO at `path`.
   *
   * Modelled because the store makes two claims about one, and without a node type for it
   * neither could be falsified here: that `openRead` does not BLOCK on it (the adapter passes
   * O_NONBLOCK, without which `open(2)` waits for a writer and the refusal below is never
   * reached), and that the descriptor is then refused for not being a regular file. The real
   * kernel answers the first one, and `snapshot-realfs.test.mjs` asks it there with an actual
   * `mkfifo`; what this models is the second, so a weakened `isFile` check fails here too
   * rather than only in the file that needs a shell binary to run.
   */
  mkfifo(path, mode = 0o600) {
    this.nodes.set(path, this.#node({ type: "fifo", mode }));
  }

  /**
   * Forces a node's identity, for cases the allocator cannot produce on its own.
   *
   * Two of them matter and neither is reachable otherwise: a replacement on a DIFFERENT DEVICE
   * with an equal inode number (which an `ino`-only comparison wrongly accepts), and a pair of
   * distinct 64-bit inodes that collide once converted to a double (which is what makes the
   * bigint migration falsifiable rather than merely present).
   */
  setIdentity(path, { dev, ino }) {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`setIdentity: nothing at ${path}`);
    if (dev !== undefined) node.dev = dev;
    if (ino !== undefined) node.ino = ino;
  }

  /** Sets a mode without going through the seam — no hook, no recorded call. */
  chmodDirect(path, mode) {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`chmodDirect: nothing at ${path}`);
    node.mode = mode;
  }

  /**
   * Moves a subtree without going through the seam, PRESERVING node identity.
   *
   * Identity preservation is the entire point. These fixtures ask whether the store notices
   * that a path now refers to a different directory, so the substitute has to arrive carrying
   * its own `(dev, ino)` — a helper that re-created nodes at the new paths would mint fresh
   * identities and the swap would be detectable for the wrong reason.
   */
  renameDirect(from, to) {
    const moved = [];
    for (const [path, node] of this.nodes) {
      if (path === from || path.startsWith(`${from}/`)) moved.push([path, node]);
    }
    if (moved.length === 0) throw new Error(`renameDirect: nothing at ${from}`);
    for (const [path] of moved) this.nodes.delete(path);
    for (const [path, node] of moved) this.nodes.set(`${to}${path.slice(from.length)}`, node);
  }

  /**
   * A deep copy of the filesystem, for CRASH simulation.
   *
   * Throwing from a hook is not a crash: the store's `catch` and `finally` still run, so
   * staging is cleaned up and descriptors are closed. A real crash runs none of that, which
   * makes the directory state it leaves strictly dirtier than anything an injected exception
   * produces — and recovery from that dirtier state is what AC 1(d) actually asks about.
   * Capturing here and restoring afterwards discards everything the unwinding did.
   */
  captureState() {
    const out = new Map();
    for (const [path, node] of this.nodes) {
      out.set(path, { ...node, ...(node.bytes ? { bytes: Buffer.from(node.bytes) } : {}) });
    }
    return out;
  }

  restoreState(state) {
    this.nodes = new Map();
    for (const [path, node] of state) {
      this.nodes.set(path, { ...node, ...(node.bytes ? { bytes: Buffer.from(node.bytes) } : {}) });
    }
    // A crashed process's descriptors are all gone.
    this.open = new Map();
  }

  /** Raw bytes at a path, for byte-identity assertions. */
  bytesAt(path) {
    const node = this.nodes.get(path);
    return node && node.type === "file" ? Buffer.from(node.bytes) : null;
  }

  /** A snapshot of every file's bytes, for "byte-identical after the failure" assertions. */
  snapshotBytes() {
    const out = new Map();
    for (const [path, node] of this.nodes) {
      if (node.type === "file") out.set(path, node.bytes.toString("hex"));
    }
    return out;
  }

  // ---- compatibility views over the node map, so fixtures read naturally ----

  get files() {
    const nodes = this.nodes;
    return {
      has: (p) => nodes.get(p)?.type === "file",
      get: (p) => {
        const node = nodes.get(p);
        if (!node || node.type !== "file") return undefined;
        return {
          get data() {
            return node.bytes.toString("utf8");
          },
          set data(value) {
            node.bytes = Buffer.from(value, "utf8");
          },
          get mode() {
            return node.mode;
          },
          set mode(value) {
            node.mode = value;
          },
        };
      },
      set: (p, { data, mode = 0o600 }) => {
        nodes.set(p, { dev: this.nextDev, ino: this.nextIno++, type: "file", mode, bytes: Buffer.from(data, "utf8") });
      },
      delete: (p) => nodes.delete(p),
      keys: () => [...nodes].filter(([, n]) => n.type === "file").map(([p]) => p),
    };
  }

  get dirs() {
    const nodes = this.nodes;
    return {
      has: (p) => nodes.get(p)?.type === "dir",
      get: (p) => {
        const node = nodes.get(p);
        if (!node || node.type !== "dir") return undefined;
        return {
          get mode() {
            return node.mode;
          },
          set mode(value) {
            node.mode = value;
          },
        };
      },
      keys: () => [...nodes].filter(([, n]) => n.type === "dir").map(([p]) => p),
    };
  }

  /** Fails the next `count` calls to `op` whose path matches `match`. */
  failOn(op, match, error, count = Infinity) {
    let remaining = count;
    this.hooks.set(op, (path) => {
      if (remaining > 0 && (match === null || (path !== null && path.includes(match)))) {
        remaining -= 1;
        throw error;
      }
    });
  }

  clearHooks() {
    this.hooks.clear();
  }

  // ---------------------------------------------------------------------------------------
  // The SnapshotFs seam
  // ---------------------------------------------------------------------------------------

  readFile(path) {
    this.#record("readFile", path);
    const { node } = this.#resolve(path, { followFinal: true });
    if (node === null) throw errno("ENOENT", `no such file: ${path}`);
    if (node.type === "dir") throw errno("EISDIR", `is a directory: ${path}`);
    return this.#decode(node.bytes, path);
  }

  /**
   * A name the real adapter could hand back.
   *
   * `readdirSync` is read as bytes there and every entry must round-trip UTF-8, so a name with
   * a lone surrogate — which a JS fixture can hold and a filesystem cannot — is refused. The
   * fake accepted it, which let a fixture assert store behaviour on an entry name production
   * would never deliver.
   */
  #assertRepresentableName(name, dir) {
    if (Buffer.from(name, "utf8").toString("utf8") !== name) {
      // EBADMSG, matching the real adapter, and the code is the whole behaviour here.
      // `EILSEQ` now classifies as `invalid-content`, which `readStoreFile` converts into an
      // unusable artifact and the store RESETS on. A bad entry NAME must not do that: the store
      // cannot address such a name to delete it, so a reset would report work it could not
      // perform, and production therefore lets it propagate (ISS-069). Left on EILSEQ, the fake
      // would have made the store reset exactly where production propagates — the fake being
      // the divergent one, which is the failure this file has already been caught in once.
      throw errno("EBADMSG", `an entry name in ${dir} does not round-trip UTF-8`);
    }
  }

  listDir(path) {
    this.#record("listDir", path);
    const resolved = this.#resolve(path, { followFinal: true });
    if (resolved.node === null) throw errno("ENOENT", `no such dir: ${path}`);
    if (resolved.node.type !== "dir") throw errno("ENOTDIR", `not a directory: ${path}`);
    const names = this.#childNames(resolved.path);
    for (const name of names) this.#assertRepresentableName(name, path);
    return names;
  }

  lstat(path) {
    this.#record("lstat", path);
    const { node } = this.#resolve(path, { followFinal: false });
    if (node === null) throw errno("ENOENT", `no such path: ${path}`);
    return {
      mode: rawMode(node),
      isFile: node.type === "file",
      isDirectory: node.type === "dir",
      isSymbolicLink: node.type === "symlink",
      dev: node.dev,
      ino: node.ino,
    };
  }

  /**
   * UTF-8 decoding that REFUSES invalid bytes, because the real adapter does.
   *
   * The fake held `bytes` as a Buffer and called `.toString("utf8")`, which substitutes U+FFFD
   * silently — so a fixture carrying corrupt bytes decoded into a clean-looking string here and
   * was refused in production. Every proof the suite builds about what the store does with a
   * corrupt artifact was therefore a proof about a DIFFERENT input than production sees, which
   * is the one failure a test double must not have.
   */
  static STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

  /**
   * Descriptors, keyed by handle IDENTITY — the same capability model the real adapter uses.
   *
   * The fake returned `{ __brand, fd }` and every method looked up `handle.fd`, so a literal
   * with the right brand and any number reached a descriptor, and a genuine handle kept working
   * after close. The adapter refuses both with EBADF. That divergence is worse than an ordinary
   * one: the store's handle discipline is exactly what the descriptor-based read exists to
   * enforce, and the fake — which is where the whole suite's proofs are built — was the lenient
   * one. A store bug here would have been invisible in 270 tests and live in production.
   */
  #handles = new WeakMap();

  /** The descriptor entry for a live handle, or EBADF. Reads nothing off the caller's value. */
  #entryOf(handle) {
    if (typeof handle !== "object" || handle === null) return null;
    // Through the PINNED intrinsic, exactly as the adapter does. A dynamic
    // `this.#handles.get(handle)` re-reads `get` off `WeakMap.prototype`, so a fixture that
    // patches that global — and this suite now has three that patch globals — would resolve a
    // forged handle here while the same patch is harmless against production. A fake that is
    // weaker than the thing it stands in for cannot falsify the thing it stands in for.
    return weakGet(this.#handles, handle) ?? null;
  }

  /**
   * The descriptor entry behind a handle — for FIXTURES, which used to reach into `open` by
   * `handle.fd` and cannot now that a handle carries nothing. Null for a closed or foreign one,
   * so a fixture that loses its grip fails rather than silently observing nothing.
   */
  entryFor(handle) {
    return this.#entryOf(handle);
  }

  #newHandle(entry) {
    const handle = freeze({ __brand: "SnapshotFileHandle" });
    weakSet(this.#handles, handle, entry);
    return handle;
  }

  #decode(bytes, what) {
    try {
      return FakeFs.STRICT_UTF8.decode(bytes);
    } catch (cause) {
      // The DECODER'S OWN ERROR travels with the errno, exactly as `decodeUtf8` preserves it in
      // the adapter. Dropping it here was a divergence that could not be caught from this side:
      // `StoreFileRead.cause` exists so that the one value naming WHERE the bytes went wrong
      // reaches the reset diagnostic, and a fake that never supplies one cannot fail when the
      // store stops forwarding it.
      throw errno("EILSEQ", `${what} is not valid UTF-8`, cause);
    }
  }

  openRead(path) {
    this.#record("openRead", path);
    // O_NOFOLLOW: the FINAL component is not followed, and a symlink there is ELOOP rather
    // than a resolution. Intermediate components still resolve, exactly as the kernel does.
    const { path: full, node } = this.#resolve(path, { followFinal: false });
    if (node === null) throw errno("ENOENT", `no such path: ${path}`);
    if (node.type === "symlink") throw errno("ELOOP", `symlink at final component: ${path}`);
    const fd = this.nextFd++;
    // Bound to the NODE, like every other descriptor here: that binding is the whole reason
    // the store opens before it validates.
    // O_RDONLY, so the descriptor is readable and NOT writable. The adapter opens with
    // `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and the kernel answers EBADF for a write through it;
    // a fake that let one through would leave a store regression that mixes read and write
    // handles green here and broken on disk.
    const entry = { fd, node, path: full, position: 0, readable: true, writable: false };
    this.open.set(fd, entry);
    return this.#newHandle(entry);
  }

  readAll(handle, maxBytes) {
    const entry = this.#entryOf(handle);
    this.#record("readAll", entry ? entry.path : null);
    if (!entry) throw errno("EBADF", "bad file descriptor");
    // A WRITE-ONLY descriptor cannot be read. `openExclusive` is `wx` — O_WRONLY | O_CREAT |
    // O_EXCL — and `read(2)` through it is EBADF; the fake used to hand back the file's bytes,
    // so a store that read from the handle it was writing worked here and failed on disk.
    if (!entry.readable) throw errno("EBADF", "descriptor is not open for reading");
    if (entry.node.type === "dir") throw errno("EISDIR", "is a directory");
    // A non-blocking FIFO with NO WRITER reads EOF — zero bytes — not EAGAIN. EAGAIN is what a
    // reader gets when a writer is open and there is simply nothing buffered yet, which is a
    // state no fixture here creates. Reaching this line at all means the store failed to refuse
    // the descriptor on its `fstat`, which is the thing under test; modelling the wrong errno
    // would mean the failure it produced was one the kernel could not produce.
    if (entry.node.type === "fifo") return "";
    // The bound is enforced on BYTES, matching the adapter, and it is an error rather than a
    // truncation: handing back a short read would let the store checksum a prefix of a file and
    // decide it was the file.
    if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw errno("EINVAL", "readAll needs a byte bound");
    }
    // From the descriptor's POSITION, advancing it — as the adapter's read loop does. Returning
    // the whole inode on every call, and applying the bound to the whole inode, meant a store
    // that accidentally read one handle twice got the complete file twice here and a second
    // EMPTY read in production. A double-read bug would have passed only under the fake, which
    // is precisely the divergence class that makes a fake-suite proof worth less than it looks.
    const remaining = entry.node.bytes.subarray(entry.position);
    if (remaining.length > maxBytes) {
      throw errno("EFBIG", `read exceeded ${maxBytes} bytes`);
    }
    entry.position = entry.node.bytes.length;
    return this.#decode(remaining, entry.path);
  }

  openDir(path) {
    this.#record("openDir", path);
    // O_NOFOLLOW | O_DIRECTORY: a final-component symlink is ELOOP and anything that is not a
    // directory is ENOTDIR, both refused by the kernel before a descriptor exists.
    const { path: full, node } = this.#resolve(path, { followFinal: false });
    if (node === null) throw errno("ENOENT", `no such path: ${path}`);
    if (node.type === "symlink") throw errno("ELOOP", `symlink at final component: ${path}`);
    if (node.type !== "dir") throw errno("ENOTDIR", `not a directory: ${path}`);
    const fd = this.nextFd++;
    // O_RDONLY | O_DIRECTORY. Readable in the access-mode sense — `read(2)` on it is EISDIR,
    // which is a different refusal and is modelled separately below.
    const entry = { fd, node, path: full, position: 0, readable: true, writable: false };
    this.open.set(fd, entry);
    return this.#newHandle(entry);
  }

  openExclusive(path) {
    this.#record("openExclusive", path);
    const { full } = this.#resolveParent(path);
    // `wx` refuses ANY existing entry, including a directory or a dangling symlink — it is
    // O_EXCL, not "overwrite unless it happens to be a file".
    if (this.nodes.has(full)) throw errno("EEXIST", `exists: ${path}`);
    // A umask-filtered create: the requested 0600 is masked, which is exactly why the store
    // fchmods afterwards instead of trusting the open mode.
    const node = this.#node({ type: "file", mode: 0o600 & ~this.umaskBits, bytes: Buffer.alloc(0) });
    this.nodes.set(full, node);
    const fd = this.nextFd++;
    // The NODE, not the path. A real descriptor stays bound to the inode it opened: rename the
    // name, unlink it, or replace it, and the descriptor still reads and writes the original
    // file. Looking the pathname up again on every write modelled the opposite — a replacement
    // at the same name would have RECEIVED this writer's bytes — which is exactly backwards
    // for the staging-swap proof.
    // `wx` is O_WRONLY | O_CREAT | O_EXCL: write-only. `readAll` through it is EBADF on a real
    // filesystem, and the store must never need one.
    const entry = { fd, node, path: full, position: 0, readable: false, writable: true };
    this.open.set(fd, entry);
    return this.#newHandle(entry);
  }

  write(handle, bytes, offset) {
    const entry = this.#entryOf(handle);
    this.#record("write", entry ? entry.path : null);
    if (!entry) throw errno("EBADF", "bad file descriptor");
    // A READ-ONLY descriptor cannot be written. `openRead` and `openDir` are both O_RDONLY, and
    // `write(2)` through either is EBADF on a real filesystem.
    if (!entry.writable) throw errno("EBADF", "descriptor is not open for writing");
    const node = entry.node;
    const remaining = bytes.length - offset;
    const n = Math.min(remaining, this.shortWriteLimit);
    // RAW BYTES at the descriptor's position. Decoding each short chunk as UTF-8 and
    // concatenating strings — what this used to do — inserts U+FFFD whenever a short write
    // splits a multibyte character, which invents checksum failures the kernel would never
    // produce and hides offset bugs whenever the fixture happens to be ASCII.
    const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + offset, n);
    const end = entry.position + n;
    if (end > node.bytes.length) {
      const grown = Buffer.alloc(end);
      node.bytes.copy(grown, 0);
      node.bytes = grown;
    }
    chunk.copy(node.bytes, entry.position);
    entry.position = end;
    return n;
  }

  fchmod(handle, mode) {
    const entry = this.#entryOf(handle);
    this.#record("fchmod", entry ? entry.path : null);
    if (!entry) throw errno("EBADF", "bad file descriptor");
    entry.node.mode = mode;
  }

  fstat(handle) {
    const entry = this.#entryOf(handle);
    this.#record("fstat", entry ? entry.path : null);
    if (!entry) throw errno("EBADF", "bad file descriptor");
    const node = entry.node;
    // Derived from the NODE, not hardcoded. Reporting every descriptor as a regular file made
    // the store's "is this actually a regular file" check unfalsifiable here: a directory or a
    // FIFO opened at an artifact name answered `isFile: true`, so the refusal could be deleted
    // and this suite would stay green. A fake that agrees with the bug is worse than no fake.
    return {
      mode: rawMode(node),
      isFile: node.type === "file",
      isDirectory: node.type === "dir",
      isSymbolicLink: node.type === "symlink",
      dev: node.dev,
      ino: node.ino,
    };
  }

  close(handle) {
    const entry = this.#entryOf(handle);
    // The HOOK fires first, the descriptor is revoked in `finally`.
    //
    // Releasing the fd before dispatching modelled close(2) correctly (it always consumes the
    // descriptor, EIO included) and broke the suite's other rule: every hook fires BEFORE its
    // operation, and every close-window fixture is written against that boundary. Observers
    // were silently landing AFTER the close they were placed to observe. Both rules hold this
    // way — the hook sees the pre-close state, and an injected close failure still consumes the
    // descriptor on its way out.
    try {
      this.#record("close", entry ? entry.path : null);
    } finally {
      if (entry) this.open.delete(entry.fd);
      if (entry) weakDelete(this.#handles, handle);
    }
    // The kernel gives EBADF for an unknown or already-closed descriptor. Succeeding silently
    // made an accidental double close visible only through trace counting, which is a weaker
    // guarantee than the close-exactly-once tests claim to have.
    if (!entry) throw errno("EBADF", "bad file descriptor");
  }

  rename(from, to) {
    this.#record("rename", from, [to]);
    const source = this.#resolve(from, { followFinal: false });
    if (source.node === null) throw errno("ENOENT", `no such file: ${from}`);
    const target = this.#resolveParent(to);

    const existing = this.nodes.get(target.full);
    if (existing !== undefined) {
      if (existing.type === "dir" && source.node.type !== "dir") {
        throw errno("EISDIR", `is a directory: ${to}`);
      }
      if (existing.type !== "dir" && source.node.type === "dir") {
        throw errno("ENOTDIR", `not a directory: ${to}`);
      }
      if (existing.type === "dir" && this.#childNames(target.full).length > 0) {
        throw errno("ENOTEMPTY", `not empty: ${to}`);
      }
    }

    // Move the node and, for a directory, everything beneath it.
    const moved = [];
    for (const [path, node] of this.nodes) {
      if (path === source.path || path.startsWith(`${source.path}/`)) {
        moved.push([path, node]);
      }
    }
    for (const [path] of moved) this.nodes.delete(path);
    this.nodes.delete(target.full);
    for (const [path, node] of moved) {
      this.nodes.set(`${target.full}${path.slice(source.path.length)}`, node);
    }
  }

  unlink(path) {
    this.#record("unlink", path);
    // No-follow: unlink removes the LINK, never what it points at. A fake that could not
    // remove a symlink made a reset look non-convergent for the wrong reason.
    const { path: resolved, node } = this.#resolve(path, { followFinal: false });
    if (node === null) throw errno("ENOENT", `no such file: ${path}`);
    // The PLATFORM's code, not one of them hardcoded.
    //
    // POSIX specifies EPERM and macOS obeys; Linux returns EISDIR. The fake said EPERM
    // unconditionally, which made the conformance case `unlink on a directory fails rather than
    // removing it` — the test whose entire job is to detect fake/kernel divergence — pass on
    // darwin and FAIL on every Linux CI worker. Worse, the store's own reasoning is written
    // against EISDIR (see `resetStore`'s manifest-directory branch, which exists because
    // `unlink` on a directory wedged the store), so the fake disagreed with the module it was
    // built to model, in a direction no local run could reveal.
    if (node.type === "dir") {
      const code = process.platform === "linux" ? "EISDIR" : "EPERM";
      throw errno(code, `is a directory: ${path}`);
    }
    this.nodes.delete(resolved);
  }

  mkdir(path, mode = 0o777) {
    this.#record("mkdir", path);
    const { full } = this.#resolveParent(path);
    if (this.nodes.has(full)) throw errno("EEXIST", `exists: ${path}`);
    this.nodes.set(full, this.#node({ type: "dir", mode: mode & ~this.umaskBits }));
  }

  rmdir(path) {
    this.#record("rmdir", path);
    const { path: resolved, node } = this.#resolve(path, { followFinal: false });
    if (node === null) throw errno("ENOENT", `no such dir: ${path}`);
    if (node.type !== "dir") throw errno("ENOTDIR", `not a directory: ${path}`);
    if (this.#childNames(resolved).length > 0) throw errno("ENOTEMPTY", `not empty: ${path}`);
    this.nodes.delete(resolved);
  }

}

/**
 * An authority that can be revoked, recording every assertion for ordering checks.
 *
 * What it RETURNS is a genuine `LatchingWriteAuthority` wrapping a revocable inner seam, not
 * a look-alike. The store's entry points are nominally typed at compile time and, at runtime,
 * require membership in a module-private `WeakSet` — NOT `instanceof`, which is forgeable via
 * `Object.create(Proto)` and re-definable through `Symbol.hasInstance`. The guard also arrives
 * frozen, with a frozen prototype, so neither an own property nor a prototype swap can shadow
 * `assertHeld`. A test double that forged the brand would test a store no caller can reach.
 *
 * Returning a different object from a constructor is legal JS and overrides `this`, which is
 * what keeps every existing `new FakeAuthority(fs)` call site working unchanged.
 *
 * Revocation drives the INNER seam, but every assertion the test observes has gone through the
 * real latch: revoke once and the SECOND call throws `AuthorityLostError` from the latch rather
 * than from the inner, exactly as production behaves. There is deliberately no assertion
 * COUNTER — the ordering proofs read `fs.calls`, which records where each assertion fell
 * relative to the mutations, and a bare count could never have answered the question those
 * tests ask.
 *
 * The revoke handle lives in a WeakMap rather than as a property on the returned guard, because
 * the guard is FROZEN. That is not an inconvenience to work around — it is the fix for a real
 * bypass (`guard.assertHeld = () => {}` shadowed the latch), and a fake that could still bolt a
 * property onto a guard would be modelling an object production does not produce. The test
 * double bends to the guarantee; the guarantee does not bend to the test double.
 */
const REVOKE = new WeakMap();

export class FakeAuthority {
  constructor(fakeFs) {
    const state = { held: true };
    const inner = {
      assertHeld() {
        // `paths: []` keeps every trace entry the same shape, so a containment check can
        // iterate `c.paths` over the whole trace without a null special case.
        if (fakeFs) fakeFs.recordAuthorityAssertion();
        if (!state.held) {
          const err = new Error("write authority lost");
          err.name = "AuthorityLostError";
          throw err;
        }
      },
    };
    // The handler must state terminal action or the latch itself throws a contract error.
    const guard = createWriteAuthority(inner, () => TERMINATED);
    REVOKE.set(guard, () => {
      state.held = false;
    });
    return guard;
  }

  /** Drops the inner authority behind a guard this class produced. */
  static revoke(guard) {
    const revoke = REVOKE.get(guard);
    if (revoke === undefined) throw new Error("not a FakeAuthority guard");
    revoke();
  }
}
