import {
  BOOL, CHAR, CType, Declarator, Expr, FLOAT, Func, INT, Init, LONG, Param, Program,
  SHORT, STRING, Stmt, SwitchCase, UBYTE, VOID,
} from "./ast";
import { CompileError, Token } from "./lexer";

/** Type names RobotC programs use. Enum-like RobotC types are plain ints here. */
const TYPE_NAMES: Record<string, CType> = {
  int: INT,
  short: SHORT,
  long: LONG,
  char: CHAR,
  byte: CHAR,
  sbyte: CHAR,
  ubyte: UBYTE,
  word: SHORT,
  bool: BOOL,
  float: FLOAT,
  double: FLOAT,
  string: STRING,
  void: VOID,
  TButtons: INT,
  TSounds: INT,
  tMotor: INT,
  tSensors: INT,
  TTimers: INT,
  TSensorTypes: INT,
  TSensorModes: INT,
};
const QUALIFIERS = new Set(["const", "static", "volatile", "signed", "unsigned"]);

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

// Binary operator precedence (higher binds tighter).
const BINARY_PREC: Record<string, number> = {
  "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5,
  "==": 6, "!=": 6,
  "<": 7, ">": 7, "<=": 7, ">=": 7,
  "<<": 8, ">>": 8,
  "+": 9, "-": 9,
  "*": 10, "/": 10, "%": 10,
};

function expr(k: Expr["k"], line: number, fields: Partial<Expr>): Expr {
  return { k, line, ty: INT, pure: true, ...fields };
}

