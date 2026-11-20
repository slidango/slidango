<script setup lang="ts">
/** Admin settings (people, templates, LLM, running previews) as a modal over the current page. */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Theme } from '@slidango/shared'
import { api, type RunningPreview } from '../api'
import PeoplePanel from './PeoplePanel.vue'

const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const tab = ref<'people' | 'templates' | 'llm' | 'previews'>('people')
const tabs = [
  { id: 'people', label: 'People' },
  { id: 'templates', label: 'Templates' },
  { id: 'llm', label: 'Slidango AI' },
  { id: 'previews', label: 'Previews' },
] as const

const themes = ref<Theme[]>([])
const previews = ref<RunningPreview[]>([])
const version = ref('')
const changelog = ref('')
const file = ref<File | null>(null)
const uploading = ref(false)
const error = ref<string | null>(null)
const openLog = ref<string | null>(null)
const llm = ref({ baseUrl: '', model: '', apiKey: '', vision: false, hasApiKey: false })
const llmSaved = ref<string | null>(null)

async function loadLlm() {
  const settings = await api.admin.llmSettings()
  llm.value = { ...settings, apiKey: '' }
}

async function saveLlm() {
  llmSaved.value = null
  try {
    const settings = await api.admin.saveLlmSettings({
      baseUrl: llm.value.baseUrl,
      model: llm.value.model,
      apiKey: llm.value.apiKey || undefined,
      vision: llm.value.vision,
    })
    llm.value = { ...settings, apiKey: '' }
    llmSaved.value = 'Saved.'
  } catch (e) {
    llmSaved.value = `Error: ${(e as Error).message}`
  }
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

async function load() {
  ;[themes.value, previews.value] = await Promise.all([api.admin.themes(), api.admin.previews()])
}

async function upload() {
  if (!file.value) return
  uploading.value = true
  error.value = null
  try {
    await api.admin.uploadTheme(version.value, changelog.value, file.value)
    version.value = ''
    changelog.value = ''
    file.value = null
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    uploading.value = false
  }
}

async function makeDefault(v: string) {
  themes.value = await api.admin.setDefaultTheme(v)
}

// Installs run in the background; refresh while one is pending.
const timer = setInterval(() => {
  if (themes.value.some((t) => t.status === 'installing')) void load()
}, 3000)
onBeforeUnmount(() => clearInterval(timer))
onMounted(() => {
  dialog.value?.showModal()
  void Promise.all([load(), loadLlm()])
})
</script>

<template>
  <dialog ref="dialog" class="settings" aria-labelledby="settings-title" @close="emit('close')" @click.self="dialog?.close()">
    <div class="frame">
      <header>
        <h1 id="settings-title">Settings</h1>
        <nav class="tabs" role="tablist">
          <button v-for="t in tabs" :key="t.id" role="tab" :aria-selected="tab === t.id" :class="{ active: tab === t.id }" @click="tab = t.id">
            {{ t.label }}
          </button>
        </nav>
        <button class="ghost icon close" aria-label="Close" title="Close (Esc)" @click="dialog?.close()">✕</button>
      </header>
      <div class="body">
        <PeoplePanel v-if="tab === 'people'" />
        <template v-else-if="tab === 'templates'">
          <section>
            <h2>Template versions</h2>
            <table v-if="themes.length">
              <thead>
                <tr><th>Version</th><th>Package</th><th>Status</th><th>Uploaded</th><th /></tr>
              </thead>
              <tbody>
                <template v-for="theme in themes" :key="theme.version">
                  <tr>
                    <td>
                      <strong>{{ theme.version }}</strong>
                      <span v-if="theme.isDefault" class="badge">Default</span>
                      <div v-if="theme.changelog" class="muted changelog">{{ theme.changelog }}</div>
                    </td>
                    <td><code>{{ theme.name }}</code></td>
                    <td :class="theme.status">
                      {{ { installing: 'Installing …', ready: 'Ready', failed: 'Failed' }[theme.status] }}
                    </td>
                    <td class="muted">{{ dateFormat.format(new Date(theme.uploadedAt)) }}</td>
                    <td class="actions">
                      <button v-if="theme.status === 'ready' && !theme.isDefault" @click="makeDefault(theme.version)">Make default</button>
                      <button v-if="theme.log" @click="openLog = openLog === theme.version ? null : theme.version">Log</button>
                    </td>
                  </tr>
                  <tr v-if="openLog === theme.version">
                    <td colspan="5"><pre>{{ theme.log }}</pre></td>
                  </tr>
                </template>
              </tbody>
            </table>
            <p v-else class="muted">No template yet. Decks use the default Slidev theme.</p>
          </section>

          <section>
            <h2>Upload a template</h2>
            <p class="muted">
              A Slidev theme as .zip or .tgz (max. 50 MB) with <code>package.json</code>, <code>guide.md</code> and optionally
              <code>starter.md</code>. After the upload it is installed and tested with the starter deck.
            </p>
            <form class="upload" @submit.prevent="upload">
              <input v-model="version" placeholder="Version, e.g. 1.4.0" required pattern="[0-9A-Za-z][0-9A-Za-z._\-]{0,63}" />
              <textarea v-model="changelog" placeholder="Changelog" rows="3" />
              <input type="file" accept=".zip,.tgz,.tar.gz" required @change="file = ($event.target as HTMLInputElement).files?.[0] ?? null" />
              <div>
                <button class="primary" type="submit" :disabled="uploading || !file || !version">
                  {{ uploading ? 'Uploading …' : 'Upload' }}
                </button>
                <span v-if="error" class="error">{{ error }}</span>
              </div>
            </form>
          </section>
        </template>
        <template v-else-if="tab === 'llm'">
          <section>
            <h2>LLM endpoint</h2>
            <p class="muted">Any OpenAI-compatible endpoint (Chat Completions with tools). Deck content and briefings are sent to this endpoint.</p>
            <form class="upload" @submit.prevent="saveLlm">
              <label>Base URL<input v-model="llm.baseUrl" type="url" required placeholder="https://api.example.com/v1" /></label>
              <label>Model<input v-model="llm.model" required /></label>
              <label>
                API key
                <input v-model="llm.apiKey" type="password" autocomplete="off" :placeholder="llm.hasApiKey ? 'saved – leave empty to keep' : 'optional'" />
              </label>
              <label class="check"><input v-model="llm.vision" type="checkbox" /> Model understands images (send briefing images)</label>
              <div>
                <button class="primary" type="submit">Save</button>
                <span v-if="llmSaved" class="muted saved">{{ llmSaved }}</span>
              </div>
            </form>
          </section>
        </template>
        <template v-else>
          <section>
            <h2>Running previews</h2>
            <table v-if="previews.length">
              <thead>
                <tr><th>Deck</th><th>Template</th><th>Port</th><th>Status</th><th>Last active</th></tr>
              </thead>
              <tbody>
                <tr v-for="p in previews" :key="p.deckId">
                  <td><RouterLink :to="`/decks/${p.deckId}`">{{ p.deckId.slice(0, 8) }}</RouterLink></td>
                  <td>{{ p.themeVersion ?? 'Default' }}</td>
                  <td>{{ p.port }}</td>
                  <td>{{ p.status }}</td>
                  <td class="muted">{{ dateFormat.format(new Date(p.lastActive)) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">None.</p>
          </section>
        </template>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.settings { border: 1px solid var(--line); padding: 0; border-radius: var(--radius-lg); width: min(54rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); box-shadow: var(--shadow); background: var(--surface); color: var(--text); }
.frame { display: flex; flex-direction: column; height: min(40rem, calc(100dvh - 2rem)); }
header { display: flex; align-items: center; gap: 1rem; padding: 0.8rem 0.8rem 0 1.25rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
h1 { font-size: 1.2rem; margin: 0 0 0.6rem; }
.tabs { display: flex; gap: 0.2rem; flex: 1; align-self: flex-end; }
.tabs button { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none !important; padding: 0.45rem 0.7rem; color: var(--muted); font-weight: 500; }
.tabs button:hover { color: var(--text); background: none; }
.tabs button.active { color: var(--ink); border-bottom-color: var(--tango); }
.close { margin-bottom: 0.6rem; }
.body { overflow: auto; padding: 0.5rem 1.25rem 1.25rem; }
section + section { border-top: 1px solid var(--border); margin-top: 1rem; padding-top: 0.5rem; }
h2 { font-size: 1.05rem; margin: 0.6rem 0 0.3rem; }
.upload { display: grid; gap: 0.5rem; max-width: 32rem; }
.upload label { display: grid; gap: 0.2rem; font-size: 0.85rem; }
.upload label.check { display: flex; gap: 0.4rem; align-items: center; }
.saved { margin-left: 0.5rem; }
textarea { font: inherit; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 0.4rem 0.6rem; }
.error { color: var(--danger); margin-left: 0.5rem; }
table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
th { font: 500 12px/1.3 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); background: var(--surface-2); }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
.badge { margin-left: 0.4rem; }
.changelog { white-space: pre-wrap; font-size: 0.85rem; }
.ready { color: var(--success); }
.failed { color: var(--danger); }
.actions { display: flex; gap: 0.4rem; }
pre { font-size: 12px; background: var(--code-bg); color: var(--code-ink); padding: var(--space-3); border-radius: var(--radius-sm); white-space: pre-wrap; max-height: 24rem; overflow: auto; margin: 0; }
</style>
