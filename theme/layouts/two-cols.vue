<template>
  <div class="slidev-layout two-columns sl-two-cols">
    <div v-if="$frontmatter.eyebrow" class="sl-eyebrow">{{ $frontmatter.eyebrow }}</div>
    <div v-if="$slots.top" class="sl-top"><slot name="top" /></div>
    <div class="sl-cols">
      <div class="sl-col"><slot /></div>
      <div class="sl-col"><slot name="right" /></div>
    </div>
    <SlFooter />
  </div>
</template>

<style scoped>
.sl-two-cols { display: flex; flex-direction: column; }
.sl-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 3rem; flex: 1; min-height: 0; }
.sl-col { min-width: 0; }
</style>
