import type { Midi } from "@tonejs/midi";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** How overlapping notes are reduced to what one NXT can play. */
export type VoiceMode = "highest" | "lowest" | "off";
/** What to do with notes the NXT speaker can't reproduce well. */
export type RangeMode = "octave" | "clamp" | "drop";
/** "compact" = data array + loop, "expanded" = one PlayTone line per note. */
export type CodeStyle = "compact" | "expanded";

export interface ConvertOptions {
  /** Track indexes to include. Empty/undefined = every non-drum track with notes. */
  tracks?: number[];
  /** Number of NXT bricks to split the music across (1 to MAX_NXTS). */
  nxtCount?: number;
  /** Only used when nxtCount is 1. */
  voiceMode?: VoiceMode;
  /** Shift every note by this many semitones. */
  transpose?: number;
  /** Playback speed in percent (100 = original tempo). */
  tempoPercent?: number;
  /** Convert only part of the song, in seconds of the original file. */
  startSec?: number;
  endSec?: number | null;
  rangeMode?: RangeMode;
  minFrequency?: number;
  maxFrequency?: number;
  /** Notes shorter than this (ms, after tempo change) are dropped. */
  minNoteMs?: number;
  /** Forced silence between two consecutive notes of the same pitch, so the buzzer re-attacks. */
  repeatGapMs?: number;
  codeStyle?: CodeStyle;
  /** 1 = play once, 0 = loop forever, N = play N times. */
  repeatCount?: number;
  /** Wait for the orange button before playing (handy for starting several NXTs together). */
  waitForButton?: boolean;
  /** Show the song title and part name on the NXT screen. */
  showOnLcd?: boolean;
  /** NXT speaker volume, 0-4. */
  volume?: number;
  /** Title used in comments and on the LCD. */
  title?: string;
}

const DEFAULTS = {
  nxtCount: 1,
  voiceMode: "highest" as VoiceMode,
  transpose: 0,
  tempoPercent: 100,
  startSec: 0,
  endSec: null as number | null,
  rangeMode: "octave" as RangeMode,
  minFrequency: 220,
  maxFrequency: 8000,
  minNoteMs: 30,
  repeatGapMs: 35,
  codeStyle: "compact" as CodeStyle,
  repeatCount: 1,
  waitForButton: false,
  showOnLcd: true,
  volume: 4,
  title: "Song",
};

type ResolvedOptions = typeof DEFAULTS & { tracks: number[] };

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One entry of the NXT timeline. frequency 0 = rest. Durations are in 1/100 s (PlayTone units). */
export interface ToneEvent {
  frequency: number;
  durationCs: number;
  /** Start time in 1/100 s from the start of the part. */
  startCs: number;
  /** Original MIDI note (after transpose/octave fold), or null for rests. */
  midi: number | null;
  /** 1-based measure number in the original file. */
  measure: number;
}

export interface PartResult {
  /** "Melody", "Bass", "Harmony 1", ... */
  label: string;
  /** 1-based NXT number. */
  nxtNumber: number;
  code: string;
  events: ToneEvent[];
  noteCount: number;
  durationSeconds: number;
  /** Notes moved by octave folding, clamped, or dropped because of range. */
  outOfRangeCount: number;
}

export interface ConversionResult {
  parts: PartResult[];
  warnings: string[];
  /** Source notes considered, after track/section filtering. */
  sourceNoteCount: number;
}

export interface TrackSummary {
  index: number;
  name: string;
  instrument: string;
  noteCount: number;
  isDrums: boolean;
  lowest: number | null;
  highest: number | null;
}

interface SimpleNote {
  /** seconds */
  time: number;
  /** seconds */
  duration: number;
  midi: number;
}

// ---------------------------------------------------------------------------
// Pitch helpers
// ---------------------------------------------------------------------------

const NOTE_FREQUENCIES: number[] = Array.from({ length: 128 }, (_, n) =>
  Math.round(440 * Math.pow(2, (n - 69) / 12))
);

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * Equal-tempered frequency for a MIDI note, rounded to a whole Hz. Every note
 * snaps to the same fixed table, so the generator never emits near-duplicate
 * pitches (440 vs 443 Hz) that the NXT buzzer can't tell apart anyway.
 */
