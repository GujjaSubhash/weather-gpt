'use client'

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight, Bot, Check, ChevronRight, Cloud, CloudDrizzle,
  CloudLightning, CloudRain, Compass, Droplets, Eye, Gauge,
  LocateFixed, MapPin, MoveHorizontal, RefreshCw, Search, Send,
  ShieldCheck, Sun, TrendingDown, TrendingUp, Wind, X,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { db } from '@/lib/firebase'
import {
  collection, addDoc, query, orderBy, limit,
  onSnapshot, serverTimestamp, Timestamp,
} from 'firebase/firestore'

const WeatherMap = dynamic(() => import('@/components/weather-map'), { ssr: false })

type Weather = {
  area: string; temperature: number; feelsLike: number; condition: string
  rain: number; wind: number; humidity: number
  visibility?: number; pressure?: number; cloud?: number; rainChance?: number
  risk: 'high' | 'moderate' | 'safe'
  roadStatus: string; recommendedAction: string; estimatedWait: string; safeRoute: string
  updatedAt: string
  forecast: { label: string; value: number }[]
  lat: number; lon: number
}
type Language = 'EN' | 'हि' | 'తె'
type ChatMsg = { role: 'user' | 'bot'; text: string }
type Report = { id: string; area: string; description: string; timestamp: Date; lat?: number; lon?: number }

const langParam: Record<Language, string> = { EN: 'EN', 'हि': 'hi', 'తె': 'te' }

