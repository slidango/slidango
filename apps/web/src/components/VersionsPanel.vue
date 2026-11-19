<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type Version } from '../api'

const props = defineProps<{ deckId: string; readOnly: boolean }>()
const emit = defineEmits<{ close: [] }>()
const versions = ref<Version[]>([])
const confirming = ref<string | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

async function load() {
  versions.value = await api.versions(props.deckId)
}

async function restore(sha: string) {
  busy.value = true
  error.value = null
  try {
    await api.restore(props.deckId, sha)
    confirming.value = null
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <aside class="versions" data-testid="versions">
    <header>
      <h2>Versions</h2>
      <button class="ghost icon" title="Close" aria-label="Close" @click="emit('close')">✕</button>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <ol>
      <li v-for="(version, i) in versions" :key="version.sha">
        <div class="message">{{ version.message }}</div>
        <div class="muted meta">{{ version.author }} · {{ dateFormat.format(new Date(version.date)) }}</div>
        <template v-if="i > 0 && !readOnly">
          <div v-if="confirming === version.sha" class="confirm">
            <span>Replace the current state for everyone?</span>
            <button class="primary" :disabled="busy" @click="restore(version.sha)">Restore</button>
            <button :disabled="busy" @click="confirming = null">Cancel</button>
          </div>
          <button v-else class="link" @click="confirming = version.sha">Restore …</button>
        </template>
      </li>
      <li v-if="versions.length === 0" class="muted">No versions yet.</li>
    </ol>
  </aside>
</template>

<style scoped>
.versions { height: 100%; border-left: 1px solid var(--border); background: var(--surface); overflow: auto; }
header { display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0.75rem 0.6rem 1rem; border-bottom: 1px solid var(--border); background: var(--surface-2); }
h2 { font-size: 1rem; margin: 0; }
ol { list-style: none; margin: 0; padding: 0; }
li { padding: 0.6rem 1rem; border-bottom: 1px solid var(--border); }
.meta { font-size: 0.8rem; margin: 0.15rem 0 0.35rem; }
.confirm { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; font-size: 0.85rem; }
.link { border: none; padding: 0; color: var(--accent); background: none !important; font-size: 0.85rem; }
.error { color: var(--danger); padding: 0 1rem; }
</style>
