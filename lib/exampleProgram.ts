/** Shown in the simulator before a MIDI file is loaded. Users can edit it or paste their own code. */
export const EXAMPLE_PROGRAM = `// Example RobotC program -- edit it, or paste your own NXT code.
// Load a MIDI file above to generate a song instead.

int scale[8] = {523, 587, 659, 698, 784, 880, 988, 1047};

// Plays one note and waits for it to finish.
void note(int freq, int duration)
{
	PlayTone(freq, duration);
	wait10Msec(duration);
}

task main()
{
	int i;
	nVolume = 3;
	eraseDisplay();
	nxtDisplayCenteredTextLine(1, "Scale demo");

	// Up the C major scale
	for (i = 0; i < 8; i++)
	{
		nxtDisplayTextLine(3, "Note %d: %d Hz", i + 1, scale[i]);
		note(scale[i], 20);
	}

	// A little arpeggio, three times
	for (i = 0; i < 3; i++)
	{
		note(523, 12);
		note(659, 12);
		note(784, 12);
		note(1047, 24);
		writeDebugStreamLine("Arpeggio %d done", i + 1);
	}

	nxtDisplayCenteredTextLine(5, "Done!");
	while (bSoundActive)
	{
		wait1Msec(1);
	}
}
`;
