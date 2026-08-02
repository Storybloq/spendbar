// Raw -> sanitized capture-manifest mapping (plan §6): one manifest cannot be both complete
// and committable, so the raw one (paths, command lines, environment values) stays outside
// git and this module derives the committed one.
//
// The sanitizer is trusted to produce committed evidence, so it gets more than a
// does-it-redact test:
//   * a TYPED field mapping with an ALLOWLIST of transformations — a field with no declared
//     transformation is a hard error, never a pass-through, so a new raw field cannot ship
//     verbatim by default;
//   * preservation checked independently of the sanitizer (checkPreservation): field
//     coverage, argument order and count, flag names, exits, stream statistics and digests
//     must survive byte-identical; only designated sensitive values change, and only into
//     their declared typed placeholder;
//   * the mutations that must be rejected are tests: drop an argument, reorder two, merge
//     two, and normalize two materially different commands to the same representation.
//
// Review round 1 closed the hole that made all of that weaker than it read. The old `copy`
// transformation was an UNRESTRICTED shallow pass-through: eleven of the twenty-three fields
// declared it, so any nested value the capture ever put inside `spawn`, `frames`,
// `environmental` or `retries` reached the committed manifest verbatim — and `spawn.client`
// already carried `String(error)`, which is a spawn message containing an absolute path. The
// three changes:
//
//   1. There is no `copy`. Every field is RECONSTRUCTED from a per-field schema that selects
//      named keys, checks each one's type and pattern, and builds a fresh value. Nothing is
//      shared with the raw object, so a nested reference cannot leak either.
//   2. Free text is either preserved because it matched a declared safe pattern, or replaced
//      by a DECLARED typed placeholder. Those are the only two outcomes, and the preservation
//      check knows both, so a sanitizer that quietly rewrote something would still be caught.
//   3. The serialized result is run through the repository's own privacy classifier before it
//      is returned. That is the backstop for everything the schemas did not anticipate — and
//      per §8 the refusal names the class and the line, never the value.
//
// Values never leave this module in an error message.

import { scanText } from "../../../scripts/privacy-scan.mjs";
import { ENVIRONMENTAL_CONDITIONS } from "./classify.mjs";
import { CAPTURE_INPUTS } from "./provenance.mjs";

export class SanitizeError extends Error {}

const SHA256 = /^[0-9a-f]{64}$/;
const SIGNAL = /^SIG[A-Z0-9]{2,10}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RETRY_NOTE = /^attempt \d{1,3} after infrastructure-unavailable$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const PROTOCOL_VERSION = /^[A-Za-z0-9.-]{1,40}$/;
const TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
/** A version banner is free text from a third-party binary: one line, and not path-shaped. */
const VERSION_LINE = /^[^\n\r]{1,200}$/;
/** Detail strings are composed here from literals; anything else is not one of ours. */
const DETAIL_TEXT = /^[A-Za-z0-9 ,.:;()_-]{0,200}$/;

/**
 * Is this string plausibly a filesystem location? (review round 2, chunk 3)
 *
 * The old test was `/[\\/]/` — a literal separator, nothing else — and it was the ONLY path test
 * in the module. Three shapes walked past it, each demonstrated before this was written: a
 * percent-encoded path (`%2FUsers%2F...`), a `file:` URL, and a bare `~user` home reference,
 * which has no separator at all. All three reached the committed manifest through argv and
 * through the version banner, and the privacy backstop did not see them either, because it
 * classifies the encoded bytes rather than what they decode to.
 *
 * This is deliberately over-broad. A false positive costs one redaction in evidence nobody
 * reads for its literal argument text; a false negative is a published home directory.
 */
export function looksLikePath(value) {
  if (typeof value !== "string") return false;
  if (/[\\/]/.test(value)) return true;
  // A tilde ANYWHERE, not just at the start. `~jdoe` is a home reference with no separator in
  // it at all, and it does not have to be the whole string — a version banner reading
  // "cli 1.0 built at ~jdoe" is one. The first spelling of this anchored at ^, which caught it
  // in argv (where the element IS the value) and missed it in every other field.
  if (value.includes("~")) return true;
  if (/%(2f|5c|7e)/i.test(value)) return true; // an encoded / \ or ~, whatever it decodes to
  if (/\bfile:/i.test(value)) return true; // file:///... survives even once decoded
  return false;
}

