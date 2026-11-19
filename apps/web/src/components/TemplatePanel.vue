<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Deck, Theme } from '@slidango/shared'
import { api } from '../api'

const props = defineProps<{ deck: Deck }>()
const emit = defineEmits<{ updated: [deck: Deck]; close: [] }>()
const themes = ref<Theme[]>([])
const busy = ref(false)
const error = ref<string | null>(null)

const current = computed(() => themes.value.find((t) => t.version === props.deck.themeVersion) ?? null)
const others = computed(() => themes.value.filter((t) => t.version !== props.deck.themeVersion))

async function switchTo(version: string) {
  busy.value = true
  error.value = null
  try {
    emit('updated', await api.setDeckTheme(props.deck.id, version))
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

onMounted(async () => (themes.value = await api.themes()))
</script>

<template>
  <aside class="panel" data-testid="template-panel">
    <header>
      <h2>Template</h2>
      <button class="ghost icon" title="Close" aria-label="Close" @click="emit('close')">✕</button>
    </header>
    <p class="current">
      Current: <strong>{{ deck.themeVersion ?? 'Slidev default' }}</strong>
      <span v-if="current?.isDefault" class="muted">(Default)</span>
    </p>
    <p v-if="error" class="error">{{ error }}</p>
    <ol>
      <li v-for="theme in others" :key="theme.version">
        <div class="title">
          <strong>{{ theme.version }}</strong>
          <span v-if="theme.isDefault" class="badge">Default</span>
        </div>
        <p v-if="theme.changelog" class="changelog">{{ theme.changelog }}</p>
        <button v-if="!deck.archived" :disabled="busy" @click="switchTo(theme.version)">
          {{ busy ? 'Switching …' : `Switch to ${theme.version}` }}
        </button>
      </li>
      <li v-if="others.length === 0" class="muted">No other template versions.</li>
    </ol>
    <p class="muted hint">Switching restarts the preview and is saved as a version.</p>
  </aside>
</template>

<style scoped>
.panel { height: 100%; border-left: 1px solid var(--border); background: var(--surface); overflow: auto; }
header { display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0.75rem 0.6rem 1rem; border-bottom: 1px solid var(--border); background: var(--surface-2); }
h2 { font-size: 1rem; margin: 0; }
.current, .hint, .error { padding: 0 1rem; }
.error { color: var(--danger); }
ol { list-style: none; margin: 0; padding: 0; }
li { padding: 0.6rem 1rem; border-top: 1px solid var(--border); }
.title { display: flex; gap: 0.4rem; align-items: center; }

.changelog { white-space: pre-wrap; font-size: 0.85rem; margin: 0.3rem 0 0.5rem; }
.hint { font-size: 0.8rem; }
</style>
