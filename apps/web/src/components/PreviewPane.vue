<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Preview } from '@slidango/shared'
import { api } from '../api'
import { theme } from '../composables/theme'
import MenuButton from './MenuButton.vue'

const props = defineProps<{ deckId: string; slide: number; total: number }>()
const follow = defineModel<boolean>('follow', { default: true })
/** The viewer navigated inside the preview (arrows, clicks): the editor can follow. */
const emit = defineEmits<{ navigated: [no: number] }>()

const preview = ref<Preview | null>(null)
const error = ref<string | null>(null)
const src = ref<string | null>(null)
const frame = ref<HTMLIFrameElement>()
const current = ref(props.slide)
const nav = ref({ hasNext: true, hasPrev: false })
// Slide we asked the preview to show; its echo is not reported as user navigation.
let requested: number | null = null

async function start() {
  error.value = null
  preview.value = null
  src.value = null
  try {
    preview.value = await api.preview(props.deckId)
    // Embedded mode: Slidev hides its own controls and reports navigation via postMessage.
    if (preview.value.status === 'ready') {
      requested = props.slide
      src.value = `${preview.value.url}/${props.slide}?embedded=true`
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}

// Slidev letterboxes the slide in black; match the stage (surface-100 of the current theme) instead.
const stage = () => getComputedStyle(document.documentElement).getPropertyValue('--surface-100').trim() || '#14171c'
let styled = false

/** After any (re)load the preview should show the cursor's slide again. */
function onLoad() {
  styled = false
  if (follow.value) requested = props.slide
}

function post(message: Record<string, unknown>) {
  frame.value?.contentWindow?.postMessage({ target: 'slidev', ...message }, '*')
}

/**
 * The preview follows the app theme: Slidev switches decks without a fixed `colorSchema`
 * (the Slidango template defaults to auto); decks that pin light or dark keep their variant.
 */
function applyTheme() {
  post({ type: 'color-schema', color: theme.value })
  post({ type: 'css-vars', vars: { '--slidev-slide-container-background': stage() } })
}
watch(theme, () => {
  // The CSS variables of the new theme apply on the next frame.
  if (styled) requestAnimationFrame(applyTheme)
})

/** Jumps without reloading (Slidev's embedded control). */
function goTo(no: number) {
  if (no === current.value) return
  requested = no
  post({ type: 'navigate', no })
}

function step(operation: 'next' | 'prev') {
  requested = null
  post({ type: 'navigate', operation })
}

function onMessage(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow) return
  const state = (event.data as { target?: string; navState?: { no: number; hasNext: boolean; hasPrev: boolean } })?.navState
  if ((event.data as { target?: string })?.target !== 'slidev' || !state) return
  // The first nav report means Slidev's embedded control listens; style once per page load.
  if (!styled) {
    styled = true
    applyTheme()
  }
  current.value = state.no
  nav.value = { hasNext: state.hasNext, hasPrev: state.hasPrev }
  if (requested === state.no) requested = null
  else if (requested !== null) {
    // The request got lost (e.g. Vite reloaded the page while pre-bundling): send it again.
    post({ type: 'navigate', no: requested })
  } else emit('navigated', state.no)
}

watch(
  () => [props.slide, follow.value] as const,
  ([slide, on]) => {
    if (on && preview.value?.status === 'ready') goTo(slide)
  },
)

const open = (path: string) => window.open(`${preview.value!.url}${path}`, '_blank', 'noopener')

function fullscreen() {
  void frame.value?.requestFullscreen()
  frame.value?.focus()
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  void start()
})
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
defineExpose({ restart: start, step })
</script>

