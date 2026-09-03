# WeatherGPT

A weather and flood-risk app for Hyderabad. It shows live conditions, a short-term
rainfall forecast, and a flood-risk read for wherever you are, plus a chat assistant
you can ask things like "should I carry an umbrella?" in English, Hindi, or Telugu.

Built for Smart India Hackathon 2026 — problem statement SIH26068, Ministry of Earth Sciences.

## What it does

- Current conditions for a searched place or your GPS location
- A 90-minute, minute-by-minute rainfall nowcast
- Flood risk shown as Safe / Moderate / High, worked out from live rainfall
- Official weather alerts (AccuWeather / IMD) when there are any
- A live radar map so you can see rain moving in real time
- A chat assistant that replies in whatever language you type

It doesn't guess things it can't measure. There's no road, traffic, or drainage feed,
so it never claims any — a missing value shows up as "unavailable" instead of a made-up
number. Flood risk is a model estimate from rainfall, not a ground measurement, and the
UI says so.

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4
- Weather: Tomorrow.io (primary + nowcast), OpenWeatherMap (fallback + geocoding),
  AccuWeather (measured rain + official alerts)
- Map: Leaflet, CARTO basemap, RainViewer radar tiles
- Chat: Google Gemini, grounded with you.com web search
- Runs on any Node host or serverless (deploys cleanly to Vercel)

Provider keys are read server-side inside the API routes (`app/api/weather`,
`app/api/chat`) and are never sent to the browser.

## Running it locally

Needs Node 20+ and pnpm.

```bash
pnpm install
cp .env.example .env.local   # then fill in your keys
pnpm dev
```

The app runs at http://localhost:3000.

You don't need every key to start. Tomorrow.io and OpenWeatherMap cover the core
weather, Gemini powers the chat, and AccuWeather and you.com are optional — the app
degrades gracefully when they're missing.

## Environment variables

`.env.example` lists everything with notes. Server-only keys (weather providers,
Gemini, you.com) stay on the server; anything prefixed `NEXT_PUBLIC_` gets inlined
into the client bundle, so don't put a secret behind that prefix.

To confirm no server key leaked into the client bundle:

```bash
pnpm build
pnpm scan:secrets
```

## Demo mode

For a live demo you can force a scenario instead of waiting on the real weather:

    /?demo=heavy_rain
    /?demo=moderate_rain
    /?demo=clear

These are labelled as simulated in the UI.
