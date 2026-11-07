import { BOOL, CType, Declarator, Expr, FLOAT, Func, INT, Init, LONG, Program, STRING, Stmt, VOID } from "./ast";
import { BUILTIN_CONSTANTS, BUILTIN_FUNCS, BUILTIN_VARS } from "./builtins";
import { Diagnostic } from "./lexer";

interface Symbol {
  ty: CType;
  rank: number;
  isConst: boolean;
  line: number;
}

const isNumeric = (t: CType) => t.base === "int" || t.base === "float" || t.base === "bool";

/** Usual arithmetic conversions, with RobotC's 16-bit int as the minimum width. */
export function promote(a: CType, b: CType): CType {
  if (a.base === "string" || b.base === "string") return STRING;
  if (a.base === "float" || b.base === "float") return FLOAT;
  const ab = a.base === "bool" ? 8 : a.bits;
  const bb = b.base === "bool" ? 8 : b.bits;
  const bits = Math.max(16, ab, bb);
  const unsigned = (ab === bits && a.unsigned && a.base !== "bool") || (bb === bits && b.unsigned && b.base !== "bool");
  if (bits === 16 && !unsigned) return INT;
  if (bits === 32 && !unsigned) return LONG;
  return { base: "int", bits, unsigned, name: `${unsigned ? "unsigned " : ""}${bits === 32 ? "long" : "int"}` };
}

/**
 * Type-checks a parsed program, resolves names, and reports the kind of
 * mistakes RobotC's compiler would: unknown names, wrong argument counts,
 * assigning to constants, a missing task main, and so on.
 */
