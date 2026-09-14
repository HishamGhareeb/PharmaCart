import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'PharmaCart local purchase loop',
  description: 'Local synthetic PharmaCart purchase loop. Development only.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // English first. Arabic and RTL are not implemented here and AC-018 is not claimed.
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
