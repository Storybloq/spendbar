/**
 * Built-in operations this module depends on, captured at module load.
 *
 * Every branded-identity check in the snapshot store is a method call on a global: `GUARDED.has`
 * resolves `has` through `WeakSet.prototype`, `HANDLE_FD.get` resolves `get` through
 * `WeakMap.prototype`, and both of those prototypes are ordinary mutable objects any code in the
 * realm can write to. The collections themselves are module-private and unreachable, and that is
 * exactly what made this easy to miss: the SET cannot be forged, so the check looked closed —
 * while the METHOD used to interrogate it could be replaced with `() => true` at any point after
 * this module was imported. A membership test that always answers yes is not a membership test.
 *
 * The concrete failures, each demonstrated by a mutant in this suite:
 *
 *   WeakSet.prototype.has = () => true     -> `assertGuardedAuthority` accepts an object that
 *                                             never entered GUARDED, so store mutations run
 *                                             behind an own no-op `assertHeld`. AC 8 defeated.
 *   WeakMap.prototype.get = () => 1        -> every forged handle resolves to fd 1, so `write`
 *                                             writes to stdout. The exact capability forgery
 *                                             `HANDLE_FD` exists to prevent.
 *   WeakMap.prototype.get = () => undefined-> every seam failure classifies as "not ours", so an
 *                                             unreadable live manifest reads as absent and
 *                                             publish commits over it.
 *
 * This is the same defect the write-authority latch was fixed for three times in a row — a value
 * proven at one point and RE-READ at another, each fix removing one read and leaving the next one
 * further out. Named here once, in one place, rather than rediscovered per call site.
 *
 * WHAT THIS DOES NOT CLAIM, stated because a security comment that overclaims is worse than none:
 * it does not defeat code that patches these globals BEFORE this module is imported. Nothing in a
 * single realm can, and no part of this design pretends otherwise. It closes the window that
 * actually exists — between this module being loaded and the checks below being used.
 *
 * WHERE THE LINE IS — and this paragraph replaces a WRONG one, so the correction is the point.
 *
 * The previous version claimed that general-purpose builtins (`JSON.parse`, `Object.keys`,
 * `Number.isSafeInteger`, `Array.isArray`) did not need pinning, because a lying general-purpose
 * builtin only changes what the caller's DATA appears to say and every validator here re-derives
 * what it needs. That argument is FALSE, and review round 12 disproved it with about twenty
 * counterexamples, each reproduced: `Number.isSafeInteger = () => true` makes
 * `compareSourceVersions({a:20,b:NaN}, {a:5,b:9})` answer `dominates`, so a snapshot that
 * REGRESSED source `b` publishes over a good one; `Object.keys = () => []` makes
 * `canonicalSourceVersion({a:10})` persist `{}`; `RegExp.prototype.test = () => true` lets the id
 * `../../../pwned` through the grammar and out of the store; `Hash.prototype.digest = () =>
 * "same"` collapses every checksum and every manifest identity. Nothing downstream re-derives any
 * of it.
 *
 * The correct statement is the one that finding implies but does not say: **there is no line.**
 * The enumeration does not terminate. `String.prototype.startsWith` is not on the reviewer's list
 * and patching it makes `contained("/etc/passwd", root)` answer true, defeating containment
 * outright — and after that come getters installed on `Object.prototype` for any key this code
 * reads, `Symbol.toPrimitive` on any value it coerces, `Array.prototype[Symbol.iterator]`, and
 * `Function.prototype.bind`. Closing that surface is not a matter of pinning more names; it takes
 * a hardened realm — every intrinsic frozen before any of this loads — which is a decision for
 * the PROCESS, not for a library that ships into other people's, and freezing `Object.prototype`
 * from inside a dependency is hostile besides.
 *
 * So what this file is, honestly: the intrinsics below are pinned because they are cheap, local,
 * and they close the one case that is NOT about hostile code in the realm — a CALLER of this API
 * passing a forged authority or handle. That is an ordinary structural mistake, and the brands
 * catch it. Against code that can patch `Object.prototype` after import, none of this helps and
 * none of it is claimed to: such code can call `fs.unlinkSync` on the store directly and skip
 * every guard here. The full surface is tracked as its own issue with the threat-model decision
 * it needs; it is not silently assumed closed.
 *
 * One class IS closed here, and it is the one that does not need an attacker at all: ordinary
 * PROTOTYPE POLLUTION by some other library in the process. `"value" in descriptor`,
 * `this.name = ...` and `err.code = ...` all consult or invoke `Object.prototype` and
 * `Error.prototype`, which any dependency can write to by accident. `hasOwn` and `defineOwn`
 * below exist for exactly those, and they are used at every such site.
 */