export function analyze(program: Program): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const error = (line: number, message: string) => diags.push({ line, message, severity: "error" });
  const warn = (line: number, message: string) => diags.push({ line, message, severity: "warning" });

  const scopes: Map<string, Symbol>[] = [new Map()];
  const globals = scopes[0];
  let currentFunc: Func | null = null;
  let loopDepth = 0;
  let switchDepth = 0;

  const lookup = (name: string): Symbol | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const s = scopes[i].get(name);
      if (s) return s;
    }
    return undefined;
  };

  const declare = (d: Declarator) => {
    const scope = scopes[scopes.length - 1];
    if (scope.has(d.name)) error(d.line, `'${d.name}' is already declared in this scope.`);
    if (program.functions.has(d.name)) error(d.line, `'${d.name}' is already the name of a function or task.`);
    if (BUILTIN_CONSTANTS[d.name] || BUILTIN_VARS[d.name]) {
      error(d.line, `'${d.name}' is a built-in RobotC name and can't be used as a variable.`);
    }
    scope.set(d.name, { ty: d.ty, rank: d.dims.length, isConst: d.isConst, line: d.line });
  };

  const checkInit = (init: Init, rank: number, ty: CType, name: string) => {
    if (init.k === "list") {
      if (rank === 0) error(init.line, `'${name}' isn't an array, so it can't be set with { ... }.`);
      init.items.forEach((item) => checkInit(item, rank - 1, ty, name));
    } else {
      const e = visit(init.e);
      if (rank > 0 && init.e.k !== "str") {
        error(init.line, `Array '${name}' needs a { ... } list to initialize it.`);
      } else if (ty.base === "string" && e.base !== "string") {
        error(init.line, `'${name}' is a string but is being set to a number.`);
      } else if (ty.base !== "string" && e.base === "string") {
        error(init.line, `'${name}' is a number but is being set to a string.`);
      }
    }
  };

  const visitDecl = (d: Declarator) => {
    if (d.ty.base === "void") error(d.line, `Variable '${d.name}' can't have type void.`);
    d.dims.forEach((dim, i) => {
      if (dim) {
        const t = visit(dim);
        if (t.base !== "int" && t.base !== "bool") error(d.line, "Array sizes must be whole numbers.");
      } else if (i > 0 || !d.init) {
        error(d.line, `Array '${d.name}' needs a size.`);
      }
    });
    if (d.init) checkInit(d.init, d.dims.length, d.ty, d.name);
    else if (d.isConst) error(d.line, `const '${d.name}' needs an initial value.`);
    declare(d);
  };

  const requireScalar = (e: Expr, what: string) => {
    if ((e.rank ?? 0) > 0) error(e.line, `Array '${e.name ?? ""}' can't be used as a single value${what ? ` in ${what}` : ""}. Add an [index].`);
  };

  const lvalueInfo = (e: Expr): { writable: boolean; name: string } => {
    let base = e;
    while (base.k === "index") base = base.obj!;
    const name = base.name ?? "?";
    if (base.ref === "const") return { writable: false, name };
    if (base.ref === "bvar") return { writable: BUILTIN_VARS[name].writable, name };
    const sym = lookup(name);
    return { writable: !!sym && !sym.isConst, name };
  };

  function visit(e: Expr): CType {
    const ty = visitInner(e);
    e.ty = ty;
    return ty;
  }

  function visitInner(e: Expr): CType {
    e.rank = 0;
    switch (e.k) {
      case "num": {
        const v = e.value as number;
        if (e.ty.base === "float") return FLOAT;
        if (v > 32767 || v < -32768) return LONG;
        return INT;
      }
      case "str":
        return STRING;
      case "id": {
        const name = e.name!;
        const sym = lookup(name);
        if (sym) {
          e.ref = "var";
          e.rank = sym.rank;
          return sym.ty;
        }
        const c = BUILTIN_CONSTANTS[name];
        if (c) {
          e.ref = "const";
          e.constValue = c.value;
          return c.ty;
        }
        const bv = BUILTIN_VARS[name];
        if (bv) {
          e.ref = "bvar";
          e.rank = bv.length ? 1 : 0;
          return bv.ty;
        }
        if (program.functions.has(name) || BUILTIN_FUNCS[name]) {
          error(e.line, `'${name}' is a function; call it with parentheses, like ${name}().`);
        } else {
          error(e.line, `'${name}' is not declared.`);
        }
        return INT;
      }
      case "index": {
        const objTy = visit(e.obj!);
        const idxTy = visit(e.index!);
        e.pure = e.obj!.pure && e.index!.pure;
        requireScalar(e.index!, "an index");
        if (idxTy.base !== "int" && idxTy.base !== "bool") error(e.line, "Array indexes must be whole numbers.");
        const rank = e.obj!.rank ?? 0;
        if (rank === 0) {
          if (objTy.base === "string") {
            e.rank = 0;
            return INT; // s[i] gives a character
          }
          error(e.line, `'${e.obj!.name ?? "value"}' isn't an array.`);
          return INT;
        }
        e.rank = rank - 1;
        return objTy;
      }
      case "call":
        return visitCall(e);
      case "unary": {
        const t = visit(e.arg!);
        e.pure = e.arg!.pure;
        requireScalar(e.arg!, "an expression");
        if (t.base === "string") error(e.line, `Operator '${e.op}' doesn't work on strings.`);
        if (e.op === "!") return BOOL;
        if (e.op === "~" && t.base === "float") error(e.line, "Operator '~' needs a whole number.");
        return promote(t, INT);
      }
      case "update": {
        const t = visit(e.arg!);
        e.pure = e.arg!.pure;
        requireScalar(e.arg!, `'${e.op}'`);
        if (e.arg!.k !== "id" && e.arg!.k !== "index") error(e.line, `'${e.op}' needs a variable.`);
        else if (!lvalueInfo(e.arg!).writable) error(e.line, `'${lvalueInfo(e.arg!).name}' can't be changed.`);
        if (!isNumeric(t)) error(e.line, `'${e.op}' needs a number.`);
        return t;
      }
      case "binary": {
        const l = visit(e.l!);
        const r = visit(e.r!);
        e.pure = e.l!.pure && e.r!.pure;
        requireScalar(e.l!, `'${e.op}'`);
        requireScalar(e.r!, `'${e.op}'`);
        const op = e.op!;
        const cmp = ["==", "!=", "<", ">", "<=", ">="].includes(op);
        if (l.base === "string" || r.base === "string") {
          if (l.base !== r.base) error(e.line, `Can't combine a string and a number with '${op}'.`);
          else if (op !== "+" && !cmp) error(e.line, `Operator '${op}' doesn't work on strings.`);
          return cmp ? BOOL : STRING;
        }
        if (cmp) return BOOL;
        if (["%", "&", "|", "^", "<<", ">>"].includes(op) && (l.base === "float" || r.base === "float")) {
          error(e.line, `Operator '${op}' needs whole numbers, not floats.`);
        }
        return promote(l, r);
      }
      case "logical":
        visit(e.l!);
        visit(e.r!);
        requireScalar(e.l!, `'${e.op}'`);
        requireScalar(e.r!, `'${e.op}'`);
        e.pure = e.l!.pure && e.r!.pure;
        return BOOL;
      case "assign": {
        const t = visit(e.target!);
        const v = visit(e.r!);
        e.pure = e.target!.pure && e.r!.pure;
        const info = lvalueInfo(e.target!);
        if (!info.writable) error(e.line, `'${info.name}' can't be changed (it's a constant or read-only).`);
        if ((e.target!.rank ?? 0) > 0) error(e.line, `Can't assign a whole array '${info.name}' at once -- assign one element at a time.`);
        requireScalar(e.r!, "an assignment");
        if (t.base === "string" && v.base !== "string" && e.op === "=") error(e.line, `'${info.name}' is a string but is being set to a number.`);
        if (t.base !== "string" && v.base === "string") error(e.line, `'${info.name}' is a number but is being set to a string.`);
        return t;
      }
      case "cond": {
        visit(e.test!);
        const a = visit(e.a!);
        const b = visit(e.b!);
        e.pure = e.test!.pure && e.a!.pure && e.b!.pure;
        if ((a.base === "string") !== (b.base === "string")) error(e.line, "Both sides of '?:' must be numbers or both strings.");
        return promote(a, b);
      }
      case "cast": {
        const t = visit(e.arg!);
        e.pure = e.arg!.pure;
        if (t.base === "string" || e.to!.base === "string") error(e.line, "Can't cast between strings and numbers.");
        return e.to!;
      }
      case "comma": {
        let last: CType = INT;
        e.pure = true;
        for (const item of e.list!) {
          last = visit(item);
          e.pure = e.pure && item.pure;
        }
        return last;
      }
    }
  }

  function visitCall(e: Expr): CType {
    const name = e.name!;
    const args = e.args!;
    const user = program.functions.get(name);
    if (user) {
      e.builtin = false;
      e.pure = false;
      if (user.isTask) {
        error(e.line, `'${name}' is a task. Start it with startTask(${name}) instead of calling it.`);
        return VOID;
      }
      if (args.length !== user.params.length) {
        error(e.line, `${name}() takes ${user.params.length} argument${user.params.length === 1 ? "" : "s"} but got ${args.length}.`);
      }
      args.forEach((a, i) => {
        const t = visit(a);
        const p = user.params[i];
        if (!p) return;
        if (p.isArray && (a.rank ?? 0) === 0) error(a.line, `Argument ${i + 1} of ${name}() must be an array.`);
        if (!p.isArray && (a.rank ?? 0) > 0) error(a.line, `Argument ${i + 1} of ${name}() must be a single value, not an array.`);
        if (p.byRef && a.k !== "id" && a.k !== "index") error(a.line, `Argument ${i + 1} of ${name}() must be a variable (it's passed by reference).`);
        if ((p.ty.base === "string") !== (t.base === "string")) error(a.line, `Argument ${i + 1} of ${name}() has the wrong type.`);
      });
      return user.ret;
    }
    const b = BUILTIN_FUNCS[name];
    if (!b) {
      error(e.line, `Unknown function '${name}'. It isn't defined in this program and the simulator doesn't know it as a RobotC command.`);
      args.forEach(visit);
      return INT;
    }
    e.builtin = true;
    if (args.length < b.min || args.length > b.max) {
      const range = b.min === b.max ? `${b.min}` : `${b.min}-${b.max}`;
      error(e.line, `${name}() takes ${range} argument${b.max === 1 ? "" : "s"} but got ${args.length}.`);
    }
    if (b.taskArg) {
      const first = args[0];
      if (first && first.k === "id" && program.functions.get(first.name!)?.isTask) {
        e.taskName = first.name;
        first.ty = VOID;
        args.slice(1).forEach(visit);
      } else if (first) {
        error(e.line, `${name}() needs the name of a task.`);
      }
      e.pure = true;
      return VOID;
    }
    let pure = !b.pauses;
    // Index of the text/format argument, if this function takes one.
    const textIndex = /[dD]isplay/.test(name) && !/Clear|erase/.test(name)
      ? 1
      : /DebugStream/.test(name) || name === "strlen" || /SoundFile/.test(name)
        ? 0
        : -1;
    args.forEach((a, i) => {
      const t = visit(a);
      pure = pure && a.pure;
      requireScalar(a, `argument ${i + 1} of ${name}()`);
      if (textIndex >= 0 && i === textIndex) {
        if (t.base !== "string") error(a.line, `Argument ${i + 1} of ${name}() should be text in quotes.`);
      } else if ((textIndex < 0 || i < textIndex) && t.base === "string") {
        error(a.line, `Argument ${i + 1} of ${name}() should be a number, not a string.`);
      }
    });
    e.pure = pure;
    if (b.ret === "arg") return args[0]?.ty ?? INT;
    return b.ret;
  }

  function visitStmt(s: Stmt) {
    switch (s.k) {
      case "decl":
        s.decls!.forEach(visitDecl);
        break;
      case "expr":
        if (s.e) visit(s.e);
        break;
      case "block":
        scopes.push(new Map());
        s.stmts!.forEach(visitStmt);
        scopes.pop();
        break;
      case "if":
        visit(s.test!);
        requireScalar(s.test!, "a condition");
        visitStmt(s.then!);
        if (s.else) visitStmt(s.else);
        break;
      case "while":
      case "do":
        visit(s.test!);
        requireScalar(s.test!, "a condition");
        loopDepth++;
        visitStmt(s.body!);
        loopDepth--;
        break;
      case "for":
        scopes.push(new Map());
        if (s.init) visitStmt(s.init);
        if (s.test) visit(s.test);
        if (s.update) visit(s.update);
        loopDepth++;
        visitStmt(s.body!);
        loopDepth--;
        scopes.pop();
        break;
      case "switch":
        visit(s.test!);
        switchDepth++;
        scopes.push(new Map());
        for (const c of s.cases!) {
          if (c.test) {
            visit(c.test);
            if (!c.test.pure || !isConstantExpr(c.test)) error(c.line, "case labels must be constant numbers.");
          }
          c.body.forEach(visitStmt);
        }
        scopes.pop();
        switchDepth--;
        break;
      case "break":
        if (loopDepth === 0 && switchDepth === 0) error(s.line, "'break' is only allowed inside a loop or switch.");
        break;
      case "continue":
        if (loopDepth === 0) error(s.line, "'continue' is only allowed inside a loop.");
        break;
      case "return":
        if (s.e) {
          const t = visit(s.e);
          if (currentFunc && currentFunc.ret.base === "void") warn(s.line, `${currentFunc.name}() is void, so its return value is ignored.`);
          else if (currentFunc && (currentFunc.ret.base === "string") !== (t.base === "string")) error(s.line, "Return value has the wrong type.");
        } else if (currentFunc && currentFunc.ret.base !== "void") {
          error(s.line, `${currentFunc.name}() must return a value.`);
        }
        break;
      case "empty":
        break;
    }
  }

  // Globals first (in order), then every function body.
  program.globals.forEach(visitDecl);
  for (const f of program.functions.values()) {
    currentFunc = f;
    scopes.push(new Map());
    for (const p of f.params) {
      scopes[scopes.length - 1].set(p.name, { ty: p.ty, rank: p.isArray ? 1 : 0, isConst: false, line: f.line });
    }
    visitStmt(f.body);
    scopes.pop();
    currentFunc = null;
  }

  const main = program.functions.get("main");
  if (!main) error(1, "The program needs a 'task main()' -- that's where the NXT starts running.");
  else if (!main.isTask) error(main.line, "'main' must be declared as 'task main()'.");

  void globals;
  return diags;
}

function isConstantExpr(e: Expr): boolean {
  switch (e.k) {
    case "num":
      return true;
    case "id":
      return e.ref === "const";
    case "unary":
      return isConstantExpr(e.arg!);
    case "binary":
      return isConstantExpr(e.l!) && isConstantExpr(e.r!);
    case "cast":
      return isConstantExpr(e.arg!);
    default:
      return false;
  }
}
