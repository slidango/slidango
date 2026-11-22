<script setup lang="ts">
/** Deck settings → Template: switch to another template or another version of the current one. */
import { computed, onMounted, ref } from 'vue'
import type { Deck, Theme } from '@slidango/shared'
import { api } from '../api'
import { groupTemplates, templateLabel } from '../templates'

const props = defineProps<{ deck: Deck }>()
const emit = defineEmits<{ updated: [deck: Deck]; close: [] }>()
const themes = ref<Theme[]>([])
const busy = ref<string | null>(null)
const error = ref<string | null>(null)

const ready = computed(() => themes.value.filter((t) => t.status === 'ready'))
const current = computed(() => themes.value.find((t) => t.id === props.deck.themeId) ?? null)
const groups = computed(() => groupTemplates(ready.value))

async function switchTo(theme: Theme) {
  busy.value = theme.id
  error.value = null
  try {
    emit('updated', await api.setDeckTheme(props.deck.id, theme.id))
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = null
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
    <div class="current">
      <span class="eyebrow">Current</span>
      <strong>{{ templateLabel(themes, deck.themeId) }}</strong>
      <span v-if="current?.isDefault" class="badge">default</span>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <section v-for="group in groups" :key="group.name" class="group">
      <div class="group-head">
        <strong>{{ group.label }}</strong>
        <span v-if="group.builtin" class="badge">built-in</span>
        <code class="muted">{{ group.name }}</code>
      </div>
      <ol>
        <li v-for="theme in group.versions" :key="theme.id" :class="{ active: theme.id === deck.themeId }">
          <div class="row">
            <span class="version">{{ theme.version }}</span>
            <span v-if="theme.isDefault" class="badge">default</span>
            <span class="spacer" />
            <span v-if="theme.id === deck.themeId" class="muted in-use">In use</span>
            <button v-else-if="!deck.archived" :disabled="busy !== null" @click="switchTo(theme)">
              {{ busy === theme.id ? 'Switching …' : theme.name === current?.name ? 'Switch version' : 'Use' }}
            </button>
          </div>
          <p v-if="theme.changelog" class="changelog">{{ theme.changelog }}</p>
        </li>
      </ol>
    </section>
    <p v-if="groups.length === 0" class="muted hint">No templates installed. Admins upload them in Settings → Templates.</p>
    <p class="muted hint">Switching rewrites the deck's <code>theme:</code>, restarts the preview and is saved as a version. Layouts that the new template doesn't have are marked in the editor.</p>
  </aside>
</template>

<style scoped>
.panel { height: 100%; border-left: 1px solid var(--border); background: var(--surface); overflow: auto; }
header { display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0.75rem 0.6rem 1rem; border-bottom: 1px solid var(--border); background: var(--surface-2); }
h2 { font-size: 1rem; margin: 0; }
.current { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; padding: 0.8rem 1rem; border-bottom: 1px solid var(--border); }
.current .eyebrow { width: 100%; }
.error { color: var(--danger); padding: 0 1rem; }
.group { border-bottom: 1px solid var(--border); }
.group-head { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; padding: 0.7rem 1rem 0.3rem; }
.group-head code { font-size: 11.5px; }
ol { list-style: none; margin: 0; padding: 0 0 0.4rem; }
li { padding: 0.35rem 1rem; }
li.active { box-shadow: inset 2px 0 0 var(--tango); background: var(--hover); }
.row { display: flex; gap: 0.5rem; align-items: center; min-height: 2rem; }
.version { font: 500 13px/1.3 var(--font-mono); }
.spacer { flex: 1; }
.in-use { font: 400 12px var(--font-mono); }
.changelog { white-space: pre-wrap; font-size: 0.82rem; color: var(--ink-muted); margin: 0.1rem 0 0.3rem; }
.hint { font-size: 0.8rem; padding: 0.6rem 1rem 0; margin: 0; }
</style>
