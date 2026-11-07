import { Program } from "./ast";
import { analyze } from "./analyzer";
import { CompileError, Diagnostic, lex } from "./lexer";
import { Parser } from "./parser";

export interface CompileResult {
  /** Null when there are errors. */
  program: Program | null;
  diagnostics: Diagnostic[];
}

/** Lexes, parses and type-checks RobotC source. */
export function compile(src: string): CompileResult {
  const { tokens, diagnostics } = lex(src);
  const hasError = () => diagnostics.some((d) => d.severity === "error");
  if (hasError()) return { program: null, diagnostics: sortDiagnostics(diagnostics) };

  let program: Program;
  try {
    program = new Parser(tokens).parseProgram();
  } catch (err) {
    if (err instanceof CompileError) {
      diagnostics.push({ line: err.line, message: err.message, severity: "error" });
      return { program: null, diagnostics: sortDiagnostics(diagnostics) };
    }
    throw err;
  }
  diagnostics.push(...analyze(program));
  return { program: hasError() ? null : program, diagnostics: sortDiagnostics(diagnostics) };
}

function sortDiagnostics(d: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return d
    .filter((x) => {
      const key = `${x.line}|${x.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line || (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}
