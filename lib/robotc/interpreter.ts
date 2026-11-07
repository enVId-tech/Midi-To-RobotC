import { CType, Declarator, Expr, FLOAT, Func, INT, Init, LONG, Program, Stmt } from "./ast";
import { promote } from "./analyzer";
import { BUILTIN_VARS } from "./builtins";
import { formatPrintf, Value } from "./printf";

export type { Value } from "./printf";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export class RuntimeError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

/** A tone the NXT speaker plays. Times are in simulated milliseconds. */
export interface Tone {
  id: number;
  start: number;
  /** end === start means the tone was cancelled before it began. */
  end: number;
  freq: number;
  /** nVolume when the tone was queued, 0-4. */
  volume: number;
  /** Source line of the PlayTone() call. */
  line: number;
}

/** "Task `task` is about to run the statement on `line`" at time `t`. */
export interface LineEvent {
  t: number;
  task: number;
  line: number;
  depth: number;
}

export interface LcdState {
  lines: string[];
  big: boolean[];
}

export interface LcdEvent extends LcdState {
  t: number;
}

/** Speaker activity in the order it happened: a tone was queued, or sound was cut off at t. */
export type SoundEvent = { kind: "tone"; tone: Tone } | { kind: "cut"; t: number };

export interface DebugEvent {
  t: number;
  text: string;
  clear?: boolean;
}

export interface RuntimeWarning {
  line: number;
  message: string;
}

export interface TaskInfo {
  id: number;
  name: string;
  /** 1 inside the task body, 2 inside a function it called, ... */
  depth: number;
  line: number;
}

export type RunResult = "limit" | "done" | "stopped" | "error" | "steps";

export interface RunOptions {
  /** Stop when simulated time reaches this (ms). */
  limit?: number;
  /** Stop after this many statements (guards against endless loops in seeks). */
  maxSteps?: number;
  /**
   * Called before every statement. Return true to stop the brick there --
   * the statement has not run yet and runs first when the brick resumes.
   */
  stopBefore?: (task: TaskInfo) => boolean;
}

export interface BrickOptions {
  /** Seed for random(), so seeking and replaying give the same results. */
  seed?: number;
  /** Which NXT button is held at simulated time t (kNoButton = -1). */
  buttonAt?: (t: number) => number;
  /** Record a line event for every statement, not just changes. */
  recordAllLines?: boolean;
}

export interface VariableView {
  name: string;
  type: string;
  value: string;
}

export interface FrameView {
  name: string;
  line: number;
  locals: VariableView[];
}