export function midiNoteToFrequency(midiNote: number): number {
  return NOTE_FREQUENCIES[Math.min(127, Math.max(0, Math.round(midiNote)))];
}

export function midiNoteName(midiNote: number): string {
  const n = Math.round(midiNote);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** Nearest note name for a frequency, e.g. 523 -> "C5". */
export function frequencyToNoteName(freq: number): string {
  if (freq <= 0) return "";
  return midiNoteName(69 + 12 * Math.log2(freq / 440));
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// Track summary
// ---------------------------------------------------------------------------

export function summarizeTracks(midi: Midi): TrackSummary[] {
  return midi.tracks.map((t, i) => {
    const pitches = t.notes.map((n) => n.midi);
    const isDrums = t.channel === 9 || t.instrument.percussion;
    return {
      index: i,
      name: t.name?.trim() || `Track ${i + 1}`,
      instrument: isDrums ? "drums" : t.instrument.name || "",
      noteCount: t.notes.length,
      isDrums,
      lowest: pitches.length ? Math.min(...pitches) : null,
      highest: pitches.length ? Math.max(...pitches) : null,
    };
  });
}

/** Tracks used when the user hasn't picked any: every non-drum track that has notes. */
export function defaultTrackSelection(tracks: TrackSummary[]): number[] {
  const melodic = tracks.filter((t) => t.noteCount > 0 && !t.isDrums).map((t) => t.index);
  if (melodic.length) return melodic;
  return tracks.filter((t) => t.noteCount > 0).map((t) => t.index);
}

// ---------------------------------------------------------------------------
// Voice extraction
// ---------------------------------------------------------------------------

interface AllocNote {
  start: number; // ms
  end: number; // ms
  midi: number;
}

/**
 * Splits overlapping notes into `count` monophonic lines, one per NXT.
 *
 * A note can only start sounding at its own onset. When the top note of a
 * piano part ends a little early (staccato, or the small gap before the next
 * melody note), a chord or bass note that was already held underneath does
 * *not* take over the line -- on an NXT that would be heard as a fresh,
 * out-of-place attack of an accompaniment note. Notes that are sounding keep
 * their line (and NXT) until they end, unless a note with higher priority
 * starts and needs the line. New notes go to the free line closest to their
 * pitch rank, so line 0 stays the melody and the last line the bass.
 *
 * With count = 1 and priority to high notes this pulls the melody out of a
 * piano part; with priority to low notes it pulls out the bass line. With
 * several lines, the melody and bass are kept first and the middle lines get
 * the inner harmony.
 */
function splitByRank(notes: SimpleNote[], count: number, fromBottom: boolean): SimpleNote[][] {
  // Drop exact duplicates (the same note doubled on two selected tracks).
  const unique = new Map<string, AllocNote>();
  for (const n of notes) {
    const start = Math.round(n.time * 1000);
    const end = Math.round((n.time + n.duration) * 1000);
    if (end <= start) continue;
    const key = `${start}|${n.midi}`;
    const prev = unique.get(key);
    if (!prev || prev.end < end) unique.set(key, { start, end, midi: n.midi });
  }
  const better = (a: AllocNote, b: AllocNote) => (fromBottom ? a.midi - b.midi : b.midi - a.midi);
  const sorted = Array.from(unique.values()).sort((a, b) => a.start - b.start || better(a, b));

  /**
   * One line: the note with the highest priority. Several lines: the outer
   * voices first (top = melody, bottom = bass), then inner voices from the
   * top down -- the way an arranger thins out a chord. Sorted high to low,
   * so a note's index is the line it belongs on.
   */
  const choose = (candidates: AllocNote[]): AllocNote[] => {
    if (count === 1) return [candidates.sort(better)[0]];
    const byPitch = candidates.sort((a, b) => b.midi - a.midi);
    if (byPitch.length <= count) return byPitch;
    return [...byPitch.slice(0, count - 1), byPitch[byPitch.length - 1]];
  };

  const lines: SimpleNote[][] = Array.from({ length: count }, () => []);
  const voice: (AllocNote | null)[] = new Array(count).fill(null);
  const voiceStart: number[] = new Array(count).fill(0);

  const close = (v: number, t: number) => {
    const n = voice[v];
    if (n && t > voiceStart[v]) {
      lines[v].push({ time: voiceStart[v] / 1000, duration: (t - voiceStart[v]) / 1000, midi: n.midi });
    }
    voice[v] = null;
  };

  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i].start;
    // Lines whose note ended by now become free.
    for (let v = 0; v < count; v++) {
      const n = voice[v];
      if (n && n.end <= t) close(v, n.end);
    }
    const starting: AllocNote[] = [];
    while (i < sorted.length && sorted[i].start === t) starting.push(sorted[i++]);

    // Decide which notes should sound now, out of the held and new notes.
    const held = voice.filter((n): n is AllocNote => n !== null);
    const chosen = choose([...held, ...starting]);
    const chosenSet = new Set(chosen);
    for (let v = 0; v < count; v++) {
      if (voice[v] && !chosenSet.has(voice[v]!)) close(v, t); // bumped by a higher-priority note
    }
    for (const n of starting) {
      if (!chosenSet.has(n)) continue;
      // Target line: the top note goes to line 0 and the bottom note to the
      // last line even when fewer notes than lines are sounding.
      const idx = chosen.indexOf(n);
      const rank = count > 1 && idx === chosen.length - 1 && idx > 0 ? count - 1 : idx;
      let best = -1;
      for (let v = 0; v < count; v++) {
        if (voice[v] !== null) continue;
        if (best < 0 || Math.abs(v - rank) < Math.abs(best - rank)) best = v;
      }
      if (best < 0) continue;
      voice[best] = n;
      voiceStart[best] = t;
    }
  }
  for (let v = 0; v < count; v++) if (voice[v]) close(v, voice[v]!.end);
  return lines;
}

