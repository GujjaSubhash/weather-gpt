'use client'

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight, Cloud, CloudDrizzle,
  CloudLightning, CloudRain, Droplets, Eye, Gauge, Info,
  LocateFixed, MoveHorizontal, RefreshCw, Search, Send,
  ShieldCheck, Sun, TrendingDown, TrendingUp, Wind, X,
  type LucideIcon,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import ChatPanel from '@/components/chat/ChatPanel'
import WeatherBot from '@/components/chat/WeatherBot'
import type { ChatContext } from '@/components/chat/WeatherContextStrip'
import AlertSection, { type OfficialAlert } from '@/components/weather/AlertSection'
import ClimateCard from '@/components/weather/ClimateCard'
import RainBackdrop from '@/components/rain-backdrop'
import { playDemoAlert, type DemoAlertLevel } from '@/lib/demo-alert'

const WeatherMap = dynamic(() => import('@/components/weather-map'), { ssr: false })

/**
 * What /api/weather does not measure. Rendered as an explicit "not available"
 * row so a gap in the data reads as a gap, instead of the UI inventing a value.
 */
type DataAvailability = {
  roadConditions: string
  trafficConditions: string
  drainageStatus: string
}

/** Which provider actually served this reading, and when it observed it. */
type Provenance = { source: string; observedAt: string; kind: string }

type Weather = {
  area: string; temperature: number; feelsLike: number; condition: string
  rain: number; wind: number; humidity: number
  visibility?: number; pressure?: number; cloud?: number; rainChance?: number
  risk: 'high' | 'moderate' | 'safe'
  /** Rainfall-derived general caution. Asserts nothing about roads or traffic. */
  rainfallGuidance: string
  dataAvailability?: DataAvailability
  inSupportedArea?: boolean
  provenance?: Provenance
  /** Provider observation time, not render time. */
  updatedAt: string
  forecast: { label: string; value: number }[]
  source?: string
  /** Official alerts from AccuWeather. `alertsAvailable` separates "asked, none
   *  in force" from "could not ask"; both may be absent if AccuWeather was
   *  unavailable for this reading. */
  officialAlerts?: OfficialAlert[]
  alertsAvailable?: boolean
  /** Set only by /api/weather's demo scenarios. Drives the SIMULATED badge. */
  simulated?: boolean
  lat: number; lon: number
}

/**
 * The presentation scenarios /api/weather can serve. Kept as a literal union so
 * a typo here is a compile error rather than a silent fall-through to real data.
 */
type DemoScenarioId = 'heavy_rain' | 'moderate_rain' | 'clear'

/**
 * The three demo scenarios, as the picker modal presents them. Copy stays in
 * English at every language setting: this is presentation tooling for whoever is
 * driving the laptop, not product copy an audience reads. The weather DATA the
 * scenarios load is still fully translated by the API.
 *
 * `tint` reuses the app's risk palette (red / amber / green) so a card reads as
 * its severity at a glance. `alert` is the warning tone each scenario sounds on
 * launch — full alarm for the emergency, a quieter single cycle for moderate,
 * silence for clear.
 */
type DemoCard = {
  id: DemoScenarioId
  title: string
  description: string
  Icon: LucideIcon
  tint: 'high' | 'moderate' | 'safe'
  alert: DemoAlertLevel | null
}
/*
 * Master switch for the demo control. Set to `true` to show the "Demo" pill in
 * the header again (e.g. for a live presentation). While `false`, the button is
 * absent everywhere and a normal visitor never sees demo mode — all the picker,
 * scenario and API plumbing below stays intact, just unreachable from the UI.
 */
const DEMO_ENABLED = false

const DEMO_CARDS: DemoCard[] = [
  {
    id: 'heavy_rain',
    title: 'Heavy Rain Emergency',
    description: 'Extreme monsoon scenario — Red Alert, 18mm/hr rainfall, flooding in low-lying areas.',
    Icon: CloudLightning,
    tint: 'high',
    alert: 'high',
  },
  {
    id: 'moderate_rain',
    title: 'Moderate Rain Advisory',
    description: 'Active monsoon — 5mm/hr rainfall, moderate flood risk, travel with caution.',
    Icon: CloudRain,
    tint: 'moderate',
    alert: 'moderate',
  },
  {
    id: 'clear',
    title: 'Clear Weather Day',
    description: 'No rain, safe conditions — a normal Hyderabad summer day.',
    Icon: Sun,
    tint: 'safe',
    alert: null,
  },
]
type Language = 'EN' | 'हि' | 'తె'
type ChatMsg = { role: 'user' | 'bot'; text: string }

const langParam: Record<Language, string> = { EN: 'EN', 'हि': 'hi', 'తె': 'te' }

/** BCP-47 tags, so month names in the climate card follow the chosen language. */
const LOCALES: Record<Language, string> = { EN: 'en-IN', 'हि': 'hi-IN', 'తె': 'te-IN' }

