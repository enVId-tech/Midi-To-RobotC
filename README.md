# MIDI to NXT

Source: https://github.com/enVId-tech/Midi-To-RobotC

Convert MIDI files to RobotC for the LEGO Mindstorms NXT, and hear the result in a
RobotC simulator before downloading it to a brick.

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # interpreter, converter and simulator tests
```

## Converter

- Pick tracks (drum tracks are skipped by default), or try the built-in sample song.
- **1 NXT:** play the melody (highest voice), the bass line, or every note as written.
- **2-4 NXTs:** the music is split into melody, harmony and bass, one program per NXT.
  The outer voices (melody and bass) are kept first.
- Melody extraction only starts a note at its own onset, so held accompaniment notes
  never "take over" the melody line in the small gaps between melody notes.
- Code style: compact (data array + loop) or one line per note, grouped by measure.
- Repeat once, forever, or N times; transpose; tempo; convert only some measures;
  pitch range with octave folding, clamping or dropping; volume; title on the LCD;
  wait for the orange button (to start several NXTs together).
- Generated code waits on `nPgmTime` instead of fixed delays, so it doesn't drift over a
  long song, and keeps every duration small enough for RobotC's 16-bit `int`.

## Simulator

A RobotC interpreter (`lib/robotc`) runs the code the way an NXT would, and
`lib/sim` plays it through Web Audio.

- Play, pause, stop, and click the timeline to jump anywhere.
- Step, step over, step out; click a line number for a breakpoint.
- Select lines (click, shift-click) and play just those, once or on a loop;
  play from a line; run to a line.
- Simulated NXT screen and buttons, speaker readout, debug stream, and a
  variables view when paused.
- Several NXTs play together on one clock, with mute per NXT.
- Edit the code or paste your own RobotC; errors and warnings point to lines.

What it models: 16-bit `int` (with overflow warnings), `long`, `float`, `string`, arrays,
functions (including `&` parameters), tasks, `#define`, the `PlayTone` sound queue,
`PlayImmediateTone`, `ClearSounds`, `nVolume`, `bSoundActive`, waits and timers,
`random`, the LCD functions with printf formatting, buttons, and the debug stream.
Motors and sensors are simple stand-ins, `PlaySound` effects are approximations, and
sound files can't be played.

## Layout

```
app/page.tsx              converter UI
lib/attribution.ts        author, repository and license shown in the page
components/Simulator.tsx  simulator UI (CodeView, NxtBrick, PianoRoll)
lib/midiToRobotC.ts       MIDI -> RobotC conversion
lib/robotc/               lexer, parser, type checker, interpreter
lib/sim/engine.ts         playback, seeking, stepping, breakpoints, selections
lib/sim/audio.ts          Web Audio speakers and the original-MIDI preview
tests/run.ts              tests
```

## License

MIT. Copyright (c) 2026 Erick Tran. See [LICENSE](LICENSE).
