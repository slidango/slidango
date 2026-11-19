import { ref } from 'vue'
import type { User } from '@slidango/shared'
import { ApiError, api } from './api'

export const currentUser = ref<User | null>(null)
/** `password`: the app shows its own login form; `oidc`: oauth2-proxy handles login. */
export const authMode = ref<'oidc' | 'password'>('oidc')
export const needsLogin = ref(false)

export const userReady = (async () => {
  authMode.value = (await api.authConfig()).mode
  try {
    currentUser.value = await api.me()
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && authMode.value === 'password') needsLogin.value = true
    else throw e
  }
})()

export async function logout() {
  await api.logout()
  window.location.href = '/'
}

/**
 * Stable per-user cursor colour from the design system's presence palette
 * (cursor-ochre, cursor-mint, cursor-blue; text on them is always on-cursor).
 * Teal (cursor-ai) is reserved for Slidango AI and never handed to a person.
 */
const PRESENCE = ['#e3b061', '#7fd1ae', '#8fb3e6']
export function colorFor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return PRESENCE[Math.abs(hash) % PRESENCE.length]!
}