export interface TaskView {
  id: number;
  name: string;
  line: number;
  state: "running" | "waiting" | "done";
  frames: FrameView[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Every statement takes this much simulated time, so busy loops still advance the clock. */
export const STATEMENT_COST_MS = 0.01;
/** Statements a task may run before the next task gets a turn. */
const SLICE = 40;
const MAX_CALL_DEPTH = 120;
const MAX_ARRAY_ELEMENTS = 200_000;
const LCD_ROWS = 8;
const LCD_COLS = 16;
const LCD_BIG_COLS = 8;
/** Approximate NXT motor speed at power 100, in degrees per millisecond (~150 rpm). */
const MOTOR_DEG_PER_MS = 0.9;

/** Yielded when the running task goes to sleep. Statement yields are line numbers (>= 1). */
const WAIT = 0;

const NORMAL = 0;
const BREAK = 1;
const CONTINUE = 2;
const RETURN = 3;

type Gen<T> = Generator<number, T, void>;

interface Cell {
  ty: CType;
  v: Value;
}

interface Ref {
  ty: CType;
  get(): Value;
  set(v: Value): void;
}

interface Frame {
  task: Task;
  name: string;
  retTy: CType;
  scopes: Map<string, Cell>[];
  ret: Value;
  line: number;
}

interface Task {
  id: number;
  name: string;
  gen: Gen<void> | null;
  wake: number;
  done: boolean;
  line: number;
  frames: Frame[];
  lastEventLine: number;
  lastEventT: number;
}

const PAUSING = new Set(["wait1Msec", "wait10Msec", "sleep", "delay", "wait", "EndTimeSlice", "abortTimeslice"]);

/** Rough versions of the NXT's built-in PlaySound() effects: [Hz, 1/100 s]. */
const SOUND_EFFECTS: Record<number, [number, number][]> = {
  0: [[2093, 5]], // soundBlip
  1: [[1047, 15], [0, 5], [1047, 15]], // soundBeepBeep
  2: [[1568, 10], [1319, 10], [1047, 10], [784, 10]], // soundDownwardTones
  3: [[784, 10], [1047, 10], [1319, 10], [1568, 10]], // soundUpwardTones
  4: [[110, 50]], // soundLowBuzz
  5: [[784, 5], [1047, 5], [1319, 5], [1568, 5]], // soundFastUpwardTones
  6: [[2093, 2]], // soundShortBlip
  7: [[1047, 10], [784, 10], [523, 20]], // soundException
  8: [[110, 20]], // soundLowBuzzShort
};

export function wrapToType(v: number, ty: CType): number {
  switch (ty.base) {
    case "float":
      return Math.fround(v);
    case "bool":
      return v ? 1 : 0;
    case "int": {
      if (!Number.isFinite(v)) return 0;
      const x = Math.trunc(v);
      if (ty.bits >= 32) return ty.unsigned ? x >>> 0 : x | 0;
      if (ty.bits === 16) return ty.unsigned ? x & 0xffff : ((x & 0xffff) << 16) >> 16;
      return ty.unsigned ? x & 0xff : ((x & 0xff) << 24) >> 24;
    }
    default:
      return v;
  }
}

function typeRange(ty: CType): string {
  if (ty.unsigned) return `0 to ${2 ** ty.bits - 1}`;
  return `${-(2 ** (ty.bits - 1))} to ${2 ** (ty.bits - 1) - 1}`;
}

const truthy = (v: Value): boolean => (typeof v === "number" ? v !== 0 : typeof v === "string" ? v.length > 0 : true);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseName(e: Expr): string {
  let b = e;
  while (b.k === "index" && b.obj) b = b.obj;
  return b.name ?? "array";
}

function formatValue(v: Value, ty: CType): string {
  if (Array.isArray(v)) {
    const items = v.slice(0, 12).map((x) => formatValue(x, ty));
    return `{${items.join(", ")}${v.length > 12 ? `, ... (${v.length} total)` : ""}}`;
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (ty.base === "bool") return v ? "true" : "false";
  if (ty.base === "float") return Number.isInteger(v) ? v.toFixed(1) : String(Number(v.toPrecision(7)));
  return String(v);
}

// ---------------------------------------------------------------------------
// Brick: one simulated NXT running one program
// ---------------------------------------------------------------------------

/**
 * Runs a compiled RobotC program the way an NXT would, in simulated time.
 *
 * Each task is a generator that yields before every statement, which is what
 * lets the simulator stop on any line (breakpoints, stepping, "play from
 * here") and interleave tasks. Waits put a task to sleep until a wake time;
 * the brick's clock jumps forward when every task is asleep, so a whole song
 * can be "played" silently in milliseconds to seek or build a timeline.
 *
 * Output is collected in outboxes (soundEvents, lineEvents, lcdEvents,
 * debugEvents) that the engine drains to drive audio and the UI.
 */
export class Brick {
  vt = 0;
  finished = false;
  error: RuntimeError | null = null;
  endTime: number | null = null;
  totalSteps = 0;

  /** Every tone queued so far (trimmed in very long runs). */
  tones: Tone[] = [];
  // Outboxes
  soundEvents: SoundEvent[] = [];
  lineEvents: LineEvent[] = [];
  lcdEvents: LcdEvent[] = [];
  debugEvents: DebugEvent[] = [];
  warnings: RuntimeWarning[] = [];

  lcd: LcdState = { lines: new Array(LCD_ROWS).fill(""), big: new Array(LCD_ROWS).fill(false) };
  volume = 4;
  motorPower = [0, 0, 0];
  motorEncoder = [0, 0, 0];

  private tasks: Task[] = [];
  private rr = -1;
  private globals = new Map<string, Cell>();
  private queueEnd = 0;
  private nextToneId = 1;
  private warned = new Set<string>();
  private timers = [0, 0, 0, 0];
  private motorTarget = [0, 0, 0];
  private motorUpdated = 0;
  private sensors = [0, 0, 0, 0];
  private sensorTypes = [0, 0, 0, 0];
  private statusDisplay = 1;
  private rng: () => number;
  private buttonAt: (t: number) => number;
  private recordAll: boolean;
  private hogTask: Task | null = null;
  private cur: Task | null = null;

  constructor(private program: Program, options: BrickOptions = {}) {
    this.rng = mulberry32(options.seed ?? 12345);
    this.buttonAt = options.buttonAt ?? (() => -1);
    this.recordAll = !!options.recordAllLines;

    const init: Task = this.newTask(-1, "(globals)");
    const frame = this.newFrame(init, "(globals)", INT);
    frame.scopes = [];
    try {
      for (const d of program.globals) this.runSync(this.declare(d, this.globals, frame), d.line);
      this.startTask(program.functions.get("main")!);
    } catch (err) {
      this.fail(err, init);
    }
  }

  // ---- running ------------------------------------------------------------

  /** Runs the program until a stop condition. See RunOptions. */
  run(opts: RunOptions = {}): RunResult {
    const limit = opts.limit ?? Infinity;
    const maxSteps = opts.maxSteps ?? Infinity;
    let steps = 0;
    for (;;) {
      if (this.finished) return this.error ? "error" : "done";
      const task = this.pickRunnable();
      if (!task) {
        let next = Infinity;
        for (const t of this.tasks) if (!t.done && t.wake < next) next = t.wake;
        if (next === Infinity) {
          this.finish();
          return "done";
        }
        if (next >= limit) {
          if (limit > this.vt) this.vt = limit;
          return "limit";
        }
        if (next > this.vt) this.vt = next;
        continue;
      }
      if (this.vt >= limit) return "limit";

      this.cur = task;
      for (let n = 0; n < SLICE; n++) {
        let r: IteratorResult<number, void>;
        try {
          r = task.gen!.next();
        } catch (err) {
          this.fail(err, task);
          return "error";
        }
        if (this.finished) return this.error ? "error" : "done";
        if (r.done) {
          task.done = true;
          if (task.id === 0) {
            this.finish();
            return "done";
          }
          break;
        }
        if (task.done) break;
        const line = r.value;
        if (line === WAIT) break;

        this.vt += STATEMENT_COST_MS;
        task.line = line;
        steps++;
        this.totalSteps++;
        const depth = task.frames.length;
        if (this.recordAll || line !== task.lastEventLine || this.vt - task.lastEventT >= 4) {
          this.lineEvents.push({ t: this.vt, task: task.id, line, depth });
          task.lastEventLine = line;
          task.lastEventT = this.vt;
        }
        if (opts.stopBefore && opts.stopBefore({ id: task.id, name: task.name, depth, line })) return "stopped";
        if (steps >= maxSteps) return "steps";
        if (this.vt >= limit) return "limit";
      }
    }
  }

  /** Time the next statement will run (after any sleeping), or Infinity when finished. */
  nextActivity(): number {
    if (this.finished) return Infinity;
    let next = Infinity;
    for (const t of this.tasks) if (!t.done && t.wake < next) next = t.wake;
    return Math.max(this.vt, next);
  }

  /** Where each live task is: the last statement it reached. */
  currentLines(): { task: number; name: string; line: number; waiting: boolean }[] {
    return this.tasks
      .filter((t) => !t.done && t.id >= 0)
      .map((t) => ({ task: t.id, name: t.name, line: t.line, waiting: t.wake > this.vt }));
  }

  taskName(id: number): string {
    return this.tasks[id]?.name ?? "?";
  }

  get soundActive(): boolean {
    return this.vt < this.queueEnd;
  }

  /** Drops old tones in endless programs so memory stays bounded. */
  trimTones(before: number) {
    if (this.tones.length > 4000) this.tones = this.tones.filter((t) => t.end > before);
  }

  inspect(): { globals: VariableView[]; tasks: TaskView[] } {
    const view = (map: Map<string, Cell>): VariableView[] =>
      Array.from(map.entries()).map(([name, c]) => ({
        name,
        type: c.ty.name + (Array.isArray(c.v) ? "[]" : ""),
        value: formatValue(c.v, c.ty),
      }));
    return {
      globals: view(this.globals),
      tasks: this.tasks
        .filter((t) => t.id >= 0)
        .map((t) => ({
          id: t.id,
          name: t.name,
          line: t.line,
          state: t.done ? "done" : t.wake > this.vt ? "waiting" : "running",
          frames: t.frames
            .map((f) => {
              const locals: VariableView[] = [];
              const seen = new Set<string>();
              for (let i = f.scopes.length - 1; i >= 0; i--) {
                for (const v of view(f.scopes[i])) {
                  if (!seen.has(v.name)) {
                    seen.add(v.name);
                    locals.push(v);
                  }
                }
              }
              return { name: f.name, line: f.line, locals };
            })
            .reverse(),
        })),
    };
  }

  // ---- tasks --------------------------------------------------------------

  private newTask(id: number, name: string): Task {
    return { id, name, gen: null, wake: 0, done: false, line: 0, frames: [], lastEventLine: -1, lastEventT: -1 };
  }

  private newFrame(task: Task, name: string, retTy: CType): Frame {
    return { task, name, retTy, scopes: [new Map()], ret: 0, line: 0 };
  }

  private startTask(fn: Func) {
    const existing = this.tasks.find((t) => t.name === fn.name && !t.done);
    if (existing) return;
    const task = this.newTask(this.tasks.length, fn.name);
    task.wake = this.vt;
    const frame = this.newFrame(task, fn.name, fn.ret);
    task.frames.push(frame);
    task.gen = this.runTaskBody(fn, frame);
    this.tasks.push(task);
  }

  private *runTaskBody(fn: Func, frame: Frame): Gen<void> {
    yield* this.exec(fn.body, frame);
    frame.task.frames.pop();
  }

  private pickRunnable(): Task | null {
    if (this.hogTask && !this.hogTask.done && this.hogTask.wake <= this.vt) return this.hogTask;
    const n = this.tasks.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.rr + k) % n;
      const t = this.tasks[i];
      if (!t.done && t.wake <= this.vt) {
        this.rr = i;
        return t;
      }
    }
    return null;
  }

  private finish() {
    if (this.finished && this.endTime !== null) return;
    this.finished = true;
    this.endTime = this.vt;
    for (const t of this.tasks) t.done = true;
    // The program ending silences the speaker.
    this.clearSounds();
  }

  private fail(err: unknown, task: Task) {
    this.error =
      err instanceof RuntimeError
        ? err
        : new RuntimeError(`Simulator problem: ${err instanceof Error ? err.message : String(err)}`, task.line);
    this.finish();
  }

  /** Runs a generator that must not pause (global initializers). */
  private runSync<T>(gen: Gen<T>, line: number): T {
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
      if (r.value === WAIT) throw new RuntimeError("Global variables can't wait while being initialized.", line);
    }
  }

