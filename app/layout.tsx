import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

/*
 * Geist is the product face; Geist Mono carries measured values only.
 *
 * Loaded through next/font, which self-hosts the files at build time — so there
 * is no new dependency, no runtime request to Google, and no layout shift while
 * a webfont swaps in. Both are variable fonts, so the whole 400–600 weight range
 * costs one file per family.
 *
 * Exposed as CSS variables rather than applied via className, because the type
 * system lives in globals.css and needs to name the families in a fallback stack.
 */
const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
  display: 'swap',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'WeatherGPT Hyderabad — Live Flood Intelligence',
  description: 'Real-time weather conditions, rainfall outlook, and flood risk alerts for Hyderabad.',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0D0D0F',
  width: 'device-width',
  initialScale: 1,
  userScalable: false,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`bg-[#0D0D0F] ${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}{process.env.NODE_ENV === 'production' && <Analytics />}</body>
    </html>
  )
}
