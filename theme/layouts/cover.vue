<template>
  <div class="slidev-layout cover sl-cover">
    <div class="sl-content">
      <div v-if="$frontmatter.eyebrow" class="sl-eyebrow">{{ $frontmatter.eyebrow }}</div>
      <slot />
    </div>
    <div class="sl-meta">
      <span class="sl-meta-left">
        <template v-if="$frontmatter.author || $frontmatter.date">
          <span v-if="$frontmatter.author">{{ $frontmatter.author }}</span>
          <span v-if="$frontmatter.date">{{ $frontmatter.date }}</span>
        </template>
        <span v-else>slidango</span>
      </span>
      <span>{{ String($nav.currentPage).padStart(2, '0') }}</span>
    </div>
  </div>
</template>

<style scoped>
/* Same cover as on slidango.com: two soft glows (tango top right, AI teal bottom left),
   a big headline, the subtitle as an Instrument Serif line in tango, a mono footer row. */
.sl-cover {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 9%;
  background:
    radial-gradient(90% 120% at 100% 0%, var(--sl-glow-a), transparent 60%),
    radial-gradient(60% 80% at 0% 100%, var(--sl-glow-b), transparent 70%),
    var(--sl-paper);
}
.sl-content { max-width: 88%; }
.sl-content .sl-eyebrow { font-size: 0.8rem; letter-spacing: 0.1em; margin-bottom: 1.4rem; }
.sl-content :deep(h1) { font-size: 4.6rem; line-height: 1.02; letter-spacing: -0.035em; margin-bottom: 0; }
.sl-content :deep(h1 + p) {
  margin-top: 1rem;
  font-family: 'Instrument Serif', Georgia, serif;
  font-style: italic;
  font-size: 2.4rem;
  line-height: 1.2;
  color: var(--sl-tango);
  max-width: 24em;
}
.sl-meta {
  position: absolute;
  left: 9%;
  right: 9%;
  bottom: 2.2rem;
  display: flex;
  justify-content: space-between;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  color: var(--sl-muted);
}
.sl-meta-left { display: flex; gap: 1.5rem; }
</style>