<template>
  <div class="preview" data-testid="preview">
    <div class="stage">
      <template v-if="preview?.status === 'ready' && src">
        <div class="fit">
          <div class="sheet">
            <iframe
              ref="frame"
              :src="src"
              title="Live preview"
              allow="fullscreen; screen-wake-lock; clipboard-write"
              @load="onLoad"
            />
          </div>
        </div>
        <div class="pages">
          <span class="bars" role="group" aria-label="Slides">
            <button
              v-for="n in total"
              :key="n"
              class="bar"
              :class="{ on: n === current }"
              :title="`Slide ${n}`"
              :aria-label="`Slide ${n}`"
              :aria-current="n === current ? 'page' : undefined"
              @click="goTo(n)"
            />
          </span>
          <span class="position" data-testid="preview-position">{{ current }} / {{ total }}</span>
        </div>
      </template>
      <div v-else-if="preview?.status === 'error'" class="message error">
        <p>The preview crashed.</p>
        <button @click="start">Restart</button>
        <pre>{{ preview.logs.join('\n') }}</pre>
      </div>
      <div v-else-if="error" class="message error">
        <p>{{ error }}</p>
        <button @click="start">Try again</button>
      </div>
      <p v-else class="message starting">Starting preview …</p>
    </div>

    <div class="controls" role="toolbar" aria-label="Preview">
      <button class="ghost icon" title="Previous slide (Ctrl+Alt+←)" aria-label="Previous slide" :disabled="!nav.hasPrev" @click="step('prev')">‹</button>
      <button class="ghost icon" title="Next slide (Ctrl+Alt+→)" aria-label="Next slide" :disabled="!nav.hasNext" @click="step('next')">›</button>
      <label class="follow" title="The preview jumps to the slide under your cursor">
        <input v-model="follow" type="checkbox" /> Follow cursor
      </label>
      <span class="spacer" />
      <button class="ghost" :disabled="!preview?.url" title="Present in a new tab" @click="open(`/${current}`)">Present</button>
      <button class="ghost icon" :disabled="!src" title="Fullscreen" aria-label="Fullscreen" @click="fullscreen">⤢</button>
      <MenuButton label="⋯" title="More preview actions">
        <button :disabled="!preview?.url" @click="open(`/presenter/${current}`)">Presenter view</button>
        <button :disabled="!preview?.url" @click="open('/export')">Export (PDF, PPTX, PNG)</button>
        <button :disabled="!preview?.url" @click="open('/overview')">Slide overview</button>
        <hr />
        <button @click="start">Reload preview</button>
      </MenuButton>
    </div>
  </div>
</template>

<style scoped>
.preview { height: 100%; display: flex; flex-direction: column; background: var(--surface); min-height: 0; }
/* Like the landing page: the slide as a card on the dot grid, page bars below. */
.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 24px 10px;
  background-color: var(--surface-100);
  background-image: radial-gradient(circle, var(--line) 1.2px, transparent 1.3px);
  background-size: 24px 24px;
}
.fit { flex: 1; min-height: 0; display: grid; place-items: center; container-type: size; }
/* Exactly 16:9 and as large as fits: no letterbox inside the iframe. */
.sheet {
  width: min(100cqw, 100cqh * 16 / 9);
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-md);
  overflow: hidden;
  /* A hairline keeps the edge visible when a dark slide sits on the dark grid. */
  box-shadow: 0 0 0 1px var(--line), var(--shadow-pop);
  background: var(--surface-card);
}
iframe { display: block; border: 0; width: 100%; height: 100%; }
.pages { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 16px; }
.bars { display: flex; gap: 6px; min-width: 0; flex: 1; }
.bar { flex: 0 1 18px; min-width: 3px; height: 4px; padding: 0; border: none; border-radius: 2px; background: var(--line); cursor: pointer; transition: background 0.3s var(--ease); }
.bar:hover:not(:disabled) { background: var(--line-strong); border: none; }
.bar.on, .bar.on:hover:not(:disabled) { background: var(--tango); }
.bar:focus-visible { outline-offset: 3px; }
.message { padding: 1rem; overflow: auto; width: 100%; margin: 0; }
.starting { display: grid; place-items: center; color: var(--muted); }
.error p { color: var(--danger); margin-top: 0; }
pre { font-size: 12px; white-space: pre-wrap; background: var(--code-bg); color: var(--code-ink); border: 1px solid var(--border); padding: 0.5rem; border-radius: var(--radius-sm); }
.controls { display: flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.5rem; border-top: 1px solid var(--border); background: var(--surface); flex-wrap: wrap; }
.position { font: 400 12px/1.3 var(--font-mono); color: var(--ink-subtle); white-space: nowrap; }
.follow { display: flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; color: var(--muted); margin-left: 0.5rem; }
.spacer { flex: 1; }
.controls button { font-size: 0.85rem; }
</style>
