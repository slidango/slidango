<script setup lang="ts">
import { ref } from 'vue'
import type { DeckSlide } from '@slidango/shared'

export interface SlidePeer {
  clientId: number
  name: string
  color: string
}

const props = defineProps<{
  slides: DeckSlide[]
  current: number
  /** Slides touched by an open proposal. */
  marked: Set<number>
  /** Validation problems per slide. */
  problems: Map<number, string[]>
  /** Other people's cursors per slide. */
  peers: Map<number, SlidePeer[]>
  readOnly: boolean
}>()
const emit = defineEmits<{ select: [line: number]; move: [from: number, to: number]; collapse: [] }>()

const dragging = ref<number | null>(null)
const dropTarget = ref<number | null>(null)

// Slide 1 holds the deck headmatter and stays first.
const movable = (index: number) => !props.readOnly && index > 1

/** Layout and hints live in the tooltip so every slide fits on one line. */
function tooltip(slide: DeckSlide) {
  const lines = [`${slide.index}. ${slide.title ?? '(untitled)'}`]
  if (slide.layout) lines.push(`Layout: ${slide.layout}`)
  if (slide.hidden) lines.push('Hidden')
  if (movable(slide.index)) lines.push('Click to jump, drag to move')
  return lines.join('\n')
}

function onDragStart(event: DragEvent, index: number) {
  dragging.value = index
  event.dataTransfer!.effectAllowed = 'move'
  event.dataTransfer!.setData('text/plain', String(index))
}

function onDragOver(event: DragEvent, index: number) {
  if (dragging.value === null || index < 2) return
  event.preventDefault()
  dropTarget.value = index
}

function onDrop(index: number) {
  if (dragging.value !== null && index >= 2 && index !== dragging.value) emit('move', dragging.value, index)
  dragging.value = null
  dropTarget.value = null
}
</script>

<template>
  <nav class="slide-list" aria-label="Slides" data-testid="slide-list">
    <header>
      <span>Slides <span class="count">{{ slides.length }}</span></span>
      <button class="ghost icon" title="Collapse slide list" aria-label="Collapse slide list" @click="emit('collapse')">«</button>
    </header>
    <ol>
      <li
        v-for="slide in slides"
        :key="slide.index"
        :class="{ over: dropTarget === slide.index, dragging: dragging === slide.index }"
        @dragover="onDragOver($event, slide.index)"
        @dragleave="dropTarget = null"
        @drop.prevent="onDrop(slide.index)"
      >
        <button
          class="slide"
          :class="{ current: slide.index === current, hidden: slide.hidden }"
          :draggable="movable(slide.index)"
          :title="tooltip(slide)"
          @click="emit('select', slide.startLine)"
          @dragstart="onDragStart($event, slide.index)"
          @dragend="dragging = null; dropTarget = null"
        >
          <span class="number">{{ slide.index }}</span>
          <span class="title">{{ slide.title ?? '(untitled)' }}</span>
          <span v-if="marked.has(slide.index)" class="flag proposal" title="Open suggestion from Slidango AI" aria-label="Suggestion" />
          <span v-if="problems.has(slide.index)" class="flag problem" :title="problems.get(slide.index)!.join('\n')" aria-label="Problem" />
          <span v-if="peers.get(slide.index)?.length" class="peers">
            <span
              v-for="peer in peers.get(slide.index)"
              :key="peer.clientId"
              class="avatar"
              :style="{ background: peer.color }"
              :title="`${peer.name} is here`"
            >{{ peer.name.slice(0, 1).toUpperCase() }}</span>
          </span>
        </button>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.slide-list { height: 100%; display: flex; flex-direction: column; background: var(--surface-2); min-width: 0; }
header { display: flex; justify-content: space-between; align-items: center; padding: 0.35rem 0.35rem 0.35rem 0.75rem; font: 500 12px/1.3 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-muted); border-bottom: 1px solid var(--border); }
.count { color: var(--muted); font-weight: 400; margin-left: 0.25rem; }
ol { list-style: none; margin: 0; padding: 0.3rem; overflow: auto; flex: 1; display: grid; align-content: start; gap: 1px; }
li { border-radius: var(--radius-sm); }
li.over { box-shadow: inset 0 2px 0 var(--tango); }
li.dragging { opacity: 0.4; }
.slide { width: 100%; display: flex; align-items: center; gap: 0.35rem; text-align: left; border: 1px solid transparent; background: none; padding: 0.2rem 0.4rem; font-weight: 400; font-size: 0.8rem; line-height: 1.3; }
.slide:hover:not(:disabled) { background: var(--hover); border-color: transparent; color: var(--text); }
.slide.current { background: var(--surface); border-color: var(--line); box-shadow: inset 2px 0 0 var(--tango); }
.slide[draggable='true'] { cursor: grab; }
.number { flex: 0 0 1.3rem; color: var(--ink-subtle); font: 400 11px/1.3 var(--font-mono); }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.current .title { font-weight: 500; }
.hidden .title { text-decoration: line-through; color: var(--muted); }
.flag { flex: none; width: 0.45rem; height: 0.45rem; border-radius: 50%; }
.flag.proposal { background: var(--ai); }
.flag.problem { background: var(--danger); }
.peers { flex: none; display: flex; padding-left: 0.3rem; }
.avatar { width: 1.05rem; height: 1.05rem; border-radius: var(--radius-pill); color: var(--on-cursor); font: 500 9px/1 var(--font-mono); display: grid; place-items: center; border: 2px solid var(--surface-2); margin-left: -0.3rem; }
</style>
