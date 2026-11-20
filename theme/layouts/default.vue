<template>
  <div class="slidev-layout default">
    <div v-if="$frontmatter.eyebrow" class="sl-eyebrow">{{ $frontmatter.eyebrow }}</div>
    <slot />
    <SlFooter />
  </div>
</template>