/** Errno names this module will republish. Anything else becomes "unknown". */
export const ERRNO_NAMES = [
  "E2BIG", "EACCES", "EADDRINUSE", "EADDRNOTAVAIL", "EAGAIN", "EBADF", "EBUSY", "ECANCELED",
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EDESTADDRREQ", "EEXIST", "EFAULT", "EFBIG",
  "EHOSTUNREACH", "EINTR", "EINVAL", "EIO", "EISDIR", "ELOOP", "EMFILE", "EMSGSIZE",
  "ENAMETOOLONG", "ENETDOWN", "ENETUNREACH", "ENFILE", "ENOBUFS", "ENODEV", "ENOENT", "ENOEXEC",
  "ENOMEM", "ENOSPC", "ENOSYS", "ENOTDIR", "ENOTEMPTY", "ENOTSOCK", "ENOTTY", "ENXIO", "EPERM",
  "EPIPE", "EPROTO", "ERANGE", "EROFS", "ESPIPE", "ESRCH", "ETIMEDOUT", "EXDEV",
];
const ERRNO_CANDIDATE = /\b(E[A-Z0-9]{1,15})\b/g;

/**
 * Below this length, a whole-document substring search for an environment value collides with
 * the hex of the manifest's own digests too often to mean anything. It bounds ONE of the two
 * environment-value searches in `checkPreservation`; the other has no floor.
 */
export const ENV_VALUE_FLOOR = 4;

/** Every placeholder this module can emit, as functions — the preservation check uses these too. */
export const PLACEHOLDER = {
  path: (field) => `<path:${field}>`,
  arg: (index) => `<arg${index}:path>`,
  redacted: (what) => `<redacted:${what}>`,
};

export const FRAME_METHODS = ["initialize", "tools/list", "tools/call", "unknown", "ambiguous"];
export const LAST_PHASES = ["pre-spawn", "spawned", "initialized", "listed", "called"];
export const STREAM_STAT_KEYS = ["bytes", "lines", "messages", "remainder", "encodingErrors", "parseErrors", "protocolErrors"];
export const DIGEST_KEYS = [
  "clientToServerSha256",
  "serverStdoutSha256",
  "serverStderrSha256",
  // Client stdout/stderr carry the completion-marker and disclosure predicates. Leaving them
  // unbound meant those facts could not be reproduced once the raw capture was deleted.
  "clientStdoutSha256",
  "clientStderrSha256",
  "derivationDigest",
];

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (msg) => {
  throw new SanitizeError(msg);
};

/** Keep a free-text string only when it matches its declared safe pattern; otherwise redact it. */
const keepOrRedact = (value, pattern, what) =>
  typeof value === "string" && pattern.test(value) ? value : PLACEHOLDER.redacted(what);

/**
 * The errno inside a spawn failure message, or "unknown" (review round 2, chunk 3).
 *
 * The previous spelling took the first match of `\b(E[A-Z]{2,15})\b`, which is not a test for
 * "is an errno" but for "is an uppercase word starting with E". Node's own message for the most
 * common failure is `spawn <path> ENOENT`, so a capitalised account name in that path matched
 * FIRST and became the published `errorCode` — the real errno, sitting at the end of the same
 * string, never got looked at. An account name is not one of the classes the privacy backstop
 * recognises, so nothing downstream would have caught it.
 *
 * Scanning every candidate and keeping only the first that is an actual errno makes both halves
 * right: the name cannot be selected because it is not on the list, and the errno is still found
 * wherever in the message it sits.
 */
export function errnoOf(message) {
  if (typeof message !== "string") return "unknown";
  for (const [, candidate] of message.matchAll(ERRNO_CANDIDATE)) {
    if (ERRNO_NAMES.includes(candidate)) return candidate;
  }
  return "unknown";
}

/**
 * Transformation allowlist. Nothing outside this table may touch a field, and every entry
 * CONSTRUCTS its result — none of them returns any part of its input object.
 */
