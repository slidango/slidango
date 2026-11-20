<template>
  <div class="slidev-layout center sl-center">
    <div class="sl-content"><slot /></div>
    <SlFooter />
  </div>
</template>

<style scoped>
.sl-center { display: grid; place-items: center; text-align: center; }
.sl-content { max-width: 80%; }
.sl-content :deep(ul) { display: inline-block; text-align: left; }
</style>
