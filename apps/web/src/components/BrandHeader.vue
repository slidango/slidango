<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { currentUser, logout } from '../user'
import { theme, toggleTheme } from '../composables/theme'
import AccountDialog from './AccountDialog.vue'
import BrandLogo from './BrandLogo.vue'
import MenuButton from './MenuButton.vue'
import SettingsDialog from './SettingsDialog.vue'

/** Headline rule: `title` in bold sans, `accent` (one punchline) in italic serif. */
defineProps<{ title: string; accent?: string; subtitle?: string }>()

const route = useRoute()
const router = useRouter()
// Old /admin links land here with ?settings and open the dialog directly.
const settingsOpen = ref(route.query.settings !== undefined)
const account = ref<null | 'profile' | 'tokens'>(null)

function closeSettings() {
  settingsOpen.value = false
  if (route.query.settings !== undefined) void router.replace({ query: { ...route.query, settings: undefined } })
}
</script>

<template>
  <header class="brand-header">
    <div class="bar">
      <RouterLink to="/" class="logo" aria-label="slidango, all decks"><BrandLogo :size="20" wordmark /></RouterLink>
      <span class="spacer" />
      <button
        class="round-button"
        :title="theme === 'dark' ? 'Light theme' : 'Dark theme'"
        :aria-label="theme === 'dark' ? 'Light theme' : 'Dark theme'"
        @click="toggleTheme"
      >
        <svg v-if="theme === 'dark'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        </svg>
      </button>
      <MenuButton :label="currentUser?.name ?? 'Account'" title="Account" class="account-menu">
        <template #label><span class="user">{{ currentUser?.name }}</span></template>
        <button @click="account = 'profile'">Account</button>
        <button @click="account = 'tokens'">API tokens <span class="muted">MCP</span></button>
        <hr />
        <button @click="logout">Sign out</button>
      </MenuButton>
      <button v-if="currentUser?.isAdmin" class="round-button" title="Settings" aria-label="Settings" @click="settingsOpen = true">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.1.1-1.4-.1-1.4 2-1.6-2-3.4-2.4 1a8 8 0 0 0-2.4-1.4L14.3 2h-4l-.4 2.6a8 8 0 0 0-2.4 1.4l-2.4-1-2 3.4 2 1.6-.1 1.4.1 1.4-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2.4 1.4l.4 2.6h4l.4-2.6a8 8 0 0 0 2.4-1.4l2.4 1 2-3.4-2-1.6Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
    <div class="hero">
      <h1>{{ title }}{{ accent ? ' ' : '' }}<em v-if="accent" class="display-italic">{{ accent }}</em></h1>
      <p v-if="subtitle">{{ subtitle }}</p>
      <slot />
    </div>
    <SettingsDialog v-if="settingsOpen" @close="closeSettings" />
    <AccountDialog v-if="account" :initial-tab="account" @close="account = null" />
  </header>
</template>

<style scoped>
.brand-header {
  /* Dot grid (line-coloured 1.2px dots, 24px pitch): the system's only background pattern. */
  background:
    radial-gradient(circle, var(--line) 1.2px, transparent 1.3px) 0 0 / 24px 24px,
    var(--surface-000);
  border-bottom: 1px solid var(--line);
  color: var(--ink);
  padding: 0 max(1rem, calc((100vw - 1100px) / 2));
  padding-top: env(safe-area-inset-top, 0px);
}
.bar { display: flex; align-items: center; gap: var(--space-3); height: 56px; }
.logo { display: flex; padding: var(--space-1) 0; }
.spacer { flex: 1; }
.user { font: 500 12px/1.3 var(--font-mono); color: var(--ink-muted); }
.account-menu :deep(> button) { width: auto; padding: 0.3rem 0.7rem; border-radius: var(--radius-pill); border-color: var(--line); background: transparent; }
.account-menu :deep(> button:hover) { border-color: var(--line-strong); background: var(--hover); }
.round-button { display: grid; place-items: center; width: 2rem; height: 2rem; padding: 0; border-radius: var(--radius-pill); background: transparent; border-color: var(--line); color: var(--ink-muted); }
.round-button:hover:not(:disabled) { color: var(--ink); border-color: var(--line-strong); background: var(--hover); }
.hero { padding: var(--space-12) 0 var(--space-12); }
.hero h1, .hero p { max-width: 40rem; }
.hero h1 { font-size: clamp(2rem, 4.4vw, 3rem); line-height: 1.05; letter-spacing: -0.03em; font-weight: 700; margin: 0 0 var(--space-3); }
.hero h1 em { font-style: italic; }
.hero p { margin: 0; color: var(--ink-muted); font-size: 18px; line-height: 1.5; }
@media (max-width: 600px) {
  .user { display: inline-block; max-width: 7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  .hero { padding: var(--space-6) 0 var(--space-8); }
}
</style>