  // ---- warnings -----------------------------------------------------------

  private warnOnce(line: number, key: string, message: string) {
    const k = `${line}|${key}`;
    if (this.warned.has(k) || this.warnings.length > 200) return;
    this.warned.add(k);
    this.warnings.push({ line, message });
  }

  // ---- statements ---------------------------------------------------------

  private *execBlock(stmts: Stmt[], f: Frame): Gen<number> {
    f.scopes.push(new Map());
    try {
      for (const s of stmts) {
        const c = yield* this.exec(s, f);
        if (c !== NORMAL) return c;
      }
      return NORMAL;
    } finally {
      f.scopes.pop();
    }
  }

  private *exec(s: Stmt, f: Frame): Gen<number> {
    switch (s.k) {
      case "block":
        return yield* this.execBlock(s.stmts!, f);
      case "empty":
        return NORMAL;
      case "decl": {
        if (s.decls!.some((d) => d.init)) yield s.line;
        const scope = f.scopes[f.scopes.length - 1];
        for (const d of s.decls!) yield* this.declare(d, scope, f);
        return NORMAL;
      }
      case "expr":
        yield s.line;
        if (s.e) yield* this.ev(s.e, f);
        return NORMAL;
      case "if":
        yield s.line;
        if (truthy(yield* this.ev(s.test!, f))) return yield* this.exec(s.then!, f);
        if (s.else) return yield* this.exec(s.else, f);
        return NORMAL;
      case "while":
        for (;;) {
          yield s.line;
          if (!truthy(yield* this.ev(s.test!, f))) return NORMAL;
          const c = yield* this.exec(s.body!, f);
          if (c === BREAK) return NORMAL;
          if (c === RETURN) return RETURN;
        }
      case "do":
        for (;;) {
          const c = yield* this.exec(s.body!, f);
          if (c === BREAK) return NORMAL;
          if (c === RETURN) return RETURN;
          yield s.test!.line;
          if (!truthy(yield* this.ev(s.test!, f))) return NORMAL;
        }
      case "for": {
        f.scopes.push(new Map());
        try {
          yield s.line;
          if (s.init) {
            if (s.init.k === "decl") {
              const scope = f.scopes[f.scopes.length - 1];
              for (const d of s.init.decls!) yield* this.declare(d, scope, f);
            } else if (s.init.e) {
              yield* this.ev(s.init.e, f);
            }
          }
          let first = true;
          for (;;) {
            if (!first) yield s.line;
            first = false;
            if (s.test && !truthy(yield* this.ev(s.test, f))) return NORMAL;
            const c = yield* this.exec(s.body!, f);
            if (c === BREAK) return NORMAL;
            if (c === RETURN) return RETURN;
            if (s.update) yield* this.ev(s.update, f);
          }
        } finally {
          f.scopes.pop();
        }
      }
      case "switch": {
        yield s.line;
        const v = yield* this.ev(s.test!, f);
        const cases = s.cases!;
        let start = cases.findIndex((c) => c.test && this.evp(c.test, f) === v);
        if (start < 0) start = cases.findIndex((c) => !c.test);
        if (start < 0) return NORMAL;
        f.scopes.push(new Map());
        try {
          for (let i = start; i < cases.length; i++) {
            for (const st of cases[i].body) {
              const c = yield* this.exec(st, f);
              if (c === BREAK) return NORMAL;
              if (c !== NORMAL) return c;
            }
          }
          return NORMAL;
        } finally {
          f.scopes.pop();
        }
      }
      case "break":
        yield s.line;
        return BREAK;
      case "continue":
        yield s.line;
        return CONTINUE;
      case "return":
        yield s.line;
        if (s.e) {
          const v = yield* this.ev(s.e, f);
          if (f.retTy.base !== "void") f.ret = this.convert(v, f.retTy, s.line);
        }
        return RETURN;
    }
  }

