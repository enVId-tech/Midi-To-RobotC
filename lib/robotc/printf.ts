/** A value as the simulator stores it: a number, a string, or an array of values. */
export type Value = number | string | Value[];

const SPEC = /^%([-+ 0#]*)(\d+|\*)?(?:\.(\d*|\*))?(hh|h|ll|l|L|z)?([diouxXeEfFgGcs%])/;

function pad(text: string, width: number, left: boolean, zero: boolean): string {
  if (text.length >= width) return text;
  if (left) return text + " ".repeat(width - text.length);
  if (zero) {
    const sign = /^[-+ ]/.test(text) ? text[0] : "";
    const body = sign ? text.slice(1) : text;
    return sign + "0".repeat(width - text.length) + body;
  }
  return " ".repeat(width - text.length) + text;
}

function cExponent(text: string): string {
  // JS writes 1.5e+3; C writes 1.5e+03.
  return text.replace(/e([+-])(\d)$/, "e$10$2");
}

/**
 * C-style printf formatting for nxtDisplayTextLine, writeDebugStream and
 * friends: %d %i %u %x %X %o %c %s %f %e %g %% with flags (- + space 0 #),
 * width and precision (including *).
 */
export function formatPrintf(fmt: string, args: Value[]): string {
  let out = "";
  let ai = 0;
  const nextArg = (): Value => (ai < args.length ? args[ai++] : 0);
  const nextNum = (): number => {
    const v = nextArg();
    return typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0;
  };

  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== "%") {
      out += c;
      continue;
    }
    const m = SPEC.exec(fmt.slice(i));
    if (!m) {
      out += c;
      continue;
    }
    i += m[0].length - 1;
    const [, flags, widthText, precText, , conv] = m;
    if (conv === "%") {
      out += "%";
      continue;
    }
    const left = flags.includes("-");
    const zero = flags.includes("0") && !left;
    const plus = flags.includes("+");
    const space = flags.includes(" ");
    const width = widthText === "*" ? nextNum() : widthText ? parseInt(widthText, 10) : 0;
    let prec: number | null = null;
    if (precText !== undefined) prec = precText === "*" ? nextNum() : precText === "" ? 0 : parseInt(precText, 10);

    const signed = (n: number, body: string) => (n < 0 ? "-" : plus ? "+" : space ? " " : "") + body;
    let text: string;
    switch (conv) {
      case "d":
      case "i": {
        const n = Math.trunc(nextNum());
        let body = Math.abs(n).toString();
        if (prec !== null) body = body.padStart(prec, "0");
        text = signed(n, body);
        break;
      }
      case "u": {
        const n = Math.trunc(nextNum());
        text = (n < 0 ? n & 0xffff : n).toString();
        break;
      }
      case "x":
      case "X":
      case "o": {
        let n = Math.trunc(nextNum());
        if (n < 0) n = n >= -0x8000 ? n & 0xffff : n >>> 0;
        text = n.toString(conv === "o" ? 8 : 16);
        if (conv === "X") text = text.toUpperCase();
        if (flags.includes("#") && n !== 0) text = (conv === "o" ? "0" : conv === "x" ? "0x" : "0X") + text;
        break;
      }
      case "c": {
        const v = nextArg();
        text = typeof v === "string" ? v.charAt(0) : String.fromCharCode(Math.trunc(Number(v)) & 0xff);
        break;
      }
      case "s": {
        const v = nextArg();
        text = Array.isArray(v) ? "[array]" : String(v);
        if (prec !== null) text = text.slice(0, prec);
        break;
      }
      case "f":
      case "F": {
        const n = nextNum();
        text = signed(n, Math.abs(n).toFixed(prec ?? 6));
        break;
      }
      case "e":
      case "E": {
        const n = nextNum();
        text = signed(n, cExponent(Math.abs(n).toExponential(prec ?? 6)));
        if (conv === "E") text = text.toUpperCase();
        break;
      }
      default: {
        // %g / %G
        const n = nextNum();
        const p = prec === null ? 6 : Math.max(1, prec);
        let body = Math.abs(n).toPrecision(p);
        if (!flags.includes("#")) {
          body = body.includes("e")
            ? body.replace(/\.?0+e/, "e")
            : body.includes(".")
              ? body.replace(/\.?0+$/, "")
              : body;
        }
        text = signed(n, cExponent(body));
        if (conv === "G") text = text.toUpperCase();
      }
    }
    out += pad(text, width, left, zero && conv !== "s" && conv !== "c");
  }
  return out;
}
