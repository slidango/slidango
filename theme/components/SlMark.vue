<script setup lang="ts">
/** The "Partners" mark: two stepping cursor bars (ink + tango). Bar width 0.19 × height, gap 0.15 × height. */
const props = withDefaults(defineProps<{ size?: number }>(), { size: 18 })
const w = props.size * 0.19
</script>

<template>
  <span class="sl-mark" :style="{ gap: `${size * 0.15}px`, height: `${size * 1.15}px` }" aria-hidden="true">
    <i :style="{ width: `${w}px`, height: `${size}px`, borderRadius: `${w / 2}px`, transform: `translateY(${-size / 16}px)` }" />
    <i :style="{ width: `${w}px`, height: `${size}px`, borderRadius: `${w / 2}px`, transform: `translateY(${size / 16}px)` }" />
  </span>
</template>

<style scoped>
.sl-mark { display: inline-flex; align-items: center; }
.sl-mark i { display: block; background: var(--sl-ink); }
.sl-mark i + i { background: var(--sl-tango); }
</style>
