import Link from "next/link";
import { FAQS } from "@/lib/faq";
import { REPO_URL } from "@/lib/attribution";

/** Plain-language guide under the tool. Search engines index this text, and it helps first-time visitors too. */
export default function SeoContent() {
  return (
    <section className="guide" aria-labelledby="guide-h">
      <h2 id="guide-h">How to convert a MIDI file to RobotC</h2>
      <ol>
        <li>Drop a MIDI file (.mid or .midi) on the page, or load the built-in sample song.</li>
        <li>Choose the tracks to use and how many NXTs you have. One NXT plays the melody or the bass line, and several NXTs share the parts.</li>
        <li>Press play in the RobotC simulator to hear what each NXT will play, or step through the code line by line.</li>
        <li>Copy the RobotC code or download the .c files, open them in the RobotC IDE and download them to your NXTs.</li>
      </ol>

      <h2>What the converter does</h2>
      <ul>
        <li>Rounds every note to an exact semitone, because the NXT speaker cannot tell apart pitches a few hertz apart.</li>
        <li>Picks out the melody or the bass line, so chords and accompaniment do not cut each other off.</li>
        <li>Splits a piece into melody, harmony and bass parts, up to 64 NXTs, each with its own program.</li>
        <li>Keeps notes on time with the NXT clock, so long songs do not slowly fall behind.</li>
        <li>Can follow the loudness of the MIDI with the four NXT volume levels.</li>
        <li>Lets you convert only some measures, transpose, change the tempo and repeat the song.</li>
      </ul>

      <h2>Questions</h2>
      <div className="faq">
        {FAQS.map((f) => (
          <details key={f.question}>
            <summary>{f.question}</summary>
            <p>{f.answer}</p>
          </details>
        ))}
      </div>

      <p>
        Need the frequency for a note? See the <Link href="/nxt-note-frequencies">NXT note frequency table</Link>. The code is open
        source on <a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>.
      </p>
      <p className="legal">
        MIDI to NXT is an independent project. LEGO, MINDSTORMS and NXT are trademarks of the LEGO Group, and RobotC belongs to its
        makers. None of them sponsor or endorse this site.
      </p>
    </section>
  );
}
