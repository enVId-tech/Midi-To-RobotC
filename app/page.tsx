"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Midi } from "@tonejs/midi";
import {
  CodeStyle,
  ConversionResult,
  convertMidi,
  defaultTrackSelection,
  formatTime,
  midiNoteName,
  RangeMode,
  summarizeTracks,
  TrackSummary,
  VoiceMode,
} from "@/lib/midiToRobotC";
import { measureToSeconds, midiInfo, MidiInfo } from "@/lib/midiInfo";
import { sampleSong } from "@/lib/sampleSong";
import { EXAMPLE_PROGRAM } from "@/lib/exampleProgram";
import { SimEngine } from "@/lib/sim/engine";
import { MidiPreview } from "@/lib/sim/audio";
import Simulator, { PART_COLORS } from "@/components/Simulator";
import PianoRoll, { RollNote } from "@/components/PianoRoll";

type RepeatMode = "once" | "forever" | "times";

interface Settings {
  tracks: number[];
  nxtCount: number;
  voiceMode: VoiceMode;
  codeStyle: CodeStyle;
  repeatMode: RepeatMode;
  repeatTimes: number;
  startMeasure: number;
  endMeasure: number;
  transpose: number;
  tempoPercent: number;
  rangeMode: RangeMode;
  minFrequency: number;
  maxFrequency: number;
  minNoteMs: number;
  repeatGapMs: number;
  volume: number;
  showOnLcd: boolean;
  waitForButton: boolean;
  title: string;
}

const BASE_SETTINGS: Omit<Settings, "tracks" | "startMeasure" | "endMeasure" | "title"> = {
  nxtCount: 1,
  voiceMode: "highest",
  codeStyle: "compact",
  repeatMode: "once",
  repeatTimes: 2,
  transpose: 0,
  tempoPercent: 100,
  rangeMode: "octave",
  minFrequency: 220,
  maxFrequency: 8000,
  minNoteMs: 30,
  repeatGapMs: 35,
  volume: 4,
  showOnLcd: true,
  waitForButton: false,
};

interface Loaded {
  midi: Midi;
  name: string;
  info: MidiInfo;
  tracks: TrackSummary[];
}

const clampNum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
  help?: string;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <span className="field-input">
        <input
          type="number"
          inputMode="numeric"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v) && v >= props.min && v <= props.max) props.onChange(v);
          }}
          onBlur={() => {
            const v = clampNum(parseFloat(text), props.min, props.max);
            setText(String(v));
            props.onChange(v);
          }}
        />
        {props.suffix && <span className="suffix">{props.suffix}</span>}
      </span>
      {props.help && <span className="field-help">{props.help}</span>}
    </label>
  );
}

