import { Program } from "../robotc/ast";
import { compile } from "../robotc/compile";
import { Brick, LcdState, RunResult, RuntimeError, RuntimeWarning, TaskInfo, TaskView, VariableView } from "../robotc/interpreter";
import { Diagnostic } from "../robotc/lexer";
import { executableLines } from "../robotc/lines";
import { BrickSpeakers, Waveform } from "./audio";

export interface ProgramSpec {
  name: string;
  code: string;
}

export type EngineStatus = "stopped" | "playing" | "paused" | "finished";
export type StepMode = "into" | "over" | "out";

export interface BrickView {
  name: string;
  code: string;
  compiled: boolean;
  /** Compile errors/warnings plus warnings found while running. */
  diagnostics: Diagnostic[];
  executable: Set<number>;
  breakpoints: Set<number>;
  /** Where each running task is (the statement it's on or about to run). */
  lines: { task: number; name: string; line: number; depth: number }[];
  lcd: LcdState;
  debug: string;
  error: { line: number; message: string } | null;
  finished: boolean;
  tone: { freq: number; line: number } | null;
  volume: number;
  motors: number[];
  muted: boolean;
}

export interface TimelineTone {
  start: number;
  end: number;
  freq: number;
  brick: number;
  line: number;
}

export interface Timeline {
  tones: TimelineTone[];
  /** ms */
  duration: number;
  /** True when a program runs longer than the preview window (e.g. loops forever). */
  truncated: boolean;
}

export interface EngineSnapshot {
  status: EngineStatus;
  /** Playhead in ms. */
  time: number;
  speed: number;
  focus: number;
  bricks: BrickView[];
  timeline: Timeline;
  message: string | null;
  range: { brick: number; from: number; to: number; loop: boolean } | null;
  autoPress: boolean;
  wave: Waveform;
}

interface Slot {
  name: string;
  code: string;
  program: Program | null;
  diagnostics: Diagnostic[];
  executable: Set<number>;
  brick: Brick | null;
  breakpoints: Set<number>;
  muted: boolean;
  dryWarnings: RuntimeWarning[];
  dryError: RuntimeError | null;
  parked: TaskInfo | null;
  // What the UI shows, advanced to the playhead.
  taskLines: Map<number, { line: number; depth: number }>;
  lcd: LcdState;
  debug: string;
  lineIdx: number;
  lcdIdx: number;
  debugIdx: number;
}

interface Range {
  brick: number;
  from: number;
  to: number;
  loop: boolean;
  task: number;
  /** Call depth of the selected lines; statements in functions they call count as inside. */
  depth: number;
  startT: number;
}

const LOOKAHEAD_S = 0.12;
const HIDDEN_LOOKAHEAD_S = 1.5;
const CHUNK_MS = 10;
const TICK_MS = 25;
const PREVIEW_LIMIT_MS = 10 * 60 * 1000;
const PREVIEW_MAX_STEPS = 4_000_000;
const SEEK_MAX_STEPS = 30_000_000;
const DEBUG_MAX_CHARS = 20_000;
const K_ENTER = 3;
const K_NONE = -1;

const blankLcd = (): LcdState => ({ lines: new Array(8).fill(""), big: new Array(8).fill(false) });

/**
 * Runs one or more RobotC programs (one per simulated NXT) on a shared clock
 * and plays them through Web Audio.
 *
 * Playback runs the interpreters a little ahead of the audio clock and
 * schedules each tone at its exact time; the UI (current line, LCD, debug
 * stream) is advanced to the audio playhead on every tick. Because the
 * interpreter is deterministic (seeded random(), recorded button presses),
 * any moment can be reached again by restarting and running silently --
 * that's how seeking, pausing exactly, "play from here" and looping a
 * selection work.
 */
export class SimEngine {
  private slots: Slot[] = [];
  private speakers: BrickSpeakers | null = null;
  private status: EngineStatus = "stopped";
  private T = 0;
  private speed = 1;
  private focus = 0;
  private anchorT = 0;
  private anchorAudio = 0;
  private ranTo = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingStop: { t: number; brick: number; kind: "break" | "range" } | null = null;
  private lastStop: { info: TaskInfo; kind: "break" | "range" } | null = null;
  private range: Range | null = null;
  private buttons: { t: number; button: number }[] = [];
  private autoPress = true;
  private wave: Waveform = "square";
  private timeline: Timeline = { tones: [], duration: 0, truncated: false };
  private message: string | null = null;
  private listeners = new Set<() => void>();
  private snap: EngineSnapshot | null = null;
  private readonly seed = 2024;

