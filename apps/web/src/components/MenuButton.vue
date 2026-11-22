<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'

const props = defineProps<{ label: string; title?: string; align?: 'left' | 'right' }>()
const open = ref(false)
const root = ref<HTMLElement>()
const trigger = ref<HTMLElement>()
const menu = ref<HTMLElement>()
/**
 * The menu is positioned against the viewport (position: fixed), so scrolling containers such as
 * the settings dialog or a table never clip it. It opens upwards when there is no room below.
 */
const style = ref<Record<string, string>>({})

const GAP = 4
const MARGIN = 8

function place() {
  const button = trigger.value?.getBoundingClientRect()
  const box = menu.value?.getBoundingClientRect()
  if (!button || !box) return
  const below = window.innerHeight - button.bottom - GAP - MARGIN
  const up = box.height > below && button.top - GAP - MARGIN > below
  const top = up ? Math.max(MARGIN, button.top - GAP - box.height) : button.bottom + GAP
  let left = (props.align ?? 'right') === 'right' ? button.right - box.width : button.left
  left = Math.min(Math.max(MARGIN, left), window.innerWidth - box.width - MARGIN)
  style.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    right: 'auto',
    maxHeight: `${(up ? button.top - GAP : window.innerHeight - button.bottom - GAP) - MARGIN}px`,
    overflowY: 'auto',
  }
}

function onDocument(event: MouseEvent) {
  const target = event.target as Node
  if (!root.value?.contains(target)) close()
}

/** The trigger moved away under the menu (page or container scrolled, window resized). */
function onMove(event: Event) {
  if (menu.value && event.target instanceof Node && menu.value.contains(event.target)) return
  close()
}

async function toggle() {
  if (open.value) return close()
  // Measure off-screen first, then place, so the menu never flashes at the wrong spot.
  style.value = { position: 'fixed', top: '-9999px', left: '-9999px' }
  open.value = true
  await nextTick()
  place()
  setTimeout(() => document.addEventListener('click', onDocument), 0)
  window.addEventListener('scroll', onMove, true)
  window.addEventListener('resize', onMove)
}

function close() {
  open.value = false
  document.removeEventListener('click', onDocument)
  window.removeEventListener('scroll', onMove, true)
  window.removeEventListener('resize', onMove)
}

onBeforeUnmount(close)
defineExpose({ close })
</script>

<template>
  <div ref="root" class="menu-button" @keydown.esc="close">
    <button
      ref="trigger"
      class="icon"
      :class="{ active: open }"
      :title="title ?? label"
      :aria-label="title ?? label"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
    >
      <slot name="label">{{ label }}</slot>
    </button>
    <div v-if="open" ref="menu" class="menu" role="menu" :style="style" @click="close">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.menu-button { position: relative; }
.menu { z-index: 200; }
</style>