  private *declare(d: Declarator, scope: Map<string, Cell>, f: Frame): Gen<void> {
    if (d.dims.length === 0) {
      let v: Value = d.ty.base === "string" ? "" : 0;
      if (d.init) {
        if (d.init.k !== "expr") throw new RuntimeError(`'${d.name}' isn't an array.`, d.line);
        v = this.convert(yield* this.ev(d.init.e, f), d.ty, d.line);
      }
      scope.set(d.name, { ty: d.ty, v });
      return;
    }
    const dims: number[] = [];
    for (let i = 0; i < d.dims.length; i++) {
      const dim = d.dims[i];
      if (dim) {
        const n = yield* this.ev(dim, f);
        dims.push(Math.trunc(Number(n)));
      } else {
        dims.push(this.initLength(d.init, d.ty));
      }
    }
    let total = 1;
    for (const n of dims) {
      if (!(n > 0)) throw new RuntimeError(`Array '${d.name}' must have a size of at least 1 (got ${n}).`, d.line);
      total *= n;
    }
    if (total > MAX_ARRAY_ELEMENTS) {
      throw new RuntimeError(`Array '${d.name}' has ${total} elements -- far more than an NXT has memory for.`, d.line);
    }
    const zero: Value = d.ty.base === "string" ? "" : 0;
    const make = (level: number): Value[] =>
      Array.from({ length: dims[level] }, () => (level === dims.length - 1 ? zero : make(level + 1)));
    const arr = make(0);
    if (d.init) yield* this.fillArray(arr, d.init, dims, 0, d, f);
    scope.set(d.name, { ty: d.ty, v: arr });
  }

  private initLength(init: Init | null, ty: CType): number {
    if (!init) return 0;
    if (init.k === "list") return init.items.length;
    if (init.e.k === "str" && ty.base !== "string") return String(init.e.value).length + 1;
    return 1;
  }

  private *fillArray(arr: Value[], init: Init, dims: number[], level: number, d: Declarator, f: Frame): Gen<void> {
    const last = level === dims.length - 1;
    if (init.k === "expr") {
      if (init.e.k === "str" && last && d.ty.base !== "string") {
        const s = String(init.e.value);
        if (s.length + 1 > arr.length) throw new RuntimeError(`Text is too long for '${d.name}'.`, init.line);
        for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
        return;
      }
      throw new RuntimeError(`Array '${d.name}' needs a { ... } list.`, init.line);
    }
    if (init.items.length > arr.length) {
      throw new RuntimeError(
        `Too many values for '${d.name}': it holds ${arr.length} but the list has ${init.items.length}.`,
        init.line
      );
    }
    for (let i = 0; i < init.items.length; i++) {
      const item = init.items[i];
      if (last) {
        if (item.k !== "expr") throw new RuntimeError(`Too many { } levels for '${d.name}'.`, item.line);
        arr[i] = this.convert(yield* this.ev(item.e, f), d.ty, item.line);
      } else {
        yield* this.fillArray(arr[i] as Value[], item, dims, level + 1, d, f);
      }
    }
  }

  // ---- variables ----------------------------------------------------------

  private cell(name: string, f: Frame, line: number): Cell {
    for (let i = f.scopes.length - 1; i >= 0; i--) {
      const c = f.scopes[i].get(name);
      if (c) return c;
    }
    const g = this.globals.get(name);
    if (g) return g;
    throw new RuntimeError(`'${name}' isn't available here.`, line);
  }

  private convert(v: Value, ty: CType, line: number, check = true): Value {
    if (ty.base === "string") {
      if (Array.isArray(v)) throw new RuntimeError("Expected text but got an array.", line);
      return typeof v === "string" ? v : String(v);
    }
    if (typeof v !== "number") {
      throw new RuntimeError(Array.isArray(v) ? "Expected a single value but got an array." : "Expected a number but got text.", line);
    }
    const w = wrapToType(v, ty);
    if (check && ty.base === "int" && Number.isFinite(v) && w !== Math.trunc(v)) {
      this.warnOnce(
        line,
        "overflow",
        `${Math.trunc(v)} doesn't fit in ${/^[aeiou]/.test(ty.name) ? "an" : "a"} ${ty.name} (${typeRange(ty)}), so it wrapped around to ${w}. A real NXT does the same -- use a long if you need bigger numbers.`
      );
    }
    return w;
  }

  private num(v: Value, line: number): number {
    if (typeof v === "number") return v;
    throw new RuntimeError(Array.isArray(v) ? "Expected a number but got an array." : "Expected a number but got text.", line);
  }

  private index(v: Value, line: number): number {
    const n = this.num(v, line);
    return Math.trunc(n);
  }

  private elemRef(arr: Value[], i: number, ty: CType): Ref {
    return { ty, get: () => arr[i], set: (v) => (arr[i] = v) };
  }

  private boundsCheck(e: Expr, i: number, length: number) {
    if (i < 0 || i >= length) {
      throw new RuntimeError(
        `Index ${i} is outside array '${baseName(e)}' (it has ${length} element${length === 1 ? "" : "s"}: 0 to ${length - 1}).`,
        e.line
      );
    }
  }

