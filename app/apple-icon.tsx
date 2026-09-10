import { ImageResponse } from 'next/og'

/**
 * The iOS home-screen icon. Safari will not take an SVG for apple-touch-icon,
 * so this renders the same mark to PNG at build time via `next/og` (part of
 * Next itself — no extra dependency, and nothing to keep in sync by hand
 * beyond the path below, which is copied from app/icon.svg).
 *
 * Satori's inline-SVG support is partial, so the mark goes in as an <img> with
 * a data URI rather than as JSX elements. Two things it is fussy about: the
 * dimensions must be numbers (a string is parsed as CSS and rejected), and the
 * payload is base64 rather than percent-encoded UTF-8 — the raster step reads
 * the buffer directly and fails on the escaped form.
 */
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="118" height="118" fill="#F0C987"><path fill-rule="evenodd" clip-rule="evenodd" d="M2 22V7.4C2 4.6 5.6 4.6 5.6 7.4V10.4H18.4V7.4C18.4 4.6 22 4.6 22 7.4V22H2Z M8.6 22V17C8.6 14.4 10.2 12.9 12 12.6C13.8 12.9 15.4 14.4 15.4 17V22H8.6Z M12 14.4C12 14.4 9.9 17.3 9.9 18.8A2.1 2.1 0 1 0 14.1 18.8C14.1 17.3 12 14.4 12 14.4Z"/></svg>`

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0D0D0F',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          width={118}
          height={118}
          alt=""
          src={`data:image/svg+xml;base64,${Buffer.from(MARK).toString('base64')}`}
        />
      </div>
    ),
    size
  )
}