const TRANSFORMS = {
  boolean: (v, field) => {
    if (v !== true && v !== false) fail(`${field}: expected a boolean`);
    return v;
  },
  enum: (v, field, spec) => {
    if (!spec.values.includes(v)) fail(`${field}: value is not one of the declared ${spec.values.length} alternatives`);
    return v;
  },
  token: (v, field, spec) => {
    if (typeof v !== "string" || !(spec.pattern ?? TOKEN).test(v)) fail(`${field}: does not match its declared token pattern`);
    return v;
  },
  sha256: (v, field) => {
    if (typeof v !== "string" || !SHA256.test(v)) fail(`${field}: expected a lowercase sha256 digest`);
    return v;
  },
  // A third-party version banner: kept only if it is one line that is not path-shaped.
  "version-line": (v, field) => {
    if (typeof v !== "string") fail(`${field}: expected a string`);
    const line = v.split("\n")[0];
    if (looksLikePath(line)) return PLACEHOLDER.redacted(field);
    return keepOrRedact(line, VERSION_LINE, field);
  },
  // A whole value that is a filesystem path becomes its typed placeholder.
  "placeholder-path": (v, field) => {
    if (typeof v !== "string") fail(`${field}: placeholder-path expects a string`);
    return PLACEHOLDER.path(field);
  },
  // argv, elementwise: order and count preserved; flag names (leading -) must survive
  // byte-identical; path-shaped values become indexed typed placeholders. `--flag=value` is
  // split at the first `=` so the NAME survives and the VALUE is tested (review round 1: an
  // attached value skipped the path test entirely and shipped verbatim).
  //
  // Round 2: a leading-dash argument with NO `=` used to be returned whole, on the assumption
  // that it was a bare flag. The bundled short-option form `-I<path>` / `-C<path>` is also a
  // leading-dash argument with no `=`, and it shipped its path verbatim. There is no general
  // way to find the option/value boundary in that form — it depends on the callee's own option
  // table — so this REFUSES rather than guesses. Refusing is the safe direction: no command
  // line this repository builds uses a bundled path option, so the only thing a refusal can
  // cost is a loud capture failure that names the position, never a silent leak.
  argv: (v, field) => {
    if (!Array.isArray(v)) fail(`${field}: argv expects an array`);
    return v.map((arg, i) => {
      if (typeof arg !== "string") fail(`${field}[${i}]: not a string`);
      if (!arg.startsWith("-")) return looksLikePath(arg) ? PLACEHOLDER.arg(i) : arg;
      const eq = arg.indexOf("=");
      if (eq === -1) {
        if (looksLikePath(arg)) {
          fail(
            `${field}[${i}]: a leading-dash argument with no '=' is path-shaped, so its option/value ` +
              `boundary cannot be located — refusing rather than emitting it`,
          );
        }
        return arg;
      }
      const name = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (looksLikePath(name)) fail(`${field}[${i}]: the option NAME left of '=' is path-shaped`);
      return `${name}=${looksLikePath(value) ? PLACEHOLDER.arg(i) : value}`;
    });
  },
  // Environment: names are evidence, values never leave the raw manifest.
  "env-names": (v, field) => {
    if (!isPlainObject(v)) fail(`${field}: expects an object`);
    const names = Object.keys(v).sort();
    for (const name of names) if (!ENV_NAME.test(name)) fail(`${field}: an environment name is not a legal identifier`);
    return names;
  },
  // Spawn: the two booleans are the evidence. A failure message is a system string that has
  // carried an absolute path since the first capture — it is reduced to its errno.
  spawn: (v, field) => {
    if (!isPlainObject(v)) fail(`${field}: expects an object`);
    const side = (name) => {
      const s = v[name];
      if (!isPlainObject(s)) fail(`${field}.${name}: expects an object`);
      if (s.ok !== true && s.ok !== false) fail(`${field}.${name}.ok: expected a boolean`);
      const out = { ok: s.ok };
      if ("error" in s) out.errorCode = errnoOf(s.error);
      return out;
    };
    return { client: side("client"), server: side("server") };
  },
  environmental: (v, field) => {
    if (v === null || v === undefined) return null;
    if (!isPlainObject(v)) fail(`${field}: expects null or an object`);
    if (!ENVIRONMENTAL_CONDITIONS.includes(v.condition)) fail(`${field}.condition: not an enumerated condition`);
    return { condition: v.condition, detail: keepOrRedact(v.detail ?? "", DETAIL_TEXT, `${field}.detail`) };
  },
  isolation: (v, field) => {
    if (!isPlainObject(v)) fail(`${field}: expects an object`);
    for (const key of ["hostileConfigExecuted", "userConfigIsolated"]) {
      if (v[key] !== true && v[key] !== false) fail(`${field}.${key}: expected a boolean`);
    }
    return { hostileConfigExecuted: v.hostileConfigExecuted, userConfigIsolated: v.userConfigIsolated };
  },
  // The tee wrapper's own witness: whether the server process actually started, whether its
  // streams closed, and how many bytes it recorded but could not deliver.
  wrapper: (v, field) => {
    if (!isPlainObject(v)) fail(`${field}: expects an object`);
    for (const key of ["spawned", "closed"]) {
      if (v[key] !== true && v[key] !== false) fail(`${field}.${key}: expected a boolean`);
    }
    if (!Number.isSafeInteger(v.forwardErrors) || v.forwardErrors < 0) {
      fail(`${field}.forwardErrors: expected a non-negative integer`);
    }
    return { spawned: v.spawned, closed: v.closed, forwardErrors: v.forwardErrors };
  },
  // The capture-time provenance pin: repository-relative paths to sha256 digests, with the key
  // set fixed by the declared capture-input list rather than by whatever the record contains.
  "digest-map": (v, field, spec) => {
    if (!isPlainObject(v)) fail(`${field}: expects an object`);
    const out = {};
    for (const key of spec.keys) {
      if (typeof v[key] !== "string" || !SHA256.test(v[key])) fail(`${field}: '${key}' is not a sha256 digest`);
      out[key] = v[key];
    }
    const extra = Object.keys(v).filter((k) => !spec.keys.includes(k));
    if (extra.length) fail(`${field}: undeclared entries [${extra.join(", ")}]`);
    return out;
  },
  exit: (v, field) => {
    if (!isPlainObject(v)) fail(`${field}: expects an object`);
    if (v.code !== null && !Number.isSafeInteger(v.code)) fail(`${field}.code: expected null or an integer`);
    if (v.signal !== null && !(typeof v.signal === "string" && SIGNAL.test(v.signal))) {
      fail(`${field}.signal: expected null or a signal name`);
    }
    return { code: v.code, signal: v.signal };
  },
  termination: (v, field) => {
    if (!isPlainObject(v)) fail(`${field}: expects an object`);
    if (v.signal !== null && !(typeof v.signal === "string" && SIGNAL.test(v.signal))) {
      fail(`${field}.signal: expected null or a signal name`);
    }
    return { signal: v.signal };
  },
  // Frames are rebuilt per method: only the protocol fields the classifier judges survive,
  // each type-checked.
  //
  // Round 2, chunk 3 — the critical one. `tools/call` text used to be copied verbatim for its
  // first 1000 characters, bounded but never pattern-checked, on the reasoning that the body is
  // our own server's reply. Bounding a string limits its LENGTH, not its MEANING: a name, an
  // internal hostname and an API key planted in that body were all published, and neither the
  // preservation oracle nor the privacy backstop objected — the backstop only knows the handful
  // of shapes the repository's scanner classifies, and none of those three is one.
  //
  // The body is not evidence. Everything the classifier ever asked of it is two predicates —
  // that it was non-empty, and that it echoed this run's nonce — so those are what get
  // committed. The bytes stay in the raw capture and die with it, which is the same bargain the
  // receipt makes for every other stream: what survives is a commitment made while the bytes
  // existed, not something a later reader can recompute.
  frames: (v, field, spec, ctx) => {
    if (!Array.isArray(v)) fail(`${field}: expects an array`);
    return v.map((f, i) => {
      if (!isPlainObject(f)) fail(`${field}[${i}]: not an object`);
      if (f.type !== "response") fail(`${field}[${i}].type: only response frames are recorded`);
      if (!FRAME_METHODS.includes(f.method)) fail(`${field}[${i}].method: not a recorded method`);
      const out = { type: "response", method: f.method };
      if (f.method === "initialize") {
        out.protocolVersion = f.protocolVersion === "" ? "" : keepOrRedact(f.protocolVersion, PROTOCOL_VERSION, "protocolVersion");
      }
      if (f.method === "tools/list") {
        if (!Array.isArray(f.toolNames)) fail(`${field}[${i}].toolNames: expects an array`);
        out.toolNames = f.toolNames.map((n) => keepOrRedact(n, TOOL_NAME, "toolName"));
      }
      if (f.method === "tools/call") {
        out.structuredNonce = typeof f.structuredNonce === "string" && TOKEN.test(f.structuredNonce) ? f.structuredNonce : null;
        if (typeof f.text !== "string") fail(`${field}[${i}].text: expects a string`);
        // The nonce comes from the already-constructed output, so it has been through the
        // `token` transform. If it is not there, SCHEMA has been reordered so that `frames` is
        // built before `nonce`, and this predicate would silently be computed against nothing.
        if (typeof ctx?.nonce !== "string") {
          fail(`${field}[${i}]: the run nonce is not available yet — 'nonce' must precede 'frames' in SCHEMA`);
        }
        out.textLength = f.text.length;
        out.textEchoesNonce = f.text.includes(ctx.nonce);
        out.isError = f.isError === true;
      }
      return out;
    });
  },
  "stream-stats": (v, field) => {
    if (!isPlainObject(v)) fail(`${field}: expects an object`);
    const out = {};
    for (const key of STREAM_STAT_KEYS) {
      if (!Number.isSafeInteger(v[key]) || v[key] < 0) fail(`${field}.${key}: expected a non-negative integer`);
      out[key] = v[key];
    }
    return out;
  },
  flags: (v, field, spec) => {
    if (!isPlainObject(v)) fail(`${field}: expects an object`);
    const out = {};
    for (const key of spec.keys) {
      if (v[key] !== true && v[key] !== false) fail(`${field}.${key}: expected a boolean`);
      out[key] = v[key];
    }
    return out;
  },
  "digest-set": (v, field) => {
    if (!isPlainObject(v)) fail(`${field}: expects an object`);
    const out = {};
    for (const key of DIGEST_KEYS) {
      if (typeof v[key] !== "string" || !SHA256.test(v[key])) fail(`${field}.${key}: expected a sha256 digest`);
      out[key] = v[key];
    }
    return out;
  },
  retries: (v, field) => {
    if (!Array.isArray(v)) fail(`${field}: expects an array`);
    return v.map((note) => keepOrRedact(note, RETRY_NOTE, "retry-note"));
  },
};

