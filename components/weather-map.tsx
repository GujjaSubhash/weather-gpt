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

const MAX_ZOOM = 7 // RainViewer radar tiles top out at zoom 7
const MIN_ZOOM = 5
const FRAME_MS = 500 // radar animation speed
const RADAR_COLOR = 2 // RainViewer "Universal Blue" scheme — reads well on a dark map

const riskColors: Record<string, string> = {
  high: '#ef4444',
  moderate: '#f59e0b',
  safe: '#22c55e',
}

function makeIcon(L: typeof import('leaflet'), risk?: string) {
  const color = riskColors[risk || 'safe']
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 12px ${color}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
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

  // ── Init map, base layer, marker, and radar frames (once) ──
  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !elRef.current || mapRef.current) return
      leafletRef.current = L

      const map = L.map(elRef.current, {
        zoomControl: false,
        scrollWheelZoom: false,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
      }).setView([lat, lon], MAX_ZOOM)

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

          if (!host || frames.length === 0) {
            addPrecipFallback(L, map)
            return
          }

          // Pre-create a tile layer per frame (hidden); we cross-fade between them.
          frameLayersRef.current = frames.map((f) =>
            L.tileLayer(`${host}${f.path}/256/{z}/{x}/{y}/${RADAR_COLOR}/1_1.png`, {
              opacity: 0,
              maxZoom: MAX_ZOOM,
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
        .catch(() => {
          if (!cancelled && mapRef.current) addPrecipFallback(L, mapRef.current)
        })
    })

    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
      markerRef.current = null
      leafletRef.current = null
      frameLayersRef.current = []
      framesRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // OWM precipitation layer — used only if RainViewer is unavailable.
  function addPrecipFallback(L: typeof import('leaflet'), map: LeafletMap) {
    const key = process.env.NEXT_PUBLIC_OPENWEATHER_API_KEY
    if (!key) return
    L.tileLayer(`https://tile.openweathermap.org/map/precipitation_new/{z}/{x}/{y}.png?appid=${key}`, {
      opacity: 0.6,
      maxZoom: MAX_ZOOM,
      minZoom: MIN_ZOOM,
      zIndex: 5,
    }).addTo(map)
    setFrameLabel('Live precipitation (OpenWeatherMap)')
  }

  // ── Advance frames while playing ──
  useEffect(() => {
    if (!playing || frameCount === 0) return
    const id = setInterval(() => {
      setFrameIdx((prev) => (prev + 1) % frameCount)
    }, FRAME_MS)
    return () => clearInterval(id)
  }, [playing, frameCount])

  // ── Cross-fade to the current frame + update the timestamp label ──
  useEffect(() => {
    const layers = frameLayersRef.current
    const frames = framesRef.current
    if (!layers.length || !frames.length) return
    layers.forEach((layer, i) => {
      layer.setOpacity(i === frameIdx ? (frames[i].kind === 'forecast' ? 0.5 : 0.7) : 0)
    })
    const f = frames[frameIdx]
    if (f) {
      const time = new Date(f.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      setFrameLabel(`${time}${f.kind === 'forecast' ? ' · forecast' : ''}`)
    }
  }, [frameIdx])

  // ── React to location / risk changes ──
  useEffect(() => {
    const map = mapRef.current
    const L = leafletRef.current
    if (!map || !L) return
    map.flyTo([lat, lon], MAX_ZOOM, { duration: 1.2 })
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

      {/* Radar playback control + live timestamp */}
      {(radarReady || frameLabel) && (
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
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{frameLabel || 'Loading radar…'}</span>
        </div>
      )}

      {/* Legend */}
      <div style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        background: 'rgba(0,0,0,0.8)',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 11,
        color: '#9ca3af',
        zIndex: 1000,
        pointerEvents: 'none',
        display: 'flex',
        gap: 12,
        alignItems: 'center',
      }}>
        <span style={{ color: '#7dd3fc' }}>● Light</span>
        <span style={{ color: '#3b82f6' }}>● Moderate</span>
        <span style={{ color: '#a855f7' }}>● Heavy</span>
        <span style={{ marginLeft: 8, color: '#6b7280' }}>Radar · zoom max 7</span>
      </div>
    </div>
  )
}
