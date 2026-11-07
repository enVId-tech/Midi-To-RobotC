export type TokType = "num" | "str" | "id" | "punc" | "eof";

export interface Token {
  t: TokType;
  v: string;
  /** Numeric value for "num" tokens. */
  n?: number;
  /** True for float literals like 1.5 or 2e3. */
  isFloat?: boolean;
  line: number;
}

export interface Diagnostic {
  line: number;
  message: string;
  severity: "error" | "warning";
}

export class CompileError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

const PUNCTUATORS = [
  "<<=", ">>=",
  "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "->",
  "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", "?", ":", ";", ",", ".", "(", ")", "[", "]", "{", "}",
];

const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdChar = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/**
 * Tokenizes RobotC source. Handles // and block comments, string and char
 * literals, and a small preprocessor: object-like #define macros are
 * expanded as they are used; #pragma and #include are ignored with a
 * warning, since the simulator has no robot configuration or header files.
 */
export function lex(src: string): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  const macros = new Map<string, Token[]>();
  let i = 0;
  let line = 1;
  let atLineStart = true;

  const emitIdentifier = (name: string, at: number, out: Token[], expanding: Set<string>) => {
    const macro = macros.get(name);
    if (macro && !expanding.has(name)) {
      expanding.add(name);
      for (const tok of macro) {
        if (tok.t === "id") emitIdentifier(tok.v, at, out, expanding);
        else out.push({ ...tok, line: at });
      }
      expanding.delete(name);
      return;
    }
    out.push({ t: "id", v: name, line: at });
  };

  const readNumber = (): Token => {
    const startLine = line;
    let j = i;
    let isFloat = false;
    let value: number;
    if (src[j] === "0" && (src[j + 1] === "x" || src[j + 1] === "X")) {
      j += 2;
      while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
      value = parseInt(src.slice(i + 2, j), 16);
    } else if (src[j] === "0" && (src[j + 1] === "b" || src[j + 1] === "B")) {
      j += 2;
      while (j < src.length && (src[j] === "0" || src[j] === "1")) j++;
      value = parseInt(src.slice(i + 2, j), 2);
    } else {
      while (j < src.length && isDigit(src[j])) j++;
      if (src[j] === "." && isDigit(src[j + 1] ?? "")) {
        isFloat = true;
        j++;
        while (j < src.length && isDigit(src[j])) j++;
      } else if (src[j] === "." && !isIdStart(src[j + 1] ?? "")) {
        isFloat = true;
        j++;
      }
      if (src[j] === "e" || src[j] === "E") {
        let k = j + 1;
        if (src[k] === "+" || src[k] === "-") k++;
        if (isDigit(src[k] ?? "")) {
          isFloat = true;
          j = k;
          while (j < src.length && isDigit(src[j])) j++;
        }
      }
      value = parseFloat(src.slice(i, j));
    }
    // Suffixes: 1.5f, 100L, 10u
    while (j < src.length && /[fFlLuU]/.test(src[j])) {
      if (src[j] === "f" || src[j] === "F") isFloat = true;
      j++;
    }
    const text = src.slice(i, j);
    i = j;
    return { t: "num", v: text, n: value, isFloat, line: startLine };
  };

  const readEscape = (): string => {
    const c = src[i++];
    switch (c) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "0": return "\0";
      case "\\": return "\\";
      case "'": return "'";
      case '"': return '"';
      case "x": {
        const hex = src.slice(i, i + 2);
        i += 2;
        return String.fromCharCode(parseInt(hex, 16) || 0);
      }
      default: return c ?? "";
    }
  };

  const handleDirective = () => {
    const startLine = line;
    // Read the rest of the line, honoring backslash continuations.
    let text = "";
    while (i < src.length && src[i] !== "\n") {
      if (src[i] === "\\" && src[i + 1] === "\n") {
        i += 2;
        line++;
        continue;
      }
      text += src[i++];
    }
    text = text.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").trim();
    const m = /^#\s*(\w+)\s*(.*)$/.exec(text);
    if (!m) return;
    const [, directive, rest] = m;
    if (directive === "define") {
      const dm = /^([A-Za-z_]\w*)(\()?\s*(.*)$/.exec(rest);
      if (!dm) {
        diagnostics.push({ line: startLine, message: "Malformed #define.", severity: "error" });
        return;
      }
      const [, name, paren, body] = dm;
      if (paren) {
        diagnostics.push({
          line: startLine,
          message: `#define ${name}(...) macros with parameters aren't supported by the simulator. Use a function instead.`,
          severity: "error",
        });
        return;
      }
      const sub = lex(body);
      macros.set(name, sub.tokens.filter((t) => t.t !== "eof"));
    } else if (directive === "undef") {
      macros.delete(rest.trim());
    } else if (directive === "pragma") {
      diagnostics.push({
        line: startLine,
        message: "#pragma (motor/sensor setup) is ignored by the simulator.",
        severity: "warning",
      });
    } else if (directive === "include") {
      diagnostics.push({
        line: startLine,
        message: `#include ${rest} is ignored -- the simulator can't load other files.`,
        severity: "warning",
      });
    } else {
      diagnostics.push({
        line: startLine,
        message: `#${directive} isn't supported by the simulator and was ignored.`,
        severity: "warning",
      });
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      atLineStart = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#" && atLineStart) {
      handleDirective();
      continue;
    }
    atLineStart = false;
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const startLine = line;
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      if (i >= src.length) {
        diagnostics.push({ line: startLine, message: "Unterminated /* comment.", severity: "error" });
      }
      i += 2;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      tokens.push(readNumber());
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < src.length && isIdChar(src[j])) j++;
      const name = src.slice(i, j);
      i = j;
      emitIdentifier(name, line, tokens, new Set());
      continue;
    }
    if (c === '"') {
      const startLine = line;
      i++;
      let s = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\n") {
          diagnostics.push({ line: startLine, message: "Missing closing \" on string.", severity: "error" });
          break;
        }
        if (src[i] === "\\") {
          i++;
          s += readEscape();
        } else s += src[i++];
      }
      i++;
      tokens.push({ t: "str", v: s, line: startLine });
      continue;
    }
    if (c === "'") {
      const startLine = line;
      i++;
      let ch = src[i] === "\\" ? (i++, readEscape()) : src[i++];
      if (src[i] !== "'") {
        diagnostics.push({ line: startLine, message: "Missing closing ' on character.", severity: "error" });
        ch = ch ?? "";
      } else i++;
      tokens.push({ t: "num", v: `'${ch}'`, n: ch ? ch.charCodeAt(0) : 0, line: startLine });
      continue;
    }
    const p = PUNCTUATORS.find((op) => src.startsWith(op, i));
    if (p) {
      tokens.push({ t: "punc", v: p, line });
      i += p.length;
      continue;
    }
    diagnostics.push({ line, message: `Unexpected character '${c}'.`, severity: "error" });
    i++;
  }
  tokens.push({ t: "eof", v: "", line });
  return { tokens, diagnostics };
}
