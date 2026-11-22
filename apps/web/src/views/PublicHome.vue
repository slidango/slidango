<script setup lang="ts">
/** Start page when signed out: every public deck, and a way to sign in. */
import { onMounted, ref } from 'vue'
import type { PublicDeck } from '@slidango/shared'
import { api } from '../api'
import BrandHeader from '../components/BrandHeader.vue'
import { theme } from '../composables/theme'
import { signIn } from '../user'

const decks = ref<PublicDeck[] | null>(null)
const error = ref<string | null>(null)
const broken = ref(new Set<string>())
const thumbUrl = (deck: PublicDeck) => `/api/public/decks/${deck.id}/thumbnail?scheme=${theme.value}&v=${deck.thumbnailAt}`
const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

onMounted(async () => {
  try {
    decks.value = await api.publicDecks()
  } catch (e) {
    error.value = (e as Error).message
  }
})
</script>

<template>
  <BrandHeader
    title="Slides, made"
    accent="together."
    subtitle="Markdown decks written by a team, live in one file. These ones are public: watch them right here."
  />
  <main class="page">
    <div class="intro">
      <h2>Public decks</h2>
      <button class="ghost" @click="signIn('/')">Sign in to write your own →</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <ul v-else-if="decks?.length" class="cards" data-testid="public-decks">
      <li v-for="deck in decks" :key="deck.id" class="card">
        <a :href="deck.url" class="thumb" tabindex="-1" aria-hidden="true">
          <img v-if="deck.thumbnailAt && !broken.has(deck.id)" :src="thumbUrl(deck)" alt="" loading="lazy" @error="broken.add(deck.id)" />
          <span v-else class="placeholder"><span>{{ deck.title }}</span></span>
        </a>
        <div class="body">
          <a :href="deck.url" class="name">{{ deck.title }}</a>
          <span class="meta">{{ deck.owner }} · {{ date.format(new Date(deck.builtAt)) }}</span>
        </div>
      </li>
    </ul>
    <div v-else-if="decks" class="empty">
      <p>No public decks yet.</p>
      <p class="muted">Decks become public when their owner turns on <em>Public link</em> under Share.</p>
    </div>
  </main>
</template>

<style scoped>
.page { max-width: 1100px; margin: 0 auto; padding: var(--space-8) 0 var(--space-16); width: calc(100% - 2rem); }
.intro { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.9rem; }
.intro h2 { margin: 0; font: 500 12px/1.3 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.intro .ghost { font-size: 14px; color: var(--ink-muted); }
.intro .ghost:hover { color: var(--tango); }
.error { color: var(--danger); }
.cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(15.5rem, 1fr)); gap: 1.1rem; }
.card { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease); }
.card:hover { border-color: var(--border-strong); box-shadow: var(--shadow); }
.thumb { display: block; aspect-ratio: 16 / 9; border-bottom: 1px solid var(--border); border-radius: var(--radius-lg) var(--radius-lg) 0 0; background: var(--surface-2); overflow: hidden; }
.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.placeholder { display: flex; align-items: flex-end; width: 100%; height: 100%; padding: 1rem 1.1rem; box-sizing: border-box; background-image: radial-gradient(var(--line) 1px, transparent 1px); background-size: 14px 14px; }
.placeholder span { font: 650 19px/1.15 var(--font-sans); letter-spacing: -0.02em; color: var(--ink); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.body { display: grid; gap: 0.2rem; padding: 0.7rem 0.9rem 0.8rem; }
.name { font-weight: 600; font-size: 15px; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name:hover { color: var(--tango); }
.meta { font: 400 12px/1.4 var(--font-mono); color: var(--ink-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { text-align: center; padding: 3rem 1rem; border: 1px dashed var(--border); border-radius: var(--radius-lg); }
.empty p { margin: 0.2rem 0; }
</style>