  private lvalP(e: Expr, f: Frame): Ref {
    if (e.k === "id") return this.idRef(e, f);
    const obj = e.obj!;
    if (obj.k === "id" && obj.ref === "bvar") return this.builtinArrayRef(obj.name!, this.index(this.evp(e.index!, f), e.line), e);
    return this.arrayRef(e, this.evp(obj, f), this.evp(e.index!, f));
  }

  private *lval(e: Expr, f: Frame): Gen<Ref> {
    if (e.pure || e.k === "id") return this.lvalP(e, f);
    const obj = e.obj!;
    if (obj.k === "id" && obj.ref === "bvar") {
      const i = this.index(yield* this.ev(e.index!, f), e.line);
      return this.builtinArrayRef(obj.name!, i, e);
    }
    const arr = yield* this.ev(obj, f);
    const idx = yield* this.ev(e.index!, f);
    return this.arrayRef(e, arr, idx);
  }

  private idRef(e: Expr, f: Frame): Ref {
    if (e.ref === "bvar") {
      const name = e.name!;
      return { ty: e.ty, get: () => this.readBuiltin(name, e.line), set: (v) => this.writeBuiltin(name, v, e.line) };
    }
    const c = this.cell(e.name!, f, e.line);
    return { ty: c.ty, get: () => c.v, set: (v) => (c.v = v) };
  }

  private arrayRef(e: Expr, arr: Value, idx: Value): Ref {
    if (!Array.isArray(arr)) {
      throw new RuntimeError(
        typeof arr === "string" ? "Characters of a string can't be changed one at a time here." : `'${baseName(e)}' isn't an array.`,
        e.line
      );
    }
    const i = this.index(idx, e.line);
    this.boundsCheck(e, i, arr.length);
    return this.elemRef(arr, i, e.ty);
  }

  private indexGet(e: Expr, obj: Value, idx: Value): Value {
    const i = this.index(idx, e.line);
    if (typeof obj === "string") return i >= 0 && i < obj.length ? obj.charCodeAt(i) : 0;
    if (!Array.isArray(obj)) throw new RuntimeError(`'${baseName(e)}' isn't an array.`, e.line);
    this.boundsCheck(e, i, obj.length);
    return obj[i];
  }

  // ---- expressions --------------------------------------------------------

  /** Evaluates an expression that can't pause, without generator overhead. */
  private evp(e: Expr, f: Frame): Value {
    switch (e.k) {
      case "num":
        return e.value as number;
      case "str":
        return e.value as string;
      case "id":
        if (e.ref === "const") return e.constValue!;
        if (e.ref === "bvar") return this.readBuiltin(e.name!, e.line);
        return this.cell(e.name!, f, e.line).v;
      case "index": {
        const obj = e.obj!;
        if (obj.k === "id" && obj.ref === "bvar") return this.builtinArrayRef(obj.name!, this.index(this.evp(e.index!, f), e.line), e).get();
        return this.indexGet(e, this.evp(obj, f), this.evp(e.index!, f));
      }
      case "call":
        if (e.taskName) return this.taskBuiltin(e);
        return this.builtin(e, e.args!.map((a) => this.evp(a, f)));
      case "unary":
        return this.unary(e, this.evp(e.arg!, f));
      case "update":
        return this.update(e, this.lvalP(e.arg!, f));
      case "binary":
        return this.binary(e, this.evp(e.l!, f), this.evp(e.r!, f));
      case "logical": {
        const l = truthy(this.evp(e.l!, f));
        if (e.op === "&&") return l ? (truthy(this.evp(e.r!, f)) ? 1 : 0) : 0;
        return l ? 1 : truthy(this.evp(e.r!, f)) ? 1 : 0;
      }
      case "assign":
        return this.assign(e, this.lvalP(e.target!, f), this.evp(e.r!, f));
      case "cond":
        return this.condResult(e, truthy(this.evp(e.test!, f)) ? this.evp(e.a!, f) : this.evp(e.b!, f));
      case "cast":
        return this.cast(e, this.evp(e.arg!, f));
      case "comma": {
        let v: Value = 0;
        for (const x of e.list!) v = this.evp(x, f);
        return v;
      }
    }
  }

  private *ev(e: Expr, f: Frame): Gen<Value> {
    if (e.pure) return this.evp(e, f);
    switch (e.k) {
      case "call":
        return yield* this.call(e, f);
      case "index": {
        const obj = e.obj!;
        if (obj.k === "id" && obj.ref === "bvar") {
          const i = this.index(yield* this.ev(e.index!, f), e.line);
          return this.builtinArrayRef(obj.name!, i, e).get();
        }
        const o = yield* this.ev(obj, f);
        const i = yield* this.ev(e.index!, f);
        return this.indexGet(e, o, i);
      }
      case "unary":
        return this.unary(e, yield* this.ev(e.arg!, f));
      case "update":
        return this.update(e, yield* this.lval(e.arg!, f));
      case "binary": {
        const l = yield* this.ev(e.l!, f);
        const r = yield* this.ev(e.r!, f);
        return this.binary(e, l, r);
      }
      case "logical": {
        const l = truthy(yield* this.ev(e.l!, f));
        if (e.op === "&&") return l ? (truthy(yield* this.ev(e.r!, f)) ? 1 : 0) : 0;
        return l ? 1 : truthy(yield* this.ev(e.r!, f)) ? 1 : 0;
      }
      case "assign": {
        const ref = yield* this.lval(e.target!, f);
        const r = yield* this.ev(e.r!, f);
        return this.assign(e, ref, r);
      }
      case "cond": {
        const t = truthy(yield* this.ev(e.test!, f));
        return this.condResult(e, t ? yield* this.ev(e.a!, f) : yield* this.ev(e.b!, f));
      }
      case "cast":
        return this.cast(e, yield* this.ev(e.arg!, f));
      case "comma": {
        let v: Value = 0;
        for (const x of e.list!) v = yield* this.ev(x, f);
        return v;
      }
      default:
        return this.evp(e, f);
    }
  }

