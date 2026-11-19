<script setup lang="ts">
// "Partners" mark: two rounded cursor bars stepping in time (ink + tango), optional wordmark.
// Bar width 0.19 × height, radius half the width, gap 0.15 × height, right bar 1/8 height lower.
const props = withDefaults(defineProps<{ size?: number; wordmark?: boolean }>(), { size: 20, wordmark: false })
const w = props.size * 0.19
const gap = props.size * 0.15
const step = props.size / 16
</script>

<template>
  <span class="brand-logo" role="img" aria-label="slidango" :style="{ '--h': `${size}px` }">
    <span class="mark" :style="{ gap: `${gap}px` }">
      <span class="bar a" :style="{ width: `${w}px`, borderRadius: `${w / 2}px`, transform: `translateY(${-step}px)` }" />
      <span class="bar b" :style="{ width: `${w}px`, borderRadius: `${w / 2}px`, transform: `translateY(${step}px)` }" />
    </span>
    <span v-if="wordmark" class="word" aria-hidden="true">slidango</span>
  </span>
</template>

<style scoped>
.brand-logo { display: inline-flex; align-items: center; gap: calc(var(--h) * 0.3); color: var(--ink); }
.mark { display: inline-flex; align-items: center; height: calc(var(--h) * 1.15); }
.bar { display: block; height: var(--h); }
.a { background: var(--ink); }
.b { background: var(--tango); }
.word { font: 600 calc(var(--h) * 1.05) / 1 var(--font-sans); letter-spacing: -0.045em; }
</style>
