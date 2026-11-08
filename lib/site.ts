import { AUTHOR, AUTHOR_URL, LICENSE_URL, REPO_URL } from "./attribution";

/**
 * The public address of the site, with no trailing slash. Set NEXT_PUBLIC_SITE_URL when you build
 * (for example https://example.com) so canonical links, the sitemap and social previews point at
 * the real site instead of localhost.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/+$/, "");

export const SITE_NAME = "MIDI to NXT";
export const HOME_TITLE = "MIDI to RobotC Converter for LEGO NXT, with Simulator";
export const SITE_DESCRIPTION =
  "Free MIDI to RobotC converter for LEGO Mindstorms NXT. Extract the melody, split parts across NXTs, and hear the code in a RobotC simulator.";
export const KEYWORDS = [
  "MIDI to RobotC",
  "RobotC MIDI converter",
  "LEGO NXT music",
  "NXT PlayTone",
  "Mindstorms NXT MIDI",
  "RobotC simulator",
  "play MIDI on NXT",
  "MIDI to NXT",
];

export const absoluteUrl = (path = "/") => `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;

export { AUTHOR, AUTHOR_URL, LICENSE_URL, REPO_URL };
