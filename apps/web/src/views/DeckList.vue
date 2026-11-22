<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Deck, DeckMode, Theme } from '@slidango/shared'
import { api } from '../api'
import { groupTemplates, templateLabel } from '../templates'
import BrandHeader from '../components/BrandHeader.vue'
import MenuButton from '../components/MenuButton.vue'
import { theme } from '../composables/theme'

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
const themes = ref<Theme[]>([])
/** Picked template (latest version of it); '' = Slidev's default theme without a template. */
const themeId = ref('')
/** One choice per template: the default version for the default template, else the newest ready one. */
const templates = computed(() =>
  groupTemplates(themes.value)
    .map((g) => ({ ...g, pick: g.versions.find((v) => v.isDefault && v.status === 'ready') ?? g.latest }))
    .filter((g) => g.pick),
)
const llmConfigured = ref(false)
const error = ref<string | null>(null)
const filter = ref('')

/** Cards with slide 1 (default) or the compact list; remembered per browser. */
type View = 'cards' | 'list'
const VIEW_KEY = 'slidango-deck-view'
function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards'
  } catch {
    return 'cards'
  }
}
const view = ref<View>(storedView())
watch(view, (value) => {
  try {
    localStorage.setItem(VIEW_KEY, value)
  } catch {
    /* private mode: the choice lasts for this tab */
  }
})

/** Slide 1 in the app's theme; the timestamp busts the cache after each new render. */
const thumbUrl = (deck: Deck) => `/api/decks/${deck.id}/thumbnail?scheme=${theme.value}&v=${deck.thumbnailAt}`
const brokenThumbs = ref(new Set<string>())

async function load() {
  decks.value = await api.decks(showArchived.value)
}