  private condResult(e: Expr, v: Value): Value {
    return typeof v === "number" && e.ty.base !== "string" ? wrapToType(v, e.ty) : v;
  }

  private cast(e: Expr, v: Value): Value {
    if (typeof v !== "number") throw new RuntimeError("Only numbers can be cast.", e.line);
    return wrapToType(v, e.to!);
  }

  private unary(e: Expr, v: Value): Value {
    const n = this.num(v, e.line);
    switch (e.op) {
      case "!":
        return n === 0 ? 1 : 0;
      case "-":
        return this.convert(-n, e.ty, e.line);
      case "~":
        return wrapToType(~n, e.ty);
      default:
        return n;
    }
  }

  private update(e: Expr, ref: Ref): Value {
    const old = this.num(ref.get(), e.line);
    const nv = this.convert(e.op === "++" ? old + 1 : old - 1, ref.ty, e.line);
    ref.set(nv);
    return e.prefix ? nv : old;
  }

  private assign(e: Expr, ref: Ref, r: Value): Value {
    let v: Value;
    if (e.op === "=") {
      v = this.convert(r, ref.ty, e.line);
    } else {
      const op = e.op!.slice(0, -1);
      const cur = ref.get();
      if (ref.ty.base === "string") {
        if (op !== "+") throw new RuntimeError(`'${e.op}' doesn't work on strings.`, e.line);
        v = String(cur) + String(r);
      } else {
        const opTy = promote(ref.ty, e.r!.ty);
        v = this.convert(this.arith(op, this.num(cur, e.line), this.num(r, e.line), opTy, e.line), ref.ty, e.line);
      }
    }
    ref.set(v);
    return v;
  }

  private binary(e: Expr, l: Value, r: Value): Value {
    const op = e.op!;
    if (typeof l === "string" || typeof r === "string") {
      const a = String(l);
      const b = String(r);
      switch (op) {
        case "+":
          return a + b;
        case "==":
          return a === b ? 1 : 0;
        case "!=":
          return a !== b ? 1 : 0;
        case "<":
          return a < b ? 1 : 0;
        case ">":
          return a > b ? 1 : 0;
        case "<=":
          return a <= b ? 1 : 0;
        case ">=":
          return a >= b ? 1 : 0;
      }
      throw new RuntimeError(`'${op}' doesn't work on strings.`, e.line);
    }
    const a = this.num(l, e.line);
    const b = this.num(r, e.line);
    switch (op) {
      case "==":
        return a === b ? 1 : 0;
      case "!=":
        return a !== b ? 1 : 0;
      case "<":
        return a < b ? 1 : 0;
      case ">":
        return a > b ? 1 : 0;
      case "<=":
        return a <= b ? 1 : 0;
      case ">=":
        return a >= b ? 1 : 0;
    }
    return this.arith(op, a, b, e.ty, e.line);
  }

  private arith(op: string, a: number, b: number, ty: CType, line: number): number {
    const isInt = ty.base !== "float";
    switch (op) {
      case "+":
        return isInt ? (this.convert(a + b, ty, line) as number) : Math.fround(a + b);
      case "-":
        return isInt ? (this.convert(a - b, ty, line) as number) : Math.fround(a - b);
      case "*":
        return isInt ? (this.convert(a * b, ty, line) as number) : Math.fround(a * b);
      case "/":
        if (isInt) {
          if (b === 0) throw new RuntimeError("Division by zero.", line);
          return wrapToType(Math.trunc(a / b), ty);
        }
        if (b === 0) throw new RuntimeError("Division by zero.", line);
        return Math.fround(a / b);
      case "%":
        if (b === 0) throw new RuntimeError("Division by zero (in %).", line);
        return wrapToType(a % b, ty);
      case "&":
        return wrapToType(a & b, ty);
      case "|":
        return wrapToType(a | b, ty);
      case "^":
        return wrapToType(a ^ b, ty);
      case "<<":
        return wrapToType(a << (b & 31), ty);
      case ">>":
        return wrapToType(ty.unsigned ? a >>> (b & 31) : a >> (b & 31), ty);
    }
    throw new RuntimeError(`Unknown operator '${op}'.`, line);
  }

  // ---- calls --------------------------------------------------------------

  private *call(e: Expr, f: Frame): Gen<Value> {
    const name = e.name!;
    if (e.taskName) return this.taskBuiltin(e);
    const user = this.program.functions.get(name);
    if (user) return yield* this.callUser(user, e, f);

    const args: Value[] = [];
    for (const a of e.args!) args.push(yield* this.ev(a, f));
    if (!PAUSING.has(name)) return this.builtin(e, args);

    let ms = 0;
    switch (name) {
      case "wait1Msec":
        ms = this.num(this.convert(args[0], INT, e.line), e.line);
        break;
      case "wait10Msec":
        ms = this.num(this.convert(args[0], INT, e.line), e.line) * 10;
        break;
      case "sleep":
      case "delay":
        ms = this.num(this.convert(args[0], LONG, e.line), e.line);
        break;
      case "wait":
        ms = args.length ? this.num(args[0], e.line) * 1000 : 1000;
        break;
      default:
        ms = 0; // EndTimeSlice / abortTimeslice: let other tasks run
    }
    if (ms < 0) {
      this.warnOnce(e.line, "negwait", `${name}() was given a negative time (${ms}); the simulator treats it as 0.`);
      ms = 0;
    }
    f.task.wake = this.vt + ms;
    yield WAIT;
    return 0;
  }

