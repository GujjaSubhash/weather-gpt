'use client'

import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMap, Marker as LeafletMarker, TileLayer } from 'leaflet'
import { Pause, Play } from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import { PUBLIC_ENV } from '@/lib/env.public'

type Props = {
  lat?: number
  lon?: number
  area?: string
  risk?: 'high' | 'moderate' | 'safe'
  /** Live rainfall (mm/hr) for the shown location. Drives the drizzle overlay. */
  rain?: number
  /** Live condition text, e.g. "Partly cloudy". Classified into a weather kind. */
  condition?: string
  /** °C. Only used to tell a cold spell apart from an ordinary clear day. */
  temperature?: number
  refreshKey?: number
}

type Frame = { path: string; time: number; kind: 'past' | 'forecast' }

// ── Weather overlay tuning ──
// One config per intensity band; the bands mirror rainLevelOf() in app/page.tsx
// so the map and the forecast cards agree on what "light/moderate/heavy" means.
// speed is px/frame at ~60fps, len is streak length in px.
//
// A single particle shape serves every kind, so the render loop below can stay
// one function: rain streaks use y/len/speed/alpha, cloud blobs and cold motes
// use x/y/r, and fog bands use y/r. `phase` de-synchronises drift and shimmer.
type Particle = { x: number; y: number; r: number; len: number; speed: number; alpha: number; phase: number }
type RainBand = 'none' | 'light' | 'moderate' | 'heavy'

const CLOUD_COUNT = 5
const FOG_BANDS = 7
const COLD_MOTES = 40
const STORM_PERIOD = 190 // frames between sheet-lightning flashes (~3s at 60fps)

/**
 * What the overlay is drawing. Rain is a MEASUREMENT, so a positive reading wins
 * over the condition text; everything else is classified from that text, with
 * temperature only breaking the tie between a plain clear day and a cold one.
 * Mirrors variantOf() in components/chat/WeatherBot.tsx so the map and the
 * mascot never disagree about what the weather is.
 */
type WeatherKind = 'storm' | 'rain' | 'fog' | 'cloud' | 'cold' | 'clear'

/** Below this (°C) a clear or cloudy sky is drawn as a cold one instead. */
const COLD_C = 18

function weatherKindOf(condition?: string, rain?: number, temperature?: number): WeatherKind {
  const c = condition ?? ''
  const storm = /storm|thunder|lightning|squall/i.test(c)
  if (typeof rain === 'number' && rain > 0) return storm ? 'storm' : 'rain'
  if (storm) return 'storm'
  if (/rain|drizzle|shower|sleet/i.test(c)) return 'rain'
  if (/snow|hail|freez/i.test(c)) return 'cold'
  if (/fog|mist|haze|smoke|dust/i.test(c)) return 'fog'
  if (typeof temperature === 'number' && temperature < COLD_C) return 'cold'
  if (/cloud|overcast/i.test(c)) return 'cloud'
  return 'clear'
}

const RAIN_CFG: Record<Exclude<RainBand, 'none'>, {
  count: number; speed: number; len: number; width: number; maxAlpha: number
}> = {
  light: { count: 45, speed: 2.0, len: 7, width: 1, maxAlpha: 0.5 },
  moderate: { count: 90, speed: 3.2, len: 10, width: 1.2, maxAlpha: 0.6 },
  heavy: { count: 150, speed: 4.6, len: 14, width: 1.5, maxAlpha: 0.72 },
}

function rainBand(v?: number): RainBand {
  if (typeof v !== 'number' || !(v > 0)) return 'none'
  if (v < 3) return 'light'
  if (v < 7) return 'moderate'
  return 'heavy'
}

/** Legend wording + swatch for the kind currently being drawn. */
const KIND_LEGEND: Record<WeatherKind, { label: string; color: string }> = {
  storm: { label: 'Storm', color: '#e3a83b' },
  rain: { label: 'Rain', color: '#9bc1ff' },
  fog: { label: 'Fog / haze', color: '#b8bec9' },
  cloud: { label: 'Cloudy', color: '#9ca3af' },
  cold: { label: 'Cold', color: '#a8c9f5' },
  clear: { label: 'Clear', color: '#e3a83b' },
}

