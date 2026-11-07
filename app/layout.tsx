import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MIDI to NXT",
  description: "Convert MIDI files to RobotC for the LEGO Mindstorms NXT and hear them in a RobotC simulator.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Chivo:wght@400;500;700;900&family=JetBrains+Mono:wght@400;600&family=VT323&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
