export type BaseType = "int" | "float" | "bool" | "string" | "void";

export interface CType {
  base: BaseType;
  /** Integer width in bits (8, 16, 32). Ignored for non-integers. */
  bits: number;
  unsigned: boolean;
  name: string;
}

export const INT: CType = { base: "int", bits: 16, unsigned: false, name: "int" };
export const LONG: CType = { base: "int", bits: 32, unsigned: false, name: "long" };
export const SHORT: CType = { base: "int", bits: 16, unsigned: false, name: "short" };
export const CHAR: CType = { base: "int", bits: 8, unsigned: false, name: "char" };
export const UBYTE: CType = { base: "int", bits: 8, unsigned: true, name: "ubyte" };
export const FLOAT: CType = { base: "float", bits: 32, unsigned: false, name: "float" };
export const BOOL: CType = { base: "bool", bits: 8, unsigned: true, name: "bool" };
export const STRING: CType = { base: "string", bits: 0, unsigned: false, name: "string" };
export const VOID: CType = { base: "void", bits: 0, unsigned: false, name: "void" };

export interface Expr {
  k:
    | "num" | "str" | "id" | "index" | "call" | "unary" | "update" | "binary"
    | "logical" | "assign" | "cond" | "cast" | "comma";
  line: number;
  /** Filled in by the analyzer. */
  ty: CType;
  /** True if evaluating this expression can never pause (no waits or user function calls). */
  pure: boolean;
  value?: number | string;
  name?: string;
  op?: string;
  prefix?: boolean;
  l?: Expr;
  r?: Expr;
  arg?: Expr;
  args?: Expr[];
  obj?: Expr;
  index?: Expr;
  target?: Expr;
  test?: Expr;
  a?: Expr;
  b?: Expr;
  list?: Expr[];
  to?: CType;
  /** For identifiers the analyzer resolved to a constant. */
  constValue?: number;
  /** For identifiers: "var" (user variable), "bvar" (built-in variable), "const". */
  ref?: "var" | "bvar" | "const";
  /** For calls: whether the callee is built in. */
  builtin?: boolean;
  /** For StartTask(name)/StopTask(name): the task name. */
  taskName?: string;
  /** Array rank of the value (0 = scalar). Filled in by the analyzer. */
  rank?: number;
}

export type Init = { k: "expr"; e: Expr; line: number } | { k: "list"; items: Init[]; line: number };

export interface Declarator {
  name: string;
  ty: CType;
  /** Array dimensions; null entries mean "size from initializer" (int a[] = {...}). */
  dims: (Expr | null)[];
  init: Init | null;
  line: number;
  isConst: boolean;
}

export interface SwitchCase {
  test: Expr | null;
  body: Stmt[];
  line: number;
}

export interface Stmt {
  k:
    | "decl" | "expr" | "block" | "if" | "while" | "do" | "for" | "switch"
    | "break" | "continue" | "return" | "empty";
  line: number;
  decls?: Declarator[];
  e?: Expr | null;
  body?: Stmt;
  stmts?: Stmt[];
  test?: Expr | null;
  then?: Stmt;
  else?: Stmt | null;
  init?: Stmt | null;
  update?: Expr | null;
  cases?: SwitchCase[];
}

export interface Param {
  name: string;
  ty: CType;
  isArray: boolean;
  byRef: boolean;
}

export interface Func {
  name: string;
  ret: CType;
  params: Param[];
  body: Stmt;
  isTask: boolean;
  line: number;
}

export interface Program {
  globals: Declarator[];
  functions: Map<string, Func>;
}
