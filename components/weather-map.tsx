'use client'

import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMap, Marker as LeafletMarker, TileLayer } from 'leaflet'
import { Pause, Play } from 'lucide-react'
import 'leaflet/dist/leaflet.css'

type Props = {
  lat?: number
  lon?: number
  area?: string
  risk?: 'high' | 'moderate' | 'safe'
  refreshKey?: number
}

type Frame = { path: string; time: number; kind: 'past' | 'forecast' }

const INITIAL_ZOOM = 11 // city overview — shows all of Hyderabad
const MAX_ZOOM = 18 // street level
const MIN_ZOOM = 5
const RADAR_MAX_NATIVE_ZOOM = 6 // RainViewer radar tiles are not produced above this
const FRAME_MS = 500 // radar animation speed
const RADAR_COLOR = 2 // RainViewer "Universal Blue" scheme — reads well on a dark map

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

export default function WeatherMap({ lat = 17.385, lon = 78.4867, area, risk }: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const markerRef = useRef<LeafletMarker | null>(null)
  const leafletRef = useRef<typeof import('leaflet') | null>(null)
  const frameLayersRef = useRef<TileLayer[]>([])
  const framesRef = useRef<Frame[]>([])

  const [playing, setPlaying] = useState(true)
  const [frameIdx, setFrameIdx] = useState(0)
  const [frameCount, setFrameCount] = useState(0)
  const [frameLabel, setFrameLabel] = useState('')
  const [radarReady, setRadarReady] = useState(false)
  const [radarError, setRadarError] = useState(false)

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

      // Dark basemap — free, no API key (CARTO dark_all).
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: MAX_ZOOM,
        minZoom: MIN_ZOOM,
      }).addTo(map)

      const marker = L.marker([lat, lon], { icon: makeIcon(L, risk) }).addTo(map)
      if (area) marker.bindPopup(`<b>${area}</b><br/>Flood Risk: ${(risk || 'safe').toUpperCase()}`)
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
      marker.bindPopup(`<b>${area}</b><br/>Flood Risk: ${(risk || 'safe').toUpperCase()}`)
      marker.openPopup()
    }
    markerRef.current = marker
  }, [lat, lon, area, risk])

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={elRef}
        className="weather-map"
        aria-label="Hyderabad live rainfall radar"
        style={{ height: 450, width: '100%', borderRadius: 12 }}
      />

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
            style={{ fontVariantNumeric: 'tabular-nums', color: radarError ? '#fca5a5' : undefined }}
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
          fontSize: 11,
          color: '#9ca3af',
          zIndex: 1000,
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
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

        <div style={{ color: '#6b7280', fontSize: 10 }}>
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
