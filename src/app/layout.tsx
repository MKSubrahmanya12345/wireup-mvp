import type { Metadata, Viewport } from 'next';

import './globals.css';
import './control-plane.css';

export const metadata: Metadata = {
  title: 'Wireup — human-directed intelligence workspace',
  description:
    'Wireup turns messy goals into editable decision graphs with doubts, evidence, named real-world stakes and human approval gates — plus a grounded hardware engineering pipeline.',
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
