<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Deck, DeckMode } from '@slidango/shared'
import { api } from '../api'
import BrandHeader from '../components/BrandHeader.vue'
import MenuButton from '../components/MenuButton.vue'

const router = useRouter()
const decks = ref<Deck[]>([])
const showArchived = ref(false)
const createDialog = ref<HTMLDialogElement>()

function openCreate() {
  title.value = ''
  error.value = null
  createDialog.value?.showModal()
}
const title = ref('')
const mode = ref<DeckMode>('empty')
const hasTemplate = ref(false)
const llmConfigured = ref(false)
const error = ref<string | null>(null)
const filter = ref('')

async function load() {
  decks.value = await api.decks(showArchived.value)
}

async function create() {
  error.value = null
  try {
    const deck = await api.createDeck({ title: title.value, mode: mode.value })
    await router.push(`/decks/${deck.id}`)
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function toggleArchive(deck: Deck) {
  await (deck.archived ? api.unarchiveDeck(deck.id) : api.archiveDeck(deck.id))
  await load()
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const visible = () => decks.value.filter((d) => d.title.toLowerCase().includes(filter.value.trim().toLowerCase()))

onMounted(async () => {
  await load()
  const [themes, llm] = await Promise.all([api.themes(), api.llmStatus()])
  hasTemplate.value = themes.some((t) => t.isDefault)
  llmConfigured.value = llm.configured
  if (llm.configured) mode.value = 'assistant'
})
</script>

<template>
  <BrandHeader title="Slides, made" accent="together." subtitle="Write Markdown decks with your team, live in one file. Slidango AI writes along, one voice among several." />

  <dialog ref="createDialog" class="create-dialog" aria-labelledby="create-title" @click.self="createDialog?.close()">
    <form class="create" @submit.prevent="create">
      <h2 id="create-title">New deck</h2>
      <label>Title<input v-model="title" placeholder="Title" autofocus required maxlength="200" /></label>
      <label>
        Start with
        <select v-model="mode" aria-label="Start with">
          <option value="assistant" :disabled="!llmConfigured">Slidango AI</option>
          <option value="starter" :disabled="!hasTemplate">The template's starter deck</option>
          <option value="empty">Empty</option>
        </select>
      </label>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="buttons">
        <button type="button" @click="createDialog?.close()">Cancel</button>
        <button class="primary" type="submit" :disabled="!title.trim()">Create</button>
      </div>
    </form>
  </dialog>

  <main class="page">
    <div class="filters">
      <input v-model="filter" type="search" placeholder="Search decks" aria-label="Search decks" />
      <label class="muted"><input v-model="showArchived" type="checkbox" @change="load" /> Show archived</label>
      <button class="primary new" @click="openCreate">+ New deck</button>
    </div>

    <div class="table-wrap">
      <table class="decks">
        <thead>
          <tr><th>Title</th><th>Template</th><th>Edited</th><th class="right">Actions</th></tr>
        </thead>
        <tbody>
          <tr v-for="deck in visible()" :key="deck.id" :class="{ archived: deck.archived }">
            <td class="title">
              <RouterLink :to="`/decks/${deck.id}`">{{ deck.title }}</RouterLink>
              <span v-if="deck.archived" class="badge">archived</span>
            </td>
            <td class="muted meta" data-label="Template">{{ deck.themeVersion ?? 'Default' }}</td>
            <td class="muted meta" data-label="Edited">{{ dateFormat.format(new Date(deck.updatedAt)) }}</td>
            <td class="actions">
              <div>
                <RouterLink :to="`/decks/${deck.id}`" class="button">Edit</RouterLink>
                <a
                  v-if="deck.previewUrl"
                  :href="deck.previewUrl"
                  target="_blank"
                  rel="noopener"
                  class="button present"
                  title="Open only the presentation (new tab)"
                ><span aria-hidden="true">▶</span> Present</a>
                <MenuButton label="⋯" :title="`More actions for ${deck.title}`">
                  <a v-if="deck.previewUrl" :href="`${deck.previewUrl}/presenter/1`" target="_blank" rel="noopener">Presenter view</a>
                  <button @click="toggleArchive(deck)">{{ deck.archived ? 'Restore' : 'Archive' }}</button>
                </MenuButton>
              </div>
            </td>
          </tr>
          <tr v-if="visible().length === 0" class="empty-row">
            <td colspan="4" class="empty muted">{{ decks.length ? 'No matches.' : 'No decks yet. Create the first one with “New deck”.' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>

<style scoped>
.new { margin-left: auto; padding: 0.5rem 1.1rem; }
.create-dialog { border: 1px solid var(--line); padding: 0; border-radius: var(--radius-lg); width: min(28rem, calc(100vw - 2rem)); box-shadow: var(--shadow); background: var(--surface); color: var(--text); }
.create { display: grid; gap: 0.8rem; padding: 1.25rem 1.5rem; }
.create h2 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
.create label { display: grid; gap: 0.25rem; font-size: 0.85rem; color: var(--muted); }
.create input, .create select { color: var(--text); font-size: 0.95rem; }
.create .error { color: var(--danger); margin: 0; }
.buttons { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.3rem; }
/* Same content width and edge as the header. */
.page { max-width: 1100px; margin: 0 auto; padding: var(--space-8) 0 var(--space-16); width: calc(100% - 2rem); }
.filters { display: flex; gap: 1rem; align-items: center; margin-bottom: 0.9rem; flex-wrap: wrap; }
.filters input[type='search'] { flex: 0 1 22rem; min-width: 0; }
.filters label { display: flex; gap: 0.35rem; align-items: center; }
.table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font: 500 12px/1.3 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); padding: 0.7rem 1rem; border-bottom: 1px solid var(--border); background: var(--surface-2); }
th:first-child { border-top-left-radius: var(--radius-lg); }
th:last-child { border-top-right-radius: var(--radius-lg); }
td { padding: 0.65rem 1rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:last-child td { border-bottom: none; }
tbody tr:not(.empty-row):hover td { background: var(--hover); }
.title { width: 100%; }
.title a { font-weight: 600; font-size: 15px; letter-spacing: -0.01em; }
.title a:hover { color: var(--tango); }
.title .badge { margin-left: 0.5rem; }
.archived .title a { color: var(--muted); }
.meta { white-space: nowrap; font: 400 12px/1.4 var(--font-mono); color: var(--ink-subtle); }
.right { text-align: right; }
.actions { width: 1%; white-space: nowrap; }
.actions > div { display: flex; gap: 0.4rem; justify-content: flex-end; align-items: stretch; }
.actions :deep(.menu-button) { display: flex; }
.button { display: inline-block; font: 500 14px/1.45 var(--font-sans); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 0.35rem 0.8rem; white-space: nowrap; background: var(--surface-card); transition: background 0.12s var(--ease); }
.button:hover { background: var(--surface-100); }
.button.present { border-color: transparent; background: transparent; color: var(--ink-muted); }
.button.present span { font-size: 0.7em; margin-right: 0.2rem; vertical-align: 0.1em; }
.button.present:hover { background: var(--hover); color: var(--ink); }
.empty { text-align: center; padding: 2rem; }

/* Phones: one card per deck instead of a table that has to scroll sideways. */
@media (max-width: 700px) {
  thead { display: none; }
  table, tbody, tr, td { display: block; }
  tbody tr:not(.empty-row) { display: grid; grid-template-columns: auto 1fr; padding: 0.8rem 1rem; border-bottom: 1px solid var(--border); }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:not(.empty-row) td { padding: 0; border: none; background: none !important; }
  .title { grid-column: 1 / -1; margin-bottom: 0.2rem; }
  .meta { font-size: 0.85rem; }
  .meta + .meta::before { content: '·'; margin: 0 0.4rem; }
  .actions { grid-column: 1 / -1; width: auto; margin-top: 0.6rem; }
  .actions > div { justify-content: flex-start; }
}
</style>
