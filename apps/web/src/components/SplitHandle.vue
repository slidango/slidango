<script setup lang="ts">
/** Draggable divider; emits pixel deltas while dragging. Keyboard: arrows move by 24 px. */
const props = defineProps<{ direction: 'horizontal' | 'vertical'; label: string }>()
const emit = defineEmits<{ drag: [delta: number]; reset: [] }>()

function start(event: PointerEvent) {
  if (event.button !== 0) return
  const handle = event.currentTarget as HTMLElement
  const id = event.pointerId
  try {
    handle.setPointerCapture(id)
  } catch {
    // Capture is an optimisation; the window listeners below still end the drag.
  }
  let last = props.direction === 'horizontal' ? event.clientX : event.clientY
  document.body.classList.add('resizing', `resizing-${props.direction}`)
  const move = (e: PointerEvent) => {
    // A release we never heard about (e.g. over the preview iframe or outside the window): end the drag.
    if (e.buttons === 0) return stop()
    const pos = props.direction === 'horizontal' ? e.clientX : e.clientY
    emit('drag', pos - last)
    last = pos
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    window.removeEventListener('blur', stop)
    handle.removeEventListener('lostpointercapture', stop)
    if (handle.hasPointerCapture?.(id)) handle.releasePointerCapture(id)
    document.body.classList.remove('resizing', `resizing-${props.direction}`)
  }
  // Listen on window, not the handle: the drag must end wherever the button is released.
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
  window.addEventListener('blur', stop)
  handle.addEventListener('lostpointercapture', stop)
}

function key(event: KeyboardEvent) {
  const back = props.direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
  const forward = props.direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
  if (event.key === back) emit('drag', -24)
  else if (event.key === forward) emit('drag', 24)
  else return
  event.preventDefault()
}
</script>

<template>
  <div
    class="split-handle"
    :class="direction"
    role="separator"
    :aria-orientation="direction === 'horizontal' ? 'vertical' : 'horizontal'"
    :aria-label="label"
    tabindex="0"
    title="Drag to resize, double-click to reset"
    @pointerdown.prevent="start"
    @dblclick="emit('reset')"
    @keydown="key"
  />
</template>

<style scoped>
.split-handle { flex: 0 0 auto; position: relative; z-index: 5; background: var(--border); transition: background 0.12s; }
.split-handle.horizontal { width: 1px; cursor: col-resize; }
.split-handle.vertical { height: 1px; cursor: row-resize; }
/* Generous invisible hit area around the 1px line. */
.split-handle::after { content: ''; position: absolute; inset: -4px; }
.split-handle.vertical::after { inset: -4px 0; }
.split-handle.horizontal::after { inset: 0 -4px; }
.split-handle:hover, .split-handle:focus-visible { background: var(--line-strong); outline: none; }
</style>

<style>
/* While dragging, iframes must not swallow pointer events. */
body.resizing iframe { pointer-events: none; }
body.resizing-horizontal { cursor: col-resize; user-select: none; }
body.resizing-vertical { cursor: row-resize; user-select: none; }
</style>