/** The most NXTs the converter will split a piece across. */
export const MAX_NXTS = 64;

export function partLabel(index: number, total: number, voiceMode: VoiceMode): string {
  if (total === 1) {
    if (voiceMode === "lowest") return "Bass";
    if (voiceMode === "off") return "All notes";
    return "Melody";
  }
  if (index === 0) return "Melody";
  if (index === total - 1) return "Bass";
  return total === 3 ? "Harmony" : `Harmony ${index}`;
}

// ---------------------------------------------------------------------------
// Timeline building
// ---------------------------------------------------------------------------

interface FoldResult {
  midi: number | null;
  moved: boolean;
}

function fitToRange(midi: number, o: ResolvedOptions): FoldResult {
  const lo = o.minFrequency;
  const hi = o.maxFrequency;
  const f = midiNoteToFrequency(midi);
  if (f >= lo && f <= hi) return { midi, moved: false };
  if (o.rangeMode === "drop") return { midi: null, moved: true };
  if (o.rangeMode === "octave") {
    let m = midi;
    while (midiNoteToFrequency(m) < lo && m + 12 <= 127) m += 12;
    while (midiNoteToFrequency(m) > hi && m - 12 >= 0) m -= 12;
    const ok = midiNoteToFrequency(m) >= lo && midiNoteToFrequency(m) <= hi;
    if (ok) return { midi: m, moved: true };
  }
  // clamp (or an octave fold that couldn't fit): keep the MIDI note, the
  // frequency gets clamped when the event is written.
  return { midi, moved: true };
}

/**
 * Turns one monophonic line into NXT tone/rest events.
 *
 * Times are snapped to the 10 ms grid PlayTone uses *in absolute time*, and
 * each duration is the difference between snapped start and end. That keeps
 * the timeline drift-free: rounding never accumulates over a long song.
 */