/**
 * The raw manifest schema, field by field. A raw manifest whose field set is not EXACTLY this
 * set refuses to sanitize — that closes both "a new field ships verbatim" and "a field the
 * schema expected was quietly absent, so nothing checked it".
 */
export const SCHEMA = {
  captureId: { kind: "token", pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/ },
  client: { kind: "enum", values: ["claude-code", "codex"] },
  candidate: { kind: "enum", values: ["v1", "v2"] },
  clientVersion: { kind: "version-line" },
  promptSha256: { kind: "sha256" },
  promptInstanceSha256: { kind: "sha256" },
  nonce: { kind: "token" },
  executablePath: { kind: "placeholder-path" },
  // A digest of the resolved executable, or the recorded reason a digest was impossible.
  executableIdentity: {
    kind: "token",
    pattern: /^(sha256:[0-9a-f]{64}|unresolved-on-PATH|not-a-regular-file|unreadable)$/,
  },
  commandLine: { kind: "argv" },
  env: { kind: "env-names" },
  cwd: { kind: "placeholder-path" },
  captureInputs: { kind: "digest-map", keys: CAPTURE_INPUTS },
  candidateTreeSha256: { kind: "sha256" },
  spawn: { kind: "spawn" },
  environmental: { kind: "environmental" },
  isolation: { kind: "isolation" },
  timedOut: { kind: "boolean" },
  drainTimedOut: { kind: "boolean" },
  lastPhase: { kind: "enum", values: LAST_PHASES },
  clientExit: { kind: "exit" },
  serverTermination: { kind: "termination" },
  wrapper: { kind: "wrapper" },
  frames: { kind: "frames" },
  clientToServer: { kind: "stream-stats" },
  serverStdout: { kind: "stream-stats" },
  serverStderr: { kind: "flags", keys: ["hasReadyLine", "containsFrames"] },
  clientStdout: {
    kind: "flags",
    keys: ["hasCompletionMarker", "containsNonce", "containsAllowlistedEnvValue", "truncated"],
  },
  digests: { kind: "digest-set" },
  retries: { kind: "retries" },
};

