import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Wireup — prompt to wired hardware project',
  description:
    'Wireup is an agentic hardware engineering platform: describe a project, and an agent selects real catalog components, plans power, pins and wiring, generates firmware, diagram.json, libraries and build instructions, then validates and targeted-fixes the result.',
  applicationName: 'Wireup',
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
