import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ReelCast | AI-Powered YouTube Publishing",
  description:
    "Upload raw footage, let AI enhance and generate metadata, then publish directly to YouTube on your schedule.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icons/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-48x48.png", sizes: "48x48", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
    other: [
      { rel: "mask-icon", url: "/icons/icon.svg", color: "#ff0335" },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ReelCast",
  },
  applicationName: "ReelCast",
  other: {
    "msapplication-TileColor": "#ff0335",
    "msapplication-TileImage": "/icons/icon-144x144.png",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0f0f" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

import AnalyticsProvider from "@/components/analytics-provider";
import { Providers } from "@/components/providers";

// Production registers public/sw.js (static install assets only). In development the worker is not registered, and any
// worker or reelcast-* cache left over from an earlier run is removed: a stale worker serves old HTML that never hydrates.
const SERVICE_WORKER_SCRIPT =
  process.env.NODE_ENV === "production"
    ? `
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function() {
          navigator.serviceWorker.register('/sw.js').then(
            function(registration) {
              console.log('ServiceWorker registration successful');
            },
            function(err) {
              console.log('ServiceWorker registration failed: ', err);
            }
          );
        });
      }
    `
    : `
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
          registrations.forEach(function(registration) { registration.unregister(); });
        });
        if (window.caches) {
          caches.keys().then(function(keys) {
            keys.forEach(function(key) { if (key.indexOf('reelcast-') === 0) caches.delete(key); });
          });
        }
      }
    `;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="icon" type="image/png" href="/icons/favicon-32x32.png" />
        <link rel="shortcut icon" href="/icons/favicon.ico" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <Providers>
          <AnalyticsProvider>{children}</AnalyticsProvider>
        </Providers>
        <script dangerouslySetInnerHTML={{ __html: SERVICE_WORKER_SCRIPT }} />
      </body>
    </html>
  );
}
