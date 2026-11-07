import { Midi } from "@tonejs/midi";

export interface MidiInfo {
  durationSec: number;
  /** Number of measures (at least 1). */
  measures: number;
  bpm: number;
  timeSignature: string;
  noteCount: number;
}

export function midiInfo(midi: Midi): MidiInfo {
  const ts = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  const durationSec = midi.duration;
  return {
    durationSec,
    measures: Math.max(1, Math.ceil(secondsToMeasure(midi, durationSec) - 1 - 1e-6)),
    bpm: Math.round(bpm),
    timeSignature: `${ts[0]}/${ts[1]}`,
    noteCount: midi.tracks.reduce((n, t) => n + t.notes.length, 0),
  };
}

/** 1-based (fractional) measure at a time in seconds. */
export function secondsToMeasure(midi: Midi, sec: number): number {
  try {
    return midi.header.ticksToMeasures(midi.header.secondsToTicks(Math.max(0, sec))) + 1;
  } catch {
    return 1;
  }
}

/** Start time in seconds of a 1-based measure number. */
export function measureToSeconds(midi: Midi, measure: number): number {
  const target = Math.max(0, measure - 1);
  if (target === 0) return 0;
  // ticksToMeasures only goes one way, so search for the tick.
  let lo = 0;
  let hi = Math.max(midi.durationTicks, midi.header.ppq * 4) * 2;
  try {
    while (midi.header.ticksToMeasures(hi) < target && hi < 1e9) hi *= 2;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (midi.header.ticksToMeasures(mid) < target) lo = mid;
      else hi = mid;
    }
    return midi.header.ticksToSeconds(hi);
  } catch {
    return 0;
  }
}
