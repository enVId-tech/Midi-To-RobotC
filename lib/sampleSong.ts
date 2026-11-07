import { Midi } from "@tonejs/midi";

/**
 * A short original piece for trying the app without a MIDI file. Like most
 * piano MIDI files, the melody and the left-hand accompaniment share one
 * track, so it shows off melody extraction and multi-NXT splitting. A drum
 * track is included too (it's skipped by default).
 */
export function sampleSong(): Midi {
  const bpm = 112;
  const beat = 60 / bpm;
  const midi = new Midi();
  midi.header.setTempo(bpm);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4], measures: 0 });
  midi.header.name = "Brick Theme (sample)";
  midi.header.update();

  const piano = midi.addTrack();
  piano.name = "Piano";
  piano.instrument.number = 0;

  // [beat in bar, length in beats, MIDI note]
  const melody: [number, number, number][][] = [
    [[0, 1, 76], [1, 1, 81], [2, 0.5, 79], [2.5, 0.5, 76], [3, 1, 74]],
    [[0, 1.5, 72], [1.5, 0.5, 74], [2, 1, 76], [3, 1, 72]],
    [[0, 0.5, 67], [0.5, 0.5, 72], [1, 0.5, 76], [1.5, 0.5, 79], [2, 1, 81], [3, 1, 79]],
    [[0, 0.5, 77], [0.5, 0.5, 76], [1, 1, 74], [2, 2, 71]],
    [[0, 0.5, 69], [0.5, 0.5, 69], [1, 0.5, 72], [1.5, 0.5, 72], [2, 0.5, 76], [2.5, 0.5, 76], [3, 1, 81]],
    [[0, 0.5, 79], [0.5, 0.5, 77], [1, 1, 76], [2, 0.5, 74], [2.5, 0.5, 72], [3, 1, 74]],
    [[0, 1, 76], [1, 0.5, 77], [1.5, 0.5, 76], [2, 1, 74], [3, 1, 67]],
    [[0, 3, 72]],
  ];
  // Chord per bar: [bass root, chord tones]
  const chords: [number, number[]][] = [
    [45, [57, 60, 64]], // Am
    [41, [57, 60, 65]], // F
    [48, [55, 60, 64]], // C
    [43, [55, 59, 62]], // G
    [45, [57, 60, 64]], // Am
    [41, [57, 60, 65]], // F
    [43, [55, 59, 62]], // G
    [48, [55, 60, 64]], // C
  ];

  const bars = melody.length;
  const add = (bar: number, at: number, len: number, note: number, velocity: number) =>
    piano.addNote({ midi: note, time: (bar * 4 + at) * beat, duration: len * beat * 0.95, velocity });

  for (let rep = 0; rep < 2; rep++) {
    for (let b = 0; b < bars; b++) {
      const bar = rep * bars + b;
      for (const [at, len, note] of melody[b]) add(bar, at, len, note, 0.85);
      const [root, tones] = chords[b];
      add(bar, 0, 2, root, 0.6);
      add(bar, 2, 2, root + 12, 0.55);
      for (const at of [1, 3]) for (const t of tones) add(bar, at, 0.75, t, 0.45);
    }
  }

  const drums = midi.addTrack();
  drums.name = "Drums";
  drums.channel = 9;
  for (let bar = 0; bar < bars * 2; bar++) {
    for (let e = 0; e < 8; e++) {
      const time = (bar * 4 + e / 2) * beat;
      drums.addNote({ midi: 42, time, duration: beat * 0.25, velocity: 0.35 });
      if (e === 0 || e === 4) drums.addNote({ midi: 36, time, duration: beat * 0.25, velocity: 0.7 });
      if (e === 2 || e === 6) drums.addNote({ midi: 38, time, duration: beat * 0.25, velocity: 0.6 });
    }
  }
  return midi;
}
