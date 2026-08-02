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

export class SanitizeError extends Error {}

const PATHISH = /[\\/]/;

/** Transformation allowlist. Nothing outside this table may touch a field. */
const TRANSFORMS = {
  // Byte-identical copy — the evidence fields.
  copy: (v) => v,
  // A whole value that is a filesystem path becomes its typed placeholder.
  "placeholder-path": (v, field) => {
    if (typeof v !== "string") throw new SanitizeError(`${field}: placeholder-path expects a string`);
    return `<path:${field}>`;
  },
  // argv, elementwise: order and count preserved; flag names (leading -) must survive
  // byte-identical; path-shaped values become indexed typed placeholders.
  "argv-map": (v, field) => {
    if (!Array.isArray(v)) throw new SanitizeError(`${field}: argv-map expects an array`);
    return v.map((arg, i) => {
      if (typeof arg !== "string") throw new SanitizeError(`${field}[${i}]: not a string`);
      if (arg.startsWith("-")) return arg; // flag names are evidence
      return PATHISH.test(arg) ? `<arg${i}:path>` : arg;
    });
  },
  // Environment: names are evidence, values never leave the raw manifest.
  "env-names-only": (v, field) => {
    if (v === null || typeof v !== "object") throw new SanitizeError(`${field}: expects an object`);
    return Object.keys(v).sort();
  },
};

/**
 * The raw manifest schema, field by field. A raw manifest carrying a field absent from this
 * map refuses to sanitize — that is the "new field ships verbatim" hole, closed.
 */
export const FIELD_MAP = {
  captureId: "copy",
  client: "copy",
  candidate: "copy",
  clientVersion: "copy",
  promptSha256: "copy",
  nonce: "copy",
  executablePath: "placeholder-path",
  executableIdentity: "copy", // digest, or the recorded reason a digest was impossible
  commandLine: "argv-map",
  env: "env-names-only",
  cwd: "placeholder-path",
  spawn: "copy",
  environmental: "copy",
  timedOut: "copy",
  lastPhase: "copy",
  clientExit: "copy",
  serverTermination: "copy",
  frames: "copy", // already normalized + allowlisted protocol fields only
  serverStdout: "copy",
  serverStderr: "copy",
  clientStdout: "copy",
  digests: "copy",
  retries: "copy",
};

export function sanitize(raw) {
  const sanitized = {};
  for (const field of Object.keys(raw)) {
    const transform = FIELD_MAP[field];
    if (transform === undefined) {
      throw new SanitizeError(`raw field '${field}' has no declared transformation — refusing to pass it through`);
    }
    sanitized[field] = TRANSFORMS[transform](raw[field], field);
  }
  return sanitized;
}

/**
 * Preservation, verified WITHOUT trusting the sanitizer: everything declared `copy` must be
 * byte-identical; argv must keep length, order and every flag name; placeholders must be the
 * declared typed tokens. Returns a list of violations (empty = preserved).
 */
export function checkPreservation(raw, sanitized) {
  const violations = [];
  const rawFields = Object.keys(raw);
  const sanFields = Object.keys(sanitized);
  if (JSON.stringify(rawFields.sort()) !== JSON.stringify([...sanFields].sort())) {
    violations.push(`field sets differ: raw [${rawFields.join(",")}] vs sanitized [${sanFields.join(",")}]`);
    return violations;
  }
  for (const field of rawFields) {
    const transform = FIELD_MAP[field];
    const r = raw[field];
    const s = sanitized[field];
    if (transform === "copy") {
      if (JSON.stringify(r) !== JSON.stringify(s)) violations.push(`copy field '${field}' was altered`);
    } else if (transform === "placeholder-path") {
      if (s !== `<path:${field}>`) violations.push(`'${field}' is not its declared placeholder`);
    } else if (transform === "argv-map") {
      if (!Array.isArray(s) || s.length !== r.length) {
        violations.push(`argv '${field}' changed length: ${r.length} -> ${s?.length}`);
        continue;
      }
      r.forEach((arg, i) => {
        if (arg.startsWith("-") && s[i] !== arg) violations.push(`flag '${arg}' at ${field}[${i}] was altered`);
        else if (!arg.startsWith("-") && !PATHISH.test(arg) && s[i] !== arg) {
          violations.push(`non-path argument at ${field}[${i}] was altered`);
        } else if (PATHISH.test(arg) && !arg.startsWith("-") && s[i] !== `<arg${i}:path>`) {
          violations.push(`path argument at ${field}[${i}] is not its indexed placeholder`);
        }
      });
    } else if (transform === "env-names-only") {
      const names = Object.keys(r).sort();
      if (JSON.stringify(s) !== JSON.stringify(names)) violations.push(`env names for '${field}' were not preserved exactly`);
      for (const value of Object.values(r)) {
        if (typeof value === "string" && value.length >= 4 && JSON.stringify(sanitized).includes(value)) {
          violations.push(`an environment VALUE survived into the sanitized manifest`);
        }
      }
    }
  }
  return violations;
}