  // ---- subscription (useSyncExternalStore-friendly) -------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): EngineSnapshot => {
    if (!this.snap) this.snap = this.buildSnapshot();
    return this.snap;
  };

  private notify() {
    this.snap = null;
    this.listeners.forEach((fn) => fn());
  }

  // ---- loading --------------------------------------------------------------

  /** Loads one program per NXT. Breakpoints and mutes are kept for NXTs with the same name. */
  load(specs: ProgramSpec[]) {
    this.halt();
    const old = new Map(this.slots.map((s) => [s.name, s]));
    this.slots = specs.map((spec) => {
      const prev = old.get(spec.name);
      return this.makeSlot(spec, prev?.code === spec.code ? prev.breakpoints : new Set(), prev?.muted ?? false);
    });
    if (this.focus >= this.slots.length) this.focus = 0;
    this.range = null;
    this.speakers?.setChannelCount(this.slots.length);
    this.slots.forEach((s, i) => this.speakers?.setMuted(i, s.muted));
    this.rebuild();
  }

  /** Replaces one NXT's code (after editing). */
  setCode(i: number, code: string) {
    const s = this.slots[i];
    if (!s || s.code === code) return;
    this.halt();
    this.slots[i] = this.makeSlot({ name: s.name, code }, new Set(), s.muted);
    this.range = null;
    this.rebuild();
  }

  private makeSlot(spec: ProgramSpec, breakpoints: Set<number>, muted: boolean): Slot {
    const { program, diagnostics } = compile(spec.code);
    const executable = program ? executableLines(program) : new Set<number>();
    return {
      name: spec.name,
      code: spec.code,
      program,
      diagnostics,
      executable,
      brick: null,
      breakpoints: new Set([...breakpoints].filter((l) => executable.has(l))),
      muted,
      dryWarnings: [],
      dryError: null,
      parked: null,
      taskLines: new Map(),
      lcd: blankLcd(),
      debug: "",
      lineIdx: 0,
      lcdIdx: 0,
      debugIdx: 0,
    };
  }

  private rebuild() {
    this.buildTimeline();
    this.buttons = [];
    this.resetAll();
    this.T = 0;
    this.status = "stopped";
    this.message = null;
    this.notify();
  }

  /** Runs every program silently to find out what it plays (for the timeline). */
  private buildTimeline() {
    const tones: TimelineTone[] = [];
    let duration = 0;
    let truncated = false;
    this.slots.forEach((s, i) => {
      s.dryWarnings = [];
      s.dryError = null;
      if (!s.program) return;
      const b = this.newBrick(s.program, true);
      const res = b.run({ limit: PREVIEW_LIMIT_MS, maxSteps: PREVIEW_MAX_STEPS });
      if (res === "limit" || res === "steps") truncated = true;
      for (const t of b.tones) {
        if (t.end > t.start) tones.push({ start: t.start, end: t.end, freq: t.freq, brick: i, line: t.line });
      }
      duration = Math.max(duration, b.endTime ?? b.vt);
      s.dryWarnings = b.warnings;
      s.dryError = b.error;
    });
    tones.sort((a, b) => a.start - b.start);
    this.timeline = { tones, duration, truncated };
  }

  private newBrick(program: Program, preview = false): Brick {
    return new Brick(program, {
      seed: this.seed,
      buttonAt: preview ? (t) => this.autoButton(t) : (t) => this.buttonAt(t),
    });
  }

  private autoButton(t: number): number {
    return this.autoPress && t < 200 ? K_ENTER : K_NONE;
  }

  private buttonAt(t: number): number {
    let state = this.autoButton(t);
    for (const b of this.buttons) {
      if (b.t > t) break;
      state = b.button;
    }
    return state;
  }

  // ---- state helpers --------------------------------------------------------

  private resetSlot(i: number) {
    const s = this.slots[i];
    s.brick = s.program ? this.newBrick(s.program) : null;
    s.parked = null;
    s.taskLines = new Map();
    s.lcd = blankLcd();
    s.debug = "";
    s.lineIdx = s.lcdIdx = s.debugIdx = 0;
  }

  private resetAll() {
    this.slots.forEach((_, i) => this.resetSlot(i));
    this.pendingStop = null;
  }

  /** Moves the UI state of one NXT up to time t. */
  private applyDisplay(i: number, t: number) {
    const s = this.slots[i];
    const b = s.brick;
    if (!b) return;
    const eps = 1e-6;
    const lines = b.lineEvents;
    while (s.lineIdx < lines.length && lines[s.lineIdx].t <= t + eps) {
      const e = lines[s.lineIdx++];
      s.taskLines.set(e.task, { line: e.line, depth: e.depth });
    }
    const lcd = b.lcdEvents;
    while (s.lcdIdx < lcd.length && lcd[s.lcdIdx].t <= t + eps) {
      const e = lcd[s.lcdIdx++];
      s.lcd = { lines: e.lines, big: e.big };
    }
    const dbg = b.debugEvents;
    while (s.debugIdx < dbg.length && dbg[s.debugIdx].t <= t + eps) {
      const e = dbg[s.debugIdx++];
      s.debug = e.clear ? "" : (s.debug + e.text).slice(-DEBUG_MAX_CHARS);
    }
    // Drop what's been shown so long runs don't keep growing.
    if (s.lineIdx > 4000) {
      lines.splice(0, s.lineIdx);
      s.lineIdx = 0;
    }
    if (s.lcdIdx > 500) {
      lcd.splice(0, s.lcdIdx);
      s.lcdIdx = 0;
    }
    if (s.debugIdx > 500) {
      dbg.splice(0, s.debugIdx);
      s.debugIdx = 0;
    }
    b.trimTones(t - 2000);
  }

  /** Runs one NXT silently up to time t. */
  private advanceSlotTo(i: number, t: number): RunResult | null {
    const b = this.slots[i].brick;
    if (!b) return null;
    const res = b.run({ limit: t, maxSteps: SEEK_MAX_STEPS });
    b.soundEvents.length = 0;
    this.applyDisplay(i, t);
    return res;
  }

  private resyncSlot(i: number, t: number) {
    this.resetSlot(i);
    this.advanceSlotTo(i, t);
  }

  private allFinished(): boolean {
    const live = this.slots.filter((s) => s.brick);
    return live.length > 0 && live.every((s) => s.brick!.finished);
  }

  private finishTime(): number {
    return this.slots.reduce((m, s) => Math.max(m, s.brick?.endTime ?? 0), 0);
  }

  // ---- audio ------------------------------------------------------------------

  private ensureSpeakers(): BrickSpeakers {
    if (!this.speakers) {
      this.speakers = new BrickSpeakers();
      this.speakers.wave = this.wave;
    }
    this.speakers.setChannelCount(this.slots.length);
    this.slots.forEach((s, i) => this.speakers!.setMuted(i, s.muted));
    return this.speakers;
  }

  private audioAt(t: number): number {
    return this.anchorAudio + (t - this.anchorT) / 1000 / this.speed;
  }

  private timeAt(audio: number): number {
    return this.anchorT + (audio - this.anchorAudio) * 1000 * this.speed;
  }

  /** Sends one NXT's new tones and cut-offs to the speakers. */
  private drainSound(i: number) {
    const b = this.slots[i].brick;
    if (!b) return;
    const sp = this.speakers;
    if (sp) {
      for (const e of b.soundEvents) {
        if (e.kind === "tone") {
          const t = e.tone;
          if (t.end > t.start) sp.play(i, t.freq, this.audioAt(t.start), this.audioAt(t.end), t.volume);
        } else {
          sp.cut(i, this.audioAt(e.t));
        }
      }
    }
    b.soundEvents.length = 0;
  }

  /** Schedules every tone that is still sounding (or queued) at time t. */
  private scheduleSoundingTones(t: number) {
    const sp = this.speakers!;
    this.slots.forEach((s, i) => {
      const b = s.brick;
      if (!b) return;
      b.soundEvents.length = 0;
      for (const tone of b.tones) {
        if (tone.end > t && tone.end > tone.start) {
          sp.play(i, tone.freq, this.audioAt(Math.max(tone.start, t)), this.audioAt(tone.end), tone.volume);
        }
      }
    });
  }

  private halt() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.speakers?.stopAll();
    this.pendingStop = null;
  }

  // ---- transport ----------------------------------------------------------------

  play() {
    if (this.status === "playing") return;
    if (!this.slots.some((s) => s.brick)) {
      this.message = "Fix the errors in the code first.";
      this.notify();
      return;
    }
    if (this.allFinished()) {
      this.resetAll();
      this.T = 0;
    }
    const sp = this.ensureSpeakers();
    // Bring every NXT up to the playhead (one may be behind after stepping another).
    this.slots.forEach((s, i) => {
      if (s.brick && s.brick.vt < this.T) this.advanceSlotTo(i, this.T);
      s.parked = null;
    });
    this.anchorT = this.T;
    this.anchorAudio = sp.now() + 0.06;
    this.ranTo = this.T;
    this.scheduleSoundingTones(this.T);
    this.status = "playing";
    this.message = null;
    this.tick();
    if (this.status === "playing") this.timer = setInterval(() => this.tick(), TICK_MS);
    this.notify();
  }

  pause() {
    if (this.status !== "playing") return;
    const nowT = this.timeAt(this.speakers!.now());
    this.pauseAt(Math.max(this.anchorT, Math.min(nowT, this.pendingStop?.t ?? Infinity)), -1);
  }

  /** Back to the start, ready to play again. */
  stop() {
    this.halt();
    this.buttons = [];
    this.range = null;
    this.resetAll();
    this.T = 0;
    this.status = "stopped";
    this.message = null;
    this.notify();
  }

  /** Jumps to a time (ms). Keeps playing if it was playing. */
  seek(t: number) {
    const wasPlaying = this.status === "playing";
    this.halt();
    this.range = null;
    this.resetAll();
    t = Math.max(0, t);
    const results = this.slots.map((_, i) => this.advanceSlotTo(i, t));
    this.T = t;
    this.status = this.allFinished() ? "finished" : t > 0 ? "paused" : "stopped";
    this.message = results.includes("steps") ? "That point takes too long to reach (a loop runs millions of times)." : null;
    if (wasPlaying && this.status !== "finished") this.play();
    else this.notify();
  }

  private tick() {
    const sp = this.speakers!;
    const now = sp.now();
    const nowT = this.timeAt(now);
    const ahead = typeof document !== "undefined" && document.hidden ? HIDDEN_LOOKAHEAD_S : LOOKAHEAD_S;
    const horizon = this.timeAt(now + ahead);

    let guard = 0;
    while (this.ranTo < horizon && !this.pendingStop && guard++ < 1000) {
      const next = Math.min(horizon, this.ranTo + CHUNK_MS);
      for (let i = 0; i < this.slots.length; i++) {
        const b = this.slots[i].brick;
        if (!b || b.finished) continue;
        const res = b.run({ limit: next, stopBefore: this.stopCheck(i), maxSteps: 2_000_000 });
        this.drainSound(i);
        if (res === "stopped" && this.lastStop) {
          this.slots[i].parked = this.lastStop.info;
          this.pendingStop = { t: b.vt, brick: i, kind: this.lastStop.kind };
          break;
        }
      }
      if (!this.pendingStop) this.ranTo = next;
    }

    if (this.pendingStop && this.pendingStop.kind === "range" && this.range?.loop) {
      this.loopSelection();
      return;
    }
    if (this.pendingStop && nowT >= this.pendingStop.t) {
      this.pauseAt(this.pendingStop.t, this.pendingStop.brick);
      return;
    }
    if (this.allFinished()) {
      const end = this.finishTime();
      if (nowT >= end) {
        this.finishAt(end);
        return;
      }
    }
    this.T = Math.max(this.anchorT, nowT);
    this.slots.forEach((_, i) => this.applyDisplay(i, this.T));
    this.notify();
  }

  private stopCheck(i: number): ((info: TaskInfo) => boolean) | undefined {
    const s = this.slots[i];
    const r = this.range && this.range.brick === i ? this.range : null;
    if (!s.breakpoints.size && !r) return undefined;
    return (info) => {
      if (r && info.id === r.task && info.depth <= r.depth && (info.line < r.from || info.line > r.to)) {
        this.lastStop = { info, kind: "range" };
        return true;
      }
      if (s.breakpoints.has(info.line)) {
        this.lastStop = { info, kind: "break" };
        return true;
      }
      return false;
    };
  }

  /** Pauses at time t. NXTs that ran ahead of t (to fill the audio buffer) are re-run to exactly t. */
  private pauseAt(t: number, stoppedBrick: number) {
    const stop = this.pendingStop;
    this.halt();
    this.T = t;
    this.slots.forEach((s, i) => {
      const b = s.brick;
      if (!b) return;
      if (i === stoppedBrick) {
        this.applyDisplay(i, t);
        return;
      }
      const ahead = b.vt > t + 1e-6 || (b.finished && (b.endTime ?? 0) > t + 1e-6);
      if (ahead) this.resyncSlot(i, t);
      else this.applyDisplay(i, t);
    });
    this.status = "paused";
    if (stop?.kind === "range") {
      this.message = "Reached the end of the selection.";
      this.range = null;
    } else if (stop?.kind === "break") {
      this.focus = stop.brick;
      this.message = null;
    }
    this.notify();
  }

  private finishAt(t: number) {
    this.halt();
    this.T = t;
    this.slots.forEach((_, i) => this.applyDisplay(i, t));
    this.status = "finished";
    this.range = null;
    const errors = this.slots.filter((s) => s.brick?.error);
    this.message = errors.length ? "Stopped with an error. The line is marked in red." : null;
    this.notify();
  }

  // ---- lines, selections, stepping ------------------------------------------------

  /**
   * Restarts and runs silently until NXT `i` is about to run a statement on a
   * line between from and to. Everything else is brought to the same time.
   */
  private runToLines(i: number, from: number, to: number): { t: number; task: number; depth: number } | string {
    this.resetAll();
    const s = this.slots[i];
    const b = s.brick;
    if (!b) return "This program has errors.";
    const hit: { info: TaskInfo | null } = { info: null };
    const res = b.run({
      limit: 60 * 60 * 1000,
      maxSteps: SEEK_MAX_STEPS,
      stopBefore: (info) => {
        if (info.line >= from && info.line <= to) {
          hit.info = info;
          return true;
        }
        return false;
      },
    });
    if (res !== "stopped" || !hit.info) {
      this.resetAll();
      this.T = 0;
      const what = from === to ? `Line ${from} never runs` : `Nothing on lines ${from}-${to} runs`;
      return res === "done" || res === "error" ? `${what} before the program ends.` : `${what} (looked through the first hour).`;
    }
    s.parked = hit.info;
    const t = b.vt;
    b.soundEvents.length = 0;
    this.applyDisplay(i, t);
    this.slots.forEach((_, j) => {
      if (j !== i) this.advanceSlotTo(j, t);
    });
    this.T = t;
    return { t, task: hit.info.id, depth: hit.info.depth };
  }

  private snapLine(i: number, line: number): number | null {
    const ex = this.slots[i]?.executable;
    if (!ex) return null;
    let best: number | null = null;
    for (const l of ex) if (l >= line && (best === null || l < best)) best = l;
    return best;
  }

  /** Starts playing from the first time line `line` of NXT `i` runs. */
  playFromLine(i: number, line: number) {
    this.halt();
    this.range = null;
    const r = this.runToLines(i, line, line);
    if (typeof r === "string") {
      this.status = "stopped";
      this.message = r;
      this.notify();
      return;
    }
    this.focus = i;
    this.status = "paused";
    this.play();
  }

  /** Plays lines from..to of NXT `i` (the first time they run), once or on a loop. */
  playSelection(i: number, from: number, to: number, loop: boolean) {
    this.halt();
    this.range = null;
    const r = this.runToLines(i, from, to);
    if (typeof r === "string") {
      this.status = "stopped";
      this.message = r;
      this.notify();
      return;
    }
    this.focus = i;
    this.range = { brick: i, from, to, loop, task: r.task, depth: r.depth, startT: r.t };
    this.status = "paused";
    this.play();
  }

  private loopSelection() {
    const stop = this.pendingStop!;
    const r = this.range!;
    const sp = this.speakers!;
    this.pendingStop = null;
    if (stop.t - r.startT < 20) {
      this.pauseAt(stop.t, stop.brick);
      this.message = "The selected lines don't take any time to play, so there's nothing to loop.";
      this.notify();
      return;
    }
    const stopAudio = this.audioAt(stop.t);
    sp.cutAll(stopAudio);
    const res = this.runToLines(r.brick, r.from, r.to);
    if (typeof res === "string") {
      this.pauseAt(stop.t, -1);
      this.message = res;
      this.notify();
      return;
    }
    this.range = { ...r, task: res.task, depth: res.depth, startT: res.t };
    this.anchorT = res.t;
    this.anchorAudio = Math.max(stopAudio, sp.now());
    this.ranTo = res.t;
    this.scheduleSoundingTones(res.t);
  }

  /** Continues from the current position until NXT `i` reaches `line`, then pauses. */
  runToLine(i: number, line: number) {
    if (this.status === "playing") this.pause();
    const target = this.snapLine(i, line);
    const s = this.slots[i];
    const b = s?.brick;
    if (!b || target === null) return;
    if (b.finished) this.resetAll();
    const hit: { info: TaskInfo | null } = { info: null };
    const res = b.run({
      limit: b.vt + 60 * 60 * 1000,
      maxSteps: SEEK_MAX_STEPS,
      stopBefore: (info) => {
        if (info.line === target) {
          hit.info = info;
          return true;
        }
        return false;
      },
    });
    b.soundEvents.length = 0;
    this.focus = i;
    if (res === "stopped" && hit.info) {
      s.parked = hit.info;
      this.T = b.vt;
      this.applyDisplay(i, this.T);
      this.slots.forEach((o, j) => {
        if (j !== i && o.brick && o.brick.vt < this.T) this.advanceSlotTo(j, this.T);
      });
      this.status = "paused";
      this.message = null;
    } else {
      this.T = b.vt;
      this.applyDisplay(i, this.T);
      this.status = b.finished ? "finished" : "paused";
      this.message = `Line ${target} isn't reached again${b.finished ? " before the program ends" : ""}.`;
    }
    this.notify();
  }

  /**
   * Runs the focused NXT one statement ("into"), over a function call
   * ("over"), or until the current function returns ("out"), and plays
   * whatever that statement plays.
   */
  step(mode: StepMode = "into") {
    if (this.status === "playing") this.pause();
    const i = this.focus;
    const s = this.slots[i];
    const b = s?.brick;
    if (!b) {
      this.message = "Fix the errors in the code first.";
      this.notify();
      return;
    }
    if (b.finished) {
      this.message = "The program has ended. Press Stop to start over.";
      this.notify();
      return;
    }
    const sp = this.ensureSpeakers();
    const parked = s.parked;
    this.anchorT = b.vt;
    this.anchorAudio = sp.now() + 0.03;
    const res = b.run({
      limit: b.vt + 60 * 60 * 1000,
      maxSteps: 5_000_000,
      stopBefore: (info) => {
        if (!parked || mode === "into") {
          s.parked = info;
          return true;
        }
        const stop = mode === "over" ? info.depth <= parked.depth : info.depth < parked.depth;
        if (stop) s.parked = info;
        return stop;
      },
    });
    this.drainSound(i);
    this.T = b.vt;
    this.applyDisplay(i, this.T);
    this.message = res === "steps" ? "Still running after 5 million statements. Is there a loop without a wait?" : null;
    this.status = b.finished && this.allFinished() ? "finished" : "paused";
    this.notify();
  }

  // ---- settings & controls ---------------------------------------------------------

  setFocus(i: number) {
    if (i < 0 || i >= this.slots.length || i === this.focus) return;
    this.focus = i;
    this.notify();
  }

  toggleBreakpoint(i: number, line: number) {
    const s = this.slots[i];
    if (!s) return;
    if (s.breakpoints.has(line)) s.breakpoints.delete(line);
    else {
      const l = this.snapLine(i, line);
      if (l === null) return;
      if (s.breakpoints.has(l)) s.breakpoints.delete(l);
      else s.breakpoints.add(l);
    }
    s.breakpoints = new Set(s.breakpoints);
    this.notify();
  }

  clearBreakpoints(i: number) {
    const s = this.slots[i];
    if (!s) return;
    s.breakpoints = new Set();
    this.notify();
  }

  setMuted(i: number, muted: boolean) {
    const s = this.slots[i];
    if (!s) return;
    s.muted = muted;
    this.speakers?.setMuted(i, muted);
    this.notify();
  }

  setSpeed(speed: number) {
    if (speed === this.speed) return;
    if (this.status === "playing" && this.speakers) {
      // Re-anchor at the current moment and reschedule what's sounding.
      const sp = this.speakers;
      const now = sp.now();
      const nowT = this.timeAt(now);
      sp.stopAll();
      this.speed = speed;
      this.anchorT = nowT;
      this.anchorAudio = now + 0.03;
      this.slots.forEach((s, i) => {
        const b = s.brick;
        if (!b) return;
        for (const t of b.tones) {
          if (t.end > nowT && t.end > t.start) sp.play(i, t.freq, this.audioAt(Math.max(t.start, nowT)), this.audioAt(t.end), t.volume);
        }
      });
    } else {
      this.speed = speed;
    }
    this.notify();
  }

  setWave(wave: Waveform) {
    this.wave = wave;
    if (this.speakers) this.speakers.wave = wave;
    this.notify();
  }

  setAutoPress(on: boolean) {
    if (on === this.autoPress) return;
    this.autoPress = on;
    this.halt();
    this.rebuild();
  }

  /** NXT buttons in the simulator press on every simulated NXT at once. */
  pressButton(button: number, down: boolean) {
    const ahead = this.status === "playing" ? Math.max(this.T, ...this.slots.map((s) => s.brick?.vt ?? 0)) : this.T;
    this.buttons.push({ t: ahead, button: down ? button : K_NONE });
    this.buttons.sort((a, b) => a.t - b.t);
    this.notify();
  }

  inspect(i: number): { globals: VariableView[]; tasks: TaskView[] } | null {
    return this.slots[i]?.brick?.inspect() ?? null;
  }

  dispose() {
    this.halt();
    this.listeners.clear();
  }

  // ---- snapshot ---------------------------------------------------------------------

  private buildSnapshot(): EngineSnapshot {
    const T = this.T;
    return {
      status: this.status,
      time: T,
      speed: this.speed,
      focus: this.focus,
      timeline: this.timeline,
      message: this.message,
      autoPress: this.autoPress,
      wave: this.wave,
      range: this.range ? { brick: this.range.brick, from: this.range.from, to: this.range.to, loop: this.range.loop } : null,
      bricks: this.slots.map((s) => {
        const b = s.brick;
        const ended = !!b && b.finished && (b.endTime ?? 0) <= T + 1e-6;
        const diagnostics = [...s.diagnostics];
        const seen = new Set(diagnostics.map((d) => `${d.line}|${d.message}`));
        const runtime = [...s.dryWarnings, ...(b?.warnings ?? [])];
        if (s.dryError && !(ended && b?.error)) {
          runtime.push({ line: s.dryError.line, message: `When this runs: ${s.dryError.message}` });
        }
        for (const w of runtime) {
          const key = `${w.line}|${w.message}`;
          if (!seen.has(key)) {
            seen.add(key);
            diagnostics.push({ line: w.line, message: w.message, severity: "warning" });
          }
        }
        diagnostics.sort((a, b2) => a.line - b2.line);
        let tone: BrickView["tone"] = null;
        if (b) {
          for (let k = b.tones.length - 1; k >= 0; k--) {
            const t = b.tones[k];
            if (t.start <= T && T < t.end) {
              tone = { freq: t.freq, line: t.line };
              break;
            }
            if (t.end <= T - 2000) break;
          }
        }
        return {
          name: s.name,
          code: s.code,
          compiled: !!s.program,
          diagnostics,
          executable: s.executable,
          breakpoints: s.breakpoints,
          lines: ended
            ? []
            : Array.from(s.taskLines.entries()).map(([task, v]) => ({ task, name: b?.taskName(task) ?? "?", line: v.line, depth: v.depth })),
          lcd: s.lcd,
          debug: s.debug,
          error: ended && b?.error ? { line: b.error.line, message: b.error.message } : null,
          finished: ended,
          tone,
          volume: b?.volume ?? 4,
          motors: b ? [...b.motorPower] : [0, 0, 0],
          muted: s.muted,
        };
      }),
    };
  }
}
