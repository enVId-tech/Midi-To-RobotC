import { Program, Stmt } from "./ast";

/** Lines where the simulator can stop: every line that starts a statement. */
export function executableLines(program: Program): Set<number> {
  const lines = new Set<number>();
  const visit = (s: Stmt | null | undefined) => {
    if (!s) return;
    switch (s.k) {
      case "block":
        s.stmts!.forEach(visit);
        return;
      case "empty":
        return;
      case "decl":
        if (s.decls!.some((d) => d.init)) lines.add(s.line);
        return;
      case "if":
        lines.add(s.line);
        visit(s.then);
        visit(s.else);
        return;
      case "while":
      case "for":
        lines.add(s.line);
        visit(s.body);
        return;
      case "do":
        visit(s.body);
        if (s.test) lines.add(s.test.line);
        return;
      case "switch":
        lines.add(s.line);
        s.cases!.forEach((c) => c.body.forEach(visit));
        return;
      default:
        lines.add(s.line);
    }
  };
  for (const f of program.functions.values()) visit(f.body);
  return lines;
}
