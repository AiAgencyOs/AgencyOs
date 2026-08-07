import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'AgencyOS',
  description: 'AI-native agency operating system',
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