/** field -> transformation name, for the tests that assert the allowlist is respected. */
export const FIELD_MAP = Object.fromEntries(Object.entries(SCHEMA).map(([field, spec]) => [field, spec.kind]));
export const TRANSFORM_NAMES = Object.keys(TRANSFORMS);

/**
 * The last line of defence: the repository's own privacy classifier over the SERIALIZED
 * result. The schemas above are an allowlist of shapes, not of meanings — this catches an
 * email, a home path or a session id that arrived inside a field the schema happily allowed.
 * Per §8 the refusal names the class and the line and never the value.
 */
export function assertNoPersonalData(sanitized, label = "<sanitized-manifest>") {
  const findings = scanText(JSON.stringify(sanitized, null, 2), label);
  if (findings.length === 0) return;
  const classes = [...new Set(findings.map((f) => f.class))].sort().join(", ");
  const lines = [...new Set(findings.map((f) => f.line))].sort((a, b) => a - b).join(", ");
  fail(`sanitized manifest matched personal-data class(es) [${classes}] at line(s) [${lines}] — refusing to emit it`);
}

export function sanitize(raw) {
  if (!isPlainObject(raw)) fail("raw manifest is not an object");
  const declared = Object.keys(SCHEMA);
  const present = Object.keys(raw);
  const unexpected = present.filter((f) => !Object.prototype.hasOwnProperty.call(SCHEMA, f));
  const missing = declared.filter((f) => !Object.prototype.hasOwnProperty.call(raw, f));
  if (unexpected.length || missing.length) {
    fail(
      `raw manifest field set does not match the declared schema — ` +
        `undeclared [${unexpected.join(", ")}], absent [${missing.join(", ")}]`,
    );
  }

  // Iterating the SCHEMA (not the raw object) fixes the output field order and guarantees
  // every declared field is constructed, not merely the ones that happened to be present.
  //
  // The fourth argument is the output built SO FAR, and exactly one transform reads it:
  // `frames` needs this run's nonce to reduce the tool-result body to a predicate. It reads the
  // sanitized nonce rather than the raw one deliberately — that value has already been through
  // the `token` transform, so the predicate cannot be computed against an unvalidated string.
  const sanitized = {};
  for (const field of declared) {
    const spec = SCHEMA[field];
    sanitized[field] = TRANSFORMS[spec.kind](raw[field], field, spec, sanitized);
  }
  assertNoPersonalData(sanitized);
  return sanitized;
}