const INITIAL_ZOOM = 11 // city overview — shows all of Hyderabad
const MAX_ZOOM = 18 // street level
const MIN_ZOOM = 5
const RADAR_MAX_NATIVE_ZOOM = 6 // RainViewer radar tiles are not produced above this
const FRAME_MS = 500 // radar animation speed
const RADAR_COLOR = 2 // RainViewer "Universal Blue" scheme — reads well on a dark map

// CARTO dark basemap. The `key` query param removes CARTO's "API key required"
// watermark; without a key the tiles still load (just watermarked), so the map
// degrades gracefully when NEXT_PUBLIC_CARTO_BASEMAP_KEY is unset.
const CARTO_KEY = PUBLIC_ENV.NEXT_PUBLIC_CARTO_BASEMAP_KEY
const CARTO_TILE_URL = `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${
  CARTO_KEY ? `?key=${CARTO_KEY}` : ''
}`

// Single source of truth for the radar legend. Colours are sampled along the
// RainViewer colour scheme 2 ("Universal Blue") ramp so the swatches actually
// match the tiles: pale blue → blue → deep blue/violet → magenta for extreme.
const RADAR_LEGEND: { label: string; color: string }[] = [
  { label: 'Light', color: '#9bd7f2' },
  { label: 'Moderate', color: '#3b82c8' },
  { label: 'Heavy', color: '#3a2f9e' },
  { label: 'Extreme', color: '#d1359b' },
]

// Same colours the .risk-marker-* CSS classes use, so map marker and legend agree.
const RISK_LEGEND: { label: string; color: string }[] = [
  { label: 'High Risk', color: 'var(--red)' },
  { label: 'Moderate', color: 'var(--amber)' },
  { label: 'Safe', color: 'var(--green)' },
]

