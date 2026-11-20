<script setup lang="ts">
import { onMounted, ref } from 'vue'
import BrandLogo from '../components/BrandLogo.vue'
import { api } from '../api'
import { currentUser, needsLogin } from '../user'

const props = defineProps<{ token: string }>()

const info = ref<{ email: string; purpose: 'invite' | 'reset' } | null>(null)
const loadError = ref<string | null>(null)
const name = ref('')
const password = ref('')
const repeat = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

onMounted(async () => {
  try {
    const invite = await api.invite(props.token)
    info.value = invite
    name.value = invite.name
  } catch (e) {
    loadError.value = (e as Error).message
  }
})

async function submit() {
  error.value = null
  if (password.value !== repeat.value) {
    error.value = 'The passwords don’t match.'
    return
  }
  busy.value = true
  try {
    const { user } = await api.acceptInvite(props.token, { name: name.value, password: password.value })
    currentUser.value = user
    needsLogin.value = false
    window.history.replaceState(null, '', '/')
    window.location.reload()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="invite">
    <form class="card" @submit.prevent="submit">
      <BrandLogo :size="22" wordmark class="logo" />
      <template v-if="loadError">
        <h1>Link <em>expired.</em></h1>
        <p class="muted">{{ loadError }}</p>
        <a class="back" href="/">Go to sign-in</a>
      </template>
      <template v-else-if="info">
        <h1 v-if="info.purpose === 'invite'">Welcome <em>aboard.</em></h1>
        <h1 v-else>New <em>password.</em></h1>
        <p class="muted">
          {{ info.purpose === 'invite' ? 'Set up your account for' : 'Choose a new password for' }} <strong>{{ info.email }}</strong>.
        </p>
        <input type="email" :value="info.email" autocomplete="username" hidden readonly />
        <label>
          Name
          <input v-model="name" autocomplete="name" required maxlength="100" :autofocus="!name" />
        </label>
        <label>
          Password
          <input v-model="password" type="password" autocomplete="new-password" required minlength="10" />
        </label>
        <label>
          Repeat password
          <input v-model="repeat" type="password" autocomplete="new-password" required minlength="10" />
        </label>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="primary" type="submit" :disabled="busy">{{ info.purpose === 'invite' ? 'Create account' : 'Set password' }}</button>
        <p class="muted hint">At least 10 characters. Your name is shown to others in presence, versions and the AI history.</p>
      </template>
      <p v-else class="muted">Checking the link …</p>
    </form>
  </main>
</template>

<style scoped>
.invite { min-height: 100vh; display: grid; place-items: center; padding: 1rem; background: radial-gradient(circle, var(--line) 1.2px, transparent 1.3px) 0 0 / 24px 24px, var(--surface-000); }
.card { width: min(26rem, 100%); display: grid; gap: var(--space-4); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-8) var(--space-6); }
.logo { justify-self: start; margin-bottom: var(--space-2); }
h1 { margin: 0; font-size: 32px; line-height: 1.15; font-weight: 700; letter-spacing: -0.03em; }
h1 em { font-family: var(--font-serif); font-style: italic; font-weight: 400; letter-spacing: -0.01em; }
p { margin: 0; }
label { display: grid; gap: 0.3rem; font-size: 13px; color: var(--ink-muted); }
.error { color: var(--danger); }
.hint { font-size: 0.8rem; }
.back { color: var(--tango); }
</style>
