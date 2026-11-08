import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "../lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MIDI to NXT: MIDI to RobotC converter",
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: "#e4e7ea",
    theme_color: "#3b434c",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
