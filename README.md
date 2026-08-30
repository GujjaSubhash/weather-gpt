# WeatherGPT Hyderabad

Real-time flood alerts and weather intelligence for Hyderabad citizens.

SIH 2026 — Problem Statement SIH26068 — Ministry of Earth Sciences

## What it does

- Location-based flood risk assessment
- 90-minute rainfall forecast
- Road safety alerts
- Multilingual chat assistant
- Live radar map
- Citizen flood reports

Available in English, Hindi and Telugu.

## Tech stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Weather (primary) | Tomorrow.io — current conditions and minute-level nowcast |
| Weather (fallback) | OpenWeatherMap — weather fallback and geocoding |
| Chat | Google Gemini |
| Search grounding | you.com |
| Citizen reports | Firebase Firestore |
| Map | Leaflet |
| Radar tiles | RainViewer |
| Basemap tiles | CARTO |

## How to run

Clone the repository, copy `.env.example` to `.env.local` and fill in the keys, then:

```bash
pnpm install
pnpm run dev
```

Open http://localhost:3000.

```bash
pnpm run build         # production build
pnpm run scan:secrets  # verify no server credential reached the client bundle
```

## Environment variables

Every variable below is defined in `.env.example`.

| Variable | Scope | Purpose |
| --- | --- | --- |
| `OPENWEATHER_API_KEY` | server-only | OpenWeatherMap weather fallback and forward/reverse geocoding |
| `TOMORROW_API_KEY` | server-only | Tomorrow.io primary current conditions and minute-level rainfall nowcast |
| `GEMINI_API_KEY` | server-only | Google Gemini model powering the chat assistant |
| `YOU_API_KEY` | server-only | you.com search, used to ground chat answers in live web results |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | public | Firebase web app config |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | public | Firebase auth domain |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | public | Firebase project id |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | public | Firebase storage bucket |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | public | Firebase messaging sender id |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | public | Firebase web app id |

`NEXT_PUBLIC_*` variables are inlined into the browser bundle by Next.js and must never hold a secret; server-only variables are read exclusively in server routes and never reach the client.

## Data sources and limitations

- Weather, rainfall intensity and the 90-minute outlook come from live provider APIs.
- Radar imagery is RainViewer. Radar tiles are not produced above zoom level 6, so radar detail is upscaled when zoomed in further.
- Road, traffic and drainage conditions are not available. The app has no data source for them and does not infer them.
- Flood risk is a model-derived estimate from rainfall data, not an observed measurement.
- Citizen reports require Cloud Firestore to be enabled on the Firebase project.
