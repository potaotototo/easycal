import type { Metadata } from 'next';
import './globals.css';

const metadataBase = new URL(
  process.env.NEXT_PUBLIC_SITE_ORIGIN ?? 'http://localhost:3000',
);

export const metadata: Metadata = {
  metadataBase,
  title: 'EasyCal · Events worth showing up for',
  description: 'Review and manage the events EasyCal finds in your Telegram folders.',
  openGraph: {
    title: 'EasyCal · Events worth showing up for',
    description: 'Turn useful Telegram posts into a calendar you can review and share.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'EasyCal calendar preview' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'EasyCal · Events worth showing up for',
    description: 'Turn useful Telegram posts into a calendar you can review and share.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
