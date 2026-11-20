<template>
  <div class="slidev-layout end sl-dots sl-end">
    <div class="sl-content">
      <SlMark :size="34" />
      <slot />
    </div>
  </div>
</template>

<style scoped>
.sl-end { display: grid; place-items: center; text-align: center; }
.sl-content { display: grid; justify-items: center; gap: 1.4rem; }
.sl-content :deep(h1) { font-size: 3.2rem; margin: 0; }
.sl-content :deep(p) { color: var(--sl-muted); margin: 0; }
</style>
