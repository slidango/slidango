<template>
  <div class="slidev-layout statement sl-statement">
    <div class="sl-content"><slot /></div>
    <SlFooter />
  </div>
</template>

<style scoped>
.sl-statement { display: grid; place-items: center; text-align: center; }
.sl-content { max-width: 82%; }
.sl-content :deep(h1) { font-size: 3.6rem; line-height: 1.05; margin-bottom: 1rem; }
.sl-content :deep(p) { color: var(--sl-muted); font-size: 1.25rem; }
</style>
