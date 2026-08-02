// Duplicate-key-refusing JSON parser (review round 1). `JSON.parse` silently keeps the LAST
// occurrence of a duplicated object key, which lets a hand-edited evidence file carry two
// values for one field — one for a human reader, one for the machine. The verifier parses
// evidence through this instead: same grammar, but a duplicated key is a hard error.

export class JsonSyntaxError extends Error {}

export function parseStrictJson(text) {
  let i = 0;
  const err = (msg) => {
    throw new JsonSyntaxError(`${msg} at position ${i}`);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const parseString = () => {
    let s = "";
    i++; // opening quote
    for (;;) {
      if (i >= text.length) err("unterminated string");
      const c = text[i];
      if (c === '"') {
        i++;
        return s;
      }
      if (c === "\\") {
        const e = text[i + 1];
        i += 2;
        if (e === '"') s += '"';
        else if (e === "\\") s += "\\";
        else if (e === "/") s += "/";
        else if (e === "b") s += "\b";
        else if (e === "f") s += "\f";
        else if (e === "n") s += "\n";
        else if (e === "r") s += "\r";
        else if (e === "t") s += "\t";
        else if (e === "u") {
          const code = Number.parseInt(text.slice(i, i + 4), 16);
          if (Number.isNaN(code)) err("bad unicode escape");
          s += String.fromCharCode(code);
          i += 4;
        } else err("bad escape");
        continue;
      }
      s += c;
      i++;
    }
  };
  const parseNumber = () => {
    const start = i;
    if (text[i] === "-") i++;
    while (i < text.length && ((text[i] >= "0" && text[i] <= "9") || ".eE+-".includes(text[i]))) i++;
    const raw = text.slice(start, i);
    const n = Number(raw);
    if (raw === "" || Number.isNaN(n)) err("bad number");
    return n;
  };
  const parseObject = () => {
    i++; // {
    ws();
    const out = {};
    if (text[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      ws();
      if (text[i] !== '"') err("expected string key");
      const key = parseString();
      if (Object.prototype.hasOwnProperty.call(out, key)) err(`duplicate key '${key}'`);
      ws();
      if (text[i] !== ":") err("expected ':'");
      i++;
      out[key] = parseValue();
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
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
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
    err("unexpected token");
  };
  const result = parseValue();
  ws();
  if (i !== text.length) err("trailing content");
  return result;
}