const copy = {
  EN: {
    allow: 'Allow location', manual: 'Search manually',
    sub: 'Real-time flood intelligence for Hyderabad',
    search: 'Search any area — Meerpet, Kukatpally, Banjara Hills...',
    next: 'Next 90 minutes', reports: 'Live reports near you',
    report: 'Report flooding', ask: 'Ask WeatherGPT', source: 'Tomorrow.io + OpenWeatherMap',
    safe: 'SAFE', moderate: 'MODERATE', high: 'HIGH RISK',
    road: 'Road status', action: 'Recommended action', wait: 'Estimated wait time',
    route: 'Safe route available',
    questions: ['Is it safe to go out?', 'Which roads to avoid?', 'How long to wait?', 'Will it flood near me?'],
    reportArea: 'Area name', reportDesc: 'What are you seeing?', reportSubmit: 'Submit report',
    reportCancel: 'Cancel', noReports: 'No reports yet', beFirst: 'Be the first to report flooding in your area.',
    sending: 'Thinking...', chatPlaceholder: 'Ask about your area...',
    none: 'No rain', lightRain: 'Light', mediumRain: 'Moderate', heavyRain: 'Heavy',
    rainUp: 'Rain increasing', rainDown: 'Rain easing', rainSteady: 'Rain steady',
    currentConditions: 'Current conditions', floodRisk: 'Flood risk',
    liveMap: 'Live Rainfall Map', liveMapSub: 'Real-time precipitation over Hyderabad',
    liveMapNav: 'Live map', reportsNav: 'Reports', askNav: 'Ask WeatherGPT',
    heroTitle: 'Real-Time Flood Alerts for Hyderabad',
    heroSub: 'Know before you go with live rainfall data, flood risk, and safer routes.',
    feelsLike: 'Feels like', updated: 'Updated',
    rainfall: 'Rainfall', wind: 'Wind', humidity: 'Humidity',
    visibility: 'Visibility', pressure: 'Pressure', cloudCover: 'Cloud cover',
    rainChance: 'Rain chance', forecast90: '90 minute forecast',
    citizenSignals: 'CITIZEN SIGNALS',
    communityObs: 'Community-submitted flood observations from across Hyderabad.',
    aiAssistant: 'AI WEATHER ASSISTANT',
    aiSub: 'Get instant answers about flood risk and safe routes.',
    footerBuilt: 'Built for SIH 2026',
    locationWait: 'Getting your location...',
    locationSub: 'Finding your area and loading live weather conditions.',
    locationTimedOut: 'Location took too long. Search your area manually to continue.',
    locationPrivacy: 'Your location stays on your device',
    rainChanceSub: 'Rain chance in next 90 min',
    areaResults: 'AREA RESULTS',
  },
  'हि': {
    allow: 'स्थान अनुमति दें', manual: 'मैन्युअल खोज',
    sub: 'हैदराबाद के लिए रियल-टाइम बाढ़ जानकारी',
    search: 'क्षेत्र खोजें — मीरपेट, कुकटपल्ली, बंजारा हिल्स...',
    next: 'अगले 90 मिनट', reports: 'आपके पास की लाइव रिपोर्ट',
    report: 'बाढ़ की रिपोर्ट करें', ask: 'WeatherGPT से पूछें', source: 'Tomorrow.io + OpenWeatherMap',
    safe: 'सुरक्षित', moderate: 'मध्यम', high: 'उच्च जोखिम',
    road: 'सड़क स्थिति', action: 'अनुशंसित कार्रवाई', wait: 'अनुमानित प्रतीक्षा',
    route: 'सुरक्षित मार्ग उपलब्ध',
    questions: ['क्या बाहर जाना सुरक्षित है?', 'किन सड़कों से बचें?', 'कितनी देर प्रतीक्षा करें?', 'क्या मेरे पास बाढ़ आएगी?'],
    reportArea: 'क्षेत्र का नाम', reportDesc: 'आप क्या देख रहे हैं?', reportSubmit: 'रिपोर्ट भेजें',
    reportCancel: 'रद्द करें', noReports: 'अभी कोई रिपोर्ट नहीं', beFirst: 'अपने क्षेत्र में बाढ़ की रिपोर्ट करने वाले पहले बनें।',
    sending: 'सोच रहा हूँ...', chatPlaceholder: 'अपने क्षेत्र के बारे में पूछें...',
    none: 'बारिश नहीं', lightRain: 'हल्की', mediumRain: 'मध्यम', heavyRain: 'भारी',
    rainUp: 'बारिश बढ़ रही है', rainDown: 'बारिश कम हो रही है', rainSteady: 'बारिश स्थिर है',
    currentConditions: 'वर्तमान स्थिति', floodRisk: 'बाढ़ जोखिम',
    liveMap: 'लाइव वर्षा मानचित्र', liveMapSub: 'हैदराबाद पर रियल-टाइम वर्षा',
    liveMapNav: 'लाइव मानचित्र', reportsNav: 'रिपोर्ट', askNav: 'WeatherGPT से पूछें',
    heroTitle: 'हैदराबाद के लिए रियल-टाइम बाढ़ अलर्ट',
    heroSub: 'लाइव वर्षा डेटा, बाढ़ जोखिम और सुरक्षित मार्गों के साथ जाने से पहले जानें।',
    feelsLike: 'महसूस होता है', updated: 'अपडेट',
    rainfall: 'वर्षा', wind: 'हवा', humidity: 'आर्द्रता',
    visibility: 'दृश्यता', pressure: 'दबाव', cloudCover: 'बादल',
    rainChance: 'बारिश की संभावना', forecast90: '90 मिनट का पूर्वानुमान',
    citizenSignals: 'नागरिक संकेत',
    communityObs: 'हैदराबाद से समुदाय द्वारा प्रस्तुत बाढ़ अवलोकन।',
    aiAssistant: 'AI मौसम सहायक',
    aiSub: 'बाढ़ जोखिम और सुरक्षित मार्गों के बारे में तुरंत उत्तर पाएं।',
    footerBuilt: 'SIH 2026 के लिए बनाया गया',
    locationWait: 'आपकी लोकेशन मिल रही है...',
    locationSub: 'आपके क्षेत्र को खोजा जा रहा है।',
    locationTimedOut: 'लोकेशन में समय लगा। मैन्युअल खोज करें।',
    locationPrivacy: 'आपकी लोकेशन आपके डिवाइस पर रहती है',
    rainChanceSub: 'अगले 90 मिनट में बारिश की संभावना',
    areaResults: 'क्षेत्र परिणाम',
  },
  'తె': {
    allow: 'స్థానాన్ని అనుమతించండి', manual: 'మాన్యువల్‌గా వెతకండి',
    sub: 'హైదరాబాద్ కోసం నిజ-సమయ వరద సమాచారం',
    search: 'ప్రాంతాన్ని వెతకండి — మీర్‌పేట, కుకట్‌పల్లి, బంజారా హిల్స్...',
    next: 'తదుపరి 90 నిమిషాలు', reports: 'మీ సమీపంలోని నివేదికలు',
    report: 'వరదను నివేదించండి', ask: 'WeatherGPTని అడగండి', source: 'Tomorrow.io + OpenWeatherMap',
    safe: 'సురక్షితం', moderate: 'మధ్యస్థం', high: 'అధిక ప్రమాదం',
    road: 'రోడ్డు పరిస్థితి', action: 'సిఫార్సు చేసిన చర్య', wait: 'అంచనా వేచి సమయం',
    route: 'సురక్షిత మార్గం అందుబాటులో ఉంది',
    questions: ['బయటకు వెళ్లడం సురక్షితమేనా?', 'ఏ రోడ్లను తప్పించాలి?', 'ఎంతసేపు వేచి ఉండాలి?', 'నా దగ్గర వరద వస్తుందా?'],
    reportArea: 'ప్రాంతం పేరు', reportDesc: 'మీరు ఏమి చూస్తున్నారు?', reportSubmit: 'నివేదిక పంపండి',
    reportCancel: 'రద్దు', noReports: 'ఇంకా నివేదికలు లేవు', beFirst: 'మీ ప్రాంతంలో వరదను నివేదించే మొదటి వ్యక్తి అవ్వండి.',
    sending: 'ఆలోచిస్తోంది...', chatPlaceholder: 'మీ ప్రాంతం గురించి అడగండి...',
    none: 'వర్షం లేదు', lightRain: 'తేలికపాటి', mediumRain: 'మధ్యస్థం', heavyRain: 'భారీ',
    rainUp: 'వర్షం పెరుగుతోంది', rainDown: 'వర్షం తగ్గుతోంది', rainSteady: 'వర్షం స్థిరంగా ఉంది',
    currentConditions: 'ప్రస్తుత పరిస్థితులు', floodRisk: 'వరద ప్రమాదం',
    liveMap: 'లైవ్ వర్షపాత మ్యాప్', liveMapSub: 'హైదరాబాద్‌పై నిజ-సమయ వర్షపాతం',
    liveMapNav: 'లైవ్ మ్యాప్', reportsNav: 'నివేదికలు', askNav: 'WeatherGPTని అడగండి',
    heroTitle: 'హైదరాబాద్ కోసం నిజ-సమయ వరద హెచ్చరికలు',
    heroSub: 'లైవ్ వర్షపాత డేటా, వరద ప్రమాదం మరియు సురక్షిత మార్గాలతో వెళ్ళే ముందు తెలుసుకోండి.',
    feelsLike: 'అనిపిస్తోంది', updated: 'నవీకరించబడింది',
    rainfall: 'వర్షపాతం', wind: 'గాలి', humidity: 'తేమ',
    visibility: 'దృశ్యమానత', pressure: 'పీడనం', cloudCover: 'మేఘావరణం',
    rainChance: 'వర్షం అవకాశం', forecast90: '90 నిమిషాల అంచనా',
    citizenSignals: 'పౌర సంకేతాలు',
    communityObs: 'హైదరాబాద్ అంతటా సమాజం అందించిన వరద పరిశీలనలు.',
    aiAssistant: 'AI వాతావరణ సహాయకుడు',
    aiSub: 'వరద ప్రమాదం మరియు సురక్షిత మార్గాల గురించి తక్షణ సమాధానాలు పొందండి.',
    footerBuilt: 'SIH 2026 కోసం నిర్మించబడింది',
    locationWait: 'మీ స్థానం వెతుకుతోంది...',
    locationSub: 'మీ ప్రాంతాన్ని కనుగొంటోంది.',
    locationTimedOut: 'స్థానం ఆలస్యమైంది. మాన్యువల్‌గా వెతకండి.',
    locationPrivacy: 'మీ స్థానం మీ పరికరంలోనే ఉంటుంది',
    rainChanceSub: 'తదుపరి 90 నిమిషాల్లో వర్షం అవకాశం',
    areaResults: 'ప్రాంత ఫలితాలు',
  },
}

