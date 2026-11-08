"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SimEngine, StepMode } from "@/lib/sim/engine";
import type { Waveform } from "@/lib/sim/audio";
import { formatTime, frequencyToNoteName } from "@/lib/midiToRobotC";
import CodeView, { Selection } from "./CodeView";
import NxtBrick from "./NxtBrick";
import PianoRoll, { RollNote } from "./PianoRoll";
import { makeZip } from "@/lib/zip";

export const PART_COLORS = ["#E8820C", "#2F6FDB", "#2E9D5B", "#8A4FD1", "#C93A6B", "#0F9AA8", "#8C7A1E", "#5C6670"];

interface Props {
  engine: SimEngine;
  /** Generated code per NXT, to tell whether the user edited it. Empty when there's nothing generated. */
  generated: string[];
  fileBase: string;
  onRevert?: (i: number) => void;
  onPlay?: () => void;
}

function download(name: string, text: string | Uint8Array, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2];

export default function Simulator({ engine, generated, fileBase, onRevert, onPlay }: Props) {
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const [selections, setSelections] = useState<(Selection | null)[]>([]);
  const [editing, setEditing] = useState(false);
  const [follow, setFollow] = useState(true);
  const [loop, setLoop] = useState(false);
  const [copied, setCopied] = useState(false);
  const timeRef = useRef(0);
  timeRef.current = snap.time;
  const getTime = useCallback(() => timeRef.current, []);

  const focus = snap.focus;
  const brick = snap.bricks[focus];
  const selection = selections[focus] ?? null;
  const multi = snap.bricks.length > 1;
  const playing = snap.status === "playing";
  const paused = snap.status === "paused";

  useEffect(() => {
    if (playing) onPlay?.();
  }, [playing, onPlay]);

  // Leave edit mode when another NXT is shown or new code is loaded.
  useEffect(() => setEditing(false), [focus, snap.bricks.length]);

  const setSelection = (sel: Selection | null) =>
    setSelections((prev) => {
      const next = [...prev];
      next[focus] = sel;
      return next;
    });

  const step = useCallback((mode: StepMode) => engine.step(mode), [engine]);
  const togglePlay = useCallback(() => (playing ? engine.pause() : engine.play()), [engine, playing]);

  // Keyboard: space = play/pause, F10 = step over, F11 = step into, Shift+F11 = step out.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT") return;
    if (e.key === " " && target.tagName !== "BUTTON") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "F10") {
      e.preventDefault();
      step("over");
    } else if (e.key === "F11") {
      e.preventDefault();
      step(e.shiftKey ? "out" : "into");
    }
  };

  const timelineNotes: RollNote[] = useMemo(
    () =>
      snap.timeline.tones.map((t) => ({
        start: t.start,
        end: t.end,
        pitch: 69 + 12 * Math.log2(t.freq / 440),
        color: PART_COLORS[t.brick % PART_COLORS.length],
        alpha: snap.bricks[t.brick]?.muted ? 0.25 : 0.9,
      })),
    [snap.timeline, snap.bricks]
  );

  const variables = useMemo(
    () => (paused || snap.status === "finished" ? engine.inspect(focus) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, focus, paused, snap.status, snap.time]
  );

  if (!brick) return null;

  const edited = generated.length > 0 && generated[focus] !== undefined && generated[focus] !== brick.code;
  const errors = brick.diagnostics.filter((d) => d.severity === "error");
  const warnings = brick.diagnostics.filter((d) => d.severity === "warning");
  const currentLines = brick.lines.slice().sort((a, b) => a.task - b.task);
  const duration = Math.max(snap.timeline.duration, snap.time, 1);
  const selLabel = selection ? (selection.from === selection.to ? `line ${selection.from}` : `lines ${selection.from}-${selection.to}`) : null;
  const fileName = (i: number) =>
    `${fileBase || "song"}${snap.bricks.length > 1 ? `-nxt${i + 1}-${snap.bricks[i].name.split(" ").pop()!.toLowerCase()}` : ""}.c`;

  return (
    <section className="sim" onKeyDown={onKeyDown} aria-label="RobotC simulator">
      <div className="sim-head">
        {multi ? (
          <div className="tabs" role="tablist" aria-label="NXTs">
            {snap.bricks.map((b, i) => (
              <div key={i} className={`tab${i === focus ? " active" : ""}`} style={{ "--part": PART_COLORS[i % PART_COLORS.length] } as React.CSSProperties}>
                <button type="button" role="tab" aria-selected={i === focus} className="tab-main" onClick={() => engine.setFocus(i)}>
                  <span className="swatch" aria-hidden />
                  {b.name}
                  {b.tone && <span className="tab-note">{frequencyToNoteName(b.tone.freq)}</span>}
                  {b.diagnostics.some((d) => d.severity === "error") && <span className="tab-err">errors</span>}
                </button>
                <button
                  type="button"
                  className={`mute${b.muted ? " on" : ""}`}
                  aria-pressed={b.muted}
                  title={b.muted ? `Unmute ${b.name}` : `Mute ${b.name}`}
                  onClick={() => engine.setMuted(i, !b.muted)}
                >
                  {b.muted ? "Muted" : "Mute"}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <h3 className="sim-title">{brick.name}</h3>
        )}
        <div className="code-actions">
          {edited && <span className="badge">Edited</span>}
          {edited && onRevert && (
            <button type="button" className="btn small" onClick={() => onRevert(focus)}>
              Revert to generated
            </button>
          )}
          <button type="button" className="btn small" onClick={() => setEditing((v) => !v)} aria-pressed={editing}>
            {editing ? "Stop editing" : "Edit code"}
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              void navigator.clipboard?.writeText(brick.code).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn small" onClick={() => download(fileName(focus), brick.code)}>
            Download .c
          </button>
          {multi && (
            <button
              type="button"
              className="btn small"
              onClick={() =>
                download(
                  `${fileBase || "song"}-nxt-programs.zip`,
                  makeZip(snap.bricks.map((b, i) => ({ name: fileName(i), text: b.code }))),
                  "application/zip"
                )
              }
            >
              Download all {snap.bricks.length} (.zip)
            </button>
          )}
        </div>
      </div>

      <div className="transport" role="toolbar" aria-label="Simulator controls">
        <button type="button" className="btn primary play" onClick={togglePlay} disabled={!brick.compiled && !multi}>
          {playing ? "Pause" : snap.status === "finished" ? "Play again" : paused ? "Resume" : "Play"}
        </button>
        <button type="button" className="btn" onClick={() => engine.stop()} disabled={snap.status === "stopped" && snap.time === 0}>
          Stop
        </button>
        <span className="sep" aria-hidden />
        <button type="button" className="btn" onClick={() => step("into")} title="Run one statement (F11)">
          Step
        </button>
        <button type="button" className="btn" onClick={() => step("over")} title="Run one line, including any function it calls (F10)">
          Step over
        </button>
        <button type="button" className="btn" onClick={() => step("out")} title="Finish the current function (Shift+F11)">
          Step out
        </button>
        <span className="sep" aria-hidden />
        <button
          type="button"
          className="btn"
          disabled={!selection}
          onClick={() => selection && engine.playFromLine(focus, selection.from)}
          title="Start the program and play from the first time this line runs"
        >
          {selection ? `Play from line ${selection.from}` : "Play from line"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!selection}
          onClick={() => selection && engine.playSelection(focus, selection.from, selection.to, loop)}
          title="Play only the selected lines"
        >
          {selLabel ? `Play ${selLabel}` : "Play selection"}
        </button>
        <label className="check">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          Loop
        </label>
        <button
          type="button"
          className="btn"
          disabled={!selection}
          onClick={() => selection && engine.runToLine(focus, selection.from)}
          title="Keep running from where the program is now, and pause when it reaches this line"
        >
          Run to line
        </button>
        <span className="grow" />
        <span className="clock" aria-live="off">
          {formatTime(snap.time / 1000)} <span className="dim">/ {formatTime(snap.timeline.duration / 1000)}{snap.timeline.truncated ? "+" : ""}</span>
        </span>
      </div>

      {(snap.message || brick.error) && (
        <div className={`sim-msg${brick.error ? " error" : ""}`} role="status">
          {brick.error ? `Line ${brick.error.line}: ${brick.error.message}` : snap.message}
        </div>
      )}

      <div className="sim-body">
        <div className="sim-code">
          <CodeView
            code={brick.code}
            executable={brick.executable}
            breakpoints={brick.breakpoints}
            current={currentLines}
            errorLine={brick.error?.line ?? null}
            diagnostics={brick.diagnostics}
            selection={selection}
            onSelect={setSelection}
            onToggleBreakpoint={(line) => engine.toggleBreakpoint(focus, line)}
            follow={follow}
            editing={editing}
            onApply={(code) => {
              engine.setCode(focus, code);
              setEditing(false);
            }}
            onCancelEdit={() => setEditing(false)}
          />
          {!editing && (
            <div className="code-foot">
              <label className="check">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                Follow the running line
              </label>
              <span className="hint">
                Click a line to select it, shift-click to select several. Click a line number to pause there.
              </span>
              {brick.breakpoints.size > 0 && (
                <button type="button" className="link" onClick={() => engine.clearBreakpoints(focus)}>
                  Clear {brick.breakpoints.size} breakpoint{brick.breakpoints.size === 1 ? "" : "s"}
                </button>
              )}
            </div>
          )}
        </div>

        <aside className="sim-side">
          <NxtBrick lcd={brick.lcd} onButton={(b, down) => engine.pressButton(b, down)} label={`Simulated ${brick.name}`} />
          <dl className="readout">
            <div>
              <dt>Speaker</dt>
              <dd>
                {brick.tone ? (
                  <>
                    <strong>{frequencyToNoteName(brick.tone.freq)}</strong> {brick.tone.freq} Hz
                  </>
                ) : (
                  <span className="dim">silent</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Volume</dt>
              <dd>{brick.volume} of 4</dd>
            </div>
            {brick.motors.some((m) => m !== 0) && (
              <div>
                <dt>Motors</dt>
                <dd>
                  A {brick.motors[0]}, B {brick.motors[1]}, C {brick.motors[2]}
                </dd>
              </div>
            )}
            <div>
              <dt>Status</dt>
              <dd>
                {brick.error
                  ? "stopped by an error"
                  : brick.finished
                    ? "program ended"
                    : currentLines.length
                      ? `line ${currentLines[0].line}${currentLines.length > 1 ? ` (+${currentLines.length - 1} task${currentLines.length > 2 ? "s" : ""})` : ""}`
                      : "not started"}
              </dd>
            </div>
          </dl>

          <div className="settings-row">
            <label>
              Speed
              <select value={snap.speed} onChange={(e) => engine.setSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}x
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sound
              <select value={snap.wave} onChange={(e) => engine.setWave(e.target.value as Waveform)}>
                <option value="square">NXT buzzer</option>
                <option value="triangle">Soft</option>
                <option value="sine">Pure tone</option>
              </select>
            </label>
          </div>
          <label className="check small">
            <input type="checkbox" checked={snap.autoPress} onChange={(e) => engine.setAutoPress(e.target.checked)} />
            Press the orange button when the program starts
          </label>

          {brick.debug && (
            <details className="panel-details" open>
              <summary>Debug stream</summary>
              <pre className="debug">{brick.debug}</pre>
            </details>
          )}
          {variables && (
            <details className="panel-details" open>
              <summary>Variables</summary>
              <div className="vars">
                {variables.tasks
                  .filter((t) => t.state !== "done")
                  .map((t) =>
                    t.frames.map((f, fi) =>
                      f.locals.length ? (
                        <div key={`${t.id}-${fi}`} className="var-group">
                          <div className="var-scope">
                            {f.name}()
                          </div>
                          {f.locals.map((v) => (
                            <div key={v.name} className="var">
                              <span className="var-name">{v.name}</span>
                              <span className="var-val" title={v.type}>
                                {v.value}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null
                    )
                  )}
                {variables.globals.length > 0 && (
                  <div className="var-group">
                    <div className="var-scope">globals</div>
                    {variables.globals.map((v) => (
                      <div key={v.name} className="var">
                        <span className="var-name">{v.name}</span>
                        <span className="var-val" title={v.type}>
                          {v.value}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>
          )}
        </aside>
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="diagnostics" aria-label="Problems">
          {[...errors, ...warnings].slice(0, 30).map((d, k) => (
            <li key={k} className={d.severity}>
              <button type="button" className="link" onClick={() => setSelection({ from: d.line, to: d.line })}>
                Line {d.line}
              </button>{" "}
              {d.message}
            </li>
          ))}
        </ul>
      )}

      <div className="timeline">
        <div className="timeline-head">
          <span>What the NXT{multi ? "s" : ""} will play</span>
          {snap.timeline.truncated && <span className="dim">Showing the first {formatTime(snap.timeline.duration / 1000)} ; the program keeps going.</span>}
          <span className="dim">Click to jump</span>
        </div>
        <PianoRoll
          notes={timelineNotes}
          duration={duration}
          getTime={getTime}
          onSeek={(ms) => engine.seek(ms)}
          height={multi ? 120 : 90}
          label="Timeline of simulated notes; click to jump"
        />
      </div>
    </section>
  );
}
