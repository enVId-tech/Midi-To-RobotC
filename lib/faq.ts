/** Shared by the visible FAQ and the FAQPage structured data, so the two always match. */
export interface Faq {
  question: string;
  answer: string;
}

export const FAQS: Faq[] = [
  {
    question: "How do I convert a MIDI file to RobotC for the NXT?",
    answer:
      "Drop a .mid or .midi file onto the page, choose which tracks to use and how many NXTs you have, then copy the RobotC code or download the .c file. Open it in the RobotC IDE and download it to the brick. Each note becomes a PlayTone call with a frequency in Hz and a length in hundredths of a second.",
  },
  {
    question: "Is my MIDI file uploaded to a server?",
    answer:
      "No. The file is read and converted in your browser, and nothing is sent anywhere. The simulator also runs in your browser.",
  },
  {
    question: "Why does my song sound wrong when I play it on an NXT?",
    answer:
      "The NXT speaker plays one note at a time, but most MIDI files have chords, a bass line and a melody at once. The converter picks the melody (or the bass line) so one NXT plays a single clear line, or it splits the music into melody, harmony and bass parts for several NXTs. Notes are also rounded to exact semitones, because the NXT cannot tell apart pitches a few hertz apart.",
  },
  {
    question: "Can I hear the RobotC code before I download it to the NXT?",
    answer:
      "Yes. The built-in RobotC simulator runs the generated code the way an NXT would and plays the sound in your browser. You can play it through, step line by line, set breakpoints, or select a few lines and play just those. It models 16-bit integers, the PlayTone sound queue, waits, tasks, the screen and the buttons. Motors and sensors are only stand-ins.",
  },
  {
    question: "How do I play one song on several NXTs?",
    answer:
      "Choose the number of NXTs. The converter splits the music into a melody, harmony parts and a bass line, and gives each NXT its own program to copy or download. Turn on waiting for the orange button, load all programs, and press the buttons together to start. The simulator plays all the parts together so you can check how they fit.",
  },
  {
    question: "Does the converter use the volume changes in a MIDI file?",
    answer:
      "Optionally. With Follow the MIDI turned on, each note gets an NXT volume from 1 to your chosen top level, based on its velocity, channel volume and expression. The NXT has only four volume levels, so the changes come in steps.",
  },
  {
    question: "Which RobotC commands does the generated code use?",
    answer:
      "PlayTone for each note, nVolume for the speaker volume, nPgmTime and wait1Msec to keep every note on time without drifting, and bSoundActive to let the last note finish. Optional lines show the title on the NXT screen and wait for the orange button.",
  },
  {
    question: "Is MIDI to NXT free and open source?",
    answer: "Yes. It is free to use and the code is open source under the MIT license, so you can read it, change it and run your own copy.",
  },
];
