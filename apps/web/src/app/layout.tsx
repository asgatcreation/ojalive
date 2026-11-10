import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Ojà Live — Nigeria’s live auction house',
    template: '%s · Ojà Live',
  },
  description:
    'Live online auctions in Nigeria: vehicles, phones, electronics, art, watches and ' +
    'corporate asset disposals. Real-time bidding with anti-sniping and proxy bids.',
  applicationName: 'Ojà Live',
  authors: [{ name: 'Akanji Oluwaseun Gabriel', url: 'https://github.com/asgatcreation' }],
  openGraph: {
    title: 'Ojà Live — Nigeria’s live auction house',
    description: 'Real-time bidding on everything valuable, across Nigeria.',
    locale: 'en_NG',
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7fdfa' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1f17' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
