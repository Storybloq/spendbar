/**
 * Write-authority guard (T-010 AC 8; T-008 findings 3.5, recorded there as binding on
 * this ticket).
 *
 * Three requirements, all of them testable rather than aspirational:
 *   1. every mutation is preceded by `assertHeld()` with no intervening await;
 *   2. the lock-loss handler must terminate or irreversibly disable publishing;
 *   3. a publish attempted after an observed loss is refused.
 *
 * (1) is a property of the call sites in store.ts and is enforced by a mutant test that
 * deletes an assertion. (2) and (3) live here: the guard LATCHES on the first failure, so
 * publishing is irreversibly disabled by construction even if the handler misbehaves — and
 * a handler that returns without stating it took terminal action is itself an error, so a
 * quietly-returning handler cannot pass unnoticed.
 */
import { AuthorityHandlerContractError, AuthorityLostError } from "./errors.js";
import { apply as APPLY, freeze, isFrozen, prototypeOf, weakSetAdd, weakSetHas } from "./intrinsics.js";
import type { WriteAuthority } from "./types.js";

/**
 * Terminal action taken by a lock-loss handler. Returning this sentinel is the handler's
 * statement that it has terminated the process or irreversibly disabled publishing;
 * throwing is equally acceptable. Returning anything else is a contract violation.
 */
export const TERMINATED = "terminated";

export type LockLossHandler = (cause: unknown) => typeof TERMINATED | never;

/**
 * The assertion path performs no property read on anything a caller can reach — and getting there
 * took four attempts, each of which removed one read and introduced the next one further out.
 *
 * Dispatching as `inner.assertHeld()` re-read the caller's OBJECT on every assertion. Pinning the
 * method and calling `pinned.call(...)` re-read `call` off the caller's FUNCTION. `Reflect.apply`
 * re-read `apply` off a mutable GLOBAL. And `GUARDED.has(value)` below re-read `has` off
 * `WeakSet.prototype` — the collection is module-private and cannot be forged, which is precisely
 * what made it look closed, while the method used to interrogate it could be replaced with
 * `() => true` at any point after this module loaded. A membership test that always answers yes
 * is not a membership test.
 *
 * All of them now come from `./intrinsics.js`, captured at ITS module load, which runs before this
 * one. What that does not claim is stated there: it does not defeat code that patches these
 * globals before the module is imported. It closes the window that exists — between constructing
 * an authority and asserting with it.
 */
/** Frozen so the argument list itself is not a mutable value handed across the boundary. */
const EMPTY_ARGS = freeze([]) as readonly [];

export class LatchingWriteAuthority implements WriteAuthority {
  #inner: WriteAuthority;
  /**
   * The inner `assertHeld`, read ONCE at construction and pinned.
   *
   * Validating `inner.assertHeld` and then dispatching through `this.#inner.assertHeld()` reads
   * the caller's object again on every assertion, and the caller still owns it: `inner.assertHeld
   * = () => {}` after construction, or an accessor that answers with a real function while the
   * constructor is looking and a no-op afterwards, leaves this authority frozen, registered in
   * GUARDED, and passing `assertGuardedAuthority` while asserting nothing. That is AC 8 defeated
   * through the one object the latch does not control. Freezing `this` does not help — the
   * mutable object is the caller's, not this one.
   */
  #innerAssert: () => void;
  #onLost: LockLossHandler;
  #lost = false;

  constructor(inner: WriteAuthority, onLost: LockLossHandler) {
    // SUBCLASSES ARE REFUSED, and this is not defensive tidiness — it was a live bypass.
    // `class Bypass extends LatchingWriteAuthority { assertHeld() {} }` runs this constructor,
    // so the instance was registered in GUARDED and passed `assertGuardedAuthority`, while its
    // own override shadowed the real method: no inner check, no latch, no terminal-action
    // contract. Membership in a private set only proves this constructor ran; it says nothing
    // about which method the store will end up calling.
    if (new.target !== LatchingWriteAuthority) {
      throw new AuthorityHandlerContractError(
        "LatchingWriteAuthority cannot be subclassed; a subclass can override assertHeld " +
          "and would still be registered as a guarded authority",
      );
    }
    if (typeof onLost !== "function") {
      throw new AuthorityHandlerContractError();
    }
    // The INNER authority is checked too, and the asymmetry it replaces had teeth. `onLost` was
    // validated here and `inner` was not, so `createWriteAuthority(null, handler)` built a
    // frozen, registered, fully guarded-looking authority — and the defect surfaced at the
    // first `assertHeld()`, as a TypeError caught by the loss handler. That is not a
    // misleading message, it is the wrong EVENT: under AC 8 the loss handler terminates the
    // process or irreversibly disables publishing, so a constructor argument that was never
    // an authority was reported as a lock this process used to hold and has now lost.
    //
    // Read as an ordinary property, not through a descriptor, because that is exactly how the
    // store will dispatch to it — an own-descriptor check would refuse the legitimate case
    // where `assertHeld` lives on a class prototype, which is what `PortLock` is.
    // Read ONCE, then validated, then pinned — in that order, and the order is the point. Two
    // reads (one to check, one to call) let an accessor answer differently each time, so the
    // value that was checked need not be the value that runs.
    const held =
      typeof inner === "object" && inner !== null
        ? (inner as { assertHeld?: unknown }).assertHeld
        : undefined;
    if (typeof held !== "function") {
      throw new AuthorityHandlerContractError(
        "createWriteAuthority needs an inner authority with an assertHeld() method; " +
          "without one the first assertion reports a lock loss that never happened",
      );
    }
    this.#inner = inner;
    this.#innerAssert = held as () => void;
    this.#onLost = onLost;
    // Registered HERE, in the constructor, so the only way into the set is to have been built
    // by it. Registering in the factory instead would leave `new LatchingWriteAuthority(...)`
    // producing an object the runtime check rejects.
    weakSetAdd(GUARDED, this);
    // FROZEN, because the store calls `authority.assertHeld()` — an ordinary dynamic dispatch,
    // which an OWN property shadows. `guard.assertHeld = () => {}` on a genuine factory result
    // passed every check this module makes and then asserted nothing. Freezing also pins the
    // prototype, so `Object.setPrototypeOf` cannot swap the method out from underneath.
    // Private fields are not properties, so `#lost` still latches.
    freeze(this);
  }

