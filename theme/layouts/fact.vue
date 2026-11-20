<template>
  <div class="slidev-layout fact sl-fact">
    <div class="sl-content"><slot /></div>
    <SlFooter />
  </div>
</template>

<style scoped>
.sl-fact { display: grid; place-items: center; text-align: center; }
/* The number in Instrument Serif, the explanation in Geist. */
.sl-content :deep(h1) { font-family: 'Instrument Serif', Georgia, serif; font-style: italic; font-weight: 400; font-size: 8rem; line-height: 1; letter-spacing: -0.02em; color: var(--sl-tango); margin: 0 0 0.6rem; }
.sl-content :deep(p) { font-size: 1.35rem; color: var(--sl-muted); max-width: 30em; margin: 0 auto; }
</style>
