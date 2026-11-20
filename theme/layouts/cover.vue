<template>
  <div class="slidev-layout cover sl-dots sl-cover">
    <div class="sl-brand"><SlMark :size="22" /></div>
    <div class="sl-content">
      <div v-if="$frontmatter.eyebrow" class="sl-eyebrow">{{ $frontmatter.eyebrow }}</div>
      <slot />
    </div>
    <div v-if="$frontmatter.date || $frontmatter.author" class="sl-meta">
      <span v-if="$frontmatter.author">{{ $frontmatter.author }}</span>
      <span v-if="$frontmatter.date">{{ $frontmatter.date }}</span>
    </div>
  </div>
</template>

<style scoped>
.sl-cover { display: flex; flex-direction: column; justify-content: center; padding-left: 4.5rem; }
.sl-brand { position: absolute; top: 2.6rem; left: 4.5rem; }
.sl-content { max-width: 80%; }
.sl-content :deep(h1) { font-size: 4.2rem; line-height: 1; margin-bottom: 1.3rem; }
.sl-content :deep(h1 + p) { margin-top: 0; font-size: 1.35rem; color: var(--sl-muted); max-width: 36em; }
.sl-meta { position: absolute; left: 4.5rem; bottom: 2.4rem; display: flex; gap: 1.5rem; font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; letter-spacing: 0.04em; color: var(--sl-subtle); }
</style>
