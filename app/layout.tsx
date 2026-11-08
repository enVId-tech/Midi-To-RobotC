import type { Metadata, Viewport } from "next";
import "./globals.css";
import JsonLd from "@/components/JsonLd";
import { FAQS } from "@/lib/faq";
import { AUTHOR, AUTHOR_URL, HOME_TITLE, KEYWORDS, LICENSE_URL, REPO_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL, absoluteUrl } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: HOME_TITLE, template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  keywords: KEYWORDS,
  applicationName: SITE_NAME,
  authors: [{ name: AUTHOR, url: AUTHOR_URL }],
  creator: AUTHOR,
  category: "technology",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: HOME_TITLE,
    description: SITE_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE,
    description: SITE_DESCRIPTION,
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#3b434c",
};

const webApp = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: SITE_NAME,
  alternateName: "MIDI to RobotC converter",
  url: absoluteUrl("/"),
  description: SITE_DESCRIPTION,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any (web browser)",
  browserRequirements: "Requires JavaScript and Web Audio",
  isAccessibleForFree: true,
  inLanguage: "en",
  keywords: KEYWORDS.join(", "),
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  license: LICENSE_URL,
  author: { "@type": "Person", name: AUTHOR, url: AUTHOR_URL },
  sameAs: [REPO_URL],
};

const faqPage = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQS.map((f) => ({
    "@type": "Question",
    name: f.question,
    acceptedAnswer: { "@type": "Answer", text: f.answer },
  })),
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
      <body>
        <noscript>
          <p style={{ padding: 16 }}>
            MIDI to NXT needs JavaScript to read MIDI files and play the RobotC simulator. It converts MIDI files to RobotC code for the
            LEGO Mindstorms NXT, and the file never leaves your browser.
          </p>
        </noscript>
        {children}
        <JsonLd data={webApp} />
        <JsonLd data={faqPage} />
      </body>
    </html>
  );
}
