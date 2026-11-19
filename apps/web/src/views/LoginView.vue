<script setup lang="ts">
import { ref } from 'vue'
import BrandLogo from '../components/BrandLogo.vue'
import { api } from '../api'
import { currentUser, needsLogin } from '../user'

// Name and e-mail are remembered so returning users only type the password.
const STORAGE_KEY = 'slidango:login'
const LEGACY_STORAGE_KEY = 'slidev-collab:login' // before the rename to Slidango
function remembered(): { name?: string; email?: string } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

const name = ref(remembered().name ?? '')
const email = ref(remembered().email ?? '')
const password = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

async function submit() {
  error.value = null
  busy.value = true
  try {
    const next = new URLSearchParams(window.location.search).get('next') ?? undefined
    const result = await api.login({ name: name.value, email: email.value, password: password.value, next })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: name.value, email: email.value }))
    } catch {
      // storage unavailable (private mode): nothing to remember
    }
    // Previews live on other hosts; leave the SPA for them.
    if (result.next && new URL(result.next).origin !== window.location.origin) {
      window.location.href = result.next
      return
    }
    if (next !== undefined) {
      const target = result.next ? new URL(result.next) : null
      window.history.replaceState(null, '', target ? target.pathname + target.search + target.hash : '/')
    }
    currentUser.value = result.user
    needsLogin.value = false
  } catch (e) {
    error.value = (e as Error).message
    password.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="login">
    <form class="card" @submit.prevent="submit">
      <BrandLogo :size="22" wordmark class="logo" />
      <h1>Write <em>together.</em></h1>
      <label>
        Name
        <input v-model="name" autocomplete="name" required maxlength="100" :autofocus="!name" />
      </label>
      <label>
        Email
        <input v-model="email" type="email" autocomplete="email" required maxlength="200" />
      </label>
      <label>
        Password
        <input v-model="password" type="password" autocomplete="current-password" required :autofocus="!!name" />
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="submit" :disabled="busy">Sign in</button>
      <p class="muted hint">Your name and email are shown to others in presence, versions and the AI history.</p>
    </form>
  </main>
</template>

<style scoped>
.login { min-height: 100vh; display: grid; place-items: center; padding: 1rem; background: radial-gradient(circle, var(--line) 1.2px, transparent 1.3px) 0 0 / 24px 24px, var(--surface-000); }
.card { width: min(24rem, 100%); display: grid; gap: var(--space-4); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-8) var(--space-6); }
.logo { justify-self: start; margin-bottom: var(--space-2); }
h1 { margin: 0; font-size: 32px; line-height: 1.15; font-weight: 700; letter-spacing: -0.03em; }
h1 em { font-family: var(--font-serif); font-style: italic; font-weight: 400; letter-spacing: -0.01em; }
label { display: grid; gap: 0.3rem; font-size: 13px; color: var(--ink-muted); }
.error { margin: 0; color: var(--danger); }
.hint { margin: 0; font-size: 0.8rem; }
</style>
