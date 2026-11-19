<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BriefingFields, BriefingFile, OutlineItem } from '@slidango/shared'
import { api } from '../api'
import { streamLlm } from '../llm'

const props = defineProps<{ deckId: string; empty: boolean; readOnly: boolean }>()
const emit = defineEmits<{ phase: [phase: Phase] }>()

type Phase = 'briefing' | 'outlining' | 'outline' | 'drafting' | 'done'
const phase = ref<Phase>('briefing')
const fields = ref<BriefingFields | null>(null)
const files = ref<BriefingFile[]>([])
const sizeMode = ref<'slides' | 'minutes'>('slides')
const outline = ref<OutlineItem[]>([])
const remarks = ref('')
const layouts = ref<string[]>([])
const progress = ref<{ index: number; title: string; warning?: string }[]>([])
const total = ref(0)
const error = ref<string | null>(null)
const uploading = ref(false)
let controller: AbortController | null = null

watch(phase, (value) => emit('phase', value), { immediate: true })

onMounted(async () => {
  const [briefing, available] = await Promise.all([api.briefing(props.deckId), api.layouts(props.deckId)])
  fields.value = briefing.fields
  files.value = briefing.files
  sizeMode.value = briefing.fields.durationMinutes && !briefing.fields.slideCount ? 'minutes' : 'slides'
  layouts.value = available
})
onBeforeUnmount(() => controller?.abort())

let saveTimer: ReturnType<typeof setTimeout> | undefined
watch(
  fields,
  (value, old) => {
    if (!value || !old || props.readOnly) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void api.saveBriefing(props.deckId, value), 600)
  },
  { deep: true },
)

function setSize(value: string) {
  const n = value ? Number(value) : null
  if (!fields.value) return
  if (sizeMode.value === 'slides') Object.assign(fields.value, { slideCount: n, durationMinutes: null })
  else Object.assign(fields.value, { durationMinutes: n, slideCount: null })
}

async function addFiles(event: Event) {
  const input = event.target as HTMLInputElement
  uploading.value = true
  error.value = null
  try {
    for (const file of input.files ?? []) files.value.push(await api.uploadBriefingFile(props.deckId, file))
  } catch (e) {
    error.value = `Upload failed: ${(e as Error).message}`
  } finally {
    uploading.value = false
    input.value = ''
  }
}

async function removeFile(id: string) {
  await api.deleteBriefingFile(props.deckId, id)
  files.value = files.value.filter((f) => f.id !== id)
}

async function run(path: string, body: unknown, onDone: () => void) {
  error.value = null
  controller = new AbortController()
  let failed = false
  try {
    await streamLlm(
      path,
      body,
      (event) => {
        if (event.type === 'outline') outline.value = event.items
        else if (event.type === 'slide') {
          total.value = event.total
          progress.value.push({ index: event.index, title: event.title, warning: event.warning })
        } else if (event.type === 'error') {
          failed = true
          error.value = event.message
        }
      },
      controller.signal,
    )
    if (!failed) onDone()
  } catch (e) {
    if ((e as Error).name !== 'AbortError') error.value = (e as Error).message
  } finally {
    controller = null
  }
}

async function createOutline() {
  await api.saveBriefing(props.deckId, fields.value!)
  phase.value = 'outlining'
  await run(`/decks/${props.deckId}/llm/outline`, {}, () => (phase.value = 'outline'))
  if (phase.value === 'outlining') phase.value = 'briefing'
}

function moveItem(i: number, delta: number) {
  const items = outline.value
  const [item] = items.splice(i, 1)
  items.splice(i + delta, 0, item!)
}

async function writeDraft() {
  phase.value = 'drafting'
  progress.value = []
  total.value = outline.value.length
  await run(`/decks/${props.deckId}/llm/draft`, { outline: outline.value, remarks: remarks.value }, () => {})
  phase.value = progress.value.length ? 'done' : 'outline'
}

async function discard() {
  await api.discardDraft(props.deckId)
  progress.value = []
  phase.value = 'outline'
}

defineExpose({ phase })
</script>