const copy = {
  EN: {
    allow: 'Allow location', manual: 'Search manually',
    /* The entry screen leads with what this product is: an assistant you talk to.
       aiTagline replaced the flood-only `sub` line that used to greet every user;
       `sub` had no other reference, so it is gone rather than left dangling. */
    aiKicker: 'CONVERSATIONAL WEATHER AI',
    aiTagline: 'Conversational AI for Weather, Alerts and Climate',
    orLabel: 'OR',
    search: 'Search any area — Meerpet, Kukatpally, Banjara Hills...',
    next: 'Next 90 minutes',
    ask: 'Ask WeatherGPT',
    safe: 'SAFE', moderate: 'MODERATE', high: 'HIGH RISK',
    guidance: 'General guidance (from rainfall)',
    roadTraffic: 'Road & traffic conditions', notAvailable: 'Not available',
    coverageNotice: 'Local weather analysis covers Hyderabad only — showing weather for this location',
    /* Ordered by pillar: current conditions, forecast, alerts, travel safety,
       then the flood prompts the product started with (retained, not removed).
       The entry screen shows a fixed prefix — see ONBOARDING_SUGGESTION_LIMIT. */
    suggestions: [
      'How is the weather right now?',
      'Will it rain today?',
      'Should I carry an umbrella?',
      'Any weather alerts near me?',
      'Is it safe to go out?',
      'How does it feel outside?',
    ],
    chatEmptyHint: "Ask anything — current conditions, today's forecast, warnings, travel safety, or how today compares with normal.",
    chatContextLabel: 'LIVE CONTEXT',
    chatSend: 'Send',
    /* Alerts surface. The "not connected" wording is deliberately not an
       all-clear: it states that we cannot see official warnings, which is a
       different fact from there being none. */
    alertsKicker: 'WARNINGS & ALERTS',
    alertsTitle: 'Alerts',
    alertsSub: 'Official warnings for this area, kept separate from the advisory we calculate from rainfall.',
    alertOfficialLabel: 'OFFICIAL WARNING',
    alertsNone: 'No official weather warnings for this area right now.',
    alertsNotConnected: 'Official weather warnings are not connected yet.',
    alertsNotConnectedSub: 'This app cannot see official warning feeds at the moment, so treat this as unknown rather than as an all-clear. Active warnings will appear here once a feed is connected.',
    alertDerivedLabel: 'DERIVED FROM RAINFALL MEASUREMENTS',
    alertDerivedNote: 'Calculated from measured rainfall by this app. It is not an official warning and no authority has issued it.',
    alertSeverity: 'Severity',
    alertFrom: 'From',
    alertUntil: 'Until',
    alertSourceLink: 'Open official notice',
    alertAskCta: 'Ask WeatherGPT what this means',
    alertAskQuestion: 'What does this mean for me?',
    /* Climate pillar. Real published normals for Hyderabad (IMD 1991–2020),
       with today placed against them — see components/weather/ClimateCard.tsx. */
    climateKicker: 'HISTORICAL & CLIMATE',
    climateTitle: 'Climate context',
    climateTypical: 'TYPICAL FOR',
    climateNormalHigh: 'Normal high',
    climateNormalLow: 'Normal low',
    climateNormalRain: 'Normal rainfall this month',
    climateSeasonDry: 'Dry season',
    climateSeasonHot: 'Hot season',
    climateSeasonMonsoon: 'Monsoon season',
    climateSeasonPeak: 'Peak monsoon month',
    climateToday: 'TODAY VS NORMAL',
    climateNowTemp: 'Measured now',
    climateNormalRange: 'Normal daily range',
    climateWarmer: 'Warmer than normal',
    climateCooler: 'Cooler than normal',
    climateAboutNormal: 'Within the normal range',
    climateRainNow: 'Rainfall now',
    climateRainNote: 'Rainfall now is an hourly rate, so it is shown beside the monthly normal rather than compared with it.',
    climateNoReading: 'No live reading yet, so today cannot be placed against the normal.',
    climateSource: 'Monthly normals for Hyderabad, India Meteorological Department 1991–2020. City-wide averages — not a measurement of your exact area.',
    climateOutsideArea: 'These normals describe Hyderabad. This reading is outside that area, so they do not apply to it.',
    /* Section kickers that name each information type unambiguously. */
    currentKicker: 'CURRENT WEATHER',
    forecastKicker: 'FORECAST',
    riskKicker: 'WEATHER ADVISORY',
    chatValidation: 'That question could not be processed. Try a shorter one.',
    chatRateLimit: 'Too many questions right now. Please wait a moment and try again.',
    chatOutage: 'The assistant is temporarily unavailable. Please try again.',
    chatOffline: 'Unable to reach the assistant. Please try again.',
    sending: 'Thinking...', chatPlaceholder: 'Ask about your area...',
    none: 'No rain', lightRain: 'Light', mediumRain: 'Moderate', heavyRain: 'Heavy',
    rainUp: 'Rain increasing', rainDown: 'Rain easing', rainSteady: 'Rain steady',
    currentConditions: 'Current conditions', advisoryTitle: 'Weather advisory',
    liveMap: 'Weather Map', liveMapSub: 'Live weather and rainfall radar over Hyderabad',
    liveMapNav: 'Weather map', askNav: 'Ask WeatherGPT',
    heroTitle: 'Real-Time Weather Analysis for Hyderabad',
    heroSub: 'Live conditions, rainfall, official alerts and climate context for your area.',
    feelsLike: 'Feels like', updated: 'Updated',
    rainfall: 'Rainfall', wind: 'Wind', humidity: 'Humidity',
    visibility: 'Visibility', pressure: 'Pressure', cloudCover: 'Cloud cover',
    rainChance: 'Rain chance', forecast90: '90 minute forecast',
    aiAssistant: 'AI WEATHER ASSISTANT',
    aiSub: 'Get instant answers about current weather, alerts and climate.',
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
    aiKicker: 'संवादात्मक मौसम AI',
    aiTagline: 'मौसम, अलर्ट और जलवायु के लिए संवादात्मक AI',
    orLabel: 'या',
    search: 'क्षेत्र खोजें — मीरपेट, कुकटपल्ली, बंजारा हिल्स...',
    next: 'अगले 90 मिनट',
    ask: 'WeatherGPT से पूछें',
    safe: 'सुरक्षित', moderate: 'मध्यम', high: 'उच्च जोखिम',
    guidance: 'सामान्य सलाह (वर्षा के आधार पर)',
    roadTraffic: 'सड़क और ट्रैफ़िक स्थिति', notAvailable: 'उपलब्ध नहीं',
    coverageNotice: 'स्थानीय मौसम विश्लेषण केवल हैदराबाद के लिए है — इस स्थान का मौसम दिखाया जा रहा है',
    suggestions: [
      'अभी मौसम कैसा है?',
      'क्या आज बारिश होगी?',
      'छाता लेना चाहिए?',
      'कोई मौसम चेतावनी है?',
      'बाहर जाना सुरक्षित है?',
      'बाहर कैसा लग रहा है?',
    ],
    chatEmptyHint: 'कुछ भी पूछें — वर्तमान स्थिति, आज का पूर्वानुमान, चेतावनी, यात्रा सुरक्षा या आज सामान्य से कैसा है।',
    chatContextLabel: 'लाइव संदर्भ',
    chatSend: 'भेजें',
    alertsKicker: 'चेतावनियाँ और अलर्ट',
    alertsTitle: 'अलर्ट',
    alertsSub: 'इस क्षेत्र की आधिकारिक चेतावनियाँ, वर्षा से गणना की गई सलाह से अलग रखी गई हैं।',
    alertOfficialLabel: 'आधिकारिक चेतावनी',
    alertsNone: 'इस क्षेत्र के लिए अभी कोई आधिकारिक मौसम चेतावनी नहीं है।',
    alertsNotConnected: 'आधिकारिक मौसम चेतावनियाँ अभी जुड़ी नहीं हैं।',
    alertsNotConnectedSub: 'यह ऐप अभी आधिकारिक चेतावनी फ़ीड नहीं देख सकता, इसलिए इसे "अज्ञात" समझें, "सब ठीक है" नहीं। फ़ीड जुड़ने पर सक्रिय चेतावनियाँ यहीं दिखेंगी।',
    alertDerivedLabel: 'वर्षा मापों से गणना की गई',
    alertDerivedNote: 'यह इस ऐप द्वारा मापी गई वर्षा से गणना की गई है। यह आधिकारिक चेतावनी नहीं है और किसी प्राधिकरण ने इसे जारी नहीं किया है।',
    alertSeverity: 'गंभीरता',
    alertFrom: 'से',
    alertUntil: 'तक',
    alertSourceLink: 'आधिकारिक सूचना खोलें',
    alertAskCta: 'WeatherGPT से पूछें इसका क्या अर्थ है',
    alertAskQuestion: 'इसका मेरे लिए क्या अर्थ है?',
    climateKicker: 'ऐतिहासिक और जलवायु',
    climateTitle: 'जलवायु संदर्भ',
    climateTypical: 'इस समय सामान्यतः',
    climateNormalHigh: 'सामान्य अधिकतम',
    climateNormalLow: 'सामान्य न्यूनतम',
    climateNormalRain: 'इस माह की सामान्य वर्षा',
    climateSeasonDry: 'शुष्क मौसम',
    climateSeasonHot: 'गर्मी का मौसम',
    climateSeasonMonsoon: 'मानसून का मौसम',
    climateSeasonPeak: 'सर्वाधिक वर्षा वाला माह',
    climateToday: 'आज बनाम सामान्य',
    climateNowTemp: 'अभी मापा गया',
    climateNormalRange: 'सामान्य दैनिक सीमा',
    climateWarmer: 'सामान्य से अधिक गर्म',
    climateCooler: 'सामान्य से अधिक ठंडा',
    climateAboutNormal: 'सामान्य सीमा के भीतर',
    climateRainNow: 'अभी वर्षा',
    climateRainNote: 'अभी की वर्षा प्रति घंटा दर है, इसलिए इसे मासिक औसत के साथ दिखाया गया है, उससे तुलना नहीं की गई है।',
    climateNoReading: 'अभी कोई लाइव रीडिंग नहीं है, इसलिए आज की तुलना सामान्य से नहीं की जा सकती।',
    climateSource: 'हैदराबाद के मासिक औसत, भारत मौसम विज्ञान विभाग 1991–2020। ये शहर-व्यापी औसत हैं — आपके ठीक क्षेत्र का माप नहीं।',
    climateOutsideArea: 'ये औसत हैदराबाद के लिए हैं। यह रीडिंग उस क्षेत्र के बाहर है, इसलिए ये उस पर लागू नहीं होते।',
    currentKicker: 'वर्तमान मौसम',
    forecastKicker: 'पूर्वानुमान',
    riskKicker: 'मौसम सलाह',
    chatValidation: 'यह प्रश्न संसाधित नहीं हो सका। कृपया छोटा प्रश्न पूछें।',
    chatRateLimit: 'अभी बहुत अधिक प्रश्न हैं। कृपया थोड़ी देर बाद प्रयास करें।',
    chatOutage: 'सहायक अस्थायी रूप से अनुपलब्ध है। कृपया पुनः प्रयास करें।',
    chatOffline: 'सहायक से संपर्क नहीं हो सका। कृपया पुनः प्रयास करें।',
    sending: 'सोच रहा हूँ...', chatPlaceholder: 'अपने क्षेत्र के बारे में पूछें...',
    none: 'बारिश नहीं', lightRain: 'हल्की', mediumRain: 'मध्यम', heavyRain: 'भारी',
    rainUp: 'बारिश बढ़ रही है', rainDown: 'बारिश कम हो रही है', rainSteady: 'बारिश स्थिर है',
    currentConditions: 'वर्तमान स्थिति', advisoryTitle: 'मौसम सलाह',
    liveMap: 'मौसम मानचित्र', liveMapSub: 'हैदराबाद पर लाइव मौसम और वर्षा रडार',
    liveMapNav: 'मौसम मानचित्र', askNav: 'WeatherGPT से पूछें',
    heroTitle: 'हैदराबाद के लिए रियल-टाइम मौसम विश्लेषण',
    heroSub: 'आपके क्षेत्र के लिए लाइव स्थिति, वर्षा, आधिकारिक चेतावनियाँ और जलवायु संदर्भ।',
    feelsLike: 'महसूस होता है', updated: 'अपडेट',
    rainfall: 'वर्षा', wind: 'हवा', humidity: 'आर्द्रता',
    visibility: 'दृश्यता', pressure: 'दबाव', cloudCover: 'बादल',
    rainChance: 'बारिश की संभावना', forecast90: '90 मिनट का पूर्वानुमान',
    aiAssistant: 'AI मौसम सहायक',
    aiSub: 'वर्तमान मौसम, चेतावनियों और जलवायु के बारे में तुरंत उत्तर पाएं।',
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
    aiKicker: 'సంభాషణ వాతావరణ AI',
    aiTagline: 'వాతావరణం, హెచ్చరికలు మరియు వాతావరణ సమాచారం కోసం సంభాషణ AI',
    orLabel: 'లేదా',
    search: 'ప్రాంతాన్ని వెతకండి — మీర్‌పేట, కుకట్‌పల్లి, బంజారా హిల్స్...',
    next: 'తదుపరి 90 నిమిషాలు',
    ask: 'WeatherGPTని అడగండి',
    safe: 'సురక్షితం', moderate: 'మధ్యస్థం', high: 'అధిక ప్రమాదం',
    guidance: 'సాధారణ సూచన (వర్షపాతం ఆధారంగా)',
    roadTraffic: 'రోడ్డు & ట్రాఫిక్ పరిస్థితులు', notAvailable: 'అందుబాటులో లేదు',
    coverageNotice: 'స్థానిక వాతావరణ విశ్లేషణ హైదరాబాద్‌కు మాత్రమే — ఈ ప్రాంతపు వాతావరణం చూపుతోంది',
    suggestions: [
      'ఇప్పుడు వాతావరణం ఎలా ఉంది?',
      'ఈరోజు వర్షం పడుతుందా?',
      'గొడుగు తీసుకెళ్ళాలా?',
      'వాతావరణ హెచ్చరికలు ఉన్నాయా?',
      'బయటకు వెళ్ళడం సురక్షితమేనా?',
      'బయట ఎలా అనిపిస్తోంది?',
    ],
    chatEmptyHint: 'ఏదైనా అడగండి — ప్రస్తుత పరిస్థితులు, నేటి అంచనా, హెచ్చరికలు, ప్రయాణ భద్రత లేదా నేడు సాధారణంతో ఎలా ఉందో.',
    chatContextLabel: 'లైవ్ సందర్భం',
    chatSend: 'పంపండి',
    alertsKicker: 'హెచ్చరికలు & అలర్ట్‌లు',
    alertsTitle: 'అలర్ట్‌లు',
    alertsSub: 'ఈ ప్రాంతానికి అధికారిక హెచ్చరికలు, వర్షపాతం నుండి మేము లెక్కించిన సూచన నుండి వేరుగా.',
    alertOfficialLabel: 'అధికారిక హెచ్చరిక',
    alertsNone: 'ఈ ప్రాంతానికి ఇప్పుడు అధికారిక వాతావరణ హెచ్చరికలు లేవు.',
    alertsNotConnected: 'అధికారిక వాతావరణ హెచ్చరికలు ఇంకా అనుసంధానించబడలేదు.',
    alertsNotConnectedSub: 'ఈ యాప్ ప్రస్తుతం అధికారిక హెచ్చరిక ఫీడ్‌లను చూడలేదు, కాబట్టి దీన్ని "తెలియదు" అని భావించండి, "అంతా క్షేమం" అని కాదు. ఫీడ్ అనుసంధానమైన వెంటనే క్రియాశీల హెచ్చరికలు ఇక్కడ కనిపిస్తాయి.',
    alertDerivedLabel: 'వర్షపాత కొలతల నుండి లెక్కించబడింది',
    alertDerivedNote: 'ఇది కొలిచిన వర్షపాతం ఆధారంగా ఈ యాప్ లెక్కించింది. ఇది అధికారిక హెచ్చరిక కాదు, ఏ అధికార సంస్థ దీన్ని జారీ చేయలేదు.',
    alertSeverity: 'తీవ్రత',
    alertFrom: 'నుండి',
    alertUntil: 'వరకు',
    alertSourceLink: 'అధికారిక ప్రకటన తెరవండి',
    alertAskCta: 'దీని అర్థం ఏమిటో WeatherGPTని అడగండి',
    alertAskQuestion: 'ఇది నాకు ఏమి అర్థం?',
    climateKicker: 'చారిత్రక & వాతావరణం',
    climateTitle: 'వాతావరణ సందర్భం',
    climateTypical: 'ఈ కాలంలో సాధారణంగా',
    climateNormalHigh: 'సాధారణ గరిష్ఠం',
    climateNormalLow: 'సాధారణ కనిష్ఠం',
    climateNormalRain: 'ఈ నెల సాధారణ వర్షపాతం',
    climateSeasonDry: 'పొడి కాలం',
    climateSeasonHot: 'వేసవి కాలం',
    climateSeasonMonsoon: 'రుతుపవన కాలం',
    climateSeasonPeak: 'అత్యధిక వర్షపాత నెల',
    climateToday: 'నేడు vs సాధారణం',
    climateNowTemp: 'ఇప్పుడు కొలిచినది',
    climateNormalRange: 'సాధారణ రోజువారీ పరిధి',
    climateWarmer: 'సాధారణం కంటే వెచ్చగా',
    climateCooler: 'సాధారణం కంటే చల్లగా',
    climateAboutNormal: 'సాధారణ పరిధిలోనే',
    climateRainNow: 'ఇప్పుడు వర్షం',
    climateRainNote: 'ఇప్పటి వర్షపాతం గంటకు రేటు, కాబట్టి ఇది నెలవారీ సగటు పక్కన చూపబడింది — దానితో పోల్చబడలేదు.',
    climateNoReading: 'ఇప్పుడు లైవ్ రీడింగ్ లేదు, కాబట్టి నేటిని సాధారణంతో పోల్చలేము.',
    climateSource: 'హైదరాబాద్ నెలవారీ సగటులు, భారత వాతావరణ శాఖ 1991–2020. ఇవి నగర-వ్యాప్త సగటులు — మీ ప్రాంతపు కొలత కాదు.',
    climateOutsideArea: 'ఈ సగటులు హైదరాబాద్‌కు సంబంధించినవి. ఈ రీడింగ్ ఆ ప్రాంతం వెలుపల ఉంది, కాబట్టి ఇవి దీనికి వర్తించవు.',
    currentKicker: 'ప్రస్తుత వాతావరణం',
    forecastKicker: 'అంచనా',
    riskKicker: 'వాతావరణ సూచన',
    chatValidation: 'ఈ ప్రశ్నను ప్రాసెస్ చేయలేకపోయాము. చిన్న ప్రశ్న అడగండి.',
    chatRateLimit: 'ప్రస్తుతం చాలా ప్రశ్నలు ఉన్నాయి. కొద్దిసేపు ఆగి ప్రయత్నించండి.',
    chatOutage: 'సహాయకుడు తాత్కాలికంగా అందుబాటులో లేరు. దయచేసి మళ్లీ ప్రయత్నించండి.',
    chatOffline: 'సహాయకుడిని చేరుకోలేకపోయాము. దయచేసి మళ్లీ ప్రయత్నించండి.',
    sending: 'ఆలోచిస్తోంది...', chatPlaceholder: 'మీ ప్రాంతం గురించి అడగండి...',
    none: 'వర్షం లేదు', lightRain: 'తేలికపాటి', mediumRain: 'మధ్యస్థం', heavyRain: 'భారీ',
    rainUp: 'వర్షం పెరుగుతోంది', rainDown: 'వర్షం తగ్గుతోంది', rainSteady: 'వర్షం స్థిరంగా ఉంది',
    currentConditions: 'ప్రస్తుత పరిస్థితులు', advisoryTitle: 'వాతావరణ సూచన',
    liveMap: 'వాతావరణ మ్యాప్', liveMapSub: 'హైదరాబాద్‌పై లైవ్ వాతావరణం మరియు వర్షపాత రాడార్',
    liveMapNav: 'వాతావరణ మ్యాప్', askNav: 'WeatherGPTని అడగండి',
    heroTitle: 'హైదరాబాద్ కోసం నిజ-సమయ వాతావరణ విశ్లేషణ',
    heroSub: 'మీ ప్రాంతానికి లైవ్ పరిస్థితులు, వర్షపాతం, అధికారిక హెచ్చరికలు మరియు వాతావరణ సందర్భం.',
    feelsLike: 'అనిపిస్తోంది', updated: 'నవీకరించబడింది',
    rainfall: 'వర్షపాతం', wind: 'గాలి', humidity: 'తేమ',
    visibility: 'దృశ్యమానత', pressure: 'పీడనం', cloudCover: 'మేఘావరణం',
    rainChance: 'వర్షం అవకాశం', forecast90: '90 నిమిషాల అంచనా',
    aiAssistant: 'AI వాతావరణ సహాయకుడు',
    aiSub: 'ప్రస్తుత వాతావరణం, హెచ్చరికలు మరియు వాతావరణ సందర్భం గురించి తక్షణ సమాధానాలు పొందండి.',
    footerBuilt: 'SIH 2026 కోసం నిర్మించబడింది',
    locationWait: 'మీ స్థానం వెతుకుతోంది...',
    locationSub: 'మీ ప్రాంతాన్ని కనుగొంటోంది.',
    locationTimedOut: 'స్థానం ఆలస్యమైంది. మాన్యువల్‌గా వెతకండి.',
    locationPrivacy: 'మీ స్థానం మీ పరికరంలోనే ఉంటుంది',
    rainChanceSub: 'తదుపరి 90 నిమిషాల్లో వర్షం అవకాశం',
    areaResults: 'ప్రాంత ఫలితాలు',
  },
}

