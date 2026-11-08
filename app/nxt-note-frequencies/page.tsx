import type { Metadata } from "next";
import Link from "next/link";
import JsonLd from "@/components/JsonLd";
import { midiNoteName, midiNoteToFrequency } from "@/lib/midiToRobotC";
import { SITE_NAME, absoluteUrl } from "@/lib/site";

const TITLE = "NXT PlayTone note frequencies (C2 to C8)";
const DESCRIPTION =
  "Table of note names, MIDI numbers and frequencies in Hz to use with PlayTone in RobotC on the LEGO Mindstorms NXT, from C2 to C8.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/nxt-note-frequencies" },
  openGraph: { type: "article", url: "/nxt-note-frequencies", title: `${TITLE} | ${SITE_NAME}`, description: DESCRIPTION },
};

const FIRST = 36; // C2
const LAST = 108; // C8
const ROWS = Array.from({ length: LAST - FIRST + 1 }, (_, i) => {
  const midi = FIRST + i;
  return { midi, name: midiNoteName(midi), hz: Math.round(midiNoteToFrequency(midi)) };
});

const breadcrumbs = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: absoluteUrl("/") },
    { "@type": "ListItem", position: 2, name: "NXT note frequencies", item: absoluteUrl("/nxt-note-frequencies") },
  ],
};

export default function NoteFrequencies() {
  return (
    <main className="page reference">
      <JsonLd data={breadcrumbs} />
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">{SITE_NAME}</Link> / NXT note frequencies
      </nav>
      <h1>NXT PlayTone note frequencies</h1>
      <p>
        <code>PlayTone(frequency, duration)</code> plays a tone on the LEGO Mindstorms NXT speaker. The frequency is in hertz and the
        duration is in hundredths of a second, so <code>PlayTone(440, 50)</code> plays an A4 for half a second. The frequency has to be
        a whole number, so the values below are rounded.
      </p>
      <p>
        The table uses equal temperament with A4 at 440 Hz. The <Link href="/">MIDI to NXT converter</Link> rounds every note to these
        exact semitones and, by default, keeps notes between 220 and 8000 Hz. You can change that range under More options.
      </p>

      <table>
        <caption>Notes from C2 (MIDI 36) to C8 (MIDI 108)</caption>
        <thead>
          <tr>
            <th scope="col">Note</th>
            <th scope="col">MIDI number</th>
            <th scope="col">Frequency (Hz)</th>
            <th scope="col">RobotC</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.midi}>
              <th scope="row">{r.name}</th>
              <td>{r.midi}</td>
              <td>{r.hz}</td>
              <td>
                <code>PlayTone({r.hz}, 50);</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        <Link href="/">Convert a MIDI file to RobotC</Link>
      </p>
    </main>
  );
}
