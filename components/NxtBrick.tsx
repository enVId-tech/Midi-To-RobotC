"use client";

import type { LcdState } from "@/lib/robotc/interpreter";

interface Props {
  lcd: LcdState;
  onButton: (button: number, down: boolean) => void;
  label: string;
}

const BUTTONS = { exit: 0, right: 1, left: 2, enter: 3 } as const;

/**
 * The simulated NXT: its 100x64 screen (8 lines of 16 characters) and its
 * four buttons. Buttons work while the program runs (nNxtButtonPressed).
 */
export default function NxtBrick({ lcd, onButton, label }: Props) {
  const rows: { text: string; big: boolean; hidden: boolean }[] = [];
  for (let i = 0; i < 8; i++) {
    const hidden = i > 0 && lcd.big[i - 1];
    rows.push({ text: lcd.lines[i] ?? "", big: lcd.big[i], hidden });
  }
  const press = (b: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      onButton(b, true);
    },
    onPointerUp: () => onButton(b, false),
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) onButton(b, true);
    },
    onKeyUp: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") onButton(b, false);
    },
  });
  return (
    <div className="brick" aria-label={label}>
      <div className="brick-bezel">
        <div className="lcd" role="img" aria-label={`Screen: ${lcd.lines.filter(Boolean).join(" / ") || "blank"}`}>
          {rows.map((r, i) =>
            r.hidden ? null : (
              <div key={i} className={`lcd-row${r.big ? " big" : ""}`}>
                {r.text.replace(/ /g, " ") || " "}
              </div>
            )
          )}
        </div>
      </div>
      <div className="brick-buttons">
        <button type="button" className="nxt-btn arrow left" aria-label="Left button" {...press(BUTTONS.left)} />
        <button type="button" className="nxt-btn enter" aria-label="Orange (enter) button" {...press(BUTTONS.enter)} />
        <button type="button" className="nxt-btn arrow right" aria-label="Right button" {...press(BUTTONS.right)} />
        <button type="button" className="nxt-btn exit" aria-label="Grey (exit) button" {...press(BUTTONS.exit)} />
      </div>
    </div>
  );
}