function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`skeleton ${className}`} aria-hidden="true" />
}
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>
}
function Label({ children }: { children: React.ReactNode }) {
  return <span className="kicker">{children}</span>
}

function timeAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`
  return `${Math.floor(s / 86400)}d ago`
}

type RainLevel = 'none' | 'light' | 'moderate' | 'heavy'

function rainLevelOf(value: number): RainLevel {
  if (value <= 0) return 'none'
  if (value < 3) return 'light'
  if (value < 7) return 'moderate'
  return 'heavy'
}

function rainIcon(of: RainLevel) {
  switch (of) {
    case 'none': return Sun
    case 'light': return CloudDrizzle
    case 'moderate': return CloudRain
    case 'heavy': return CloudLightning
  }
}

function rainDropsOf(of: RainLevel): number {
  switch (of) {
    case 'none': return 0
    case 'light': return 1
    case 'moderate': return 2
    case 'heavy': return 3
  }
}

function rainLabelOf(of: RainLevel, t: typeof copy.EN) {
  switch (of) {
    case 'none': return t.none
    case 'light': return t.lightRain
    case 'moderate': return t.mediumRain
    case 'heavy': return t.heavyRain
  }
}

function forecastTrend(forecast: { value: number }[]): 'up' | 'down' | 'flat' {
  if (forecast.length < 2) return 'flat'
  const diff = forecast[forecast.length - 1].value - forecast[0].value
  if (diff > 0.5) return 'up'
  if (diff < -0.5) return 'down'
  return 'flat'
}

export default function Page() {
  const [started, setStarted] = useState(false)
  const [language, setLanguage] = useState<Language>('EN')
  const [queryText, setQueryText] = useState('')
  const [weather, setWeather] = useState<Weather | null>(null)
  const [loading, setLoading] = useState(false)
  const [locating, setLocating] = useState(false)
  const [locationTimedOut, setLocationTimedOut] = useState(false)
  const [error, setError] = useState('')
  const [mapRefreshKey, setMapRefreshKey] = useState(0)
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([
    { role: 'bot', text: 'I can help you understand current rainfall, flood risk, and safer travel options.' },
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const [reports, setReports] = useState<Report[]>([])
  const [showReportForm, setShowReportForm] = useState(false)
  const [reportArea, setReportArea] = useState('')
  const [reportDesc, setReportDesc] = useState('')
  const [reportSubmitting, setReportSubmitting] = useState(false)

  const t = copy[language]
  const risk = weather?.risk || 'safe'

  const loadWeather = useCallback(async (q = '', coordinates?: { lat: number; lon: number }) => {
    setLoading(true)
    setError('')
    try {
      const params = coordinates
        ? `lat=${coordinates.lat}&lon=${coordinates.lon}`
        : `q=${encodeURIComponent(q || 'Hyderabad, IN')}`
      const res = await fetch(`/api/weather?${params}&lang=${langParam[language]}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Weather data unavailable')
      setWeather(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load weather.')
    } finally {
      setLoading(false)
    }
  }, [language])

  const begin = useCallback((manual = false) => {
    setLocationTimedOut(false)
    setStarted(true)
    if (manual || !navigator.geolocation) {
      loadWeather('Hyderabad, IN')
      return
    }
    setLocating(true)
    let settled = false
    const fallback = window.setTimeout(() => {
      if (settled) return
      settled = true
      setLocating(false)
      setStarted(false)
      setLocationTimedOut(true)
    }, 5000)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        setLocating(false)
        loadWeather('', { lat: p.coords.latitude, lon: p.coords.longitude })
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        setLocating(false)
        loadWeather('Hyderabad, IN')
      },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 300000 },
    )
  }, [loadWeather])

  useEffect(() => {
    if (started && !weather && !loading && !locating) loadWeather('Hyderabad, IN')
  }, [started, weather, loading, locating, loadWeather])

  useEffect(() => {
    if (!started || !weather) return
    const interval = setInterval(() => {
      const coords = weather ? { lat: weather.lat, lon: weather.lon } : undefined
      if (coords) loadWeather('', coords)
      setMapRefreshKey(Date.now())
    }, 600_000)
    return () => clearInterval(interval)
  }, [started, weather, loadWeather])

  const handleSearch = (e: FormEvent) => {
    e.preventDefault()
    if (queryText.trim()) loadWeather(queryText.trim())
  }

  const sendChat = async (msg: string) => {
    if (!msg.trim()) return
    const userMsg = msg.trim()
    setChatInput('')
    setChatMessages((prev) => [...prev, { role: 'user', text: userMsg }])
    setChatLoading(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg,
          weather: weather
            ? { area: weather.area, rainfall: weather.rain, risk: weather.risk, forecast: weather.forecast }
            : { area: 'Hyderabad', rainfall: 0, risk: 'safe', forecast: [] },
          language: langParam[language],
        }),
      })
      const data = await res.json()
      setChatMessages((prev) => [...prev, { role: 'bot', text: data.reply || 'No response received.' }])
    } catch {
      setChatMessages((prev) => [...prev, { role: 'bot', text: 'Unable to reach the assistant. Please try again.' }])
    } finally {
      setChatLoading(false)
    }
  }

  const handleChatSubmit = (e: FormEvent) => {
    e.preventDefault()
    sendChat(chatInput)
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, chatLoading])

  useEffect(() => {
    const q = query(collection(db, 'reports'), orderBy('timestamp', 'desc'), limit(10))
    const unsub = onSnapshot(q, (snap) => {
      const items: Report[] = snap.docs.map((doc) => {
        const d = doc.data()
        return {
          id: doc.id,
          area: d.area || 'Unknown',
          description: d.description || '',
          timestamp: d.timestamp instanceof Timestamp ? d.timestamp.toDate() : new Date(d.timestamp),
          lat: d.lat,
          lon: d.lon,
        }
      })
      setReports(items)
    }, () => {})
    return () => unsub()
  }, [])

  const submitReport = async () => {
    if (!reportArea.trim() || !reportDesc.trim()) return
    setReportSubmitting(true)
    try {
      await addDoc(collection(db, 'reports'), {
        area: reportArea.trim(),
        description: reportDesc.trim(),
        timestamp: serverTimestamp(),
        lat: weather?.lat || 17.385,
        lon: weather?.lon || 78.4867,
      })
      setReportArea('')
      setReportDesc('')
      setShowReportForm(false)
    } catch {}
    finally { setReportSubmitting(false) }
  }

  const prevLang = useRef(language)
  useEffect(() => {
    if (prevLang.current !== language && weather) {
      loadWeather('', { lat: weather.lat, lon: weather.lon })
    }
    prevLang.current = language
  }, [language, weather, loadWeather])

  if (locating) {
    return (
      <main className="onboarding">
        <div className="location-icon loading-orbit"><LocateFixed /></div>
        <Label>LIVE FLOOD INTELLIGENCE</Label>
        <h1>WeatherGPT</h1>
        <div className="location-wait"><span className="loading-spinner" />{t.locationWait}</div>
        <p>{t.locationSub}</p>
      </main>
    )
  }

  if (!started) {
    return (
      <main className="onboarding">
        <div className="location-icon"><MapPin /></div>
        <Label>LIVE FLOOD INTELLIGENCE</Label>
        <h1>WeatherGPT</h1>
        <p>{locationTimedOut ? t.locationTimedOut : t.sub}</p>
        <div className="onboarding-actions">
          <button className="button primary" onClick={() => begin(true)}>
            <Search size={16} />{t.manual}
          </button>
          <button className="button secondary" onClick={() => begin()}>
            <LocateFixed size={16} />{t.allow}
          </button>
        </div>
        <small><ShieldCheck size={13} />{t.locationPrivacy}</small>
      </main>
    )
  }

  const forecast = weather?.forecast?.length
    ? weather.forecast
    : [{ label: '+30m', value: 0 }, { label: '+60m', value: 0 }, { label: '+90m', value: 0 }]

  const riskText = { high: t.high, moderate: t.moderate, safe: t.safe }[risk]
  const trend = forecastTrend(forecast)
  const lastUpdated = weather ? new Date(weather.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

  return (
    <main className="site-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Droplets size={15} /></div>
          <strong>WeatherGPT</strong>
          <span className="beta">HYDERABAD</span>
        </div>
        <nav className="topnav">
          <a href="#map">{t.liveMapNav}</a>
          <a href="#reports">{t.reportsNav}</a>
          <a href="#ask">{t.askNav}</a>
        </nav>
        <div className="language-pills">
          {(['EN', 'हि', 'తె'] as Language[]).map((lang) => (
            <button key={lang} className={language === lang ? 'active' : ''} onClick={() => setLanguage(lang)}>
              {lang}
            </button>
          ))}
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <Label>LIVE FLOOD INTELLIGENCE · AUTO-REFRESHES EVERY 10 MIN</Label>
          <h1>{t.heroTitle}</h1>
          <p>{t.heroSub}</p>
          <form className="searchbar" onSubmit={handleSearch}>
            <Search size={17} />
            <input
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder={t.search}
              aria-label={t.search}
            />
            <button type="submit">Search <ArrowUpRight size={15} /></button>
          </form>
          {error && <div className="error-banner"><X size={15} />{error}</div>}
          {weather && weather.risk === 'high' && (
            <div className="alert-banner high">
              ⚠️ {t.high} — {weather.area}. {weather.roadStatus}
            </div>
          )}
          {weather && weather.risk === 'moderate' && (
            <div className="alert-banner moderate">
              ⚡ {t.moderate} — {weather.area}. {weather.roadStatus}
            </div>
          )}
          {weather && weather.risk === 'safe' && (
            <div className="alert-banner safe">
              ✅ {t.safe} — {weather.area}.
            </div>
          )}
        </div>

        <Card className="hero-weather">
          <div className="card-top">
            <Label>CURRENT CONDITIONS</Label>
            <button
              className="icon-btn"
              onClick={() => loadWeather('', weather ? { lat: weather.lat, lon: weather.lon } : undefined)}
              aria-label="Refresh weather"
            >
              <RefreshCw size={15} className={loading ? 'spin' : ''} />
            </button>
          </div>
          {loading || !weather ? (
            <>
              <Skeleton className="skeleton-line" />
              <Skeleton className="skeleton-temp" />
              <Skeleton className="skeleton-line medium" />
            </>
          ) : (
            <>
              <h2>{weather.area}</h2>
              <div className="temperature">{weather.temperature}<sup>°C</sup></div>
              <p className="muted hero-condition">{weather.condition}</p>
              <span className="rain-pill"><Droplets size={13} />{weather.rain} mm/hr</span>
              <div className="hero-footer">
                <span>{t.feelsLike} {weather.feelsLike}°</span>
                <span>{t.updated} {lastUpdated}</span>
              </div>
            </>
          )}
        </Card>
      </section>

      <section id="map" className="map-section">
        <div className="section-title">
          <div>
            <Label>REAL-TIME PRECIPITATION</Label>
            <h2>{t.liveMap}</h2>
            <p>{t.liveMapSub}</p>
          </div>
          <span className="live"><i />LIVE</span>
        </div>
        <WeatherMap
          lat={weather?.lat}
          lon={weather?.lon}
          area={weather?.area}
          risk={weather?.risk}
          refreshKey={mapRefreshKey}
        />
      </section>

      <section className="results">
        <Label>{t.areaResults}</Label>
        <div className="results-grid">
          <Card className="conditions-card">
            <div className="card-top">
              <h3>{t.currentConditions}</h3>
              <span className="muted">{weather?.area || 'Hyderabad'}</span>
            </div>
            <div className="condition-list">
              <div>
                <Droplets /><span>{t.rainfall}</span>
                <b>{loading || !weather ? <Skeleton className="skeleton-value" /> : `${weather.rain} mm/hr`}</b>
              </div>
              <div>
                <Wind /><span>{t.wind}</span>
                <b>{loading || !weather ? <Skeleton className="skeleton-value" /> : `${weather.wind} km/h`}</b>
              </div>
              <div>
                <Droplets /><span>{t.humidity}</span>
                <b>{loading || !weather ? <Skeleton className="skeleton-value" /> : `${weather.humidity}%`}</b>
              </div>
              <div>
                <Eye /><span>{t.visibility}</span>
                <b>{loading || !weather ? <Skeleton className="skeleton-value" /> : `${weather.visibility ?? 0} km`}</b>
              </div>
              <div>
                <Gauge /><span>{t.pressure}</span>
                <b>{loading || !weather ? <Skeleton className="skeleton-value" /> : `${weather.pressure ?? 0} hPa`}</b>
              </div>
              <div>
                <Cloud /><span>{t.cloudCover}</span>
                <b>{loading || !weather ? <Skeleton className="skeleton-value" /> : `${weather.cloud ?? 0}%`}</b>
              </div>
              <div>
                <CloudRain /><span>{t.rainChance}</span>
                <b>{loading || !weather ? <Skeleton className="skeleton-value" /> : `${weather.rainChance ?? 0}%`}</b>
              </div>
            </div>
          </Card>

          <Card className={`risk-card risk-${risk}`}>
            <div className="card-top">
              <h3>{t.floodRisk}</h3>
              <span className="live"><i />LIVE</span>
            </div>
            <div className="risk-title">
              <span className="risk-dot" />{weather ? riskText : 'Loading...'}
            </div>
            <div className="info-list">
              <div>
                <ShieldCheck /><span>{t.road}</span>
                <b>{weather?.roadStatus || '—'}</b>
              </div>
              <div>
                <Check /><span>{t.action}</span>
                <b>{weather?.recommendedAction || '—'}</b>
              </div>
              <div>
                <Compass /><span>{t.wait}</span>
                <b>{weather?.estimatedWait || '—'}</b>
              </div>
            </div>
            <button className="route-row">
              {weather?.safeRoute || t.route}<ChevronRight size={15} />
            </button>
          </Card>

          <Card className="forecast-card">
            <div className="card-top">
              <div>
                <h3>{t.forecast90}</h3>
                <span className="muted forecast-trend">
                  {trend === 'up' ? <TrendingUp size={13} /> : trend === 'down' ? <TrendingDown size={13} /> : <MoveHorizontal size={13} />}
                  {trend === 'up' ? t.rainUp : trend === 'down' ? t.rainDown : t.rainSteady}
                </span>
              </div>
              <span className="muted">{weather?.area || 'Hyderabad'}</span>
            </div>
            <div className="rain-timeline">
              {forecast.map((f, i) => {
                const level = rainLevelOf(f.value)
                const Icon = rainIcon(level)
                const label = rainLabelOf(level, t)
                const drops = rainDropsOf(level)
                return (
                  <div key={i} className={`rain-slot rain-${level}`}>
                    <span className="rain-time">{f.label}</span>
                    <Icon size={34} />
                    <span className="rain-level">{label}</span>
                    <div className="rain-drops">
                      {[1, 2, 3].map((d) => (
                        <i key={d} className={d <= drops ? 'on' : ''} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
            {typeof weather?.rainChance === 'number' && (
              <p className="forecast-note">{t.rainChanceSub} · {weather.rainChance}%</p>
            )}
          </Card>
        </div>
      </section>

      <section id="ask" className="wide-section">
        <Card className="chat-card">
          <div className="chat-intro">
            <div className="ai-mark"><Bot size={17} /></div>
            <Label>{t.aiAssistant}</Label>
            <h2>{t.ask}</h2>
            <p>{t.aiSub}</p>
          </div>
          <div className="chat-panel">
            <div className="chat-messages" style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {chatMessages.map((msg, i) => (
                <div key={i} className={msg.role === 'bot' ? 'bot-bubble' : 'user-bubble'}>
                  {msg.text}
                </div>
              ))}
              {chatLoading && (
                <div className="bot-bubble">
                  <span className="loading-spinner" style={{ width: 12, height: 12, display: 'inline-block', marginRight: 8 }} />
                  {t.sending}
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="quick-questions">
              {t.questions.map((q) => (
                <button key={q} onClick={() => sendChat(q)}>{q}</button>
              ))}
            </div>
            <form className="chat-input" onSubmit={handleChatSubmit}>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={t.chatPlaceholder}
                aria-label="Ask WeatherGPT"
                disabled={chatLoading}
              />
              <button type="submit" disabled={chatLoading}><Send size={14} /></button>
            </form>
          </div>
        </Card>
      </section>

      <section id="reports" className="wide-section">
        <Card className="reports-card">
          <div>
            <Label>{t.citizenSignals}</Label>
            <h2>{t.reports}</h2>
            <p>{t.communityObs}</p>
          </div>
          <div>
            {showReportForm ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input
                  value={reportArea}
                  onChange={(e) => setReportArea(e.target.value)}
                  placeholder={t.reportArea}
                  style={{ padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', color: 'var(--text)', fontSize: 12, outline: 'none' }}
                />
                <textarea
                  value={reportDesc}
                  onChange={(e) => setReportDesc(e.target.value)}
                  placeholder={t.reportDesc}
                  rows={3}
                  style={{ padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', color: 'var(--text)', fontSize: 12, outline: 'none', resize: 'vertical', fontFamily: 'inherit' }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="button primary" onClick={submitReport} disabled={reportSubmitting}>
                    {reportSubmitting ? '...' : t.reportSubmit}
                  </button>
                  <button className="button secondary" onClick={() => setShowReportForm(false)}>
                    {t.reportCancel}
                  </button>
                </div>
              </div>
            ) : reports.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {reports.map((r) => (
                  <div key={r.id} style={{ padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: 12 }}><MapPin size={12} style={{ display: 'inline', marginRight: 5 }} />{r.area}</span>
                      <span style={{ color: 'var(--muted)', fontSize: 10 }}>{timeAgo(r.timestamp)}</span>
                    </div>
                    <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.4 }}>{r.description}</p>
                  </div>
                ))}
                <button className="button secondary" onClick={() => setShowReportForm(true)}>
                  {t.report}<ArrowUpRight size={14} />
                </button>
              </div>
            ) : (
              <div className="report-empty">
                <MapPin size={19} />
                <strong>{t.noReports}</strong>
                <span>{t.beFirst}</span>
                <button className="button secondary" onClick={() => setShowReportForm(true)}>
                  {t.report}<ArrowUpRight size={14} />
                </button>
              </div>
            )}
          </div>
        </Card>
      </section>

      <footer>
        <span>WeatherGPT Hyderabad · {t.source} · {t.footerBuilt}</span>
        <span>{t.updated} {lastUpdated}</span>
      </footer>
    </main>
  )
}