function makeIcon(L: typeof import('leaflet'), risk?: string) {
  // Class-driven so the marker can animate from globals.css (see .risk-marker).
  const level = risk === 'high' || risk === 'moderate' || risk === 'safe' ? risk : 'safe'
  return L.divIcon({
    className: '',
    html:
      `<div class="risk-marker risk-marker-${level}">` +
      `<span class="risk-marker-pulse"></span>` +
      `<span class="risk-marker-core"></span>` +
      `</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  })
}

export default function WeatherMap({
  lat = 17.385,
  lon = 78.4867,
  area,
  risk,
  rain,
  condition,
  temperature,
}: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const markerRef = useRef<LeafletMarker | null>(null)
  const leafletRef = useRef<typeof import('leaflet') | null>(null)
  const frameLayersRef = useRef<TileLayer[]>([])
  const framesRef = useRef<Frame[]>([])
  const rainCanvasRef = useRef<HTMLCanvasElement>(null)

  const [playing, setPlaying] = useState(true)
  const [frameIdx, setFrameIdx] = useState(0)
  const [frameCount, setFrameCount] = useState(0)
  const [frameLabel, setFrameLabel] = useState('')
  const [radarReady, setRadarReady] = useState(false)
  const [radarError, setRadarError] = useState(false)

  // What the overlay draws, and what the legend names. Derived, not stored, so
  // it always matches the reading currently on screen.
  const kind = weatherKindOf(condition, rain, temperature)
  const kindLegend = KIND_LEGEND[kind]

  // ── Init map, base layer, marker, and radar frames (once) ──
  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !elRef.current || mapRef.current) return
      leafletRef.current = L

      // The map itself is free to zoom to street level; only the radar tiles are
      // limited by their native zoom (see RADAR_MAX_NATIVE_ZOOM below).
      const map = L.map(elRef.current, {
        zoomControl: false,
        scrollWheelZoom: false,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
      }).setView([lat, lon], INITIAL_ZOOM)

      L.control.zoom({ position: 'topright' }).addTo(map)

      // Dark basemap (CARTO dark_all). CARTO_TILE_URL carries the key param when
      // configured, which removes the "API key required" watermark.
      L.tileLayer(CARTO_TILE_URL, {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: MAX_ZOOM,
        minZoom: MIN_ZOOM,
      }).addTo(map)

      const marker = L.marker([lat, lon], { icon: makeIcon(L, risk) }).addTo(map)
      if (area) marker.bindPopup(`<b>${area}</b><br/>Weather advisory: ${(risk || 'safe').toUpperCase()}`)
      markerRef.current = marker
      mapRef.current = map

      // Enable wheel-zoom only while the pointer is over the map.
      elRef.current.addEventListener('click', () => map.scrollWheelZoom.enable())
      elRef.current.addEventListener('mouseleave', () => map.scrollWheelZoom.disable())

      // Fetch RainViewer's live radar index and build animation frames.
      fetch('https://api.rainviewer.com/public/weather-maps.json')
        .then((res) => res.json())
        .then((data) => {
          if (cancelled || !mapRef.current) return
          const host: string = data?.host
          const past = (data?.radar?.past ?? []) as { path: string; time: number }[]
          const nowcast = (data?.radar?.nowcast ?? []) as { path: string; time: number }[]

          const frames: Frame[] = [
            ...past.map((f) => ({ path: f.path, time: f.time, kind: 'past' as const })),
            ...nowcast.map((f) => ({ path: f.path, time: f.time, kind: 'forecast' as const })),
          ]

          // An empty `nowcast` is normal — only a missing host or a completely
          // empty frame list (past + nowcast) means there is no radar imagery.
          if (!host || frames.length === 0) {
            setRadarError(true)
            return
          }

          // Pre-create a tile layer per frame (hidden); we cross-fade between them.
          // `maxNativeZoom: RADAR_MAX_NATIVE_ZOOM` makes Leaflet fetch the z6 tile
          // and upscale it above z6, so the radar animation stays VISIBLE at the
          // default zoom 11 instead of vanishing. Setting `maxZoom:
          // RADAR_MAX_NATIVE_ZOOM` instead would give a hard cutoff where the
          // radar simply disappears above z6.
          frameLayersRef.current = frames.map((f) =>
            L.tileLayer(`${host}${f.path}/256/{z}/{x}/{y}/${RADAR_COLOR}/1_1.png`, {
              opacity: 0,
              maxZoom: MAX_ZOOM,
              maxNativeZoom: RADAR_MAX_NATIVE_ZOOM,
              minZoom: MIN_ZOOM,
              tileSize: 256,
              zIndex: 5,
            }).addTo(map)
          )
          framesRef.current = frames

          // Start on the most recent real (past) frame.
          const startIdx = past.length ? past.length - 1 : 0
          setFrameCount(frames.length)
          setRadarReady(true)
          setFrameIdx(startIdx)
        })
        .catch((err) => {
          console.error('RainViewer radar metadata failed to load:', err)
          if (!cancelled) setRadarError(true)
        })
    })

    return () => {
      cancelled = true
      // Detach the radar frame layers explicitly before dropping the refs.
      const map = mapRef.current
      if (map) {
        frameLayersRef.current.forEach((layer) => {
          if (map.hasLayer(layer)) map.removeLayer(layer)
        })
      }
      frameLayersRef.current = []
      framesRef.current = []
      map?.remove()
      mapRef.current = null
      markerRef.current = null
      leafletRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Advance frames while playing (no-op until frames exist) ──
  useEffect(() => {
    if (!playing || frameCount === 0) return
    const id = setInterval(() => {
      setFrameIdx((prev) => (frameCount === 0 ? 0 : (prev + 1) % frameCount))
    }, FRAME_MS)
    return () => clearInterval(id)
  }, [playing, frameCount])

  // ── Cross-fade to the current frame + update the timestamp label ──
  useEffect(() => {
    const layers = frameLayersRef.current
    const frames = framesRef.current
    // Only fade once the layers actually exist and line up with the frame list.
    if (!layers.length || layers.length !== frames.length) return
    const idx = frameIdx >= 0 && frameIdx < frames.length ? frameIdx : 0
    // Exactly one frame visible at a time.
    layers.forEach((layer, i) => {
      layer.setOpacity(i === idx ? (frames[i].kind === 'forecast' ? 0.5 : 0.7) : 0)
    })
    const f = frames[idx]
    if (f) {
      const time = new Date(f.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      setFrameLabel(`${time}${f.kind === 'forecast' ? ' · forecast' : ''}`)
    }
  }, [frameIdx, frameCount])

  // ── React to location / risk changes ──
  useEffect(() => {
    const map = mapRef.current
    const L = leafletRef.current
    if (!map || !L) return
    // Never zoom the user out, and never slam them to street level either.
    const targetZoom = Math.max(map.getZoom(), INITIAL_ZOOM)
    map.flyTo([lat, lon], targetZoom, { duration: 1.2 })
    if (markerRef.current) map.removeLayer(markerRef.current)
    const marker = L.marker([lat, lon], { icon: makeIcon(L, risk) }).addTo(map)
    if (area) {
      marker.bindPopup(`<b>${area}</b><br/>Weather advisory: ${(risk || 'safe').toUpperCase()}`)
      marker.openPopup()
    }
    markerRef.current = marker
  }, [lat, lon, area, risk])

  // ── Weather overlay ──
  // An atmospheric "this is what it is doing here" cue for the shown location:
  // rain streaks when it rains (plus a lightning flicker in a storm), drifting
  // cloud when overcast, a haze veil in fog, a cool wash when cold, a warm glow
  // when clear. Rain is centre-weighted — densest where the marker sits, fading
  // outward — so a glance says "here", while the RainViewer radar underneath
  // still shows the true spatial extent. Independent of the Leaflet init above:
  // it redraws whenever the kind or the rainfall changes.
  useEffect(() => {
    const canvas = rainCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const clearCanvas = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }

    const band = rainBand(rain)
    const wet = kind === 'rain' || kind === 'storm'
    // A condition text that says rain with no measurement behind it still draws
    // rain — just at the lightest band, since nothing proves it is heavier.
    const cfg = band === 'none' ? RAIN_CFG.light : RAIN_CFG[band]

    // The map overlay now paints ONLY for actual precipitation — rain/storm
    // streaks over the radar. The old ambient variants (cloud, fog, cold and the
    // clear-sky glow) sat on the dark basemap as a big translucent mass that
    // read as a smudge on the map, so a dry sky now leaves the map clean and
    // skips the animation loop entirely.
    if (!wet) {
      clearCanvas()
      return () => clearCanvas()
    }

    // Declared up front so the ResizeObserver below can redistribute the
    // particles across the new size; render() reads this binding, not a copy.
    let parts: Particle[] = []
    let tick = 0 // frame counter — drives drift, pulse and flicker phases

    // Match the backing store to the canvas's CSS-laid-out size. The .map-rain
    // rule stretches the canvas to the map container (position:absolute; inset:0),
    // so clientWidth/Height already follow the container — we only resize the
    // pixel buffer to match (×dpr, capped at 2) and set the draw transform.
    // Deliberately NOT pinning style.width/height: that lets the overlay track
    // the container as Leaflet settles it to full width, instead of freezing at
    // whatever size the first measurement happened to catch. Returns true when a
    // resize actually happened, so the caller can re-scatter.
    const syncSize = (): boolean => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width === w && canvas.height === h) return false
      canvas.width = w
      canvas.height = h
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return true
    }

    const resetDrop = (d: Particle, w: number, h: number, initial: boolean) => {
      d.x = Math.random() * (w + 60) - 30
      d.y = initial ? Math.random() * h : Math.random() * -60
      d.len = cfg.len + Math.random() * cfg.len
      d.speed = cfg.speed + Math.random() * cfg.speed * 0.6
      d.alpha = initial ? 1 : 0
    }

    // Distribute a fresh set of particles across the current canvas size. Run on
    // first paint and whenever the size changes, so a map that grows from its
    // initial to full width fills completely instead of leaving a gap.
    const spawn = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (wet) {
        parts = Array.from({ length: cfg.count }, () => {
          const d: Particle = { x: 0, y: 0, r: 0, len: 0, speed: 0, alpha: 0, phase: 0 }
          resetDrop(d, w, h, true)
          return d
        })
      } else if (kind === 'cloud') {
        parts = Array.from({ length: CLOUD_COUNT }, () => ({
          x: Math.random() * w,
          y: h * (0.1 + Math.random() * 0.65),
          r: Math.min(w, h) * (0.18 + Math.random() * 0.22),
          len: 0,
          speed: 0.12 + Math.random() * 0.24,
          alpha: 0.1 + Math.random() * 0.12,
          phase: Math.random() * Math.PI * 2,
        }))
      } else if (kind === 'fog') {
        parts = Array.from({ length: FOG_BANDS }, (_, i) => ({
          x: Math.random() * w,
          y: (i + 0.5) * (h / FOG_BANDS),
          r: h * 0.1,
          len: 0,
          speed: 0.18 + Math.random() * 0.3,
          alpha: 0.09 + Math.random() * 0.08,
          phase: Math.random() * Math.PI * 2,
        }))
      } else if (kind === 'cold') {
        parts = Array.from({ length: COLD_MOTES }, () => ({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 0.8 + Math.random() * 1.4,
          len: 0,
          speed: 0.2 + Math.random() * 0.45,
          alpha: 0.25 + Math.random() * 0.5,
          phase: Math.random() * Math.PI * 2,
        }))
      } else {
        parts = [] // 'clear' is a gradient only
      }
    }

    const render = (advance: boolean) => {
      // Self-heal the size every frame: if the container grew or shrank, resize
      // the pixel buffer and re-scatter so coverage always fills the whole map.
      // This is what keeps the overlay correct without relying on a resize
      // callback that a hidden/background tab may never deliver.
      if (syncSize()) spawn()
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)
      if (advance) tick++

      if (wet) {
        const cx = w / 2
        const cy = h / 2
        const maxDist = Math.hypot(cx, cy) || 1
        ctx.lineWidth = cfg.width
        ctx.lineCap = 'round'
        for (const d of parts) {
          if (advance) {
            d.y += d.speed
            if (d.alpha < 1) d.alpha = Math.min(1, d.alpha + 0.06)
            if (d.y - d.len > h) resetDrop(d, w, h, false)
          }
          // Centre-weighted alpha: full near the marker, never quite zero at the
          // edges (rain there is real too — just de-emphasised).
          const dist = Math.hypot(d.x - cx, d.y - cy)
          const radial = Math.max(0.12, 1 - dist / maxDist)
          const a = cfg.maxAlpha * radial * d.alpha
          if (a <= 0.02) continue
          ctx.strokeStyle = `rgba(155,193,255,${a.toFixed(3)})`
          ctx.beginPath()
          ctx.moveTo(d.x, d.y)
          ctx.lineTo(d.x - d.len * 0.22, d.y - d.len) // slight wind-driven slant
          ctx.stroke()
        }
        // Storm: an occasional sheet-lightning flash across the whole overlay.
        if (kind === 'storm') {
          const cycle = tick % STORM_PERIOD
          const flash = cycle < 3 ? 0.16 : cycle < 6 ? 0.06 : 0
          if (flash > 0) {
            ctx.fillStyle = `rgba(255,240,190,${flash})`
            ctx.fillRect(0, 0, w, h)
          }
        }
        return
      }

      if (kind === 'clear') {
        // A warm, slowly breathing sun glow in the upper right.
        const pulse = 0.15 + 0.045 * Math.sin(tick / 70)
        const g = ctx.createRadialGradient(w * 0.82, h * 0.16, 0, w * 0.82, h * 0.16, Math.max(w, h) * 0.55)
        g.addColorStop(0, `rgba(255,206,120,${pulse.toFixed(3)})`)
        g.addColorStop(1, 'rgba(255,206,120,0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, w, h)
        return
      }

      if (kind === 'cold') {
        // A cool wash, densest at the top, plus fine motes drifting upward.
        const g = ctx.createLinearGradient(0, 0, 0, h)
        g.addColorStop(0, 'rgba(168,201,245,0.14)')
        g.addColorStop(1, 'rgba(168,201,245,0.03)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, w, h)
        for (const p of parts) {
          if (advance) {
            p.y -= p.speed
            p.x += Math.sin((tick + p.phase * 40) / 55) * 0.35
            if (p.y + p.r < 0) {
              p.y = h + p.r
              p.x = Math.random() * w
            }
          }
          ctx.fillStyle = `rgba(226,238,255,${(p.alpha * 0.5).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
          ctx.fill()
        }
        return
      }

      // 'cloud' and 'fog' are both soft drifting masses — cloud as rounded
      // blobs, fog as wide horizontal bands.
      for (const p of parts) {
        if (advance) {
          p.x += p.speed
          if (p.x - p.r * 2 > w) p.x = -p.r * 2
        }
        if (kind === 'fog') {
          const g = ctx.createLinearGradient(0, p.y - p.r, 0, p.y + p.r)
          g.addColorStop(0, 'rgba(200,208,220,0)')
          g.addColorStop(0.5, `rgba(200,208,220,${p.alpha.toFixed(3)})`)
          g.addColorStop(1, 'rgba(200,208,220,0)')
          ctx.fillStyle = g
          // Bands span the full width; p.x only shifts the soft edges' phase.
          ctx.fillRect(0, p.y - p.r, w, p.r * 2)
        } else {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r)
          g.addColorStop(0, `rgba(190,198,210,${p.alpha.toFixed(3)})`)
          g.addColorStop(1, 'rgba(190,198,210,0)')
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    syncSize()
    spawn()

    // Belt-and-suspenders for the resize the render loop can't self-heal on its
    // own: the reduced-motion path (which has no loop) and an immediate re-fit
    // the moment the container settles on a visible tab. render() self-heals the
    // size, so the callback just asks for a repaint.
    const ro = new ResizeObserver(() => render(!reduce))
    if (canvas.parentElement) ro.observe(canvas.parentElement)

    if (reduce) {
      // One static, faint frame — the weather is shown, nothing moves.
      render(false)
      return () => {
        ro.disconnect()
        clearCanvas()
      }
    }

    // Paint one frame synchronously so the overlay shows immediately, even
    // before the first animation frame fires (and in tabs where rAF is
    // throttled until the page becomes visible).
    render(true)

    let raf = 0
    const loop = () => {
      render(true)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      clearCanvas()
    }
  }, [rain, kind])

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={elRef}
        className="weather-map"
        aria-label="Hyderabad weather map with rainfall radar"
        style={{ height: 450, width: '100%', borderRadius: 12 }}
      />

      {/* Weather overlay — decorative, never intercepts clicks (see .map-rain). */}
      <canvas ref={rainCanvasRef} className="map-rain" aria-hidden="true" />

      {/* Radar playback control + live timestamp, or the radar-unavailable notice */}
      {(radarReady || frameLabel || radarError) && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'rgba(0,0,0,0.8)',
            borderRadius: 8,
            padding: '5px 10px 5px 6px',
            color: '#e5e7eb',
            fontSize: 12,
          }}
        >
          {radarReady && (
            <button
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? 'Pause radar' : 'Play radar'}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: 6,
                border: 'none',
                background: 'rgba(255,255,255,0.12)',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
          )}
          <span
            style={{
              // A radar frame time is a measured value, so it takes the mono face
              // like every other timestamp in the app.
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              letterSpacing: '-0.012em',
              fontVariantNumeric: 'tabular-nums',
              color: radarError ? '#fca5a5' : undefined,
            }}
            {...(radarError ? { role: 'status' as const } : {})}
          >
            {radarError ? 'Radar unavailable' : frameLabel || 'Loading radar…'}
          </span>
        </div>
      )}

      {/* Legend — radar intensity ramp + risk marker key */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          left: 12,
          background: 'rgba(0,0,0,0.8)',
          borderRadius: 8,
          padding: '8px 12px',
          fontSize: 11.5,
          letterSpacing: '-0.004em',
          lineHeight: 1.45,
          color: '#9ca3af',
          zIndex: 1000,
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {/* What the overlay is currently drawing, so the animation is labelled
            rather than left as decoration the user has to guess at. */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#d1d5db', fontWeight: 500 }}>
          <i
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: kindLegend.color,
              display: 'block',
            }}
          />
          {kindLegend.label}
          {condition ? <span style={{ color: '#6b7280', fontWeight: 400 }}>· {condition}</span> : null}
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.12)' }} />

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {RADAR_LEGEND.map((item) => (
            <span key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <i
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: item.color,
                  display: 'block',
                }}
              />
              {item.label}
            </span>
          ))}
        </div>

        <div style={{ color: '#6b7280', fontSize: 11 }}>
          Radar detail limited above zoom 6 — tiles are upscaled
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.12)' }} />

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {RISK_LEGEND.map((item) => (
            <span key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <i
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: item.color,
                  display: 'block',
                }}
              />
              {item.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