  private *callUser(fn: Func, e: Expr, f: Frame): Gen<Value> {
    const task = f.task;
    if (task.frames.length >= MAX_CALL_DEPTH) {
      throw new RuntimeError(`Too many nested calls to ${fn.name}() -- the NXT would run out of stack.`, e.line);
    }
    const params = new Map<string, Cell>();
    for (let i = 0; i < fn.params.length; i++) {
      const p = fn.params[i];
      const arg = e.args![i];
      if (p.isArray) {
        params.set(p.name, { ty: p.ty, v: yield* this.ev(arg, f) });
      } else if (p.byRef) {
        const ref = yield* this.lval(arg, f);
        const cell = {
          ty: p.ty,
          get v() {
            return ref.get();
          },
          set v(x: Value) {
            ref.set(x);
          },
        };
        params.set(p.name, cell);
      } else {
        params.set(p.name, { ty: p.ty, v: this.convert(yield* this.ev(arg, f), p.ty, arg.line) });
      }
    }
    const frame: Frame = { task, name: fn.name, retTy: fn.ret, scopes: [params], ret: fn.ret.base === "string" ? "" : 0, line: e.line };
    task.frames.push(frame);
    try {
      yield* this.exec(fn.body, frame);
    } finally {
      task.frames.pop();
    }
    return frame.ret;
  }

  private taskBuiltin(e: Expr): Value {
    const fn = this.program.functions.get(e.taskName!)!;
    const name = e.name!;
    if (/^start/i.test(name)) {
      this.startTask(fn);
    } else {
      for (const t of this.tasks) {
        if (t.name === fn.name && !t.done) t.done = true;
      }
      if (fn.name === "main") this.finish();
    }
    return 0;
  }

  /** Built-in functions that never pause. */
  private builtin(e: Expr, args: Value[]): Value {
    const name = e.name!;
    const line = e.line;
    const n = (i: number) => this.num(args[i] ?? 0, line);
    const int = (i: number) => this.convert(args[i] ?? 0, INT, line) as number;
    switch (name) {
      // Sound
      case "PlayTone":
      case "playTone":
        this.queueTone(int(0), int(1), line);
        return 0;
      case "PlayImmediateTone":
      case "playImmediateTone":
        this.clearSounds();
        this.queueTone(int(0), int(1), line);
        return 0;
      case "ClearSounds":
      case "clearSounds":
        this.clearSounds();
        return 0;
      case "PlaySound":
      case "playSound": {
        const fx = SOUND_EFFECTS[int(0)];
        this.warnOnce(line, "playsound", "PlaySound() effects are rough imitations of the NXT's built-in sounds.");
        if (fx) for (const [hz, cs] of fx) this.queueTone(hz, cs, line);
        return 0;
      }
      case "PlaySoundFile":
      case "playSoundFile":
        this.warnOnce(line, "soundfile", "Sound files (.rso) can't be played in the simulator, so this call is silent.");
        return 0;
      // Timers
      case "ClearTimer":
      case "clearTimer":
      case "resetTimer": {
        const t = int(0);
        if (t < 0 || t > 3) throw new RuntimeError(`Timer ${t} doesn't exist (use T1-T4).`, line);
        this.timers[t] = this.vt;
        return 0;
      }
      case "hogCPU":
        this.hogTask = this.cur;
        return 0;
      case "releaseCPU":
        this.hogTask = null;
        return 0;
      case "StopAllTasks":
      case "stopAllTasks":
        this.finish();
        return 0;
      // Math
      case "random": {
        const max = Math.trunc(n(0));
        return max <= 0 ? 0 : Math.floor(this.rng() * (max + 1));
      }
      case "rand":
        return Math.floor(this.rng() * 32768);
      case "srand":
        this.rng = mulberry32(Math.trunc(n(0)));
        return 0;
      case "abs":
        return wrapToType(Math.abs(n(0)), e.ty);
      case "sgn":
        return Math.sign(n(0));
      case "sqrt":
        if (n(0) < 0) throw new RuntimeError("sqrt() of a negative number.", line);
        return Math.fround(Math.sqrt(n(0)));
      case "sin":
        return Math.fround(Math.sin(n(0)));
      case "cos":
        return Math.fround(Math.cos(n(0)));
      case "tan":
        return Math.fround(Math.tan(n(0)));
      case "asin":
        return Math.fround(Math.asin(n(0)));
      case "acos":
        return Math.fround(Math.acos(n(0)));
      case "atan":
        return Math.fround(Math.atan(n(0)));
      case "atan2":
        return Math.fround(Math.atan2(n(0), n(1)));
      case "exp":
        return Math.fround(Math.exp(n(0)));
      case "log":
        return Math.fround(Math.log(n(0)));
      case "log10":
        return Math.fround(Math.log10(n(0)));
      case "pow":
        return Math.fround(Math.pow(n(0), n(1)));
      case "floor":
        return Math.fround(Math.floor(n(0)));
      case "ceil":
        return Math.fround(Math.ceil(n(0)));
      case "round":
        return wrapToType(Math.round(n(0)), INT);
      case "sinDegrees":
        return Math.fround(Math.sin((n(0) * Math.PI) / 180));
      case "cosDegrees":
        return Math.fround(Math.cos((n(0) * Math.PI) / 180));
      case "degreesToRadians":
        return Math.fround((n(0) * Math.PI) / 180);
      case "radiansToDegrees":
        return Math.fround((n(0) * 180) / Math.PI);
      case "strlen": {
        const s = args[0];
        return typeof s === "string" ? s.length : 0;
      }
      // Debug stream
      case "writeDebugStream":
      case "writeDebugStreamLine": {
        const text = formatPrintf(String(args[0] ?? ""), args.slice(1));
        this.debugEvents.push({ t: this.vt, text: name === "writeDebugStreamLine" ? text + "\n" : text });
        return 0;
      }
      case "clearDebugStream":
        this.debugEvents.push({ t: this.vt, text: "", clear: true });
        return 0;
      case "eraseDisplay":
        this.lcd.lines.fill("");
        this.lcd.big.fill(false);
        this.pushLcd();
        return 0;
    }
    if (/[dD]isplay/.test(name)) return this.display(name, args, line);
    throw new RuntimeError(`${name}() isn't supported by the simulator.`, line);
  }

  // ---- display ------------------------------------------------------------

