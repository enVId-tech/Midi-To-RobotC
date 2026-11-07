"use client";

import { useCallback, useEffect, useRef } from "react";

export interface RollNote {
  /** ms */
  start: number;
  /** ms */
  end: number;
  /** MIDI pitch (may be fractional) */
  pitch: number;
  color: string;
  /** 0-1 */
  alpha?: number;
}

interface Props {
  notes: RollNote[];
  /** ms */
  duration: number;
  /** Current playhead in ms, read every animation frame. */
  getTime: () => number;
  onSeek?: (ms: number) => void;
  height?: number;
  /** Optional shaded region, in ms. */
  region?: { start: number; end: number } | null;
  label: string;
}

/**
 * A compact piano-roll overview drawn on a canvas: the whole piece fits the
 * width, pitch goes up, and a playhead follows playback. Click to seek.
 */
export default function PianoRoll({ notes, duration, getTime, onSeek, height = 120, region, label }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });

  const drawBase = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(100, wrap.clientWidth);
    const h = height;
    sizeRef.current = { w, h, dpr };
    const base = baseRef.current ?? document.createElement("canvas");
    baseRef.current = base;
    base.width = w * dpr;
    base.height = h * dpr;
    const g = base.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(wrap);
    g.fillStyle = css.getPropertyValue("--roll-bg").trim() || "#f6f7f8";
    g.fillRect(0, 0, w, h);

    const dur = Math.max(1, duration);
    if (region) {
      g.fillStyle = css.getPropertyValue("--roll-region").trim() || "rgba(232,130,12,0.12)";
      g.fillRect((region.start / dur) * w, 0, ((region.end - region.start) / dur) * w, h);
    }
    if (!notes.length) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of notes) {
      if (n.pitch < lo) lo = n.pitch;
      if (n.pitch > hi) hi = n.pitch;
    }
    lo -= 2;
    hi += 2;
    const rows = Math.max(12, hi - lo);
    const rowH = (h - 8) / rows;
    const noteH = Math.max(1.5, Math.min(6, rowH));
    // Octave guide lines at every C.
    g.strokeStyle = css.getPropertyValue("--roll-grid").trim() || "rgba(0,0,0,0.06)";
    g.lineWidth = 1;
    for (let p = Math.ceil(lo / 12) * 12; p <= hi; p += 12) {
      const y = Math.round(4 + (hi - p) * rowH) + 0.5;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    for (const n of notes) {
      const x = (n.start / dur) * w;
      const nw = Math.max(1, ((n.end - n.start) / dur) * w - 0.5);
      const y = 4 + (hi - n.pitch) * rowH - noteH / 2;
      g.globalAlpha = n.alpha ?? 1;
      g.fillStyle = n.color;
      g.fillRect(x, y, nw, noteH);
    }
    g.globalAlpha = 1;
  }, [notes, duration, height, region]);

  // Redraw the static layer when data or size changes; draw the playhead every frame.
  useEffect(() => {
    drawBase();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => drawBase());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [drawBase]);

  useEffect(() => {
    let raf = 0;
    let lastX = -1;
    let lastW = -1;
    const frame = () => {
      const c = canvasRef.current;
      const base = baseRef.current;
      const { w, h, dpr } = sizeRef.current;
      if (c && base && w > 0) {
        const x = Math.round((Math.min(getTime(), duration) / Math.max(1, duration)) * w);
        if (x !== lastX || w !== lastW || c.width !== w * dpr) {
          lastX = x;
          lastW = w;
          if (c.width !== w * dpr) {
            c.width = w * dpr;
            c.height = h * dpr;
            c.style.width = `${w}px`;
            c.style.height = `${h}px`;
          }
          const g = c.getContext("2d")!;
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.drawImage(base, 0, 0);
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.fillStyle = "#1f2328";
          g.fillRect(x - 1, 0, 2, h);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // Force a redraw when the static layer changes.
    lastX = -1;
    return () => cancelAnimationFrame(raf);
  }, [getTime, duration, drawBase]);

  const seekFromEvent = (clientX: number) => {
    const wrap = wrapRef.current;
    if (!wrap || !onSeek) return;
    const r = wrap.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    onSeek(f * duration);
  };

  return (
    <div
      ref={wrapRef}
      className={`roll${onSeek ? " roll-seekable" : ""}`}
      style={{ height }}
      role={onSeek ? "slider" : "img"}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration / 1000)}
      tabIndex={onSeek ? 0 : -1}
      onPointerDown={(e) => {
        if (!onSeek) return;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        seekFromEvent(e.clientX);
      }}
      onKeyDown={(e) => {
        if (!onSeek) return;
        const t = getTime();
        if (e.key === "ArrowRight") onSeek(Math.min(duration, t + 5000));
        if (e.key === "ArrowLeft") onSeek(Math.max(0, t - 5000));
        if (e.key === "Home") onSeek(0);
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