  /** True once a loss has been observed. Never returns to false. */
  get lost(): boolean {
    return this.#lost;
  }

  assertHeld(): void {
    // A loss already observed refuses immediately, without consulting the inner authority:
    // the successor may well hold the lock by now, and a recovered-looking answer must
    // never resurrect a writer that already raced it.
    if (this.#lost) {
      throw new AuthorityLostError();
    }
    try {
      // `Reflect.apply`, NOT `.call` — and that distinction is the whole point of this line.
      //
      // Pinning the function stopped the caller's OBJECT being re-read on every assertion, and
      // then `this.#innerAssert.call(...)` re-read a property off the pinned FUNCTION instead:
      // `call` is an ordinary inherited property of a caller-owned object, so `held.call = () =>
      // undefined` after construction, or a callable Proxy whose `get("call")` answers
      // differently, disarms every assertion while the outer authority stays frozen and branded.
      // The same defect as the one pinning fixed, one level down, reintroduced by the fix.
      //
      // `Reflect.apply` reads NOTHING from the function; the receiver is still the inner
      // authority, so a prototype method such as `PortLock`'s keeps its `this`.
      APPLY(this.#innerAssert, this.#inner, EMPTY_ARGS);
    } catch (cause) {
      this.#latch(cause);
      throw cause;
    }
  }

  #latch(cause: unknown): void {
    this.#lost = true;
    // If the handler THROWS, that throw propagates untouched and this frame adds nothing to
    // it. Throwing is a blessed terminal action, the handler's error is the meaningful one,
    // and writing a property onto a value someone else threw is the thing this module refuses
    // to do everywhere else (see SnapshotCommitFailure).
    const outcome = this.#onLost(cause);
    if (outcome !== TERMINATED) {
      // The contract violation is the more urgent failure, so it is the one thrown — but the
      // LOCK-LOSS CAUSE travels with it instead of being dropped. `assertHeld`'s `throw cause`
      // is unreachable once this throws, so before this the operator saw only "the handler
      // returned without taking terminal action" and had nothing at all about the loss that
      // triggered it. Carried by reference and never inspected or stringified, which is the
      // same rule `SnapshotCommitFailure` applies to the pair of failures it exists to keep.
      throw new AuthorityHandlerContractError(undefined, cause);
    }
  }
}

/**
 * Wraps a raw authority. Every store entry point takes the result of this, never a bare
 * object, so the latch cannot be bypassed by passing the inner authority directly.
 *
 * That sentence used to be an aspiration. `WriteAuthority` is a structural interface, so any
 * `{ assertHeld() {} }` satisfied it and the store's entry points accepted a bare port lock
 * without complaint — the latch, the terminal-action contract, and the no-resurrection rule
 * all silently absent, with AC 8's guarantee reduced to a convention the next caller had to
 * remember. `LatchingWriteAuthority` carries a private field, which makes it NOMINAL: no
 * object literal can be assigned to it, so the compiler now rejects at the seam what the
 * documentation used to merely request.
 */
export function createWriteAuthority(
  inner: WriteAuthority,
  onLost: LockLossHandler,
): LatchingWriteAuthority {
  return new LatchingWriteAuthority(inner, onLost);
}

/**
 * Every authority this module has actually constructed.
 *
 * A `WeakSet` and not `instanceof`, because `instanceof` is not a brand — it is a walk of the
 * prototype chain, and anyone can put a prototype on an object:
 *
 *     const forged = Object.create(LatchingWriteAuthority.prototype);
 *     forged.assertHeld = () => {};            // passes instanceof, latches nothing
 *
 * That object has no private field, no inner authority, no terminal-action contract and no
 * loss latch, and its own `assertHeld` shadows the real one. `Symbol.hasInstance` can be
 * redefined on the exported constructor besides, which lets a caller make `instanceof` answer
 * however it likes. Membership in a module-private set is the thing that cannot be forged: the
 * only way in is through the constructor below.
 */
const GUARDED = new WeakSet<object>();

// The shared method itself, pinned. Freezing each instance stops an OWN property shadowing
// `assertHeld`; freezing the prototype stops the one definition every instance dispatches to
// being replaced wholesale, which would disable the latch for authorities already handed out.
freeze(LatchingWriteAuthority.prototype);

/**
 * Runtime half of the same guarantee, for callers the compiler cannot vouch for — JS
 * consumers, `any` at a boundary, or a structurally-typed value cast into place.
 */
export function assertGuardedAuthority(value: unknown): asserts value is LatchingWriteAuthority {
  if (
    typeof value !== "object" ||
    value === null ||
    !weakSetHas(GUARDED, value) ||
    // Belt to the constructor's braces: membership proves the constructor ran, this proves the
    // object still dispatches to the method that constructor installed.
    prototypeOf(value) !== LatchingWriteAuthority.prototype ||
    !isFrozen(value)
  ) {
    throw new AuthorityHandlerContractError(
      "store entry points require an authority from createWriteAuthority(); " +
        "a bare or forged WriteAuthority bypasses the loss latch",
    );
  }
}