// ---------- independent preservation check --------------------------------------------------

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A second, deliberately DIFFERENT answer to "is this a path?" (review round 2, chunk 3).
 *
 * The preservation check used to import the sanitizer's own `PATHISH`, which meant a wrong idea
 * of what a path looks like was wrong identically on both sides: the sanitizer shipped an
 * encoded home directory and the oracle agreed that was the correct output. Sharing the
 * predicate made the oracle silent on exactly the class of bug it exists to catch.
 *
 * So this one is written from the other direction — a character/substring scan rather than the
 * sanitizer's regex alternation — and the two must AGREE. Where they disagree, the argument is
 * reported as a violation rather than resolved in either one's favour, because a disagreement
 * means one of the two definitions is wrong and this check cannot tell which.
 */
export function independentlyPathLike(value) {
  if (typeof value !== "string") return false;
  const lower = value.toLowerCase();
  for (const ch of value) if (ch === "/" || ch === "\\" || ch === "~") return true;
  for (const marker of ["%2f", "%5c", "%7e"]) if (lower.includes(marker)) return true;
  // `file:` only counts as a scheme when it starts a word. A plain substring test called
  // "profile:default" a path — which the agreement test above caught, and which is the whole
  // reason two implementations are worth keeping.
  for (let i = lower.indexOf("file:"); i !== -1; i = lower.indexOf("file:", i + 1)) {
    const before = i === 0 ? "" : lower[i - 1];
    if (before === "" || !/[a-z0-9_]/.test(before)) return true;
  }
  return false;
}

