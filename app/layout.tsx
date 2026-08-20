import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'AgencyOS', template: '%s · AgencyOS' },
  description: 'AI-native agency operating system',
  applicationName: 'AgencyOS',
  formatDetection: { telephone: false },
  appleWebApp: { capable: true, title: 'AgencyOS', statusBarStyle: 'default' },
};

/**
 * `viewportFit: 'cover'` is what makes `env(safe-area-inset-*)` report real
 * numbers. Without it the bottom tab bar sits under the iOS home indicator and
 * the last row of it cannot be tapped at all.
 *
 * `themeColor` is matched per scheme so the browser chrome above the page is
 * the same colour as the page, rather than a white band over a dark app.
 *
 * Zoom is deliberately left alone. `maximumScale: 1` is the usual companion to
 * these two settings and it disables pinch-zoom, which is somebody's only way
 * of reading the screen.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f6f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0e14' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