<template>
  <div class="briefing" data-testid="briefing">
    <!-- While drafting and afterwards, a progress bar sits above the live preview. -->
    <template v-if="phase === 'drafting' || phase === 'done'">
      <div class="progress" role="status">
        <template v-if="phase === 'drafting'">
          <span>First draft: slide {{ progress.length }} of {{ total }} …</span>
          <button @click="controller?.abort()">Cancel</button>
        </template>
        <template v-else>
          <span>First draft done ({{ progress.length }} slides).</span>
          <button @click="discard">Discard</button>
          <button class="primary" @click="phase = 'briefing'; emit('phase', 'briefing')">Keep</button>
        </template>
        <span v-for="p in progress.filter((p) => p.warning)" :key="p.index" class="warning">
          Slide {{ p.index }}: {{ p.warning }}
        </span>
        <span v-if="error" class="error">{{ error }}</span>
      </div>
      <div class="slot"><slot /></div>
    </template>

    <form v-else-if="fields" class="form" @submit.prevent="createOutline">
      <h2>Briefing</h2>
      <p class="muted">The deck is empty. Describe the presentation and Slidango AI suggests an outline.</p>
      <label>Topic *<input v-model="fields.topic" required :disabled="readOnly" /></label>
      <label>Goal *<input v-model="fields.goal" required placeholder="What should the audience know or do afterwards?" :disabled="readOnly" /></label>
      <div class="row">
        <label>Audience<input v-model="fields.audience" :disabled="readOnly" /></label>
        <label>Language<input v-model="fields.language" :disabled="readOnly" /></label>
        <label>Tone<input v-model="fields.tone" placeholder="e.g. matter-of-fact" :disabled="readOnly" /></label>
      </div>
      <div class="row size">
        <label>Length
          <span class="inline">
            <input
              type="number"
              min="1"
              max="240"
              :value="sizeMode === 'slides' ? fields.slideCount : fields.durationMinutes"
              :disabled="readOnly"
              @input="setSize(($event.target as HTMLInputElement).value)"
            />
            <select v-model="sizeMode" @change="setSize(String((sizeMode === 'slides' ? fields.durationMinutes : fields.slideCount) ?? ''))">
              <option value="slides">slides</option>
              <option value="minutes">minutes</option>
            </select>
          </span>
        </label>
      </div>
      <label>Notes and key points<textarea v-model="fields.notes" rows="5" :disabled="readOnly" /></label>
      <div class="files">
        <span>Files (MD, TXT, PDF, images)</span>
        <ul>
          <li v-for="file in files" :key="file.id">
            {{ file.name }} <span class="muted">({{ Math.round(file.size / 1024) }} KB)</span>
            <button v-if="!readOnly" type="button" class="link" @click="removeFile(file.id)">Remove</button>
          </li>
        </ul>
        <input v-if="!readOnly" type="file" multiple accept=".md,.markdown,.txt,.pdf,.png,.jpg,.jpeg,.webp,.gif" :disabled="uploading" @change="addFiles" />
      </div>
      <p v-if="error" class="error">{{ error }}</p>

      <template v-if="phase === 'outline' || outline.length">
        <h2>Outline</h2>
        <ol class="outline" data-testid="outline">
          <li v-for="(item, i) in outline" :key="i">
            <input v-model="item.title" class="title" aria-label="Title" />
            <input v-model="item.message" aria-label="Key message" placeholder="Key message" />
            <select v-model="item.layout" aria-label="Layout">
              <option v-for="layout in layouts" :key="layout" :value="layout">{{ layout }}</option>
            </select>
            <span class="tools">
              <button type="button" :disabled="i === 0" title="Move up" @click="moveItem(i, -1)">↑</button>
              <button type="button" :disabled="i === outline.length - 1" title="Move down" @click="moveItem(i, 1)">↓</button>
              <button type="button" title="Remove" @click="outline.splice(i, 1)">✕</button>
            </span>
          </li>
        </ol>
        <button type="button" @click="outline.push({ title: 'New slide', message: '', layout: 'default' })">Add slide</button>
        <label>Remarks on the outline<textarea v-model="remarks" rows="2" /></label>
      </template>

      <div v-if="!readOnly" class="actions">
        <button :class="{ primary: !outline.length }" type="submit" :disabled="phase === 'outlining' || !fields.topic || !fields.goal">
          {{ phase === 'outlining' ? 'Writing outline …' : outline.length ? 'Recreate outline' : 'Create outline' }}
        </button>
        <button v-if="outline.length" class="primary" type="button" :disabled="!empty" @click="writeDraft">Write first draft</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.briefing { height: 100%; overflow: auto; background: var(--surface); display: flex; flex-direction: column; }
.form { display: grid; gap: 0.6rem; padding: 1rem; max-width: 48rem; }
h2 { font-size: 1.05rem; margin: 0.5rem 0 0; }
p { margin: 0; }
label { display: grid; gap: 0.2rem; font-size: 0.85rem; }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.6rem; }
.inline { display: flex; gap: 0.4rem; }
.inline input { width: 6rem; }
textarea, select { font: inherit; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 0.4rem 0.5rem; background: var(--surface); }
.files { display: grid; gap: 0.3rem; font-size: 0.85rem; }
.files ul { margin: 0; padding-left: 1.2rem; }
.link { border: none; background: none !important; padding: 0; color: var(--accent); }
.outline { margin: 0; padding-left: 1.4rem; display: grid; gap: 0.4rem; }
.outline li { display: grid; grid-template-columns: minmax(8rem, 1fr) minmax(8rem, 2fr) auto auto; gap: 0.3rem; align-items: center; }
.outline .title { font-weight: 500; }
.tools { display: flex; gap: 0.2rem; }
.tools button { padding: 0.2rem 0.45rem; }
.actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.progress { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; padding: 0.5rem 0.75rem; background: var(--ai-soft); border-bottom: 1px solid var(--line); font-size: 0.85rem; }
.warning { flex-basis: 100%; color: var(--danger); }
.error { color: var(--danger); }
.slot { flex: 1; min-height: 0; }
@media (max-width: 700px) { .outline li { grid-template-columns: 1fr; } }
</style>
