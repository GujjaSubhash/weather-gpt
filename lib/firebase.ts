import { initializeApp, getApps, getApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getAuth, signInAnonymously } from 'firebase/auth'
import { PUBLIC_ENV } from '@/lib/env.public'

/**
 * Config comes from `PUBLIC_ENV` rather than inline `process.env` reads so the
 * public variable surface has exactly one declaration site (lib/env.public.ts),
 * which is what the schema-agreement check in lib/env.ts is written against.
 */
const firebaseConfig = {
  apiKey: PUBLIC_ENV.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: PUBLIC_ENV.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: PUBLIC_ENV.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: PUBLIC_ENV.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: PUBLIC_ENV.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: PUBLIC_ENV.NEXT_PUBLIC_FIREBASE_APP_ID,
}

const app = getApps().length ? getApp() : initializeApp(firebaseConfig)
export const db = getFirestore(app)

/**
 * Anonymous identity for citizen reports.
 *
 * firestore.rules requires `request.auth != null` and `uid == request.auth.uid`
 * on create, so a report cannot be written — or attributed to someone else —
 * without one. The promise is memoized, so a session signs in at most once no
 * matter how many reports are submitted. A failed sign-in is not cached, which
 * lets a later submit retry rather than being stuck with a rejected promise.
 */
let uidPromise: Promise<string> | null = null

export function getAuthedUid(): Promise<string> {
  if (uidPromise) return uidPromise

  const auth = getAuth(app)
  const existing = auth.currentUser?.uid
  if (existing) {
    uidPromise = Promise.resolve(existing)
    return uidPromise
  }

  uidPromise = signInAnonymously(auth)
    .then((cred) => cred.user.uid)
    .catch((err) => {
      uidPromise = null
      throw err
    })

  return uidPromise
}
