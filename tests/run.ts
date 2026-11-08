/* Run with: npm test */
import { compile } from "../lib/robotc/compile";
import { Brick } from "../lib/robotc/interpreter";
import { formatPrintf } from "../lib/robotc/printf";
import { convertMidi, ConvertOptions } from "../lib/midiToRobotC";
import { sampleSong } from "../lib/sampleSong";
import { midiInfo, measureToSeconds } from "../lib/midiInfo";
import { MAX_NXTS } from "../lib/midiToRobotC";
import { crc32, makeZip } from "../lib/zip";
import { FAQS } from "../lib/faq";
import { HOME_TITLE, SITE_DESCRIPTION, SITE_URL, absoluteUrl } from "../lib/site";
import sitemap from "../app/sitemap";
import robots from "../app/robots";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function run(src: string, opts: { limit?: number } = {}) {
  const c = compile(src);
  if (!c.program) throw new Error("compile failed: " + c.diagnostics.map((d) => `${d.line}: ${d.message}`).join("; "));
  const b = new Brick(c.program);
  const res = b.run({ maxSteps: 5e6, limit: opts.limit });
  const debug = b.debugEvents.map((e) => e.text).join("");
  return { b, res, debug };
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

{
  const { debug, b } = run(`
task main() {
  int a = 32767; a++;
  long l = 32767; l++;
  int d = -7 / 2; int m = -7 % 2;
  float f = 7 / 2; float g = 7.0 / 2;
  ubyte u = 255; u++;
  writeDebugStreamLine("%d %ld %d %d %.1f %.1f %d", a, l, d, m, f, g, u);
}`);
  check("int arithmetic", debug.trim() === "-32768 32768 -3 -1 3.0 3.5 0", debug);
  check("overflow warning", b.warnings.some((w) => w.line === 3 && /wrapped/.test(w.message)));
}

{
  const { debug } = run(`
int grid[2][3] = {{1, 2, 3}, {4, 5, 6}};
int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }
void swap(int &x, int &y) { int t = x; x = y; y = t; }
int sum(int arr[], int n) { int s = 0; for (int i = 0; i < n; i++) s += arr[i]; return s; }
task main() {
  int i = 0, total = 0;
  do { i++; if (i == 2) continue; if (i > 4) break; total += i; } while (true);
  int p = 1, q = 2; swap(p, q);
  string s = "ab"; s += "cd";
  switch (q) { case 1: writeDebugStream("one "); case 2: writeDebugStream("two "); break; default: writeDebugStream("other "); }
  writeDebugStreamLine("%d %d %d %d %s %d %d", total, fact(6), p, q, s, grid[1][2], sum(grid[0], 3));
}`);
  check("control flow and functions", debug === "one two 8 720 2 1 abcd 6 6\n", JSON.stringify(debug));
}

{
  const c = compile(`task main() { int a[3]; a[3] = 1; }`);
  const b = new Brick(c.program!);
  b.run();
  check("bounds error", !!b.error && b.error.line === 1 && /outside array 'a'/.test(b.error.message), b.error?.message);
  const c2 = compile(`task main() { int z = 0;\n int y = 5 / z; }`);
  const b2 = new Brick(c2.program!);
  b2.run();
  check("division by zero", b2.error?.line === 2);
}

{
  const c = compile(`task main() { int x = ; }`);
  check("syntax error reported", !c.program && c.diagnostics[0]?.severity === "error");
  const c2 = compile(`task main() { foo(); undeclared = 3; }`);
  check("unknown names reported", !c2.program && c2.diagnostics.length >= 2);
  const c3 = compile(`void f() {}`);
  check("missing task main", !c3.program && /task main/.test(c3.diagnostics[0].message));
}

{
  check("printf", formatPrintf("%5d|%-4s|%04.1f|%x|%c|%%|%+d", [42, "ab", 3.14159, 255, 65, 7]) === "   42|ab  |03.1|ff|A|%|+7");
}

{
  // Sound queue: PlayTone queues; PlayImmediateTone and ClearSounds cut.
  const { b } = run(`
task main() {
  PlayTone(440, 50); PlayTone(880, 50);
  wait1Msec(200);
  PlayImmediateTone(660, 100);
  wait1Msec(100);
  ClearSounds();
  wait1Msec(100);
}`);
  const t = b.tones.filter((x) => x.end > x.start).map((x) => [x.freq, Math.round(x.start), Math.round(x.end)]);
  check("sound queue", JSON.stringify(t) === JSON.stringify([[440, 0, 200], [660, 200, 300]]), JSON.stringify(t));
}

{
  // Tasks run side by side and the program ends when main ends.
  const { debug, b } = run(`
int n = 0;
task counter() { while (true) { n++; wait1Msec(10); } }
task main() { startTask(counter); wait1Msec(95); writeDebugStreamLine("%d", n); }`);
  check("tasks", debug.trim() === "10" && b.finished, debug);
}

{
  // random() is seeded, so replays match.
  const src = `task main() { int i; for (i = 0; i < 5; i++) writeDebugStream("%d ", random(100)); }`;
  check("deterministic random", run(src).debug === run(src).debug);
}

{
  // Busy loops still let time pass.
  const { b, res } = run(`task main() { while (nPgmTime < 50) { } }`);
  check("busy loop advances time", res === "done" && b.vt >= 50 && b.vt < 52);
}

// ---------------------------------------------------------------------------
// Converter round trips: the generated code, run in the simulator, plays exactly the events.
// ---------------------------------------------------------------------------

const midi = sampleSong();
const info = midiInfo(midi);
check("sample info", info.measures === 16 && info.timeSignature === "4/4");
check("measure seconds", Math.abs(measureToSeconds(midi, 3) - (2 * 4 * 60) / 112) < 1e-3);

// More than four NXTs.
{
  const r8 = convertMidi(midi, { tracks: [0, 1], nxtCount: 8 });
  check("8 NXTs gives 8 parts", r8.parts.length === 8 && r8.parts.every((p, i) => p.nxtNumber === i + 1));
  check(
    "8 NXT labels",
    r8.parts[0].label === "Melody" && r8.parts[7].label === "Bass" && r8.parts[1].label === "Harmony 1" && r8.parts[6].label === "Harmony 6",
    r8.parts.map((p) => p.label).join(",")
  );
  check("8 NXT programs compile", r8.parts.every((p) => !!compile(p.code).program));
  check("8 NXT header names the part", r8.parts[7].code.includes("Part 8 of 8"));
  const r16 = convertMidi(midi, { tracks: [0, 1], nxtCount: 16 });
  check("16 NXTs gives 16 parts", r16.parts.length === 16);
  check("silent parts are reported once", r16.warnings.filter((w) => /have no notes|has no notes/.test(w)).length === 1, r16.warnings.join(" | "));
  check("silent parts still compile", r16.parts.every((p) => !!compile(p.code).program));
  check("limit", convertMidi(midi, { nxtCount: 500 }).parts.length === MAX_NXTS);
  check("zero and NaN fall back to one NXT", convertMidi(midi, { nxtCount: 0 }).parts.length === 1 && convertMidi(midi, { nxtCount: NaN }).parts.length === 1);
}

// Dynamics: NXT volume follows the MIDI's loudness.
{
  const off = convertMidi(midi, { tracks: [0] });
  check("dynamics off keeps one volume", off.parts[0].events.every((e) => e.volume === undefined) && !/song\[i \+ 2\]/.test(off.parts[0].code));
  for (const codeStyle of ["compact", "expanded"] as const) {
    const on = convertMidi(midi, { tracks: [0], dynamics: true, codeStyle });
    const code = on.parts[0].code;
    const c = compile(code);
    check(`dynamics ${codeStyle} compiles`, !!c.program && c.diagnostics.length === 0, c.diagnostics.map((d) => d.message).join("; "));
    const tones = on.parts[0].events.filter((e) => e.frequency > 0);
    const levels = new Set(tones.map((e) => e.volume));
    check(`dynamics ${codeStyle} uses several levels`, levels.size >= 3 && tones.every((e) => e.volume! >= 1 && e.volume! <= 4), Array.from(levels).join(","));
    check(`dynamics ${codeStyle} writes the volume`, codeStyle === "compact" ? /NOTE_COUNT \* 3/.test(code) : /playNote\(\d+, \d+, [1-4]\)/.test(code));
    // The simulated NXT really plays each note at its volume.
    const b = new Brick(c.program!);
    b.run({ maxSteps: 5e6 });
    const played = b.tones;
    check(`dynamics ${codeStyle} plays at the chosen volumes`, played.length === tones.length && played.every((t, i) => t.volume === tones[i].volume), `${played.length} vs ${tones.length}`);
  }
  const capped = convertMidi(midi, { tracks: [0], dynamics: true, volume: 2 });
  check("loudest level follows the volume option", capped.parts[0].events.every((e) => e.frequency === 0 || (e.volume! >= 1 && e.volume! <= 2)));
  const multi = convertMidi(midi, { tracks: [0], dynamics: true, nxtCount: 3 });
  check(
    "all parts share one loudness scale",
    multi.parts.every((p) => !!compile(p.code).program) && multi.parts.some((p) => p.events.some((e) => e.volume === 1)) && multi.parts.some((p) => p.events.some((e) => e.volume === 4))
  );
  // Flat loudness: one level and a warning.
  const flat = sampleSong();
  for (const t of flat.tracks) for (const n of t.notes) (n as { velocity: number }).velocity = 0.7;
  const fr = convertMidi(flat, { tracks: [0], dynamics: true });
  check("flat music reports it", fr.warnings.some((w) => /almost no loudness changes/.test(w)) && fr.parts[0].events.every((e) => e.frequency === 0 || e.volume === 4));
  // Channel volume (CC 7) scales the loudness of a track.
  const cc = sampleSong();
  const quiet = cc.tracks[0];
  quiet.addCC({ number: 7, value: 0.3, time: 0 });
  const lo = convertMidi(cc, { tracks: [0], dynamics: true }).parts[0].events.filter((e) => e.frequency > 0);
  check("CC 7 is read", lo.every((e) => Math.abs((e.velocity ?? 0) - 0.3 * 1) <= 0.3) && Math.max(...lo.map((e) => e.velocity ?? 0)) < 0.35);
}

// Search engine basics.
{
  check("site url has no trailing slash", !SITE_URL.endsWith("/") && /^https?:\/\//.test(SITE_URL));
  check("absoluteUrl joins paths", absoluteUrl("/a") === `${SITE_URL}/a` && absoluteUrl("a") === `${SITE_URL}/a`);
  check("title length", HOME_TITLE.length >= 30 && HOME_TITLE.length <= 60, String(HOME_TITLE.length));
  check("description length", SITE_DESCRIPTION.length >= 70 && SITE_DESCRIPTION.length <= 160, String(SITE_DESCRIPTION.length));
  const urls = sitemap().map((e) => e.url);
  check("sitemap lists the pages", urls.includes(absoluteUrl("/")) && urls.includes(absoluteUrl("/nxt-note-frequencies")) && new Set(urls).size === urls.length);
  check("robots points at the sitemap", robots().sitemap === absoluteUrl("/sitemap.xml"));
  check("faq entries are complete and unique", FAQS.length >= 5 && FAQS.every((f) => f.question.endsWith("?") && f.answer.length > 40) && new Set(FAQS.map((f) => f.question)).size === FAQS.length);
}

// ZIP writer.
{
  check("crc32", crc32(new TextEncoder().encode("123456789")) === 0xcbf43926);
  const zip = makeZip([
    { name: "a-nxt1.c", text: "task main() {}\n" },
    { name: "b-nxt2.c", text: "// \u00e9" },
  ]);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  check("zip end record", dv.getUint32(eocd, true) === 0x06054b50 && dv.getUint16(eocd + 10, true) === 2);
  const centralAt = dv.getUint32(eocd + 16, true);
  check("zip central directory", dv.getUint32(centralAt, true) === 0x02014b50);
  check("zip first entry", dv.getUint32(0, true) === 0x04034b50 && new TextDecoder().decode(zip.slice(30, 38)) === "a-nxt1.c");
}

const matrix: ConvertOptions[] = [];
for (const nxtCount of [1, 2, 3, 4, 5, 8])
  for (const codeStyle of ["compact", "expanded"] as const) matrix.push({ nxtCount, codeStyle });
for (const voiceMode of ["highest", "lowest", "off"] as const) matrix.push({ voiceMode });
matrix.push({ transpose: -14, tempoPercent: 63, rangeMode: "clamp" });
matrix.push({ rangeMode: "drop", minFrequency: 400, maxFrequency: 900, repeatCount: 3 });
matrix.push({ startSec: measureToSeconds(midi, 5), endSec: measureToSeconds(midi, 7), waitForButton: true, codeStyle: "expanded" });
matrix.push({ tracks: [0, 1], nxtCount: 2, showOnLcd: false, volume: 2 });

for (const opts of matrix) {
  const label = JSON.stringify(opts);
  const r = convertMidi(midi, { title: "Brick Theme", ...opts });
  for (const p of r.parts) {
    const c = compile(p.code);
    if (!c.program) {
      check(`compiles ${label}`, false, c.diagnostics.map((d) => d.message).join("; "));
      continue;
    }
    check(`no compile warnings ${label}`, c.diagnostics.length === 0, JSON.stringify(c.diagnostics));
    const b = new Brick(c.program, { buttonAt: (t) => (t < 200 ? 3 : -1) });
    const res = b.run({ maxSteps: 5e6, limit: 20 * 60 * 1000 });
    check(`runs ${label}`, res === "done" && !b.error, `${res} ${b.error?.message}`);
    check(`no runtime warnings ${label}`, b.warnings.length === 0, JSON.stringify(b.warnings));
    const reps = opts.repeatCount ?? 1;
    const expected = p.events.filter((e) => e.frequency > 0);
    const total = p.events.reduce((s, e) => s + e.durationCs * 10, 0);
    const played = b.tones.filter((t) => t.end > t.start);
    let maxErr = 0;
    if (played.length !== expected.length * reps) maxErr = Infinity;
    const offset = played.length ? played[0].start - expected[0]?.startCs * 10 : 0;
    played.forEach((t, k) => {
      const e = expected[k % expected.length];
      const rep = Math.floor(k / expected.length);
      if (!e || t.freq !== e.frequency) maxErr = Infinity;
      else
        maxErr = Math.max(
          maxErr,
          Math.abs(t.start - offset - (e.startCs * 10 + rep * total)),
          Math.abs(t.end - t.start - e.durationCs * 10)
        );
    });
    check(`timing ${label} ${p.label}`, maxErr < 2.5, `tones ${played.length}/${expected.length * reps} maxErr ${maxErr}`);
  }
}

{
  // Melody extraction: no accompaniment note should sneak into the melody line.
  const r = convertMidi(midi, { tracks: [0] });
  const melodyPitches = new Set([67, 69, 71, 72, 74, 76, 77, 79, 81, 64]);
  const bad = r.parts[0].events.filter((e) => e.midi !== null && !melodyPitches.has(e.midi));
  check("melody line is clean", bad.length === 0, bad.map((e) => e.midi).join(","));
  const r3 = convertMidi(midi, { tracks: [0], nxtCount: 3 });
  const bassFirst = r3.parts[2].events.find((e) => e.midi !== null);
  check("bass part starts on the bass note", bassFirst?.midi === 57, String(bassFirst?.midi)); // A2 folded up an octave
}

{
  // 16-bit safety: a long rest is split so duration * 10 never overflows.
  const r = convertMidi(midi, { tempoPercent: 25, tracks: [0] });
  check("durations fit 16-bit math", r.parts[0].events.every((e) => e.durationCs <= 3000));
}

// ---------------------------------------------------------------------------
// Engine with a fake audio clock
// ---------------------------------------------------------------------------

class Param {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  setTargetAtTime() {}
  cancelScheduledValues() {}
}
class FakeNode {
  gain = new Param();
  pan = new Param();
  frequency = new Param();
  type = "";
  connect() {}
  disconnect() {}
  start() {}
  stop() {}
}
class FakeAudioContext {
  static now = 0;
  state = "running";
  destination = {};
  get currentTime() {
    return FakeAudioContext.now;
  }
  resume() {}
  createGain() {
    return new FakeNode();
  }
  createOscillator() {
    return new FakeNode();
  }
  createBiquadFilter() {
    return new FakeNode();
  }
  createStereoPanner() {
    return new FakeNode();
  }
}
(globalThis as unknown as { window: unknown }).window = { AudioContext: FakeAudioContext };

async function engineTests() {
  const { SimEngine } = await import("../lib/sim/engine");
  const { BrickSpeakers } = await import("../lib/sim/audio");
  type Rec = { ch: number; freq: number; start: number; end: number; voice: { end: number } };
  const played: Rec[] = [];
  const origPlay = BrickSpeakers.prototype.play;
  BrickSpeakers.prototype.play = function (this: InstanceType<typeof BrickSpeakers>, ch, freq, start, end, volume) {
    origPlay.call(this, ch, freq, start, end, volume);
    const voices = (this as unknown as { channels: { voices: { end: number; start: number }[] }[] }).channels[ch].voices;
    const v = voices[voices.length - 1];
    if (v && v.start === Math.max(start, FakeAudioContext.now)) played.push({ ch, freq, start: v.start, end, voice: v });
  };
  const audible = () => played.reduce((s, p) => s + Math.max(0, p.voice.end - p.start), 0) * 1000;

  const advance = (engine: InstanceType<typeof SimEngine>, seconds: number) => {
    const steps = Math.ceil(seconds / 0.025);
    for (let k = 0; k < steps; k++) {
      FakeAudioContext.now += 0.025;
      if (engine.getSnapshot().status === "playing") (engine as unknown as { tick: () => void }).tick();
    }
  };

  const r = convertMidi(midi, { tracks: [0], codeStyle: "expanded", title: "T" });
  const code = r.parts[0].code;
  const lines = code.split("\n");
  const m3 = lines.findIndex((l) => l.includes("// Measure 3 ")) + 1;
  const m4 = lines.findIndex((l) => l.includes("// Measure 4 ")) + 1;

  // Whole song, with a pause in the middle: everything is heard exactly once.
  {
    played.length = 0;
    const e = new SimEngine();
    e.load([{ name: "Melody", code }]);
    const expectMs = e.getSnapshot().timeline.tones.reduce((s, t) => s + t.end - t.start, 0);
    e.play();
    advance(e, 10.37);
    e.pause();
    const pausedAt = e.getSnapshot().time;
    advance(e, 3);
    e.play();
    advance(e, 30);
    const s = e.getSnapshot();
    check("plays to the end", s.status === "finished", s.status);
    check("pause is exact", Math.abs(pausedAt - 10370 + 60) < 40, String(pausedAt));
    check("pause/resume keeps every note once", Math.abs(audible() - expectMs) < 15, `${audible().toFixed(1)} vs ${expectMs}`);
    e.dispose();
  }

  // Playing a selection plays exactly those notes, then stops.
  {
    played.length = 0;
    const e = new SimEngine();
    e.load([{ name: "Melody", code }]);
    e.playSelection(0, m3 + 1, m4 - 2, false);
    advance(e, 4);
    const s = e.getSnapshot();
    const noteLines = lines.slice(m3, m4 - 2).filter((l) => /playNote\((\d+)/.exec(l) && !/playNote\(0,/.test(l));
    check("selection stops", s.status === "paused" && /end of the selection/.test(s.message ?? ""), `${s.status} ${s.message}`);
    check("selection plays its notes", played.length === noteLines.length, `${played.length} vs ${noteLines.length}`);
    e.dispose();
  }

  // Looping a selection keeps repeating it.
  {
    played.length = 0;
    const e = new SimEngine();
    e.load([{ name: "Melody", code }]);
    e.playSelection(0, m3 + 1, m4 - 2, true);
    advance(e, 7);
    const s = e.getSnapshot();
    const per = lines.slice(m3, m4 - 2).filter((l) => /playNote\([1-9]/.test(l)).length;
    check("loop keeps playing", s.status === "playing" && played.length > per * 2, `${s.status} ${played.length} per ${per}`);
    e.stop();
    e.dispose();
  }

  // Breakpoints pause on the line; step over moves to the next line in main.
  {
    const e = new SimEngine();
    e.load([{ name: "Melody", code }]);
    const bp = m4 + 1;
    e.toggleBreakpoint(0, bp);
    e.play();
    advance(e, 8);
    let s = e.getSnapshot();
    check("breakpoint hit", s.status === "paused" && s.bricks[0].lines[0]?.line === bp, `${s.status} ${s.bricks[0].lines[0]?.line}`);
    const t0 = s.time;
    e.step("over");
    s = e.getSnapshot();
    const firstLen = Number(/playNote\(\d+, (\d+)\)/.exec(lines[bp - 1])![1]) * 10;
    check("step over", s.bricks[0].lines[0]?.line === bp + 1 && Math.abs(s.time - t0 - firstLen) < 2, `${s.bricks[0].lines[0]?.line} dt ${s.time - t0}`);
    e.step("into");
    s = e.getSnapshot();
    check("step into enters the function", (s.bricks[0].lines[0]?.depth ?? 0) === 2, JSON.stringify(s.bricks[0].lines));
    e.step("out");
    s = e.getSnapshot();
    check("step out returns", s.bricks[0].lines[0]?.depth === 1 && s.bricks[0].lines[0]?.line === bp + 2, JSON.stringify(s.bricks[0].lines));
    const vars = e.inspect(0);
    check("variables visible", !!vars && vars.globals.some((g) => g.name === "nextTime"));
    e.dispose();
  }

  // Run to line continues from the current position.
  {
    const e = new SimEngine();
    e.load([{ name: "Melody", code }]);
    e.runToLine(0, m4 + 1);
    const t1 = e.getSnapshot().time;
    e.runToLine(0, m3 + 1);
    const s = e.getSnapshot();
    check("run to line", t1 > 0 && /isn't reached again/.test(s.message ?? ""), `${t1} ${s.message}`);
    e.dispose();
  }

  // Several NXTs stay in step and seeking works.
  {
    played.length = 0;
    const parts = convertMidi(midi, { tracks: [0], nxtCount: 3 }).parts;
    const e = new SimEngine();
    e.load(parts.map((p) => ({ name: p.label, code: p.code })));
    e.seek(20000);
    const s0 = e.getSnapshot();
    check("seek", s0.time === 20000 && s0.status === "paused");
    e.play();
    advance(e, 20);
    const s = e.getSnapshot();
    check("multi-NXT finishes", s.status === "finished", s.status);
    const after = s.timeline.tones.filter((t) => t.end > 20000);
    check("multi-NXT plays every part from the seek point", played.length === after.length, `${played.length} vs ${after.length}`);
    e.dispose();
  }

  // Eight NXTs run on one clock.
  {
    played.length = 0;
    const parts = convertMidi(midi, { tracks: [0, 1], nxtCount: 8 }).parts;
    const e = new SimEngine();
    e.load(parts.map((p) => ({ name: p.label, code: p.code })));
    check("8 bricks load", e.getSnapshot().bricks.length === 8);
    e.play();
    advance(e, 120);
    const s = e.getSnapshot();
    check("8 NXTs finish", s.status === "finished", s.status);
    check("8 NXTs play every note", played.length === s.timeline.tones.length && played.length > 0, `${played.length} vs ${s.timeline.tones.length}`);
    e.dispose();
  }

  // Programs that never end are previewed for a while and marked as such.
  {
    const e = new SimEngine();
    e.load([{ name: "Loop", code: convertMidi(midi, { tracks: [0], repeatCount: 0 }).parts[0].code }]);
    const s = e.getSnapshot();
    check("loop forever preview", s.timeline.truncated && s.timeline.duration >= 9 * 60 * 1000);
    e.dispose();
  }

  BrickSpeakers.prototype.play = origPlay;
}

engineTests()
  .then(() => {
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