export class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private get tok(): Token {
    return this.tokens[this.pos];
  }
  private peek(offset = 1): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }
  private is(v: string): boolean {
    return (this.tok.t === "punc" || this.tok.t === "id") && this.tok.v === v;
  }
  private accept(v: string): boolean {
    if (this.is(v)) {
      this.next();
      return true;
    }
    return false;
  }
  private expect(v: string, what?: string): Token {
    if (!this.is(v)) {
      const got = this.tok.t === "eof" ? "end of file" : `'${this.tok.v}'`;
      // A missing ';' is reported on the line it belongs to, not the next one.
      const line = v === ";" && this.pos > 0 ? this.tokens[this.pos - 1].line : this.tok.line;
      throw new CompileError(`Expected '${v}'${what ? ` ${what}` : ""} but found ${got}.`, line);
    }
    return this.next();
  }
  private ident(what: string): Token {
    if (this.tok.t !== "id") {
      throw new CompileError(`Expected ${what} but found '${this.tok.v || "end of file"}'.`, this.tok.line);
    }
    return this.next();
  }

  /** True if the tokens at the cursor start a type (possibly with qualifiers). */
  private atType(offset = 0): boolean {
    let k = offset;
    while (this.peek(k).t === "id" && QUALIFIERS.has(this.peek(k).v)) k++;
    const t = this.peek(k);
    if (t.t !== "id") return false;
    if (TYPE_NAMES[t.v]) return true;
    // "unsigned x" alone means unsigned int.
    return k > offset && this.peek(k - 1).v === "unsigned";
  }

  private parseType(): { ty: CType; isConst: boolean } {
    let isConst = false;
    let unsigned = false;
    let sawQualifier = false;
    while (this.tok.t === "id" && QUALIFIERS.has(this.tok.v)) {
      const q = this.next().v;
      sawQualifier = true;
      if (q === "const") isConst = true;
      if (q === "unsigned") unsigned = true;
    }
    let ty: CType;
    if (this.tok.t === "id" && TYPE_NAMES[this.tok.v]) {
      ty = TYPE_NAMES[this.next().v];
      // "long int", "short int", "long long"
      if ((ty === LONG || ty === SHORT) && (this.is("int") || this.is("long"))) this.next();
    } else if (sawQualifier && unsigned) {
      ty = INT;
    } else {
      throw new CompileError(`Unknown type '${this.tok.v}'.`, this.tok.line);
    }
    if (unsigned && ty.base === "int") {
      ty = { ...ty, unsigned: true, name: `unsigned ${ty.name}` };
    }
    return { ty, isConst };
  }

  parseProgram(): Program {
    const globals: Declarator[] = [];
    const functions = new Map<string, Func>();
    while (this.tok.t !== "eof") {
      if (this.accept(";")) continue;
      const line = this.tok.line;
      if (this.is("task")) {
        this.next();
        const name = this.ident("a task name").v;
        this.expect("(");
        this.accept("void");
        this.expect(")", "after the task name");
        const body = this.parseBlock();
        this.addFunc(functions, { name, ret: VOID, params: [], body, isTask: true, line });
        continue;
      }
      if (this.is("typedef") || this.is("struct") || this.is("enum") || this.is("union")) {
        throw new CompileError(`'${this.tok.v}' isn't supported by the simulator.`, line);
      }
      if (!this.atType()) {
        throw new CompileError(`Expected a declaration, function or task but found '${this.tok.v}'.`, line);
      }
      const { ty, isConst } = this.parseType();
      const nameTok = this.ident("a name");
      if (this.is("(")) {
        this.next();
        const params = this.parseParams();
        if (this.accept(";")) continue; // prototype
        const body = this.parseBlock();
        this.addFunc(functions, { name: nameTok.v, ret: ty, params, body, isTask: false, line });
        continue;
      }
      globals.push(...this.parseDeclaratorsAfterName(ty, isConst, nameTok));
      this.expect(";", "after the declaration");
    }
    return { globals, functions };
  }

  private addFunc(map: Map<string, Func>, f: Func) {
    if (map.has(f.name)) throw new CompileError(`'${f.name}' is defined twice.`, f.line);
    map.set(f.name, f);
  }

  private parseParams(): Param[] {
    const params: Param[] = [];
    if (this.accept(")")) return params;
    if (this.is("void") && this.peek().v === ")") {
      this.next();
      this.next();
      return params;
    }
    do {
      const { ty } = this.parseType();
      const byRef = this.accept("&");
      const name = this.ident("a parameter name").v;
      let isArray = false;
      while (this.accept("[")) {
        while (!this.is("]") && this.tok.t !== "eof") this.next();
        this.expect("]");
        isArray = true;
      }
      params.push({ name, ty, isArray, byRef });
    } while (this.accept(","));
    this.expect(")", "after the parameters");
    return params;
  }

  private parseDeclaratorsAfterName(ty: CType, isConst: boolean, first: Token): Declarator[] {
    const decls: Declarator[] = [];
    let nameTok: Token | null = first;
    for (;;) {
      const tok = nameTok ?? this.ident("a variable name");
      nameTok = null;
      const dims: (Expr | null)[] = [];
      while (this.accept("[")) {
        dims.push(this.is("]") ? null : this.parseAssign());
        this.expect("]");
      }
      let init: Init | null = null;
      if (this.accept("=")) init = this.parseInit();
      decls.push({ name: tok.v, ty, dims, init, line: tok.line, isConst });
      if (!this.accept(",")) break;
    }
    return decls;
  }

  private parseInit(): Init {
    const line = this.tok.line;
    if (this.accept("{")) {
      const items: Init[] = [];
      while (!this.is("}")) {
        items.push(this.parseInit());
        if (!this.accept(",")) break;
      }
      this.expect("}", "to close the initializer list");
      return { k: "list", items, line };
    }
    return { k: "expr", e: this.parseAssign(), line };
  }

  private parseBlock(): Stmt {
    const line = this.expect("{").line;
    const stmts: Stmt[] = [];
    while (!this.is("}")) {
      if (this.tok.t === "eof") throw new CompileError("Missing '}' -- a block was never closed.", line);
      stmts.push(this.parseStatement());
    }
    this.next();
    return { k: "block", line, stmts };
  }

  private parseStatement(): Stmt {
    const line = this.tok.line;
    if (this.is("{")) return this.parseBlock();
    if (this.accept(";")) return { k: "empty", line };
    if (this.tok.t === "id") {
      switch (this.tok.v) {
        case "if": {
          this.next();
          this.expect("(", "after 'if'");
          const test = this.parseExpr();
          this.expect(")", "after the if condition");
          const then = this.parseStatement();
          const els = this.accept("else") ? this.parseStatement() : null;
          return { k: "if", line, test, then, else: els };
        }
        case "while": {
          this.next();
          this.expect("(", "after 'while'");
          const test = this.parseExpr();
          this.expect(")", "after the while condition");
          return { k: "while", line, test, body: this.parseStatement() };
        }
        case "do": {
          this.next();
          const body = this.parseStatement();
          this.expect("while", "after the do body");
          this.expect("(");
          const test = this.parseExpr();
          this.expect(")");
          this.expect(";", "after do-while");
          return { k: "do", line, test, body };
        }
        case "for": {
          this.next();
          this.expect("(", "after 'for'");
          let init: Stmt | null = null;
          if (this.accept(";")) init = null;
          else if (this.atType()) {
            const { ty, isConst } = this.parseType();
            const first = this.ident("a variable name");
            init = { k: "decl", line, decls: this.parseDeclaratorsAfterName(ty, isConst, first) };
            this.expect(";", "in the for header");
          } else {
            init = { k: "expr", line, e: this.parseExpr() };
            this.expect(";", "in the for header");
          }
          const test = this.is(";") ? null : this.parseExpr();
          this.expect(";", "in the for header");
          const update = this.is(")") ? null : this.parseExpr();
          this.expect(")", "to close the for header");
          return { k: "for", line, init, test, update, body: this.parseStatement() };
        }
        case "switch": {
          this.next();
          this.expect("(", "after 'switch'");
          const test = this.parseExpr();
          this.expect(")");
          this.expect("{");
          const cases: SwitchCase[] = [];
          while (!this.accept("}")) {
            const caseLine = this.tok.line;
            let caseTest: Expr | null = null;
            if (this.accept("case")) caseTest = this.parseTernary();
            else if (!this.accept("default")) {
              throw new CompileError("Expected 'case' or 'default' in switch.", caseLine);
            }
            this.expect(":");
            const body: Stmt[] = [];
            while (!this.is("case") && !this.is("default") && !this.is("}")) {
              if (this.peek(0).t === "eof") throw new CompileError("Missing '}' after switch.", line);
              body.push(this.parseStatement());
            }
            cases.push({ test: caseTest, body, line: caseLine });
          }
          return { k: "switch", line, test, cases };
        }
        case "break":
          this.next();
          this.expect(";", "after 'break'");
          return { k: "break", line };
        case "continue":
          this.next();
          this.expect(";", "after 'continue'");
          return { k: "continue", line };
        case "return": {
          this.next();
          const e = this.is(";") ? null : this.parseExpr();
          this.expect(";", "after return");
          return { k: "return", line, e };
        }
        case "else":
          throw new CompileError("'else' without a matching 'if'.", line);
      }
      if (this.atType()) {
        const { ty, isConst } = this.parseType();
        const first = this.ident("a variable name");
        const decls = this.parseDeclaratorsAfterName(ty, isConst, first);
        this.expect(";", "after the declaration");
        return { k: "decl", line, decls };
      }
    }
    const e = this.parseExpr();
    this.expect(";", "at the end of the statement");
    return { k: "expr", line, e };
  }

  // ---- expressions ------------------------------------------------------

  parseExpr(): Expr {
    const first = this.parseAssign();
    if (!this.is(",")) return first;
    const list = [first];
    while (this.accept(",")) list.push(this.parseAssign());
    return expr("comma", first.line, { list });
  }

  private parseAssign(): Expr {
    const left = this.parseTernary();
    if (this.tok.t === "punc" && ASSIGN_OPS.has(this.tok.v)) {
      const op = this.next().v;
      const value = this.parseAssign();
      if (left.k !== "id" && left.k !== "index") {
        throw new CompileError("The left side of an assignment must be a variable or array element.", left.line);
      }
      return expr("assign", left.line, { op, target: left, r: value });
    }
    return left;
  }

  private parseTernary(): Expr {
    const test = this.parseBinary(1);
    if (!this.accept("?")) return test;
    const a = this.parseAssign();
    this.expect(":", "in the ?: expression");
    const b = this.parseAssign();
    return expr("cond", test.line, { test, a, b });
  }

  private parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const op = this.tok.v;
      const prec = this.tok.t === "punc" ? BINARY_PREC[op] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      const right = this.parseBinary(prec + 1);
      left = expr(op === "&&" || op === "||" ? "logical" : "binary", left.line, { op, l: left, r: right });
    }
  }

  private parseUnary(): Expr {
    const line = this.tok.line;
    if (this.tok.t === "punc") {
      const op = this.tok.v;
      if (op === "++" || op === "--") {
        this.next();
        const arg = this.parseUnary();
        return expr("update", line, { op, prefix: true, arg });
      }
      if (op === "-" || op === "+" || op === "!" || op === "~") {
        this.next();
        return expr("unary", line, { op, arg: this.parseUnary() });
      }
      if (op === "&") {
        throw new CompileError("Pointers ('&') aren't supported by the simulator.", line);
      }
      if (op === "(" && this.atType(1)) {
        // Cast: (int) x
        this.next();
        const { ty } = this.parseType();
        this.expect(")", "after the cast type");
        return expr("cast", line, { to: ty, arg: this.parseUnary() });
      }
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.is("[")) {
        this.next();
        const index = this.parseExpr();
        this.expect("]");
        e = expr("index", e.line, { obj: e, index });
      } else if (this.is("(")) {
        if (e.k !== "id") throw new CompileError("Only named functions can be called.", e.line);
        this.next();
        const args: Expr[] = [];
        if (!this.is(")")) {
          do args.push(this.parseAssign());
          while (this.accept(","));
        }
        this.expect(")", `to close the call to ${e.name}`);
        e = expr("call", e.line, { name: e.name, args });
      } else if (this.is("++") || this.is("--")) {
        const op = this.next().v;
        e = expr("update", e.line, { op, prefix: false, arg: e });
      } else if (this.is(".") || this.is("->")) {
        throw new CompileError("Structs ('.' and '->') aren't supported by the simulator.", this.tok.line);
      } else return e;
    }
  }

  private parsePrimary(): Expr {
    const t = this.tok;
    if (t.t === "num") {
      this.next();
      return expr("num", t.line, { value: t.n!, ty: t.isFloat ? FLOAT : INT });
    }
    if (t.t === "str") {
      this.next();
      // Adjacent string literals concatenate: "ab" "cd"
      let s = t.v;
      while (this.tok.t === "str") s += this.next().v;
      return expr("str", t.line, { value: s, ty: STRING });
    }
    if (t.t === "id") {
      this.next();
      return expr("id", t.line, { name: t.v });
    }
    if (this.accept("(")) {
      const e = this.parseExpr();
      this.expect(")", "to close the parenthesis");
      return e;
    }
    const got = t.t === "eof" ? "end of file" : `'${t.v}'`;
    throw new CompileError(`Expected a value but found ${got}.`, t.line);
  }
}
