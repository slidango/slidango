<template>
  <div class="slidev-layout section sl-dots sl-section">
    <div class="sl-content">
      <div class="sl-number">{{ $frontmatter.eyebrow ?? String($nav.currentPage).padStart(2, '0') }}</div>
      <slot />
    </div>
    <SlFooter />
  </div>
</template>

<style scoped>
.sl-section { display: flex; align-items: center; }
.sl-content { max-width: 75%; border-left: 3px solid var(--sl-tango); padding-left: 2rem; }
.sl-number { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-muted); margin-bottom: 0.8rem; }
.sl-content :deep(h1) { font-size: 3.4rem; margin-bottom: 0.8rem; }
.sl-content :deep(p) { color: var(--sl-muted); font-size: 1.25rem; }
</style>
