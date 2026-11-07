/** Shared Web Audio context, created on first use (browsers require a click first). */
let sharedCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedCtx) {
    const AC: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new AC({ latencyHint: "interactive" });
  }
  if (sharedCtx.state === "suspended") void sharedCtx.resume();
  return sharedCtx;
}

export type Waveform = "square" | "triangle" | "sine";

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  start: number;
  end: number;
}

interface Channel {
  gain: GainNode;
  pan: StereoPannerNode | null;
  voices: Voice[];
  muted: boolean;
}

/** Loudness per waveform so switching sounds doesn't jump in volume. */
const WAVE_LEVEL: Record<Waveform, number> = { square: 0.16, triangle: 0.34, sine: 0.38 };

/**
 * One "speaker" per simulated NXT. Each channel is monophonic like the NXT's
 * buzzer: starting a tone cuts off anything still sounding on that channel.
 */
export class BrickSpeakers {
  readonly ctx: AudioContext;
  private master: GainNode;
  private channels: Channel[] = [];
  wave: Waveform = "square";

  constructor() {
    this.ctx = getAudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    // Soften the harshest edges of the square wave a little.
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 9000;
    this.master.connect(lp);
    lp.connect(this.ctx.destination);
  }

  now(): number {
    return this.ctx.currentTime;
  }

  setChannelCount(n: number) {
    while (this.channels.length < n) {
      const gain = this.ctx.createGain();
      const pan = typeof this.ctx.createStereoPanner === "function" ? this.ctx.createStereoPanner() : null;
      if (pan) {
        gain.connect(pan);
        pan.connect(this.master);
      } else {
        gain.connect(this.master);
      }
      this.channels.push({ gain, pan, voices: [], muted: false });
    }
    // Spread several NXTs across the stereo field so the parts are easier to tell apart.
    this.channels.forEach((c, i) => {
      if (c.pan) c.pan.pan.value = n > 1 && i < n ? -0.45 + (0.9 * i) / (n - 1) : 0;
    });
  }

  setMuted(i: number, muted: boolean) {
    const c = this.channels[i];
    if (!c) return;
    c.muted = muted;
    c.gain.gain.setValueAtTime(muted ? 0 : 1, this.ctx.currentTime);
  }

  setMasterVolume(v: number) {
    this.master.gain.setValueAtTime(Math.max(0, Math.min(1.5, v)), this.ctx.currentTime);
  }

  /** Plays a tone on channel `ch` from audio time `start` to `end`. volume is nVolume (0-4). */
  play(ch: number, freq: number, start: number, end: number, volume: number) {
    const c = this.channels[ch];
    if (!c || end <= start || volume <= 0) return;
    const now = this.ctx.currentTime;
    if (end <= now) return;
    start = Math.max(start, now);
    this.cut(ch, start);
    this.prune(c, now);

    const osc = this.ctx.createOscillator();
    osc.type = this.wave;
    osc.frequency.value = Math.max(20, Math.min(20000, freq));
    const gain = this.ctx.createGain();
    const level = WAVE_LEVEL[this.wave] * (volume / 4);
    const ramp = Math.min(0.003, (end - start) / 4);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + ramp);
    gain.gain.setValueAtTime(level, end - ramp);
    gain.gain.linearRampToValueAtTime(0, end);
    osc.connect(gain);
    gain.connect(c.gain);
    osc.start(start);
    osc.stop(end + 0.01);
    c.voices.push({ osc, gain, start, end });
  }

  /** Silences channel `ch` from audio time `at` on, including tones scheduled later. */
  cut(ch: number, at: number) {
    const c = this.channels[ch];
    if (!c) return;
    const now = this.ctx.currentTime;
    at = Math.max(at, now);
    for (const v of c.voices) {
      if (v.end <= at) continue;
      v.end = at;
      try {
        v.gain.gain.cancelScheduledValues(at);
        v.gain.gain.setValueAtTime(0, at);
        v.osc.stop(at);
      } catch {
        // Already stopped.
      }
    }
  }

  cutAll(at: number) {
    for (let i = 0; i < this.channels.length; i++) this.cut(i, at);
  }

  stopAll() {
    this.cutAll(this.ctx.currentTime);
  }

  private prune(c: Channel, now: number) {
    if (c.voices.length > 64) c.voices = c.voices.filter((v) => v.end > now - 0.5);
  }
}