/**
 * How many suggestion chips the entry screen shows. A fixed prefix of the
 * dictionary list — so it is the same on every render and in every language,
 * with no randomness. The chat panel offers no chips of its own.
 */
const ONBOARDING_SUGGESTION_LIMIT = 3

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
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([
    { role: 'bot', text: 'I can help you read the current weather, rainfall, official alerts, and how today compares with normal.' },
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  // A question typed on the entry screen, before any session exists. It is held
  // here and sent once the session has started and the first reading has settled
  // — never before, so the answer is grounded in real weather.
  const [onboardingAsk, setOnboardingAsk] = useState('')
  const pendingQuestionRef = useRef<string | null>(null)

  // ── Demo mode (presentation only) ──
  // A first-class presentation tool, reachable from a "Demo" control in the
  // header on every visit. `demoModalOpen` toggles the scenario picker;
  // `demoScenario` is the pinned scenario, mirrored into a ref because
  // loadWeather reads it — the ref keeps loadWeather's identity stable, so the
  // manual refresh button re-fetches the pinned scenario instead of silently
  // reverting the demo to live data mid-presentation. Real data is untouched
  // until a scenario is deliberately launched, and one click on "Exit" restores
  // it.
  const [demoModalOpen, setDemoModalOpen] = useState(false)
  const [demoScenario, setDemoScenario] = useState<DemoScenarioId | null>(null)
  const demoRef = useRef<DemoScenarioId | null>(null)

  const t = copy[language]
  const risk = weather?.risk || 'safe'

  const loadWeather = useCallback(async (q = '', coordinates?: { lat: number; lon: number }) => {
    setLoading(true)
    setError('')
    try {
      // A pinned scenario outranks the query and the coordinates, so the refresh
      // button and any search both stay inside the demo until "Live data" is
      // pressed. Nothing drops out of demo mode by surprise.
      const params = demoRef.current
        ? `demo=${encodeURIComponent(demoRef.current)}`
        : coordinates
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

  /** Pin a scenario and show it, entering the dashboard if we are not there yet. */
  const loadDemo = useCallback((id: DemoScenarioId) => {
    demoRef.current = id
    setDemoScenario(id)
    setDemoModalOpen(false)
    setLocationTimedOut(false)
    setLocating(false)
    // Sounded here, inside the click handler, so it counts as a user gesture —
    // browsers block audio otherwise. Keyed off the scenario rather than the
    // card, so the tone always matches the data being shown.
    const alert = DEMO_CARDS.find((c) => c.id === id)?.alert
    if (alert) playDemoAlert(alert)
    window.scrollTo({ top: 0 })
    setStarted(true)
    loadWeather()
  }, [loadWeather])

  /** Drop the pin and go straight back to a real reading. */
  const exitDemo = useCallback(() => {
    demoRef.current = null
    setDemoScenario(null)
    setDemoModalOpen(false)
    loadWeather('Hyderabad, IN')
  }, [loadWeather])

  const begin = useCallback((manual = false) => {
    setLocationTimedOut(false)
    // Entering from a scrolled position would otherwise drop the user mid-page.
    window.scrollTo({ top: 0 })
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

  const handleSearch = (e: FormEvent) => {
    e.preventDefault()
    if (queryText.trim()) loadWeather(queryText.trim())
  }

  const sendChat = useCallback(async (msg: string) => {
    if (!msg.trim()) return
    const userMsg = msg.trim()
    // Captured before the new turn is appended: this is the prior transcript the
    // model needs for follow-ups, and the question itself travels as `message`.
    const history = chatMessages.slice(-10).map((m) => ({ role: m.role, text: m.text }))
    setChatInput('')
    setChatMessages((prev) => [...prev, { role: 'user', text: userMsg }])
    setChatLoading(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg,
          // Full live context, or null when we genuinely have no reading — the
          // API turns null into an honest "unavailable" line rather than a fake
          // 0mm/safe default. rain is mm/hr; risk is the localized word.
          weather: weather
            ? {
                area: weather.area,
                temperature: weather.temperature,
                feelsLike: weather.feelsLike,
                condition: weather.condition,
                rain: weather.rain,
                wind: weather.wind,
                humidity: weather.humidity,
                rainChance: weather.rainChance,
                risk: weather.risk,
                forecast: weather.forecast,
                updatedAt: weather.updatedAt,
                source: weather.source,
                alerts: weather.officialAlerts ?? [],
              }
            : null,
          language: langParam[language],
          history,
        }),
      })
      // /api/chat now answers with real status codes, so the failure the user is
      // told about matches the failure that happened. No endpoint or credential
      // detail from the response is ever surfaced.
      if (!res.ok) {
        const text =
          res.status === 429 ? t.chatRateLimit
            : res.status >= 500 ? t.chatOutage
              : t.chatValidation
        setChatMessages((prev) => [...prev, { role: 'bot', text }])
        return
      }
      const data = await res.json()
      setChatMessages((prev) => [...prev, { role: 'bot', text: data.reply || t.chatOutage }])
    } catch {
      setChatMessages((prev) => [...prev, { role: 'bot', text: t.chatOffline }])
    } finally {
      setChatLoading(false)
    }
  }, [chatMessages, weather, language, t])

  const handleChatSubmit = (e: FormEvent) => {
    e.preventDefault()
    sendChat(chatInput)
  }

  /**
   * Ask-first entry: park the question, then start the session exactly the way
   * the "Search manually" button does. Nothing is sent yet — sendChat runs from
   * the effect below, once there is a reading to answer against.
   */
  const askAndBegin = useCallback((question: string) => {
    const trimmed = question.trim()
    if (!trimmed) return
    pendingQuestionRef.current = trimmed
    setOnboardingAsk('')
    begin(true)
  }, [begin])

  // Fires the parked question once, as soon as the first weather load has
  // settled. `loading` gates it so the request carries the live reading; the ref
  // is cleared before the send, so an identity change in sendChat cannot replay
  // it. An outright load failure still sends, rather than swallowing the
  // question — sendChat falls back to its default context in that case.
  useEffect(() => {
    if (!started || !pendingQuestionRef.current) return
    if (loading || locating) return
    if (!weather && !error) return
    const question = pendingQuestionRef.current
    pendingQuestionRef.current = null
    sendChat(question)
  }, [started, loading, locating, weather, error, sendChat])

  const prevLang = useRef(language)
  useEffect(() => {
    if (prevLang.current !== language && weather) {
      loadWeather('', { lat: weather.lat, lon: weather.lon })
    }
    prevLang.current = language
  }, [language, weather, loadWeather])

  // While the picker is open, Escape closes it and the page behind it stops
  // scrolling — standard modal behaviour, so the dialog does not feel bolted on.
  useEffect(() => {
    if (!demoModalOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDemoModalOpen(false) }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [demoModalOpen])

  /*
   * The header demo control, shown on both the entry screen and the dashboard.
   * When no scenario is pinned it is a quiet outlined "Demo" pill that opens the
   * picker. Once a scenario is live it becomes a red "DEMO MODE" badge — the
   * badge itself reopens the picker to switch scenarios, and the adjacent ✕
   * exits to live data. It is the only thing that drops the pin, which is why the
   * pin can be trusted to hold everywhere else.
   */
  const demoControl = !DEMO_ENABLED ? null : demoScenario ? (
    <div className="demo-active">
      <button
        type="button"
        className="demo-badge"
        onClick={() => setDemoModalOpen(true)}
        aria-haspopup="dialog"
        title="Switch demo scenario"
      >
        <span className="demo-badge-dot" aria-hidden="true" />
        DEMO MODE
      </button>
      <button
        type="button"
        className="demo-exit"
        onClick={exitDemo}
        aria-label="Exit demo mode and restore live data"
        title="Exit demo — restore live data"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  ) : (
    <button
      type="button"
      className="demo-trigger"
      onClick={() => setDemoModalOpen(true)}
      aria-haspopup="dialog"
    >
      Demo
    </button>
  )

  /*
   * The scenario picker. Rendered on both the entry screen and the dashboard so
   * a scenario can be launched cold, before any real fetch. Absent from the DOM
   * unless opened; a normal visit never builds it.
   */
  const demoModalNode = demoModalOpen ? (
    <div
      className="demo-modal-overlay"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) setDemoModalOpen(false) }}
    >
      <div className="demo-modal" role="dialog" aria-modal="true" aria-labelledby="demo-modal-title">
        <div className="demo-modal-head">
          <div>
            <h2 id="demo-modal-title">Demo scenarios</h2>
            <p>Load simulated conditions for a live walkthrough. No real weather API is called while a scenario is active.</p>
          </div>
          <button
            type="button"
            className="demo-modal-close"
            onClick={() => setDemoModalOpen(false)}
            aria-label="Close demo scenarios"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <div className="demo-cards">
          {DEMO_CARDS.map((card) => {
            const active = demoScenario === card.id
            return (
              <div key={card.id} className={`demo-card demo-card-${card.tint}${active ? ' active' : ''}`}>
                <div className="demo-card-icon"><card.Icon size={22} aria-hidden="true" /></div>
                <h3>{card.title}</h3>
                <p>{card.description}</p>
                <button
                  type="button"
                  className="demo-card-launch"
                  onClick={() => loadDemo(card.id)}
                  aria-current={active ? 'true' : undefined}
                >
                  {active ? 'Active scenario' : 'Launch demo'}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  ) : null

  if (locating) {
    return (
      <main className="onboarding">
        <div className="location-icon loading-orbit"><LocateFixed /></div>
        <Label>{t.aiKicker}</Label>
        <h1>WeatherGPT</h1>
        <div className="location-wait"><span className="loading-spinner" />{t.locationWait}</div>
        <p>{t.locationSub}</p>
      </main>
    )
  }

  if (!started) {
    return (
      /* One screen, ask-first: the prompt box is the primary control, so the
         first thing a visitor can do is put a question to the assistant. The
         two location buttons still work exactly as before — they are the
         secondary path, not the only one. */
      <main className="onboarding onboarding-entry">
        <RainBackdrop />
        {/* Language is chosen here, before anything is asked — the dashboard is
            not the first place a Hindi or Telugu speaker should find it. Same
            control as the topbar's, so switching persists into the dashboard.
            The Demo control sits alongside it, so a scenario can be launched
            straight from the welcome screen. */}
        <div className="onboarding-langs">
          {demoControl}
          <div className="language-pills">
            {(['EN', 'हि', 'తె'] as Language[]).map((lang) => (
              <button
                key={lang}
                type="button"
                className={language === lang ? 'active' : ''}
                onClick={() => setLanguage(lang)}
                aria-pressed={language === lang}
              >
                {lang}
              </button>
            ))}
          </div>
        </div>

        <div className="onboarding-inner">
          <h1>WeatherGPT</h1>
          <p className="onboarding-tagline">{locationTimedOut ? t.locationTimedOut : t.aiTagline}</p>

          <form
            className="chat-input onboarding-ask"
            onSubmit={(e) => { e.preventDefault(); askAndBegin(onboardingAsk) }}
          >
            <WeatherBot condition={weather?.condition} rain={weather?.rain} size={26} className="chat-input-bot" />
            <input
              value={onboardingAsk}
              onChange={(e) => setOnboardingAsk(e.target.value)}
              placeholder={t.chatPlaceholder}
              aria-label={t.ask}
            />
            <button
              type="submit"
              className="chat-send"
              aria-label={t.chatSend}
              disabled={!onboardingAsk.trim()}
            >
              <Send size={14} />
              <span>{t.chatSend}</span>
            </button>
          </form>

          {/* Same prompt list the assistant offers, so the gate promises nothing
              the dashboard does not already answer. */}
          <div className="chat-suggestions onboarding-suggestions">
            {t.suggestions.slice(0, ONBOARDING_SUGGESTION_LIMIT).map((q) => (
              <button key={q} type="button" onClick={() => askAndBegin(q)}>{q}</button>
            ))}
          </div>

          <div className="onboarding-divider"><span>{t.orLabel}</span></div>

          <div className="onboarding-actions">
            <button className="button secondary" onClick={() => begin()}>
              <LocateFixed size={16} />{t.allow}
            </button>
            <button className="button secondary" onClick={() => begin(true)}>
              <Search size={16} />{t.manual}
            </button>
          </div>
          <small><ShieldCheck size={13} />{t.locationPrivacy}</small>
        </div>
        {demoModalNode}
      </main>
    )
  }

  const forecast = weather?.forecast?.length
    ? weather.forecast
    : [{ label: '+30m', value: 0 }, { label: '+60m', value: 0 }, { label: '+90m', value: 0 }]

  const riskText = { high: t.high, moderate: t.moderate, safe: t.safe }[risk]
  const trend = forecastTrend(forecast)

  // "Updated" is the provider's observation instant, carried in provenance
  // (updatedAt mirrors it). An unparseable timestamp shows as unknown rather
  // than as "Invalid Date".
  const observedAt = weather?.provenance?.observedAt || weather?.updatedAt
  const observedDate = observedAt ? new Date(observedAt) : null
  const lastUpdated = observedDate && !Number.isNaN(observedDate.getTime())
    ? observedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—'
  // Driven by the API's own availability report, so if a road/traffic feed is
  // ever wired up the row starts showing it without a UI change here.
  const roadTrafficValue =
    weather?.dataAvailability?.roadConditions === 'unavailable' ||
    weather?.dataAvailability?.trafficConditions === 'unavailable'
      ? t.notAvailable
      : '—'

  // Context handed to the assistant's chip strip. Built only from fields the
  // reading actually carries — no field is defaulted, so a chip that cannot be
  // sourced is simply not rendered. `undefined` while there is no reading at all.
  const chatContext: ChatContext | undefined = weather
    ? {
        area: weather.area,
        temperature: weather.temperature,
        condition: weather.condition,
        rain: weather.rain,
        risk: weather.risk,
        observedAt: observedAt,
        source: weather.provenance?.source || weather.source,
        labels: {
          noRain: t.none,
          risk: riskText,
          // Relative age of the provider's observation. Dropped when the
          // timestamp is unparseable.
          freshness: observedDate && !Number.isNaN(observedDate.getTime())
            ? `${t.updated} ${timeAgo(observedDate)}`
            : undefined,
        },
      }
    : undefined

  return (
    <main className="site-shell">
      <header className="topbar">
        {/* The logo is Home: it returns to the ask-first welcome screen, so a
            visitor who allowed location or searched is never stuck away from the
            entry point. The loaded reading stays in state meanwhile. */}
        <div
          className="brand"
          role="button"
          tabIndex={0}
          aria-label="Go to WeatherGPT home"
          title="Home"
          onClick={() => setStarted(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStarted(false) }
          }}
        >
          <div className="brand-mark"><Droplets size={15} /></div>
          <strong>WeatherGPT</strong>
          <span className="beta">HYDERABAD</span>
        </div>
        {/* Ordered to match the page order now that the assistant leads. */}
        <nav className="topnav">
          <a href="#ask">{t.askNav}</a>
          <a href="#alerts">{t.alertsTitle}</a>
          <a href="#map">{t.liveMapNav}</a>
        </nav>
        <div className="topbar-actions">
          {demoControl}
          <div className="language-pills">
            {(['EN', 'हि', 'తె'] as Language[]).map((lang) => (
              <button key={lang} className={language === lang ? 'active' : ''} onClick={() => setLanguage(lang)}>
                {lang}
              </button>
            ))}
          </div>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <Label>REAL-TIME WEATHER ANALYSIS</Label>
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
              ⚠️ {t.high} — {weather.area}. {weather.rainfallGuidance}
            </div>
          )}
          {weather && weather.risk === 'moderate' && (
            <div className="alert-banner moderate">
              ⚡ {t.moderate} — {weather.area}. {weather.rainfallGuidance}
            </div>
          )}
          {weather && weather.risk === 'safe' && (
            <div className="alert-banner safe">
              ✅ {t.safe} — {weather.area}.
            </div>
          )}
          {/* Outside the Hyderabad window the weather is real but the local
              advisory framing does not apply, so the difference is stated
              instead of implied. */}
          {weather && weather.inSupportedArea === false && (
            <div className="alert-banner notice">
              <Info size={14} />{t.coverageNotice}
            </div>
          )}
        </div>

        <Card className="hero-weather">
          <div className="card-top">
            {/* A simulated reading is labelled where the reading is, not only in
                the footer — the badge is the difference between a demo and a
                claim. Real readings render the bare kicker exactly as before.
                A span, not a div: `.card-top>div>.kicker` would break the row. */}
            {weather?.simulated ? (
              <span className="card-top-lead">
                <Label>{t.currentKicker}</Label>
                <span className="simulated-badge">SIMULATED</span>
              </span>
            ) : (
              <Label>{t.currentKicker}</Label>
            )}
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

      {/* The assistant is the product's primary surface, so it sits directly
          under the hero. ChatPanel is presentational: the messages, input,
          loading flag, scroll sentinel and submit handler are all the page's
          existing state — the chat logic is not forked. */}
      <section id="ask" className="wide-section primary-chat">
        <Card className="chat-card">
          <ChatPanel
            messages={chatMessages}
            input={chatInput}
            loading={chatLoading}
            onInputChange={setChatInput}
            onSubmit={handleChatSubmit}
            copy={{
              assistant: t.aiAssistant,
              title: t.ask,
              subtitle: t.aiSub,
              placeholder: t.chatPlaceholder,
              sending: t.sending,
              emptyHint: t.chatEmptyHint,
              contextLabel: t.chatContextLabel,
              send: t.chatSend,
            }}
            context={chatContext}
          />
        </Card>
      </section>

      <section className="results">
        <Label>{t.areaResults}</Label>
        <div className="results-grid">
          <Card className="conditions-card">
            {/* Each card names its information type, so current weather,
                forecast, alerts and climate never read as one blur. */}
            <div className="card-top">
              <div>
                <Label>{t.currentKicker}</Label>
                <h3>{t.currentConditions}</h3>
              </div>
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
              <div>
                <Label>{t.riskKicker}</Label>
                <h3>{t.advisoryTitle}</h3>
              </div>
              <span className="live"><i />LIVE</span>
            </div>
            <div className="risk-title">
              <span className="risk-dot" />{weather ? riskText : 'Loading...'}
            </div>
            {/* Rainfall-derived caution and an explicit statement of what is not
                measured. The previous three rows (road status / recommended action
                / estimated wait) asserted conditions this product never observes. */}
            <div className="info-list">
              <div>
                <CloudRain /><span>{t.guidance}</span>
                <b>{weather?.rainfallGuidance || '—'}</b>
              </div>
              <div>
                <Info /><span>{t.roadTraffic}</span>
                <b>{roadTrafficValue}</b>
              </div>
            </div>
          </Card>

          <Card className="forecast-card">
            <div className="card-top">
              <div>
                <Label>{t.forecastKicker}</Label>
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

      {/* Alerts are a pillar of the product, so they get their own surface
          between the readings and the map instead of living as a banner inside
          the hero. AlertSection is data-driven: it renders whatever the API can
          actually prove and states the gap when it cannot prove anything. */}
      <section id="alerts" className="wide-section alerts-section">
        <AlertSection
          /* Now wired: /api/weather returns officialAlerts + alertsAvailable
             (AccuWeather). The component shows official warnings when present,
             "none active" when AccuWeather was asked and returned none, and its
             "not connected" state only when AccuWeather could not be reached. */
          officialAlerts={weather?.officialAlerts}
          alertsAvailable={weather?.alertsAvailable}
          risk={weather?.risk}
          rainfallGuidance={weather?.rainfallGuidance}
          onAskAboutAlert={sendChat}
          copy={{
            kicker: t.alertsKicker,
            title: t.alertsTitle,
            subtitle: t.alertsSub,
            officialLabel: t.alertOfficialLabel,
            none: t.alertsNone,
            notConnected: t.alertsNotConnected,
            notConnectedSub: t.alertsNotConnectedSub,
            derivedLabel: t.alertDerivedLabel,
            derivedNote: t.alertDerivedNote,
            riskWord: riskText,
            severityLabel: t.alertSeverity,
            fromLabel: t.alertFrom,
            untilLabel: t.alertUntil,
            sourceLink: t.alertSourceLink,
            askCta: t.alertAskCta,
            askQuestion: t.alertAskQuestion,
          }}
        />

        {/* Climate pillar. The normals are published IMD figures for the city,
            not a record this app measured — ClimateCard says so in its footnote
            and places the live reading against the month's normal range. */}
        <ClimateCard
          temperature={weather?.temperature}
          rain={weather?.rain}
          inSupportedArea={weather?.inSupportedArea}
          locale={LOCALES[language]}
          copy={{
            kicker: t.climateKicker,
            title: t.climateTitle,
            typicalLabel: t.climateTypical,
            normalHigh: t.climateNormalHigh,
            normalLow: t.climateNormalLow,
            normalRain: t.climateNormalRain,
            seasonDry: t.climateSeasonDry,
            seasonHot: t.climateSeasonHot,
            seasonMonsoon: t.climateSeasonMonsoon,
            seasonPeak: t.climateSeasonPeak,
            todayLabel: t.climateToday,
            nowTemp: t.climateNowTemp,
            normalRange: t.climateNormalRange,
            warmer: t.climateWarmer,
            cooler: t.climateCooler,
            aboutNormal: t.climateAboutNormal,
            rainNow: t.climateRainNow,
            rainNote: t.climateRainNote,
            noReading: t.climateNoReading,
            source: t.climateSource,
            outsideArea: t.climateOutsideArea,
          }}
        />
      </section>

      <section id="map" className="map-section">
        <div className="section-title">
          <div>
            <Label>LIVE WEATHER · RAINFALL RADAR</Label>
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
          rain={weather?.rain}
          condition={weather?.condition}
          temperature={weather?.temperature}
        />
      </section>

      <footer>
        <span>{t.updated} {lastUpdated}</span>
      </footer>
      {demoModalNode}
    </main>
  )
}