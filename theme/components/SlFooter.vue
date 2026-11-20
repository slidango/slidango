<script setup lang="ts">
import SlMark from './SlMark.vue'

/** Page number bottom left (`02 / 09`), the mark bottom right. Used by content layouts. */
const pad = (n: number) => String(n).padStart(2, '0')
</script>

<template>
  <div class="sl-footer">
    <span class="sl-page">{{ pad($nav.currentPage) }} / {{ pad($nav.total) }}</span>
    <SlMark :size="14" />
  </div>
</template>

<style scoped>
.sl-footer { position: absolute; left: 4rem; right: 3.2rem; bottom: 1.4rem; display: flex; justify-content: space-between; align-items: center; pointer-events: none; }
.sl-page { font-family: 'JetBrains Mono', monospace; font-size: 0.68rem; color: var(--sl-subtle); letter-spacing: 0.04em; }
</style>