// ---------------------------------------------------------------------------
// Original MIDI preview
// ---------------------------------------------------------------------------

export interface PreviewNote {
  start: number; // seconds
  end: number; // seconds
  midi: number;
  velocity: number;
}

/**
 * Plays the original MIDI notes with a soft polyphonic synth, so the source
 * can be compared with what the NXT will play. Notes are scheduled a little
 * ahead of time in a loop, so even long files start instantly.
 */
export class MidiPreview {
  private ctx: AudioContext;
  private out: GainNode;
  private notes: PreviewNote[] = [];
  private next = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private anchorAudio = 0;
  private anchorSec = 0;
  private active: { osc: OscillatorNode; gain: GainNode; end: number }[] = [];
  playing = false;
  duration = 0;
  onEnded: (() => void) | null = null;

  constructor() {
    this.ctx = getAudioContext();
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.7;
    this.out.connect(this.ctx.destination);
  }

  setNotes(notes: PreviewNote[]) {
    const pos = this.position();
    const wasPlaying = this.playing;
    this.pause();
    this.notes = [...notes].sort((a, b) => a.start - b.start);
    this.duration = this.notes.reduce((m, n) => Math.max(m, n.end), 0);
    if (wasPlaying) this.play(pos);
    else this.anchorSec = pos;
  }

  position(): number {
    if (!this.playing) return this.anchorSec;
    return this.anchorSec + (this.ctx.currentTime - this.anchorAudio);
  }

  play(fromSec = this.anchorSec) {
    this.pause();
    if (fromSec >= this.duration) fromSec = 0;
    this.anchorSec = fromSec;
    this.anchorAudio = this.ctx.currentTime + 0.05;
    this.next = this.notes.findIndex((n) => n.end > fromSec);
    if (this.next < 0) this.next = this.notes.length;
    this.playing = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), 40);
  }

  pause() {
    if (this.playing) this.anchorSec = this.position();
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const now = this.ctx.currentTime;
    for (const v of this.active) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, 0.01);
        v.osc.stop(now + 0.05);
      } catch {
        // already stopped
      }
    }
    this.active = [];
  }

  seek(sec: number) {
    if (this.playing) this.play(sec);
    else this.anchorSec = Math.max(0, sec);
  }

  private tick() {
    const horizon = this.position() + 0.3;
    while (this.next < this.notes.length && this.notes[this.next].start < horizon) {
      const n = this.notes[this.next++];
      const start = this.anchorAudio + (n.start - this.anchorSec);
      const end = this.anchorAudio + (n.end - this.anchorSec);
      if (end > this.ctx.currentTime) this.voice(n, Math.max(start, this.ctx.currentTime), end);
    }
    const now = this.ctx.currentTime;
    this.active = this.active.filter((v) => v.end > now - 0.2);
    if (this.next >= this.notes.length && this.position() >= this.duration + 0.1) {
      this.pause();
      this.anchorSec = 0;
      this.onEnded?.();
    }
  }

  private voice(n: PreviewNote, start: number, end: number) {
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 440 * Math.pow(2, (n.midi - 69) / 12);
    const gain = this.ctx.createGain();
    const peak = 0.12 * (0.3 + 0.7 * n.velocity);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.006);
    gain.gain.setTargetAtTime(peak * 0.45, start + 0.006, 0.25);
    gain.gain.setValueAtTime(peak * 0.45, Math.max(start + 0.01, end));
    gain.gain.setTargetAtTime(0, Math.max(start + 0.01, end), 0.04);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(start);
    osc.stop(end + 0.3);
    this.active.push({ osc, gain, end: end + 0.3 });
  }
}
