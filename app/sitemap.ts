import type { MetadataRoute } from "next";
import { absoluteUrl } from "../lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: absoluteUrl("/"), changeFrequency: "monthly", priority: 1 },
    { url: absoluteUrl("/nxt-note-frequencies"), changeFrequency: "yearly", priority: 0.6 },
  ];
}
