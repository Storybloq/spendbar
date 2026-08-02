// Token-cost measurement plumbing (plan §7) — measurement only, no acceptance oracle.
//
// Criterion 6 asks for a check against a recorded threshold; the THRESHOLD is open question 3,
// an owner decision, and nothing here commits one. What is implemented is decision-neutral:
// a canonical serialization of a listed tool definition, its byte count, and a proxy token
// count under a PINNED proxy — so that when the owner answers, the comparison is a small
// localized change over numbers that already exist, captured identically for both SDKs.
//
// The proxy is deliberately trivial and versioned: ceil(bytes / 4), the common
// chars-per-token rule of thumb. It exists to give a stable, reproducible magnitude — not to
// impersonate any real tokenizer. Changing the proxy MUST change TOKEN_PROXY_VERSION, because
// recorded counts are only comparable under the same proxy.

export const TOKEN_PROXY_VERSION = "bytes-div-4/v1";

/** Recursively sort object keys; arrays keep their order (order is meaning in JSON arrays). */
export function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortDeep(value[k])]),
    );
  }
  return value;
}

/** Canonical bytes of a JSON value: sorted keys, no insignificant whitespace, UTF-8. */
export function canonicalize(value) {
  return JSON.stringify(sortDeep(value));
}

export function proxyTokens(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/**
 * Measure one listed tool definition as the client would receive it. The input is the tool
 * object from a real `tools/list` response — measuring what the SDK actually emits, not what
 * we registered, is the point: the two SDKs serialize the same registration differently.
 */
export function measureToolDefinition(listedTool) {
  const canonical = canonicalize(listedTool);
  return {
    proxyVersion: TOKEN_PROXY_VERSION,
    canonicalBytes: Buffer.byteLength(canonical, "utf8"),
    proxyTokens: proxyTokens(canonical),
    fields: Object.keys(sortDeep(listedTool)),
  };
}
