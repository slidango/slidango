<script setup lang="ts">
import { ref } from 'vue'
import { appErrors, dismissError } from './errors'
import { useRouter } from 'vue-router'
import { authMode, currentUser, initialPath, needsLogin, signIn, userReady } from './user'
import PublicHome from './views/PublicHome.vue'
import InviteView from './views/InviteView.vue'
import LoginView from './views/LoginView.vue'

// Invitation and reset links work signed in or not, so they are handled before the login gate.
const inviteToken = /^\/invite\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname)?.[1] ?? null
const error = ref<string | null>(null)
const router = useRouter()
userReady.then(
  () => {
    // Signed in on /login (e.g. an old bookmark): go to the decks.
    if (currentUser.value && initialPath === '/login') void router.replace('/')
    // SSO, signed out, a page other than the start page: oauth2-proxy's login, then back here.
    if (needsLogin.value && authMode.value !== 'local' && initialPath !== '/') signIn()
  },
  (e: Error) => (error.value = e.message),
)
</script>

<template>
  <InviteView v-if="inviteToken" :token="inviteToken" />
  <div v-else-if="error" class="fatal">Sign-in failed: {{ error }}</div>
  <PublicHome v-else-if="needsLogin && initialPath === '/'" />
  <LoginView v-else-if="needsLogin && authMode === 'local'" />
  <RouterView v-else-if="currentUser" />
  <div class="errors" role="alert" aria-live="assertive">
    <div v-for="item in appErrors" :key="item.id" class="error-toast">
      <span>{{ item.message }}</span>
      <button title="Dismiss" aria-label="Dismiss" @click="dismissError(item.id)">✕</button>
    </div>
  </div>
</template>

<style scoped>
.errors { position: fixed; bottom: calc(1rem + env(safe-area-inset-bottom, 0px)); left: 50%; transform: translateX(-50%); display: grid; gap: 0.5rem; z-index: 100; width: min(36rem, calc(100vw - 2rem)); }
.error-toast { display: flex; gap: 0.75rem; align-items: center; justify-content: space-between; background: var(--surface-card); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 0.6rem 0.8rem; box-shadow: var(--shadow-pop); }
.error-toast span::before { content: ''; display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--danger); margin-right: 0.6rem; vertical-align: 0.05em; }
.error-toast button { background: none; border: none; color: var(--ink-muted); }
</style>