async function create() {
  error.value = null
  try {
    const deck = await api.createDeck({ title: title.value, mode: mode.value, themeId: themeId.value || null })
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
const shortDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const visible = () => decks.value.filter((d) => d.title.toLowerCase().includes(filter.value.trim().toLowerCase()))

onMounted(async () => {
  await load()
  const [installed, llm] = await Promise.all([api.themes(), api.llmStatus()])
  themes.value = installed
  themeId.value = installed.find((t) => t.isDefault && t.status === 'ready')?.id ?? ''
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
        Template
        <select v-model="themeId" aria-label="Template">
          <option v-for="group in templates" :key="group.name" :value="group.pick!.id">
            {{ group.label }} · {{ group.pick!.version }}{{ group.pick!.isDefault ? ' · default' : '' }}
          </option>
          <option value="">Slidev default (no template)</option>
        </select>
      </label>
      <label>
        Start with
        <select v-model="mode" aria-label="Start with">
          <option value="assistant" :disabled="!llmConfigured">Slidango AI</option>
          <option value="starter" :disabled="!themeId">The template's starter deck</option>
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
      <div class="view-toggle" role="group" aria-label="View">
        <button :aria-pressed="view === 'cards'" title="Cards with slide 1" @click="view = 'cards'">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="5.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="5.5" height="4.5" rx="1" /><rect x="1.5" y="9" width="5.5" height="4.5" rx="1" /><rect x="9" y="9" width="5.5" height="4.5" rx="1" /></svg>
          Cards
        </button>
        <button :aria-pressed="view === 'list'" title="Compact list" @click="view = 'list'">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" /></svg>
          List
        </button>
      </div>
      <button class="primary new" @click="openCreate">+ New deck</button>
    </div>

    <ul v-if="view === 'cards'" class="cards" data-testid="decks">
      <li v-for="deck in visible()" :key="deck.id" class="card" :class="{ archived: deck.archived }" data-testid="deck-item">
        <RouterLink :to="`/decks/${deck.id}`" class="thumb" tabindex="-1" aria-hidden="true">
          <img
            v-if="deck.thumbnailAt && !brokenThumbs.has(deck.id)"
            :src="thumbUrl(deck)"
            alt=""
            loading="lazy"
            @error="brokenThumbs.add(deck.id)"
          />
          <span v-else class="placeholder"><span>{{ deck.title }}</span></span>
        </RouterLink>
        <div class="body">
          <div class="head">
            <RouterLink :to="`/decks/${deck.id}`" class="name">{{ deck.title }}</RouterLink>
            <MenuButton label="⋯" :title="`More actions for ${deck.title}`">
              <a v-if="deck.previewUrl" :href="`${deck.previewUrl}/presenter/1`" target="_blank" rel="noopener">Presenter view</a>
              <button v-if="deck.can?.manage" @click="toggleArchive(deck)">{{ deck.archived ? 'Restore' : 'Archive' }}</button>
              <span v-if="!deck.previewUrl && !deck.can?.manage" class="muted none">No actions</span>
            </MenuButton>
          </div>
          <div class="badges">
            <span v-if="deck.archived" class="badge">archived</span>
            <span v-if="deck.public" class="badge public" title="Anyone can watch the last saved version">public</span>
            <span v-if="deck.access === 'members'" class="badge" title="Only members see this deck">members only</span>
            <span v-else-if="deck.access === 'team-view'" class="badge" title="Everyone can view, members edit">view only for team</span>
            <span v-if="deck.role === 'viewer' || deck.can?.edit === false" class="badge">you can view</span>
          </div>
          <div class="foot">
            <span class="meta">
              <span class="template" :title="templateLabel(themes, deck.themeId)">{{ templateLabel(themes, deck.themeId) }}</span>
              <span :title="`Edited ${dateFormat.format(new Date(deck.updatedAt))}`">{{ shortDate.format(new Date(deck.updatedAt)) }}</span>
            </span>
            <a
              v-if="deck.previewUrl"
              :href="deck.previewUrl"
              target="_blank"
              rel="noopener"
              class="button present"
              title="Open only the presentation (new tab)"
            ><span aria-hidden="true">▶</span> Present</a>
          </div>
        </div>
      </li>
      <li v-if="visible().length === 0" class="empty muted">
        {{ decks.length ? 'No matches.' : 'No decks yet. Create the first one with “New deck”.' }}
      </li>
    </ul>

    <div v-else class="table-wrap" data-testid="decks">
      <table class="decks">
        <thead>
          <tr><th>Title</th><th>Template</th><th>Edited</th><th class="right">Actions</th></tr>
        </thead>
        <tbody>
          <tr v-for="deck in visible()" :key="deck.id" :class="{ archived: deck.archived }" data-testid="deck-item">
            <td class="title">
              <RouterLink :to="`/decks/${deck.id}`">{{ deck.title }}</RouterLink>
              <span v-if="deck.archived" class="badge">archived</span>
              <span v-if="deck.public" class="badge public" title="Anyone can watch the last saved version">public</span>
              <span v-if="deck.access === 'members'" class="badge" title="Only members see this deck">members only</span>
              <span v-else-if="deck.access === 'team-view'" class="badge" title="Everyone can view, members edit">view only for team</span>
              <span v-if="deck.role === 'viewer' || deck.can?.edit === false" class="badge">you can view</span>
            </td>
            <td class="muted meta" data-label="Template">{{ templateLabel(themes, deck.themeId) }}</td>
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
                  <button v-if="deck.can?.manage" @click="toggleArchive(deck)">{{ deck.archived ? 'Restore' : 'Archive' }}</button>
                  <span v-if="!deck.previewUrl && !deck.can?.manage" class="muted none">No actions</span>
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
.new { padding: 0.5rem 1.1rem; }
.view-toggle { margin-left: auto; display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 2px; background: var(--surface-card); }
.view-toggle button { display: inline-flex; align-items: center; gap: 0.35rem; border: none; background: transparent; color: var(--ink-muted); padding: 0.3rem 0.65rem; font-size: 13px; border-radius: calc(var(--radius-md) - 2px); }
.view-toggle button[aria-pressed='true'] { background: var(--surface-100); color: var(--ink); }
.view-toggle button:hover { color: var(--ink); }
.view-toggle svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; }

.cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(15.5rem, 1fr)); gap: 1.1rem; }
/* No transform on hover: it would become the containing block of the fixed ⋯ menu and clip it. */
.card { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease); }
.card:hover { border-color: var(--border-strong); box-shadow: var(--shadow); }
.thumb { display: block; border-radius: var(--radius-lg) var(--radius-lg) 0 0; aspect-ratio: 16 / 9; border-bottom: 1px solid var(--border); background: var(--surface-2); overflow: hidden; }
.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
/* Until slide 1 has been rendered: the title on the dot grid of the editor stage. */
.placeholder { display: flex; align-items: flex-end; width: 100%; height: 100%; padding: 1rem 1.1rem; box-sizing: border-box; background-image: radial-gradient(var(--line) 1px, transparent 1px); background-size: 14px 14px; }
.placeholder span { font: 650 19px/1.15 var(--font-sans); letter-spacing: -0.02em; color: var(--ink); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.card.archived .thumb { opacity: 0.55; filter: grayscale(0.6); }
.body { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.7rem 0.6rem 0.55rem 0.9rem; flex: 1; }
.head { display: flex; align-items: center; gap: 0.3rem; }
.head :deep(.menu-button) { display: flex; }
.name { flex: 1; min-width: 0; font-weight: 600; font-size: 15px; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 0.3rem; }
.name:hover { color: var(--tango); }
.card.archived .name { color: var(--muted); }
.badges { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.badges:empty { display: none; }
.foot { display: flex; align-items: center; gap: 0.2rem; margin-top: auto; }
.foot { align-items: flex-end; }
.foot .meta { flex: 1; min-width: 0; display: grid; gap: 0.1rem; white-space: normal; }
.foot .meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.foot .template { color: var(--ink-muted); }
.foot .button.present { padding: 0.25rem 0.55rem; font-size: 13px; }
.cards .empty { grid-column: 1 / -1; text-align: center; padding: 2.5rem; border: 1px dashed var(--border); border-radius: var(--radius-lg); }
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
.badge.public { color: var(--tango); border-color: color-mix(in srgb, var(--tango) 40%, transparent); }

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