/**
 * `Reflect.apply`, and the reason everything below goes through it.
 *
 * `PINNED_METHOD.call(...)` would re-introduce the defect one level down: `call` is an ordinary
 * inherited property of the pinned FUNCTION, so replacing `Function.prototype.call` disarms every
 * invocation here. `Reflect.apply` reads nothing off the function it invokes.
 */
export const apply = Reflect.apply;

const WEAKMAP_GET = WeakMap.prototype.get;
const WEAKMAP_SET = WeakMap.prototype.set;
const WEAKMAP_DELETE = WeakMap.prototype.delete;
const WEAKSET_HAS = WeakSet.prototype.has;
const WEAKSET_ADD = WeakSet.prototype.add;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_IS_FROZEN = Object.isFrozen;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;

/**
 * `map.get(key)` with no property read on anything a caller can reach.
 *
 * The argument list is a fresh array each call and is never handed out, so `Reflect.apply`'s
 * reads of its `length` and indices cannot be intercepted either.
 */
export function weakGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return apply(WEAKMAP_GET, map, [key]) as V | undefined;
}

export function weakSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  apply(WEAKMAP_SET, map, [key, value]);
}

export function weakDelete<K extends object, V>(map: WeakMap<K, V>, key: K): void {
  apply(WEAKMAP_DELETE, map, [key]);
}

export function weakSetHas<T extends object>(set: WeakSet<T>, value: T): boolean {
  return apply(WEAKSET_HAS, set, [value]) as boolean;
}

export function weakSetAdd<T extends object>(set: WeakSet<T>, value: T): void {
  apply(WEAKSET_ADD, set, [value]);
}

/**
 * The three `Object` operations that carry a DECISION.
 *
 * `Object` is a mutable global like any other, and these are not conveniences: freezing is how an
 * own `assertHeld` is stopped from shadowing the real one, and the prototype and frozen checks are
 * what `assertGuardedAuthority` uses to prove an object still dispatches to the method its
 * constructor installed. `Object.freeze = (o) => o` alone reopens the shadowing bypass.
 */
export function freeze<T>(value: T): T {
  return apply(OBJECT_FREEZE, Object, [value]) as T;
}

export function isFrozen(value: unknown): boolean {
  return apply(OBJECT_IS_FROZEN, Object, [value]) as boolean;
}

export function prototypeOf(value: object): unknown {
  return apply(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
}

/**
 * `Object.getOwnPropertyDescriptor`, for the one place that reads a property off a value somebody
 * else threw. A descriptor read runs no getter and no Proxy `get` trap; a replaced
 * `getOwnPropertyDescriptor` would run whatever it likes, at the exact seam that exists to keep
 * foreign code out.
 */
export function ownDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  return apply(OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, Object, [value, key]) as
    | PropertyDescriptor
    | undefined;
}

/**
 * An OWN-property test that no prototype can answer for.
 *
 * `"value" in descriptor` was the shape this replaces, and it does not need an attacker to go
 * wrong: a descriptor object returned by `getOwnPropertyDescriptor` inherits from
 * `Object.prototype`, so any library in the process that writes `Object.prototype.value` — by
 * accident, which is what prototype pollution usually is — makes an ACCESSOR descriptor answer
 * `true` to that test. The caller then reads `descriptor.value`, gets the inherited value, and
 * concludes it read a data property without invoking a getter. That is the exact claim the check
 * exists to make, inverted, and if the polluted value is itself an accessor it also RUNS foreign
 * code inside the boundary that promises to run none.
 */
export function hasOwn(value: object, key: string): boolean {
  return apply(OBJECT_HAS_OWN, Object, [value, key]) as boolean;
}

/**
 * Installs an own DATA property, for the fields this module set writes onto its own errors.
 *
 * `this.name = "SnapshotPathError"` and `err.code = "EILSEQ"` are ordinary assignments, so they
 * consult the prototype chain for a setter — and `Error.prototype` is writable. A setter
 * installed there (again: prototype pollution, not necessarily malice) can swallow the
 * assignment, so the error carries no `code` and classifies as `other` instead of
 * `invalid-content`; or it can throw, replacing a `SnapshotPathError` with an arbitrary value
 * that the store's catches do not recognise and cannot dispose of. Defining the property
 * bypasses the chain entirely.
 */
export function defineOwn(target: object, key: string, value: unknown): void {
  apply(OBJECT_DEFINE_PROPERTY, Object, [
    target,
    key,
    { value, writable: true, enumerable: false, configurable: true },
  ]);
}