function buildEvents(
  line: SimpleNote[],
  o: ResolvedOptions,
  measureAt: (sourceSec: number) => number,
  timeScale: number,
  sectionStart: number
): { events: ToneEvent[]; outOfRange: number } {
  const notes = [...line].sort((a, b) => a.time - b.time || b.midi - a.midi);
  const events: ToneEvent[] = [];
  const minCs = Math.max(1, Math.round(o.minNoteMs / 10));
  const gapCs = Math.max(0, Math.round(o.repeatGapMs / 10));
  let cursor = 0;
  let outOfRange = 0;

  const toCs = (sec: number) => Math.round((sec - sectionStart) * timeScale * 100);

  const lastTone = (): ToneEvent | null => {
    for (let k = events.length - 1; k >= 0; k--) {
      if (events[k].frequency > 0) return events[k];
      if (k < events.length - 1) return null;
    }
    return null;
  };

  for (const n of notes) {
    let s = toCs(n.time);
    const e = toCs(n.time + n.duration);
    if (e - s < minCs) continue;

    const fit = fitToRange(n.midi, o);
    if (fit.moved) outOfRange++;
    if (fit.midi === null) continue;
    const freq = Math.min(o.maxFrequency, Math.max(o.minFrequency, midiNoteToFrequency(fit.midi)));

    if (s < cursor) {
      // Overlap (only possible in "off" mode): the newer note cuts the older
      // one short, like a mono synth. Same-onset notes keep the first one.
      const prev = events[events.length - 1];
      if (!prev || prev.frequency === 0 || prev.startCs >= s) continue;
      prev.durationCs = s - prev.startCs;
      cursor = s;
    }

    const gap = s - cursor;
    if (gap > 0) {
      const prev = events[events.length - 1];
      if (gap <= 1 && prev && prev.frequency > 0 && prev.frequency !== freq) {
        prev.durationCs += gap; // a 10 ms hole just sounds like a glitch -- stay legato
      } else if (prev && prev.frequency === 0) {
        prev.durationCs += gap;
      } else {
        events.push({ frequency: 0, durationCs: gap, startCs: cursor, midi: null, measure: measureAt(n.time) });
      }
      cursor = s;
    }

    // Same pitch again with too little silence in between: borrow the
    // silence from the end of the previous note so this note still starts on
    // time but the buzzer audibly re-attacks.
    const prevTone = lastTone();
    if (gapCs > 0 && prevTone && prevTone.frequency === freq) {
      const restAfter = events[events.length - 1] !== prevTone ? events[events.length - 1].durationCs : 0;
      const need = gapCs - restAfter;
      if (need > 0) {
        const take = Math.min(need, prevTone.durationCs - 1);
        if (take > 0) {
          prevTone.durationCs -= take;
          if (restAfter > 0) {
            const rest = events[events.length - 1];
            rest.durationCs += take;
            rest.startCs -= take;
          } else {
            events.push({ frequency: 0, durationCs: take, startCs: cursor - take, midi: null, measure: prevTone.measure });
          }
        }
      }
    }

    events.push({ frequency: freq, durationCs: e - s, startCs: s, midi: fit.midi, measure: measureAt(n.time) });
    cursor = e;
    s = e;
  }
  return { events, outOfRange };
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

function cleanText(text: string, max: number): string {
  // Plain ASCII only: the NXT font has no accents, and quotes/backslashes
  // would break the string literal.
  return text
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .trim()
    .slice(0, max);
}

interface CodeContext {
  title: string;
  label: string;
  nxtNumber: number;
  nxtCount: number;
  o: ResolvedOptions;
}

function headerLines(events: ToneEvent[], ctx: CodeContext): string[] {
  const tones = events.filter((e) => e.frequency > 0).length;
  const total = events.reduce((sum, e) => sum + e.durationCs, 0) / 100;
  return [
    "// ============================================================",
    `// ${cleanText(ctx.title, 60) || "Song"} -- ${ctx.label}`,
    ctx.nxtCount > 1
      ? `// Part ${ctx.nxtNumber} of ${ctx.nxtCount}: load this program onto NXT #${ctx.nxtNumber}.`
      : "// Generated by MIDI -> RobotC.",
    `// ${tones} notes, ${formatTime(total)} long.`,
    "// ============================================================",
  ];
}

/** The helper every generated program uses to play a note on time. */
function playNoteHelper(): string[] {
  return [
    "long nextTime; // when the current note should end (ms since the program started)",
    "",
    "// Plays a note (freq in Hz, duration in 1/100 s), or a rest when freq is 0,",
    "// then waits until the note should end. Waiting for a time on the clock",
    "// instead of a fixed delay stops the song from slowly falling behind --",
    "// that matters when several NXTs play together.",
    "void playNote(int freq, int duration)",
    "{",
    "\tif (freq > 0)",
    "\t{",
    "\t\tPlayTone(freq, duration);",
    "\t}",
    "\tnextTime += duration * 10;",
    "\tif (nextTime > nPgmTime)",
    "\t{",
    "\t\twait1Msec(nextTime - nPgmTime);",
    "\t}",
    "}",
  ];
}

function setupLines(ctx: CodeContext, indent: string): string[] {
  const { o } = ctx;
  const out: string[] = [];
  out.push(`${indent}nVolume = ${Math.max(0, Math.min(4, Math.round(o.volume)))};`);
  if (o.showOnLcd) {
    out.push(`${indent}eraseDisplay();`);
    out.push(`${indent}nxtDisplayCenteredTextLine(1, "${cleanText(ctx.title, 16) || "Song"}");`);
    const part = ctx.nxtCount > 1 ? `${ctx.nxtNumber}/${ctx.nxtCount} ${ctx.label}` : ctx.label;
    out.push(`${indent}nxtDisplayCenteredTextLine(3, "${cleanText(part, 16)}");`);
  }
  if (o.waitForButton) {
    out.push("");
    out.push(`${indent}// Wait for the orange button so several NXTs can start together.`);
    out.push(`${indent}nxtDisplayCenteredTextLine(6, "Press orange");`);
    out.push(`${indent}while (nNxtButtonPressed != kEnterButton)`);
    out.push(`${indent}{`);
    out.push(`${indent}\twait1Msec(5);`);
    out.push(`${indent}}`);
    out.push(`${indent}nxtDisplayClearTextLine(6);`);
  }
  return out;
}

function repeatOpen(o: ResolvedOptions, indent: string): string[] {
  if (o.repeatCount === 0) return [`${indent}while (true) // loop forever`, `${indent}{`];
  if (o.repeatCount > 1) return [`${indent}for (rep = 0; rep < ${o.repeatCount}; rep++)`, `${indent}{`];
  return [];
}

function repeatClose(o: ResolvedOptions, indent: string): string[] {
  return o.repeatCount === 1 ? [] : [`${indent}}`];
}

function endingLines(): string[] {
  return [
    "",
    "\t// Let the last note finish before the program ends.",
    "\twhile (bSoundActive)",
    "\t{",
    "\t\twait1Msec(1);",
    "\t}",
    "}",
    "",
  ];
}

/** Groups events by measure, splitting long measures so lines stay readable. */
function groupByMeasure(events: ToneEvent[], maxPerGroup: number): ToneEvent[][] {
  const groups: ToneEvent[][] = [];
  let current: ToneEvent[] = [];
  let measure = -1;
  for (const e of events) {
    if (current.length && (e.measure !== measure || current.length >= maxPerGroup)) {
      groups.push(current);
      current = [];
    }
    measure = e.measure;
    current.push(e);
  }
  if (current.length) groups.push(current);
  return groups;
}

function noteComment(e: ToneEvent): string {
  return e.frequency > 0 && e.midi !== null ? midiNoteName(e.midi) : "-";
}

function compactCode(events: ToneEvent[], ctx: CodeContext): string {
  const { o } = ctx;
  const lines = headerLines(events, ctx);
  lines.push("");
  if (events.length === 0) return emptyProgram(lines, ctx);
  lines.push(`#define NOTE_COUNT ${events.length}`);
  lines.push("");
  lines.push("// Pairs of {frequency in Hz (0 = rest), duration in 1/100 s}.");
  lines.push("// One line per measure; the comment gives the measure, time and notes.");
  lines.push("int song[NOTE_COUNT * 2] =");
  lines.push("{");
  const groups = groupByMeasure(events, 8);
  groups.forEach((g, gi) => {
    const isLast = gi === groups.length - 1;
    const data = g
      .map((e, ei) => `${e.frequency}, ${e.durationCs}${isLast && ei === g.length - 1 ? "" : ","}`)
      .join(" ");
    const when = formatTime(g[0].startCs / 100);
    lines.push(`\t${data.padEnd(48)} // m${g[0].measure} ${when}  ${g.map(noteComment).join(" ")}`);
  });
  lines.push("};");
  lines.push("");
  lines.push(...playNoteHelper());
  lines.push("");
  lines.push("task main()");
  lines.push("{");
  lines.push("\tint i;");
  if (o.repeatCount > 1) lines.push("\tint rep;");
  lines.push(...setupLines(ctx, "\t"));
  lines.push("");
  lines.push("\tnextTime = nPgmTime;");
  const open = repeatOpen(o, "\t");
  const inner = open.length ? "\t\t" : "\t";
  lines.push(...open);
  lines.push(`${inner}for (i = 0; i < NOTE_COUNT * 2; i += 2)`);
  lines.push(`${inner}{`);
  lines.push(`${inner}\tplayNote(song[i], song[i + 1]);`);
  lines.push(`${inner}}`);
  lines.push(...repeatClose(o, "\t"));
  lines.push(...endingLines());
  return lines.join("\n");
}

function expandedCode(events: ToneEvent[], ctx: CodeContext): string {
  const { o } = ctx;
  const lines = headerLines(events, ctx);
  lines.push("");
  if (events.length === 0) return emptyProgram(lines, ctx);
  lines.push(...playNoteHelper());
  lines.push("");
  lines.push("task main()");
  lines.push("{");
  if (o.repeatCount > 1) lines.push("\tint rep;");
  lines.push(...setupLines(ctx, "\t"));
  lines.push("");
  lines.push("\tnextTime = nPgmTime;");
  const open = repeatOpen(o, "\t");
  const ind = open.length ? "\t\t" : "\t";
  lines.push(...open);
  let measure = -1;
  for (const e of events) {
    if (e.measure !== measure) {
      if (measure !== -1) lines.push("");
      lines.push(`${ind}// Measure ${e.measure} (${formatTime(e.startCs / 100)})`);
      measure = e.measure;
    }
    const stmt = `playNote(${e.frequency}, ${e.durationCs});`;
    lines.push(`${ind}${stmt.padEnd(24)} // ${e.frequency > 0 ? noteComment(e) : "rest"}`);
  }
  lines.push(...repeatClose(o, "\t"));
  lines.push(...endingLines());
  return lines.join("\n");
}

function emptyProgram(lines: string[], ctx: CodeContext): string {
  lines.push("// This part has no notes (the music never has this many notes at once).");
  lines.push("task main()");
  lines.push("{");
  lines.push(...setupLines(ctx, "\t"));
  lines.push('\tnxtDisplayCenteredTextLine(5, "No notes");');
  lines.push("\twait1Msec(2000);");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Keeps every duration at or below MAX_EVENT_CS so `duration * 10` never
 * overflows RobotC's 16-bit int (32767). Long rests are split; a very long
 * note is shortened and followed by a rest so the timing stays the same.
 */
const MAX_EVENT_CS = 3000;
function capDurations(events: ToneEvent[]): ToneEvent[] {
  const out: ToneEvent[] = [];
  for (const e of events) {
    let remaining = e.durationCs;
    let start = e.startCs;
    let first = true;
    while (remaining > 0) {
      const d = Math.min(remaining, MAX_EVENT_CS);
      out.push({ ...e, frequency: first ? e.frequency : 0, midi: first ? e.midi : null, durationCs: d, startCs: start });
      first = false;
      remaining -= d;
      start += d;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function resolve(options: ConvertOptions, tracks: TrackSummary[]): ResolvedOptions {
  const o = { ...DEFAULTS } as ResolvedOptions;
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) (o as unknown as Record<string, unknown>)[k] = v;
  }
  o.nxtCount = Math.max(1, Math.min(MAX_NXTS, Math.round(o.nxtCount) || 1));
  o.tempoPercent = Math.max(10, Math.min(400, o.tempoPercent || 100));
  o.repeatCount = Math.max(0, Math.round(o.repeatCount));
  o.minFrequency = Math.max(20, o.minFrequency);
  o.maxFrequency = Math.max(o.minFrequency + 1, o.maxFrequency);
  o.tracks = options.tracks && options.tracks.length ? options.tracks : defaultTrackSelection(tracks);
  return o;
}

export function convertMidi(midi: Midi, options: ConvertOptions = {}): ConversionResult {
  const summaries = summarizeTracks(midi);
  const o = resolve(options, summaries);
  const warnings: string[] = [];

  const start = Math.max(0, o.startSec || 0);
  const end = o.endSec && o.endSec > start ? o.endSec : Infinity;

  // Gather notes from the chosen tracks, trimmed to the section.
  const notes: SimpleNote[] = [];
  for (const index of o.tracks) {
    const track = midi.tracks[index];
    if (!track) continue;
    for (const n of track.notes) {
      const s = Math.max(n.time, start);
      const e = Math.min(n.time + n.duration, end);
      if (e <= s) continue;
      notes.push({ time: s, duration: e - s, midi: n.midi + o.transpose });
    }
  }
  if (summaries.some((t) => o.tracks.includes(t.index) && t.isDrums)) {
    warnings.push("A drum track is selected. Drum notes are pitches of drum sounds, not melody, so they usually sound random on the NXT.");
  }
  if (notes.length === 0) {
    throw new Error(
      o.tracks.length === 0
        ? "This MIDI file has no notes."
        : "No notes in the selected tracks and section."
    );
  }

  const measureAt = (sec: number) => {
    try {
      return Math.floor(midi.header.ticksToMeasures(midi.header.secondsToTicks(sec))) + 1;
    } catch {
      return 1;
    }
  };
  const timeScale = 100 / o.tempoPercent;

  const lines =
    o.nxtCount > 1
      ? splitByRank(notes, o.nxtCount, false)
      : o.voiceMode === "off"
        ? [notes]
        : splitByRank(notes, 1, o.voiceMode === "lowest");

  const parts: PartResult[] = lines.map((line, i) => {
    const label = partLabel(i, lines.length, o.voiceMode);
    const built = buildEvents(line, o, measureAt, timeScale, start);
    const events = capDurations(built.events);
    const outOfRange = built.outOfRange;
    const ctx: CodeContext = { title: o.title, label, nxtNumber: i + 1, nxtCount: lines.length, o };
    const code = o.codeStyle === "expanded" ? expandedCode(events, ctx) : compactCode(events, ctx);
    const last = events[events.length - 1];
    return {
      label,
      nxtNumber: i + 1,
      code,
      events,
      noteCount: events.filter((e) => e.frequency > 0).length,
      durationSeconds: last ? (last.startCs + last.durationCs) / 100 : 0,
      outOfRangeCount: outOfRange,
    };
  });

  const silent = parts.filter((p) => p.noteCount === 0);
  if (parts.length > 1 && silent.length > 0) {
    const list = silent.map((p) => p.nxtNumber).join(", ");
    warnings.push(
      silent.length === parts.length
        ? "No part has any notes."
        : `NXT ${list} ${silent.length === 1 ? "has" : "have"} no notes. This music never plays more than ${parts.length - silent.length} notes at once, so you can use ${parts.length - silent.length} NXTs or fewer.`
    );
  }

  parts.forEach((p) => {
    if (p.outOfRangeCount > 0) {
      const verb = o.rangeMode === "octave" ? "moved by an octave" : o.rangeMode === "clamp" ? "clamped" : "dropped";
      warnings.push(
        `${parts.length > 1 ? `NXT ${p.nxtNumber}: ` : ""}${p.outOfRangeCount} note${p.outOfRangeCount === 1 ? "" : "s"} outside ${o.minFrequency}-${o.maxFrequency} Hz ${p.outOfRangeCount === 1 ? "was" : "were"} ${verb}.`
      );
    }
    if (p.events.length > 1500) {
      warnings.push(
        `${parts.length > 1 ? `NXT ${p.nxtNumber}: ` : ""}${p.events.length} tone/rest events is a lot for one NXT program. If it won't download or compile, convert a shorter section.`
      );
    }
  });

  return { parts, warnings, sourceNoteCount: notes.length };
}
