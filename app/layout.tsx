import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'WeatherGPT Hyderabad — Live Flood Intelligence',
  description: 'Real-time weather conditions, rainfall outlook, and flood risk alerts for Hyderabad.',
  generator: 'v0.app',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0D0D0F',
  width: 'device-width',
  initialScale: 1,
  userScalable: false,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="bg-[#0D0D0F]"><body>{children}{process.env.NODE_ENV === 'production' && <Analytics />}</body></html>
}
