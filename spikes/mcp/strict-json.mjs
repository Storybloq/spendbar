// Duplicate-key-refusing JSON parser (review round 1). `JSON.parse` silently keeps the LAST
// occurrence of a duplicated object key, which lets a hand-edited evidence file carry two
// values for one field — one for a human reader, one for the machine. The verifier parses
// evidence through this instead.
//
// The contract, and it is exact: accept precisely the JSON grammar (RFC 8259) — nothing
// JSON.parse rejects — and additionally reject duplicated object keys. Any OTHER divergence
// from JSON.parse is a bug in either direction, because the evidence this parses is compared
// and re-serialized elsewhere; strict-json.test.mjs differential-tests the two side by side.
//
// Objects are built with a NULL PROTOTYPE and own data properties (review round 1): plain
// `{}` plus `out[key] = …` routes a `__proto__` key through the inherited setter, where it
// creates no own property at all — invisible to `Object.keys`, invisible to the duplicate
// check, and able to feed inherited values to the verifier's later field lookups.

export class JsonSyntaxError extends Error {}

// Documented bounds: recursion is depth-limited so deep input fails as a JsonSyntaxError
// rather than an uncatchable RangeError, and the whole document is length-limited. Evidence
// files are kilobytes; these are four orders of magnitude of headroom.
export const MAX_DEPTH = 200;
export const MAX_INPUT_CHARS = 50_000_000;

const HEX4 = /^[0-9A-Fa-f]{4}$/;
const isDigit = (c) => c >= "0" && c <= "9";

export function parseStrictJson(text) {
  if (typeof text !== "string") throw new JsonSyntaxError("input is not a string");
  if (text.length > MAX_INPUT_CHARS) {
    throw new JsonSyntaxError(`input exceeds ${MAX_INPUT_CHARS} characters`);
  }

  let i = 0;
  let depth = 0;
  const err = (msg) => {
    throw new JsonSyntaxError(`${msg} at position ${i}`);
  };
  const ws = () => {
    // The four JSON whitespace characters, exactly — not JS's wider set.
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };

  const readEscape = () => {
    const e = text[i];
    i++;
    if (e === '"') return '"';
    if (e === "\\") return "\\";
    if (e === "/") return "/";
    if (e === "b") return "\b";
    if (e === "f") return "\f";
    if (e === "n") return "\n";
    if (e === "r") return "\r";
    if (e === "t") return "\t";
    if (e === "u") {
      // Exactly four hex digits: Number.parseInt would accept a valid prefix followed by
      // junk, which JSON.parse rejects (review round 1). Lone surrogates pass through as
      // single code units, matching JSON.parse.
      const hex = text.slice(i, i + 4);
      if (!HEX4.test(hex)) err("bad unicode escape");
      i += 4;
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    i--; // report at the offending character
    return err("bad escape");
  };

  const parseString = () => {
    i++; // opening quote
    let out = "";
    let chunkStart = i; // slice unescaped runs wholesale instead of per character
    for (;;) {
      if (i >= text.length) err("unterminated string");
      const code = text.charCodeAt(i);
      if (code === 0x22) {
        out += text.slice(chunkStart, i);
        i++;
        return out;
      }
      if (code === 0x5c) {
        out += text.slice(chunkStart, i);
        i++;
        out += readEscape();
        chunkStart = i;
        continue;
      }
      // JSON forbids raw U+0000–U+001F inside strings; they must be escaped.
      if (code < 0x20) err(`unescaped control character U+${code.toString(16).padStart(4, "0")}`);
      i++;
    }
  };

  /** The JSON number production exactly: -? (0 | [1-9]\d*) (\.\d+)? ([eE][+-]?\d+)? */
  const parseNumber = () => {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") {
      i++;
    } else {
      if (!isDigit(text[i])) err("bad number: expected a digit");
      while (isDigit(text[i])) i++;
    }
    if (text[i] === ".") {
      i++;
      if (!isDigit(text[i])) err("bad number: fraction needs at least one digit");
      while (isDigit(text[i])) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!isDigit(text[i])) err("bad number: exponent needs at least one digit");
      while (isDigit(text[i])) i++;
    }
    return Number(text.slice(start, i));
  };

  const parseObject = () => {
    i++; // {
    ws();
    const out = Object.create(null);
    if (text[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      ws();
      if (text[i] !== '"') err("expected a string key");
      const key = parseString();
      // Own-property semantics on a null-prototype accumulator: `__proto__` is an ordinary
      // key here, so it is both duplicate-checked and visible to Object.keys.
      if (Object.prototype.hasOwnProperty.call(out, key)) err(`duplicate key '${key}'`);
      ws();
      if (text[i] !== ":") err("expected ':'");
      i++;
      const value = parseValue();
      Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return out;
      }
      err("expected ',' or '}'");
    }
  };

  const parseArray = () => {
    i++; // [
    ws();
    const out = [];
    if (text[i] === "]") {
      i++;
      return out;
    }
    for (;;) {
      out.push(parseValue());
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return out;
      }
      err("expected ',' or ']'");
    }
  };

  const parseValue = () => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      if (++depth > MAX_DEPTH) err(`nesting deeper than ${MAX_DEPTH}`);
      const value = c === "{" ? parseObject() : parseArray();
      depth--;
      return value;
    }
    if (c === '"') return parseString();
    if (c === "-" || isDigit(c)) return parseNumber();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    return err("unexpected token");
  };

  const result = parseValue();
  ws();
  if (i !== text.length) err("trailing content");
  return result;
}