/**
 * Preservation, verified WITHOUT trusting the sanitizer and WITHOUT consulting the schema table
 * it used: everything that is evidence must be byte-identical; a value that is not identical
 * must be one of the DECLARED placeholders and nothing else; and no raw path or environment
 * value may appear in the serialized result. Returns a list of violations (empty = preserved).
 *
 * What "independent" does and does not claim, precisely, so the comment cannot outrun the code:
 *   * INDEPENDENT of SCHEMA and TRANSFORMS — this function re-derives the expected output from
 *     the raw manifest and never consults the table that produced it;
 *   * INDEPENDENT in its path test — `independentlyPathLike` above is a separate implementation
 *     and disagreement with the sanitizer is itself a violation;
 *   * SHARED, by design, is the PLACEHOLDER vocabulary. An oracle that did not know what a
 *     legitimate redaction looks like could not tell one from a leak. That is the one shared
 *     assumption, and it is a vocabulary rather than a judgement.
 */
export function checkPreservation(raw, sanitized) {
  const violations = [];
  const rawFields = Object.keys(raw).sort();
  const sanFields = Object.keys(sanitized).sort();
  if (!sameJson(rawFields, sanFields)) {
    violations.push(`field sets differ: raw [${rawFields.join(",")}] vs sanitized [${sanFields.join(",")}]`);
    return violations;
  }
  const serialized = JSON.stringify(sanitized);

  // 1. Verbatim evidence: statistics, digests, exits, flags, adverse process facts.
  for (const field of [
    "captureId",
    "client",
    "candidate",
    "promptSha256",
    "promptInstanceSha256",
    "nonce",
    "executableIdentity",
    "captureInputs",
    "candidateTreeSha256",
    "timedOut",
    "drainTimedOut",
    "lastPhase",
    "clientExit",
    "serverTermination",
    "wrapper",
    "clientToServer",
    "serverStdout",
    "serverStderr",
    "clientStdout",
    "digests",
    "isolation",
  ]) {
    if (!sameJson(raw[field], sanitized[field])) violations.push(`'${field}' was altered`);
  }
  if (raw.spawn?.client?.ok !== sanitized.spawn?.client?.ok || raw.spawn?.server?.ok !== sanitized.spawn?.server?.ok) {
    violations.push("spawn outcome was altered");
  }
  if ((raw.environmental?.condition ?? null) !== (sanitized.environmental?.condition ?? null)) {
    violations.push("environmental condition was altered");
  }
  if ((raw.retries?.length ?? 0) !== (sanitized.retries?.length ?? 0)) violations.push("retry count was altered");

  // 2. Free text: identical, or exactly its declared placeholder — never anything else.
  if (sanitized.clientVersion !== raw.clientVersion && sanitized.clientVersion !== PLACEHOLDER.redacted("clientVersion")) {
    violations.push("clientVersion is neither preserved nor its declared redaction");
  }

  // 3. Frames: the protocol claim, in order.
  if (!Array.isArray(sanitized.frames) || sanitized.frames.length !== raw.frames.length) {
    violations.push(`frames changed length: ${raw.frames.length} -> ${sanitized.frames?.length}`);
  } else {
    raw.frames.forEach((f, i) => {
      const s = sanitized.frames[i];
      if (s.type !== f.type || s.method !== f.method) violations.push(`frame ${i} changed identity`);
      if ("protocolVersion" in f && s.protocolVersion !== f.protocolVersion && s.protocolVersion !== PLACEHOLDER.redacted("protocolVersion")) {
        violations.push(`frame ${i} protocolVersion is neither preserved nor its declared redaction`);
      }
      if ("toolNames" in f) {
        const kept = (s.toolNames ?? []).every(
          (n, j) => n === f.toolNames[j] || n === PLACEHOLDER.redacted("toolName"),
        );
        if (!kept || s.toolNames?.length !== f.toolNames.length) violations.push(`frame ${i} tool set was altered`);
      }
      if ("isError" in f && s.isError !== f.isError) violations.push(`frame ${i} isError was altered`);
      if (typeof f.structuredNonce === "string" && s.structuredNonce !== f.structuredNonce) {
        violations.push(`frame ${i} structuredNonce was altered`);
      }
      // The tool-result body must be GONE, and the two predicates that replaced it must be the
      // ones the raw body actually supports. Re-derived here from raw.text and raw.nonce, so a
      // sanitizer that asserted `textEchoesNonce` on a body that never carried the nonce is a
      // violation rather than a committed falsehood.
      if (typeof f.text === "string") {
        if ("text" in s) violations.push(`frame ${i} still carries the tool-result body`);
        if (s.textLength !== f.text.length) violations.push(`frame ${i} textLength does not describe the raw body`);
        if (s.textEchoesNonce !== f.text.includes(raw.nonce)) {
          violations.push(`frame ${i} textEchoesNonce does not match the raw body`);
        }
      }
    });
  }

  // 4. argv: length, order, flag names, and the typed placeholders.
  const r = raw.commandLine;
  const s = sanitized.commandLine;
  if (!Array.isArray(s) || s.length !== r.length) {
    violations.push(`argv 'commandLine' changed length: ${r.length} -> ${s?.length}`);
  } else {
    r.forEach((arg, i) => {
      // Both definitions of "path" get a vote; disagreement is reported, not resolved.
      const pathLike = independentlyPathLike(arg);
      if (pathLike !== looksLikePath(arg)) {
        violations.push(`commandLine[${i}]: the two path definitions disagree about this argument`);
      }
      const eq = arg.startsWith("-") ? arg.indexOf("=") : -1;
      if (eq !== -1) {
        const name = arg.slice(0, eq);
        const value = arg.slice(eq + 1);
        const want = `${name}=${independentlyPathLike(value) ? PLACEHOLDER.arg(i) : value}`;
        if (s[i] !== want) violations.push(`attached-value flag at commandLine[${i}] was altered`);
      } else if (arg.startsWith("-")) {
        // A bundled short option carrying a path must not have reached this point at all —
        // the sanitizer refuses it. Reaching here means it was emitted anyway.
        if (pathLike) violations.push(`path-shaped bundled option at commandLine[${i}] was emitted instead of refused`);
        else if (s[i] !== arg) violations.push(`flag '${arg}' at commandLine[${i}] was altered`);
      } else if (pathLike) {
        if (s[i] !== PLACEHOLDER.arg(i)) violations.push(`path argument at commandLine[${i}] is not its indexed placeholder`);
      } else if (s[i] !== arg) {
        violations.push(`non-path argument at commandLine[${i}] was altered`);
      }
    });
  }

  // 5. Environment names survive exactly; no environment VALUE survives. TWO searches, because
  //    neither alone is the check the header used to claim:
  //
  //    (a) the WHOLE serialized document, for values of at least ENV_VALUE_FLOOR characters.
  //        Broad enough to catch a value in a field nobody anticipated — including one a future
  //        transform invents — but it cannot go shorter: a three-character string collides with
  //        the hex of a digest often enough that the check would fire on every honest manifest.
  //    (b) the ENUMERATED free-text sites, at ANY length. Removing the tool-result body left a
  //        small, listable set of places a value can actually land, none of which contains hex
  //        digests, so the floor is unnecessary there. This is what closes initials, a short
  //        account name, a region code — everything (a) exempts.
  //
  //    Reported as one violation either way. The old check was (a) alone, and the comment above
  //    it claimed the coverage of (b).
  const names = Object.keys(raw.env).sort();
  if (!sameJson(sanitized.env, names)) violations.push("env names were not preserved exactly");
  const freeTextSites = JSON.stringify([
    sanitized.clientVersion,
    sanitized.environmental?.detail ?? null,
    sanitized.commandLine,
    sanitized.retries,
    sanitized.spawn?.client?.errorCode ?? null,
    sanitized.spawn?.server?.errorCode ?? null,
    (sanitized.frames ?? []).map((f) => [f.protocolVersion ?? null, f.toolNames ?? null]),
  ]);
  for (const value of Object.values(raw.env)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const broad = value.length >= ENV_VALUE_FLOOR && serialized.includes(value);
    if (broad || freeTextSites.includes(value)) {
      violations.push("an environment VALUE survived into the sanitized manifest");
    }
  }

  // 6. Paths: the typed placeholder, and the raw value absent from the whole document.
  //    The absence test applies to PATH-SHAPED values only. These fields also hold bare
  //    binary names resolved through PATH, and "claude" is a substring of the `client` field
  //    "claude-code" — which made an honest sanitizer look like it had leaked.
  for (const field of ["executablePath", "cwd"]) {
    if (sanitized[field] !== PLACEHOLDER.path(field)) violations.push(`'${field}' is not its declared placeholder`);
    if (independentlyPathLike(raw[field]) && serialized.includes(raw[field])) {
      violations.push(`the raw '${field}' value survived into the sanitized manifest`);
    }
  }

  return violations;
}
