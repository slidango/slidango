<template>
  <div class="slidev-layout quote sl-quote">
    <div class="sl-content"><slot /></div>
    <SlFooter />
  </div>
</template>

<style scoped>
.sl-quote { display: flex; flex-direction: column; justify-content: center; padding-left: 6rem; padding-right: 6rem; }
.sl-content :deep(blockquote),
.sl-content :deep(h1),
.sl-content :deep(p:first-child) { font-family: 'Instrument Serif', Georgia, serif; font-style: italic; font-weight: 400; font-size: 2.6rem; line-height: 1.2; letter-spacing: -0.01em; color: var(--sl-ink); border: none; padding: 0; margin: 0 0 1.2rem; }
.sl-content :deep(p:last-child:not(:first-child)) { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; letter-spacing: 0.04em; color: var(--sl-muted); }
</style>