function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="field">
      <span className="field-label" id={`seg-${props.label}`}>
        {props.label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={`seg-${props.label}`}>
        {props.options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === props.value}
            className={o.value === props.value ? "on" : ""}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const engine = useMemo(() => new SimEngine(), []);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [needsRegen, setNeedsRegen] = useState(false);
  const loadedCodes = useRef<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  // ---- loading ------------------------------------------------------------

  const openMidi = useCallback((midi: Midi, name: string) => {
    const tracks = summarizeTracks(midi);
    const info = midiInfo(midi);
    if (info.noteCount === 0) {
      setLoadError("This MIDI file has no notes in it.");
      return;
    }
    setLoadError("");
    setLoaded({ midi, name, info, tracks });
    setSettings({
      ...BASE_SETTINGS,
      tracks: defaultTrackSelection(tracks),
      startMeasure: 1,
      endMeasure: info.measures,
      title: name.replace(/\.midi?$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 40) || "Song",
    });
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      if (!/\.(mid|midi|kar)$/i.test(file.name)) {
        setLoadError(`"${file.name}" isn't a MIDI file. Choose a file ending in .mid or .midi.`);
        return;
      }
      try {
        const midi = new Midi(await file.arrayBuffer());
        openMidi(midi, file.name);
      } catch (err) {
        setLoadError(`Couldn't read "${file.name}" as MIDI${err instanceof Error ? ` (${err.message})` : ""}. The file may be damaged.`);
      }
    },
    [openMidi]
  );

  // ---- conversion ---------------------------------------------------------

  const conversion = useMemo((): { result: ConversionResult | null; error: string } => {
    if (!loaded || !settings) return { result: null, error: "" };
    try {
      const { midi } = loaded;
      const start = measureToSeconds(midi, settings.startMeasure);
      const end = settings.endMeasure >= loaded.info.measures ? null : measureToSeconds(midi, settings.endMeasure + 1);
      const result = convertMidi(midi, {
        tracks: settings.tracks,
        nxtCount: settings.nxtCount,
        voiceMode: settings.voiceMode,
        codeStyle: settings.codeStyle,
        repeatCount: settings.repeatMode === "once" ? 1 : settings.repeatMode === "forever" ? 0 : settings.repeatTimes,
        startSec: start,
        endSec: end,
        transpose: settings.transpose,
        tempoPercent: settings.tempoPercent,
        rangeMode: settings.rangeMode,
        minFrequency: settings.minFrequency,
        maxFrequency: Math.max(settings.maxFrequency, settings.minFrequency + 50),
        minNoteMs: settings.minNoteMs,
        repeatGapMs: settings.repeatGapMs,
        volume: settings.volume,
        showOnLcd: settings.showOnLcd,
        waitForButton: settings.waitForButton,
        title: settings.title,
      });
      return { result, error: "" };
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : "Conversion failed." };
    }
  }, [loaded, settings]);

  const generated = useMemo(() => conversion.result?.parts.map((p) => p.code) ?? [], [conversion.result]);

  const loadIntoSimulator = useCallback(() => {
    const parts = conversion.result?.parts;
    if (!parts) return;
    const specs = parts.map((p) => ({ name: parts.length > 1 ? `NXT ${p.nxtNumber} ${p.label}` : p.label, code: p.code }));
    engine.load(specs);
    loadedCodes.current = specs.map((s) => s.code);
    setNeedsRegen(false);
  }, [conversion.result, engine]);

  // New conversion: load it, unless the user has edited the code we loaded last time.
  useEffect(() => {
    if (!conversion.result) {
      if (!loaded && loadedCodes.current.length === 0) {
        engine.load([{ name: "Example", code: EXAMPLE_PROGRAM }]);
        loadedCodes.current = [];
      }
      return;
    }
    const current = engine.getSnapshot().bricks.map((b) => b.code);
    const edited =
      loadedCodes.current.length > 0 &&
      current.length === loadedCodes.current.length &&
      current.some((c, i) => c !== loadedCodes.current[i]);
    if (edited) setNeedsRegen(true);
    else loadIntoSimulator();
  }, [conversion.result, engine, loadIntoSimulator, loaded]);

  useEffect(() => () => engine.dispose(), [engine]);

  // ---- original MIDI preview ------------------------------------------------

  const previewRef = useRef<MidiPreview | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewNotes = useMemo(() => {
    if (!loaded || !settings) return [];
    const chosen = new Set(settings.tracks);
    const out: { start: number; end: number; midi: number; velocity: number; track: number }[] = [];
    loaded.midi.tracks.forEach((t, ti) => {
      if (!chosen.has(ti) || loaded.tracks[ti].isDrums) return;
      for (const n of t.notes) out.push({ start: n.time, end: n.time + n.duration, midi: n.midi, velocity: n.velocity, track: ti });
    });
    return out;
  }, [loaded, settings]);

  useEffect(() => {
    previewRef.current?.setNotes(previewNotes);
  }, [previewNotes]);

  useEffect(() => {
    previewRef.current?.pause();
    previewRef.current?.seek(0);
    setPreviewPlaying(false);
  }, [loaded]);

  const getPreview = () => {
    if (!previewRef.current) {
      previewRef.current = new MidiPreview();
      previewRef.current.setNotes(previewNotes);
      previewRef.current.onEnded = () => setPreviewPlaying(false);
    }
    return previewRef.current;
  };

  const togglePreview = () => {
    const p = getPreview();
    if (p.playing) {
      p.pause();
      setPreviewPlaying(false);
    } else {
      engine.pause();
      p.play();
      setPreviewPlaying(true);
    }
  };

  const pausePreview = useCallback(() => {
    if (previewRef.current?.playing) {
      previewRef.current.pause();
      setPreviewPlaying(false);
    }
  }, []);

  const getPreviewTime = useCallback(() => (previewRef.current ? previewRef.current.position() * 1000 : 0), []);

  const rollNotes: RollNote[] = useMemo(() => {
    if (!loaded || !settings) return [];
    const notes: RollNote[] = previewNotes.map((n) => ({
      start: n.start * 1000,
      end: n.end * 1000,
      pitch: n.midi,
      color: "#8B949E",
      alpha: 0.55,
    }));
    const res = conversion.result;
    if (res) {
      const start = measureToSeconds(loaded.midi, settings.startMeasure);
      const scale = settings.tempoPercent / 100;
      res.parts.forEach((p, pi) => {
        for (const e of p.events) {
          if (e.frequency <= 0 || e.midi === null) continue;
          const s = (start + (e.startCs / 100) * scale) * 1000;
          notes.push({
            start: s,
            end: s + e.durationCs * 10 * scale,
            pitch: e.midi - settings.transpose,
            color: PART_COLORS[pi % 4],
            alpha: 0.95,
          });
        }
      });
    }
    return notes;
  }, [previewNotes, conversion.result, loaded, settings]);

  const region = useMemo(() => {
    if (!loaded || !settings) return null;
    if (settings.startMeasure <= 1 && settings.endMeasure >= loaded.info.measures) return null;
    const s = measureToSeconds(loaded.midi, settings.startMeasure) * 1000;
    const e =
      settings.endMeasure >= loaded.info.measures ? loaded.info.durationSec * 1000 : measureToSeconds(loaded.midi, settings.endMeasure + 1) * 1000;
    return { start: s, end: e };
  }, [loaded, settings]);

  // ---- render ---------------------------------------------------------------

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => (s ? { ...s, [key]: value } : s));
  const res = conversion.result;
  const fileBase = (settings?.title || "song").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "song";

  return (
    <main className="page">
      <header className="masthead">
        <h1>MIDI to NXT</h1>
        <p>
          Turn a MIDI file into RobotC for the LEGO Mindstorms NXT, then hear it the way the brick will play it, line by line if
          you like.
        </p>
      </header>

      <div className="workbench">
        <section className="panel source" aria-labelledby="source-h">
          <h2 id="source-h">
            <span className="step-num">1</span> Music
          </h2>
          <label
            className={`dropzone${dragging ? " dragging" : ""}${loaded ? " compact" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFile(f);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".mid,.midi,.kar,audio/midi,audio/x-midi"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
            {loaded ? (
              <span>
                <strong>{loaded.name}</strong>
                <span className="dim"> Drop or click to choose another file</span>
              </span>
            ) : (
              <span>
                <strong>Choose a MIDI file</strong> or drop it here
              </span>
            )}
          </label>
          {!loaded && (
            <button type="button" className="btn ghost" onClick={() => openMidi(sampleSong(), "Brick Theme (sample).mid")}>
              Try the sample song
            </button>
          )}
          {loadError && <p className="error-text">{loadError}</p>}

          {loaded && settings && (
            <>
              <p className="file-facts">
                {formatTime(loaded.info.durationSec)} long, {loaded.info.measures} measures in {loaded.info.timeSignature} at{" "}
                {loaded.info.bpm} bpm.
              </p>
              <fieldset className="tracks">
                <legend>Tracks to use</legend>
                {loaded.tracks
                  .filter((t) => t.noteCount > 0)
                  .map((t) => (
                    <label key={t.index} className="track">
                      <input
                        type="checkbox"
                        checked={settings.tracks.includes(t.index)}
                        onChange={(e) =>
                          set(
                            "tracks",
                            e.target.checked
                              ? [...settings.tracks, t.index].sort((a, b) => a - b)
                              : settings.tracks.filter((x) => x !== t.index)
                          )
                        }
                      />
                      <span className="track-name">{t.name}</span>
                      <span className="track-meta">
                        {t.isDrums ? "drums" : t.instrument}
                        {t.lowest !== null && !t.isDrums ? `, ${midiNoteName(t.lowest)}-${midiNoteName(t.highest!)}` : ""}, {t.noteCount} notes
                      </span>
                    </label>
                  ))}
                {settings.tracks.length === 0 && <p className="field-help">Pick at least one track.</p>}
              </fieldset>
            </>
          )}
        </section>

        {loaded && settings && (
          <section className="panel settings" aria-labelledby="settings-h">
            <h2 id="settings-h">
              <span className="step-num">2</span> Conversion
            </h2>
            <Segmented
              label="Number of NXTs"
              value={settings.nxtCount}
              options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
              onChange={(v) => set("nxtCount", v)}
            />
            <p className="field-help">
              {settings.nxtCount === 1
                ? "One NXT plays one note at a time."
                : `The music is split into ${settings.nxtCount === 2 ? "melody and bass" : settings.nxtCount === 3 ? "melody, harmony and bass" : "melody, two harmony parts and bass"}, one program per NXT.`}
            </p>
            {settings.nxtCount === 1 && (
              <Segmented
                label="Which notes to play"
                value={settings.voiceMode}
                options={[
                  { value: "highest", label: "Melody" },
                  { value: "lowest", label: "Bass line" },
                  { value: "off", label: "Every note" },
                ]}
                onChange={(v) => set("voiceMode", v)}
              />
            )}
            {settings.nxtCount === 1 && settings.voiceMode === "off" && (
              <p className="warning-text">
                Every note plays the notes exactly as written, one after another. If the track has chords, a bass line, or both hands
                of a piano part, notes will cut each other off and it will likely sound wrong. Use Melody unless the track is a single
                line.
              </p>
            )}
            <Segmented
              label="Code style"
              value={settings.codeStyle}
              options={[
                { value: "compact", label: "Compact" },
                { value: "expanded", label: "One line per note" },
              ]}
              onChange={(v) => set("codeStyle", v)}
            />
            <p className="field-help">
              {settings.codeStyle === "compact"
                ? "Notes are stored in an array and played by a loop. Short code, good for long songs."
                : "Each note gets its own line, grouped by measure. Longer, but easy to edit and to play a few measures at a time."}
            </p>
            <Segmented
              label="Repeat"
              value={settings.repeatMode}
              options={[
                { value: "once", label: "Play once" },
                { value: "forever", label: "Loop forever" },
                { value: "times", label: "Several times" },
              ]}
              onChange={(v) => set("repeatMode", v)}
            />
            {settings.repeatMode === "times" && (
              <NumberField label="Times" value={settings.repeatTimes} min={2} max={100} onChange={(v) => set("repeatTimes", v)} />
            )}

            <details className="advanced">
              <summary>More options</summary>
              <div className="field-pair">
                <NumberField
                  label="From measure"
                  value={settings.startMeasure}
                  min={1}
                  max={loaded.info.measures}
                  onChange={(v) => setSettings((s) => (s ? { ...s, startMeasure: v, endMeasure: Math.max(v, s.endMeasure) } : s))}
                />
                <NumberField
                  label="To measure"
                  value={settings.endMeasure}
                  min={settings.startMeasure}
                  max={loaded.info.measures}
                  onChange={(v) => set("endMeasure", v)}
                />
              </div>
              <div className="field-pair">
                <NumberField label="Transpose" value={settings.transpose} min={-24} max={24} suffix="semitones" onChange={(v) => set("transpose", v)} />
                <NumberField label="Tempo" value={settings.tempoPercent} min={25} max={400} suffix="%" onChange={(v) => set("tempoPercent", v)} />
              </div>
              <div className="field-pair">
                <NumberField label="Lowest pitch" value={settings.minFrequency} min={50} max={2000} suffix="Hz" onChange={(v) => set("minFrequency", v)} />
                <NumberField label="Highest pitch" value={settings.maxFrequency} min={500} max={14000} suffix="Hz" onChange={(v) => set("maxFrequency", v)} />
              </div>
              <Segmented
                label="Notes outside that range"
                value={settings.rangeMode}
                options={[
                  { value: "octave", label: "Move by octaves" },
                  { value: "clamp", label: "Clamp" },
                  { value: "drop", label: "Leave out" },
                ]}
                onChange={(v) => set("rangeMode", v)}
              />
              <p className="field-help">The NXT speaker is weak below about 220 Hz. Moving notes by octaves keeps the tune recognizable.</p>
              <div className="field-pair">
                <NumberField label="Shortest note" value={settings.minNoteMs} min={0} max={500} suffix="ms" onChange={(v) => set("minNoteMs", v)} />
                <NumberField
                  label="Gap between repeated notes"
                  value={settings.repeatGapMs}
                  min={0}
                  max={200}
                  suffix="ms"
                  onChange={(v) => set("repeatGapMs", v)}
                />
              </div>
              <p className="field-help">
                The gap makes the buzzer stop briefly so the same note played twice is heard twice instead of as one long note.
              </p>
              <Segmented
                label="NXT volume"
                value={settings.volume}
                options={[1, 2, 3, 4].map((v) => ({ value: v, label: String(v) }))}
                onChange={(v) => set("volume", v)}
              />
              <label className="field">
                <span className="field-label">Title on the NXT screen</span>
                <input type="text" value={settings.title} maxLength={40} onChange={(e) => set("title", e.target.value)} />
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.showOnLcd} onChange={(e) => set("showOnLcd", e.target.checked)} />
                Show the title and part on the screen
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.waitForButton} onChange={(e) => set("waitForButton", e.target.checked)} />
                Wait for the orange button before playing (handy for starting several NXTs together)
              </label>
            </details>
          </section>
        )}

        {loaded && settings && (
          <section className="panel compare" aria-labelledby="compare-h">
            <div className="compare-head">
              <h2 id="compare-h">
                <span className="step-num">3</span> Original and NXT parts
              </h2>
              <button type="button" className="btn" onClick={togglePreview} disabled={previewNotes.length === 0}>
                {previewPlaying ? "Pause original" : "Play original"}
              </button>
            </div>
            <PianoRoll
              notes={rollNotes}
              duration={loaded.info.durationSec * 1000}
              getTime={getPreviewTime}
              onSeek={(ms) => getPreview().seek(ms / 1000)}
              region={region}
              height={170}
              label="Piano roll of the original MIDI with the NXT parts on top; click to move the playhead"
            />
            <div className="legend">
              <span>
                <i style={{ background: "#8B949E" }} /> Original
              </span>
              {res?.parts.map((p, i) => (
                <span key={i}>
                  <i style={{ background: PART_COLORS[i % 4] }} /> {res.parts.length > 1 ? `NXT ${p.nxtNumber} ` : ""}
                  {p.label}: {p.noteCount} notes, {formatTime(p.durationSeconds)}
                </span>
              ))}
            </div>
            {conversion.error && <p className="error-text">{conversion.error}</p>}
            {res && res.warnings.length > 0 && (
              <ul className="warnings">
                {res.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      <section className="panel sim-panel" aria-labelledby="sim-h">
        <div className="sim-intro">
          <h2 id="sim-h">
            <span className="step-num">{loaded ? 4 : 2}</span> RobotC simulator
          </h2>
          <p>
            {loaded
              ? "This runs the generated RobotC the way an NXT would. Play it, step through it, or select lines and play just those."
              : "Runs RobotC NXT programs in the browser and plays their sound. Edit the example or paste your own code."}
          </p>
        </div>
        {needsRegen && (
          <div className="regen">
            You changed the settings, but the code in the simulator has your edits.
            <button type="button" className="btn primary small" onClick={loadIntoSimulator}>
              Replace my edits with new code
            </button>
          </div>
        )}
        <Simulator
          engine={engine}
          generated={snap.bricks.length === generated.length ? generated : []}
          fileBase={fileBase}
          onRevert={(i) => generated[i] !== undefined && engine.setCode(i, generated[i])}
          onPlay={pausePreview}
        />
      </section>

      <footer className="foot">
        <p>
          The simulator follows RobotC for the NXT: 16-bit ints, the sound queue behind PlayTone, wait1Msec, tasks, the screen and
          buttons. Motors and sensors are only stand-ins, and PlaySound effects are approximations.
        </p>
      </footer>
    </main>
  );
}