  private display(name: string, args: Value[], line: number): Value {
    const row = Math.trunc(this.num(args[0] ?? 0, line));
    if (row < 0 || row >= LCD_ROWS) {
      this.warnOnce(line, "lcdrow", `The NXT screen has text lines 0-7, so line ${row} isn't shown.`);
      return 0;
    }
    const L = this.lcd;
    if (/ClearTextLine/.test(name)) {
      L.lines[row] = "";
      L.big[row] = false;
      this.pushLcd();
      return 0;
    }
    const text = formatPrintf(String(args[1] ?? ""), args.slice(2));
    const big = /Big/.test(name);
    const cols = big ? LCD_BIG_COLS : LCD_COLS;
    let out = text.slice(0, cols);
    if (/Centered/.test(name)) out = " ".repeat(Math.max(0, Math.floor((cols - out.length) / 2))) + out;
    if (/String$/.test(name)) {
      // nxtDisplayString writes over the start of the line and keeps the rest.
      const old = L.lines[row];
      out = out + old.slice(out.length);
    }
    L.lines[row] = out;
    L.big[row] = big;
    if (big && row + 1 < LCD_ROWS) {
      L.lines[row + 1] = "";
      L.big[row + 1] = false;
    }
    if (big && row === LCD_ROWS - 1) L.big[row] = false;
    this.pushLcd();
    return 0;
  }

  private pushLcd() {
    this.lcdEvents.push({ t: this.vt, lines: [...this.lcd.lines], big: [...this.lcd.big] });
  }

  // ---- sound --------------------------------------------------------------

  private queueTone(freq: number, cs: number, line: number) {
    if (cs <= 0) return;
    const start = Math.max(this.vt, this.queueEnd);
    const end = start + cs * 10;
    this.queueEnd = end;
    if (freq <= 0 || this.volume <= 0) return; // silent entry: still occupies the queue
    if (freq < 20 || freq > 20000) {
      this.warnOnce(line, "freq", `${freq} Hz is outside what you can hear (or the NXT can play).`);
    }
    const tone: Tone = { id: this.nextToneId++, start, end, freq, volume: this.volume, line };
    this.tones.push(tone);
    this.soundEvents.push({ kind: "tone", tone });
  }

  private clearSounds() {
    const t = this.vt;
    if (this.queueEnd > t) this.queueEnd = t;
    for (let i = this.tones.length - 1; i >= 0; i--) {
      const tone = this.tones[i];
      if (tone.end <= t) break;
      tone.end = tone.start >= t ? tone.start : t;
    }
    this.soundEvents.push({ kind: "cut", t });
  }

  // ---- built-in variables -------------------------------------------------

  private readBuiltin(name: string, line: number): Value {
    switch (name) {
      case "nVolume":
        return this.volume;
      case "bSoundActive":
        return this.vt < this.queueEnd ? 1 : 0;
      case "bSoundQueueAvailable":
        return 1;
      case "nNxtButtonPressed":
        return this.buttonAt(this.vt);
      case "nSysTime":
      case "nPgmTime":
        return wrapToType(Math.floor(this.vt), LONG);
      case "nAvgBatteryLevel":
      case "nImmediateBatteryLevel":
        return 7800;
      case "bNxtLCDStatusDisplay":
        return this.statusDisplay;
    }
    throw new RuntimeError(`'${name}' is an array; add an [index].`, line);
  }

  private writeBuiltin(name: string, v: Value, line: number) {
    const n = this.num(v, line);
    if (name === "nVolume") {
      const vol = Math.trunc(n);
      if (vol < 0 || vol > 4) this.warnOnce(line, "volume", `nVolume goes from 0 to 4; ${vol} was limited to that range.`);
      this.volume = Math.max(0, Math.min(4, vol));
    } else if (name === "bNxtLCDStatusDisplay") {
      this.statusDisplay = n ? 1 : 0;
    } else {
      throw new RuntimeError(`'${name}' can't be changed.`, line);
    }
  }

  private updateMotors() {
    const dt = this.vt - this.motorUpdated;
    if (dt > 0) {
      for (let m = 0; m < 3; m++) this.motorEncoder[m] += (this.motorPower[m] / 100) * MOTOR_DEG_PER_MS * dt;
    }
    this.motorUpdated = this.vt;
  }

  private builtinArrayRef(name: string, i: number, e: Expr): Ref {
    const info = BUILTIN_VARS[name];
    const len = info.length ?? 1;
    if (i < 0 || i >= len) {
      throw new RuntimeError(`${name}[${i}] doesn't exist (valid indexes are 0 to ${len - 1}).`, e.line);
    }
    const line = e.line;
    const ro = () => {
      throw new RuntimeError(`'${name}' can't be changed.`, line);
    };
    switch (name) {
      case "time1":
      case "time10":
      case "time100": {
        const unit = name === "time1" ? 1 : name === "time10" ? 10 : 100;
        return {
          ty: INT,
          get: () => wrapToType(Math.floor((this.vt - this.timers[i]) / unit), INT),
          set: (v) => (this.timers[i] = this.vt - this.num(v, line) * unit),
        };
      }
      case "motor":
        return {
          ty: INT,
          get: () => this.motorPower[i],
          set: (v) => {
            this.updateMotors();
            this.motorPower[i] = Math.max(-100, Math.min(100, Math.trunc(this.num(v, line))));
          },
        };
      case "nMotorEncoder":
        return {
          ty: LONG,
          get: () => {
            this.updateMotors();
            return Math.trunc(this.motorEncoder[i]);
          },
          set: (v) => {
            this.updateMotors();
            this.motorEncoder[i] = this.num(v, line);
          },
        };
      case "nMotorEncoderTarget":
        return { ty: LONG, get: () => this.motorTarget[i], set: (v) => (this.motorTarget[i] = this.num(v, line)) };
      case "SensorValue":
      case "SensorRaw":
        return {
          ty: INT,
          get: () => this.sensors[i],
          set: name === "SensorRaw" ? ro : (v) => (this.sensors[i] = Math.trunc(this.num(v, line))),
        };
      case "SensorType":
        return { ty: INT, get: () => this.sensorTypes[i], set: (v) => (this.sensorTypes[i] = Math.trunc(this.num(v, line))) };
    }
    return { ty: FLOAT, get: () => 0, set: ro };
  }
}
