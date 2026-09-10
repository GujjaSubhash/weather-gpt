/**
 * Speech input and output via the Web Speech API.
 *
 * Browser-native on purpose: no new dependency, no API key, no per-request
 * cost, and no microphone audio leaving the device. The trade-off is uneven
 * language support, which this module surfaces rather than hides.
 *
 * ── THE HONESTY RULE ──
 * Telugu and Hindi voices are not installed everywhere. The tempting failure is
 * to fall back to an English voice, which then reads Telugu text as English
 * phonemes and produces confident-sounding nonsense. So `findVoice` returns
 * null instead of a wrong-language voice, `speak` refuses rather than mangling,
 * and the UI hides the control when support is genuinely absent. A missing
 * button is honest; a button that produces gibberish is not.
 *
 * Client-only — every export touches `window` and must not run during SSR.
 */

export type SpeechLang = 'en' | 'hi' | 'te';

/**
 * BCP-47 tags. The -IN region matters: en-IN gets an Indian English voice,
 * which reads Hyderabad place names far better than en-US.
 */
export const SPEECH_LOCALE: Record<SpeechLang, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  te: 'te-IN',
};

/** Fallback locales tried when the exact tag has no voice, same language only. */
const LOCALE_FALLBACKS: Record<SpeechLang, string[]> = {
  en: ['en-IN', 'en-GB', 'en-US', 'en'],
  hi: ['hi-IN', 'hi'],
  te: ['te-IN', 'te'],
};

// ── Speech recognition (input) ────────────────────────────────────────────────

/**
 * Minimal shape of the events actually used. The DOM lib does not ship
 * SpeechRecognition types (it is still prefixed in every shipping browser), so
 * the surface is declared here rather than pulling in a types package.
 */
type RecognitionResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type RecognitionErrorEvent = { error: string };

export type SpeechRecognitionHandle = {
  start: () => void;
  stop: () => void;
};

type RecognitionCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Whether this browser can listen at all.
 *
 * Note this cannot tell you whether a given LANGUAGE will be recognized well —
 * the API exposes no capability query, and an unsupported language typically
 * yields poor transcripts rather than an error. Chrome and Edge support all
 * three; Firefox and (as of writing) Safari support none.
 */
export function isListeningSupported(): boolean {
  return recognitionCtor() !== null;
}

/**
 * Start one dictation and hand back the final transcript.
 *
 * Single-utterance: `continuous = false` means recognition ends on its own when
 * the speaker stops, which suits a chat box better than an open microphone.
 * Returns null when unsupported, so callers can branch without a try/catch.
 */
export function listenOnce(
  lang: SpeechLang,
  handlers: {
    onResult: (transcript: string) => void;
    onError?: (code: string) => void;
    onEnd?: () => void;
  }
): SpeechRecognitionHandle | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.lang = SPEECH_LOCALE[lang];
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript;
    if (typeof transcript === 'string' && transcript.trim()) {
      handlers.onResult(transcript.trim());
    }
  };
  recognition.onerror = (event) => handlers.onError?.(event.error);
  recognition.onend = () => handlers.onEnd?.();

  try {
    recognition.start();
  } catch {
    // start() throws if called while already running. Nothing useful to report.
    return null;
  }

  return {
    start: () => recognition.start(),
    // stop() finishes the utterance and still fires onresult; abort() discards.
    stop: () => recognition.stop(),
  };
}

// ── Speech synthesis (output) ────────────────────────────────────────────────

export function isSpeakingSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * A voice that genuinely speaks `lang`, or null.
 *
 * Chrome populates the voice list asynchronously, so an early call can see an
 * empty array — `onVoicesReady` exists for that. Matching is prefix-based on
 * the language subtag, never cross-language: for 'te' only a te-* voice will
 * do, and English is never substituted.
 */
export function findVoice(lang: SpeechLang): SpeechSynthesisVoice | null {
  if (!isSpeakingSupported()) return null;

  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const normalized = (tag: string) => tag.toLowerCase().replace('_', '-');

  for (const wanted of LOCALE_FALLBACKS[lang]) {
    const target = normalized(wanted);
    const hit = voices.find((v) => {
      const have = normalized(v.lang);
      return have === target || have.startsWith(`${target}-`);
    });
    if (hit) return hit;
  }
  return null;
}

/**
 * Run `callback` once the voice list is populated, and whenever it changes.
 * Returns an unsubscribe function. Fires immediately if voices are already in.
 */
export function onVoicesReady(callback: () => void): () => void {
  if (!isSpeakingSupported()) return () => {};

  if (window.speechSynthesis.getVoices().length) callback();
  window.speechSynthesis.addEventListener('voiceschanged', callback);
  return () => window.speechSynthesis.removeEventListener('voiceschanged', callback);
}

/** True when this browser can actually speak `lang` in that language. */
export function canSpeak(lang: SpeechLang): boolean {
  return findVoice(lang) !== null;
}

/**
 * Speak `text` in `lang`. Returns false if it could not be done correctly —
 * which the caller should treat as "hide the control", never as "speak it in
 * whatever voice is lying around".
 *
 * Any utterance already in flight is cancelled first, so tapping speak on a
 * second message replaces the first rather than queueing behind it.
 */
export function speak(
  text: string,
  lang: SpeechLang,
  onDone?: () => void
): boolean {
  if (!isSpeakingSupported() || !text.trim()) return false;

  const voice = findVoice(lang);
  if (!voice) return false;

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  // Slightly under default: weather replies carry numbers and place names, and
  // the stock rate runs them together.
  utterance.rate = 0.95;
  utterance.onend = () => onDone?.();
  utterance.onerror = () => onDone?.();

  window.speechSynthesis.speak(utterance);
  return true;
}

/** Stop whatever is being spoken. Safe to call when nothing is. */
export function stopSpeaking(): void {
  if (isSpeakingSupported()) window.speechSynthesis.cancel();
}
