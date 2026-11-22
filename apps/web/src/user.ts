import { ref } from 'vue'
import type { AuthMode, User } from '@slidango/shared'
import { ApiError, api } from './api'

export const currentUser = ref<User | null>(null)
/** Path the app was opened with, read before the router touches the URL. */
export const initialPath = window.location.pathname
/** `local`: the app shows its own login form; `oidc`: oauth2-proxy handles login. */
export const authMode = ref<AuthMode>('oidc')
/** Signed out: the start page shows public decks, every other page asks to sign in. */
export const needsLogin = ref(false)

export const userReady = (async () => {
  authMode.value = (await api.authConfig()).mode
  try {
    currentUser.value = await api.me()
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) needsLogin.value = true
    else throw e
  }
})()

/** Local accounts: the app's login form. SSO: oauth2-proxy, back to `next` afterwards. */
export function signIn(next: string = window.location.pathname + window.location.search) {
  if (authMode.value === 'local') {
    window.location.href = next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`
  } else {
    window.location.href = `/oauth2/sign_in?rd=${encodeURIComponent(new URL(next, window.location.origin).href)}`
  }
}

export async function logout() {
  if (authMode.value === 'local') await api.logout()
  // With SSO, oauth2-proxy ends the session.
  window.location.href = authMode.value === 'local' ? '/' : '/oauth2/sign_out'
}

/**
 * Stable per-user cursor colour from the design system's presence palette
 * (cursor-ochre, cursor-mint, cursor-blue; text on them is always on-cursor).
 * Teal (cursor-ai) is reserved for Slidango AI and never handed to a person.
 */
export const PRESENCE = ['#e3b061', '#7fd1ae', '#8fb3e6']
export function colorFor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return PRESENCE[Math.abs(hash) % PRESENCE.length]!
}
