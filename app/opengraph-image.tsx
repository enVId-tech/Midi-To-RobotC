import { ImageResponse } from "next/og";

export const alt = "MIDI to NXT: convert MIDI files to RobotC for LEGO Mindstorms NXT, with a RobotC simulator";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BARS = [
  [0, 3],
  [1, 2],
  [2, 4],
  [3, 3],
  [4, 5],
  [5, 4],
  [6, 2],
  [7, 3],
];

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#e4e7ea",
          padding: 72,
          color: "#1f2328",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 120, fontWeight: 900, letterSpacing: -3 }}>MIDI to NXT</div>
          <div style={{ fontSize: 40, marginTop: 16, color: "#59626c", maxWidth: 900 }}>
            Convert MIDI files to RobotC for the LEGO Mindstorms NXT, then hear the code in a RobotC simulator.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14 }}>
            {BARS.map(([i, h]) => (
              <div key={i} style={{ width: 44, height: h * 26, background: "#e8820c", borderRadius: 8 }} />
            ))}
          </div>
          <div
            style={{
              display: "flex",
              background: "#b3bf9f",
              color: "#232c1d",
              padding: "18px 28px",
              borderRadius: 10,
              fontSize: 34,
              fontFamily: "monospace",
            }}
          >
            PlayTone(659, 51);
          </div>
        </div>
      </div>
    ),
    size
  );
}
