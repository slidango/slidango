<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

defineProps<{ label: string; title?: string; align?: 'left' | 'right' }>()
const open = ref(false)
const root = ref<HTMLElement>()

function onDocument(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) open.value = false
}
function toggle() {
  open.value = !open.value
  if (open.value) setTimeout(() => document.addEventListener('click', onDocument), 0)
  else document.removeEventListener('click', onDocument)
}
function close() {
  open.value = false
  document.removeEventListener('click', onDocument)
}
onBeforeUnmount(() => document.removeEventListener('click', onDocument))
defineExpose({ close })
</script>

<template>
  <div ref="root" class="menu-button" @keydown.esc="close">
    <button class="icon" :class="{ active: open }" :title="title ?? label" :aria-label="title ?? label" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
      <slot name="label">{{ label }}</slot>
    </button>
    <div v-if="open" class="menu" role="menu" :class="align ?? 'right'" @click="close">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.menu-button { position: relative; }
.menu { top: calc(100% + 4px); }
.menu.right { right: 0; }
.menu.left { left: 0; }
</style>
