"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Diagnostic } from "@/lib/robotc/lexer";

export interface Selection {
  from: number;
  to: number;
}

interface Props {
  code: string;
  executable: Set<number>;
  breakpoints: Set<number>;
  /** Lines tasks are on: the first entry is the main task. */
  current: { line: number; name: string; task: number }[];
  errorLine: number | null;
  diagnostics: Diagnostic[];
  selection: Selection | null;
  onSelect: (sel: Selection) => void;
  onToggleBreakpoint: (line: number) => void;
  follow: boolean;
  editing: boolean;
  onApply: (code: string) => void;
  onCancelEdit: () => void;
}

interface RowProps {
  n: number;
  text: string;
  exec: boolean;
  bp: boolean;
  cur: "main" | "other" | null;
  taskName: string | null;
  err: boolean;
  diag: "error" | "warning" | null;
  diagText: string | null;
  selected: boolean;
  onGutter: (n: number) => void;
  onLine: (n: number, extend: boolean) => void;
}

const Row = memo(function Row({ n, text, exec, bp, cur, taskName, err, diag, diagText, selected, onGutter, onLine }: RowProps) {
  const cls = ["code-row", cur ? `is-${cur}` : "", err ? "is-error" : "", selected ? "is-selected" : ""].join(" ");
  return (
    <div className={cls} data-line={n}>
      <button
        type="button"
        className={`gutter${exec ? " exec" : ""}${bp ? " bp" : ""}`}
        onClick={() => onGutter(n)}
        title={exec ? (bp ? `Remove breakpoint on line ${n}` : `Pause on line ${n}`) : `Line ${n}`}
        tabIndex={-1}
      >
        <span className="ln">{n}</span>
        <span className="dot" aria-hidden />
      </button>
      <div
        className="code-text"
        onMouseDown={(e) => {
          if (e.shiftKey) e.preventDefault(); // shift-click extends our selection, not the browser's
        }}
        onClick={(e) => onLine(n, e.shiftKey)}
      >
        {text || " "}
        {taskName && <span className="task-tag">{taskName}</span>}
        {diag && (
          <span className={`diag-tag ${diag}`} title={diagText ?? ""}>
            {diag === "error" ? "error" : "note"}
          </span>
        )}
      </div>
    </div>
  );
});

/**
 * Read-only RobotC listing with line numbers, breakpoints (click the
 * gutter), the line each task is on, and a line selection (click, then
 * shift-click). Switches to a plain textarea for editing.
 */
export default function CodeView(props: Props) {
  const { code, executable, breakpoints, current, errorLine, diagnostics, selection, follow, editing } = props;
  const lines = useMemo(() => code.replace(/\t/g, "    ").split("\n"), [code]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<number | null>(null);
  const [draft, setDraft] = useState(code);

  useEffect(() => {
    if (editing) setDraft(code);
  }, [editing, code]);

  const diagByLine = useMemo(() => {
    const m = new Map<number, { sev: "error" | "warning"; text: string }>();
    for (const d of diagnostics) {
      const prev = m.get(d.line);
      if (!prev || (prev.sev === "warning" && d.severity === "error")) m.set(d.line, { sev: d.severity, text: d.message });
    }
    return m;
  }, [diagnostics]);

  const curByLine = useMemo(() => {
    const m = new Map<number, { kind: "main" | "other"; name: string }>();
    current.forEach((c, i) => {
      if (!m.has(c.line)) m.set(c.line, { kind: i === 0 ? "main" : "other", name: c.name });
    });
    return m;
  }, [current]);

  const mainLine = current[0]?.line ?? null;
  useEffect(() => {
    if (!follow || mainLine === null || editing) return;
    const box = scrollRef.current;
    const row = box?.querySelector<HTMLElement>(`[data-line="${mainLine}"]`);
    if (!box || !row) return;
    const top = row.offsetTop;
    if (top < box.scrollTop + 24 || top > box.scrollTop + box.clientHeight - 48) {
      box.scrollTop = top - box.clientHeight / 3;
    }
  }, [mainLine, follow, editing]);

  const onGutterRef = useRef(props.onToggleBreakpoint);
  onGutterRef.current = props.onToggleBreakpoint;
  const onSelectRef = useRef(props.onSelect);
  onSelectRef.current = props.onSelect;
  const onGutter = useMemo(() => (n: number) => onGutterRef.current(n), []);
  const onLine = useMemo(
    () => (n: number, extend: boolean) => {
      if (extend && anchorRef.current !== null) {
        const a = anchorRef.current;
        onSelectRef.current({ from: Math.min(a, n), to: Math.max(a, n) });
      } else {
        anchorRef.current = n;
        onSelectRef.current({ from: n, to: n });
      }
    },
    []
  );

  if (editing) {
    return (
      <div className="code-edit">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          aria-label="RobotC code"
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: s, selectionEnd: en } = el;
              const next = draft.slice(0, s) + "\t" + draft.slice(en);
              setDraft(next);
              requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1));
            }
          }}
        />
        <div className="code-edit-bar">
          <button type="button" className="btn primary" onClick={() => props.onApply(draft)}>
            Apply changes
          </button>
          <button type="button" className="btn" onClick={props.onCancelEdit}>
            Cancel
          </button>
          <span className="hint">The simulator reloads with your code. Tab inserts a tab.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="code-view" ref={scrollRef}>
      {lines.map((text, i) => {
        const n = i + 1;
        const cur = curByLine.get(n);
        const d = diagByLine.get(n);
        return (
          <Row
            key={n}
            n={n}
            text={text}
            exec={executable.has(n)}
            bp={breakpoints.has(n)}
            cur={cur?.kind ?? null}
            taskName={cur && current.length > 1 ? cur.name : null}
            err={errorLine === n}
            diag={d?.sev ?? null}
            diagText={d?.text ?? null}
            selected={!!selection && n >= selection.from && n <= selection.to}
            onGutter={onGutter}
            onLine={onLine}
          />
        );
      })}
    </div>
  );
}
