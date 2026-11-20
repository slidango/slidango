<script setup lang="ts">
import { HocuspocusProvider } from '@hocuspocus/provider'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as Y from 'yjs'
import {
  type Deck,
  type DeckSlide,
  type Proposal,
  SLIDES_TEXT,
  applyOps,
  collabDocumentName,
  isDeckEmpty,
  parseDeck,
  validateSlide,
} from '@slidango/shared'
import { api } from '../api'
import AssistantPanel from '../components/AssistantPanel.vue'
import BrandLogo from '../components/BrandLogo.vue'
import BriefingPane from '../components/BriefingPane.vue'
import MenuButton from '../components/MenuButton.vue'
import PreviewPane from '../components/PreviewPane.vue'
import SlideList, { type SlidePeer } from '../components/SlideList.vue'
import SlidesEditor, { type Highlight, type Problem } from '../components/SlidesEditor.vue'
import ShareDialog from '../components/ShareDialog.vue'
import SplitHandle from '../components/SplitHandle.vue'
import TemplatePanel from '../components/TemplatePanel.vue'
import VersionsPanel from '../components/VersionsPanel.vue'
import { useEditorLayout } from '../composables/layout'
import { theme, toggleTheme } from '../composables/theme'
import { reportError } from '../errors'
import { PRESENCE, colorFor, currentUser } from '../user'

const props = defineProps<{ id: string }>()

interface Peer extends SlidePeer {
  /** 0-based line of the peer's cursor, if known. */
  line: number | null
}

const deck = ref<Deck | null>(null)
/** Read-only for archived decks and for people who may only view (viewer role, team-view). */
const readOnly = computed(() => !deck.value || deck.value.archived || deck.value.can?.edit === false)
const canManage = computed(() => deck.value?.can?.manage ?? false)
const sharingOpen = ref(false)
async function reloadDeck() {
  const fresh = await api.deck(props.id)
  deck.value = { ...fresh, previewUrl: fresh.previewUrl ?? deck.value?.previewUrl }
}
const error = ref<string | null>(null)
const status = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
const synced = ref(false)
const peers = shallowRef<Peer[]>([])
const editingTitle = ref(false)
const titleDraft = ref('')
const slide = ref(1)
const followCursor = ref(true)
const drawer = ref<'versions' | 'template' | null>(null)
const savingVersion = ref(false)
const versionMessage = ref('')
const notice = ref<string | null>(null)
const layouts = ref<string[]>([])
const editor = ref<InstanceType<typeof SlidesEditor>>()
const preview = ref<InstanceType<typeof PreviewPane>>()
const assistant = ref<InstanceType<typeof AssistantPanel>>()
const versionsPanel = ref<InstanceType<typeof VersionsPanel>>()
const versionInput = ref<HTMLInputElement>()
const fileInput = ref<HTMLInputElement>()
const body = ref<HTMLElement>()
const right = ref<HTMLElement>()

const { layout } = useEditorLayout()

const document = new Y.Doc()
const text = document.getText(SLIDES_TEXT)
const provider = shallowRef<HocuspocusProvider>()

// --- Deck structure, follows the shared text ---------------------------------

const slides = shallowRef<DeckSlide[]>([])
const empty = ref(false)
const draftPhase = ref('briefing')
const proposals = shallowRef<Proposal[]>([])
let parseTimer: ReturnType<typeof setTimeout> | undefined
text.observe(() => {
  clearTimeout(parseTimer)
  // Parsing on every keystroke is wasteful; 150 ms keeps the list and markers current.
  parseTimer = setTimeout(() => {
    const markdown = text.toString()
    slides.value = parseDeck(markdown)
    empty.value = isDeckEmpty(markdown)
    // The cursor may have moved into a slide that did not exist at the last parse.
    slide.value = slideOfLine(cursorLine)
    updatePeers()
  }, 150)
})

const showBriefing = computed(() => !deck.value?.archived && (empty.value || ['drafting', 'done'].includes(draftPhase.value)))

/** Slide containing a 0-based line; lines past the end belong to the last slide. */
const slideOfLine = (line: number) =>
  slides.value.find((s) => line >= s.startLine && line <= s.endLine)?.index ?? Math.max(1, slides.value.length)
let cursorLine = 0

/** Slides touched by open proposals, in the numbering the proposal was made for. */
const highlights = computed<Highlight[]>(() =>
  proposals.value
    .filter((p) => p.status === 'open' && p.slideCount === slides.value.length)
    .flatMap((p) =>
      p.ops.flatMap((op): Highlight[] => {
        const range = (i: number, kind: Highlight['kind']) => {
          const s = slides.value[i - 1]
          return s ? [{ from: s.startLine, to: s.endLine, kind }] : []
        }
        if (op.type === 'replace') return range(op.index, 'replace')
        if (op.type === 'delete') return op.indexes.flatMap((i) => range(i, 'delete'))
        if (op.type === 'move') return range(op.from, 'move')
        const s = slides.value[op.after - 1]
        return s ? [{ from: s.endLine, to: s.endLine, kind: 'insert' }] : []
      }),
    ),
)
const marked = computed(() => {
  const lines = highlights.value
  return new Set(slides.value.filter((s) => lines.some((h) => h.from <= s.endLine && h.to >= s.startLine)).map((s) => s.index))
})

/** Frontmatter and layout problems per slide; shown in the list, the editor gutter and the status bar. */
const problems = computed(() => {
  const map = new Map<number, string[]>()
  if (!layouts.value.length) return map
  for (const s of slides.value) {
    const found = validateSlide(s.content, layouts.value)
    if (found.length) map.set(s.index, found)
  }
  return map
})
const editorProblems = computed<Problem[]>(() =>
  [...problems.value].flatMap(([index, messages]) => {
    const s = slides.value[index - 1]!
    return messages.map((message) => ({ line: s.startLine, message }))
  }),
)
const firstProblem = computed(() => {
  const [entry] = problems.value
  return entry ? { index: entry[0], message: entry[1][0]! } : null
})

// --- Collaboration ------------------------------------------------------------

api
  .deck(props.id)
  .then((d) => {
    deck.value = d
    connect()
    void loadLayouts()
  })
  .catch((e: Error) => (error.value = e.message))

async function loadLayouts() {
  layouts.value = await api.layouts(props.id).catch(() => [])
}

function connect() {
  const wsUrl = new URL('/collab', location.href)
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const p = new HocuspocusProvider({
    url: wsUrl.toString(),
    name: collabDocumentName(props.id),
    document,
    // Identity comes from the SSO proxy headers; the token only triggers onAuthenticate.
    token: 'proxy',
    onStatus: ({ status: s }) => (status.value = s),
    onSynced: () => (synced.value = true),
    onAuthenticationFailed: () => (error.value = 'You don’t have access to this deck.'),
  })
  const user = currentUser.value!
  p.awareness!.setLocalStateField('user', { id: user.id, name: user.name, color: colorFor(user.id) })
  p.awareness!.on('change', updatePeers)
  provider.value = p
}

/**
 * Three presence colours collide quickly when picked by hash. If someone else in the deck already
 * shows our colour and a free one exists, switch to it. Only the later client (higher id) moves,
 * so two people never swap back and forth.
 */
function avoidColorClash(awareness: NonNullable<HocuspocusProvider['awareness']>) {
  const own = awareness.getLocalState()?.user as { color?: string } | undefined
  if (!own?.color) return
  const others = [...awareness.getStates()].filter(([id, state]) => id !== awareness.clientID && state.user?.color)
  const clash = others.some(([id, state]) => state.user.color === own.color && id < awareness.clientID)
  if (!clash) return
  const used = new Set(others.map(([, state]) => state.user.color as string))
  const free = PRESENCE.find((c) => !used.has(c))
  if (free) awareness.setLocalStateField('user', { ...own, color: free })
}

/** Peers with the line of their cursor (y-codemirror keeps it as a relative Yjs position). */
function updatePeers() {
  const awareness = provider.value?.awareness
  if (!awareness) return
  avoidColorClash(awareness)
  const markdown = text.toString()
  peers.value = [...awareness.getStates()]
    .filter(([, state]) => state.user)
    .map(([clientId, state]) => {
      let line: number | null = null
      const head = state.cursor?.head
      if (head) {
        const absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), document)
        if (absolute) line = markdown.slice(0, absolute.index).split('\n').length - 1
      }
      return { clientId, name: state.user.name, color: state.user.color, line }
    })
}

const ownClientId = computed(() => provider.value?.awareness?.clientID)
const peersBySlide = computed(() => {
  const map = new Map<number, SlidePeer[]>()
  for (const peer of peers.value) {
    if (peer.clientId === ownClientId.value || peer.line === null) continue
    const index = slideOfLine(peer.line)
    map.set(index, [...(map.get(index) ?? []), peer])
  }
  return map
})

onBeforeUnmount(() => {
  provider.value?.destroy()
  document.destroy()
})

const statusLabel = computed(() => ({ connecting: 'Connecting …', connected: 'Connected', disconnected: 'Offline' })[status.value])

// --- Actions ------------------------------------------------------------------

function onCursorLine(line: number) {
  cursorLine = line
  slide.value = slideOfLine(line)
}

function onPreviewNavigated(no: number) {
  slide.value = no
  const target = slides.value[no - 1]
  if (target) editor.value?.goToLine(target.startLine, false)
}

function onMove(from: number, to: number) {
  const result = applyOps(text.toString(), [{ type: 'move', from, to }], {})
  if (result.ok) editor.value?.replaceAll(result.text)
}

function flash(message: string) {
  notice.value = message
  setTimeout(() => notice.value === message && (notice.value = null), 3000)
}

async function startSaving() {
  savingVersion.value = true
  await nextTick()
  versionInput.value?.focus()
}

async function saveVersion() {
  const version = await api.saveVersion(props.id, versionMessage.value)
  savingVersion.value = false
  versionMessage.value = ''
  flash(version ? 'Version saved.' : 'No changes since the last version.')
  await versionsPanel.value?.reload()
}

async function uploadImage(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  await insertImages(files)
}

/** Uploads images into the deck's public/ folder and inserts them as Markdown at the cursor. */
async function insertImages(files: File[]) {
  if (!files.length) return
  flash(files.length === 1 ? 'Uploading image …' : `Uploading ${files.length} images …`)
  const lines: string[] = []
  for (const file of files) {
    try {
      const { path } = await api.uploadAsset(props.id, file)
      // Pasted screenshots are all called "image.png"; their alt text stays generic.
      const alt = file.name && file.name !== 'image.png' ? file.name.replace(/\.[^.]+$/, '') : 'Image'
      lines.push(`![${alt}](${path})`)
    } catch (e) {
      reportError(new Error(`Couldn’t upload ${file.name || 'image'}: ${(e as Error).message}`))
    }
  }
  if (lines.length) editor.value?.insert(lines.join('\n\n'))
}

function onTemplateUpdated(updated: Deck) {
  deck.value = { ...updated, previewUrl: deck.value?.previewUrl }
  drawer.value = null
  flash(`Template ${updated.themeVersion} aktiv.`)
  preview.value?.restart()
  void loadLayouts()
}

function startRename() {
  titleDraft.value = deck.value!.title
  editingTitle.value = true
}

async function saveTitle() {
  editingTitle.value = false
  const title = titleDraft.value.trim()
  if (!title || title === deck.value!.title) return
  deck.value = { ...(await api.updateDeck(props.id, { title })), previewUrl: deck.value!.previewUrl }
}

function present() {
  if (deck.value?.previewUrl) window.open(`${deck.value.previewUrl}/${slide.value}`, '_blank', 'noopener')
}

// --- Layout -------------------------------------------------------------------

const narrow = ref(false)
const tab = ref<'slides' | 'editor' | 'preview' | 'assistant'>('editor')
const rightWidth = ref(0)
const rightHeight = ref(0)
let media: MediaQueryList | undefined
let observer: ResizeObserver | undefined

function onMedia() {
  narrow.value = media!.matches
}

onMounted(() => {
  media = window.matchMedia('(max-width: 900px)')
  media.addEventListener('change', onMedia)
  onMedia()
  observer = new ResizeObserver(([entry]) => {
    rightWidth.value = entry!.contentRect.width
    rightHeight.value = entry!.contentRect.height
  })
  watch(
    right,
    (el, old) => {
      if (old) observer!.unobserve(old)
      if (el) observer!.observe(el)
    },
    { immediate: true },
  )
  window.addEventListener('keydown', onShortcut)
})
onBeforeUnmount(() => {
  media?.removeEventListener('change', onMedia)
  observer?.disconnect()
  window.removeEventListener('keydown', onShortcut)
})

const CONTROLS_HEIGHT = 37
/** Preview height: the user's choice, else exactly a 16:9 slide plus its control bar. */
const ASSISTANT_MIN = 220
/** Preview height: the user's choice, else a 16:9 slide plus its control bar, leaving room for an open assistant. */
const previewHeight = computed(() => {
  if (layout.previewHeight !== null) return layout.previewHeight
  const natural = Math.round((rightWidth.value * 9) / 16) + CONTROLS_HEIGHT
  if (!layout.assistantOpen || !rightHeight.value) return natural
  return Math.max(140, Math.min(natural, rightHeight.value - ASSISTANT_MIN))
})

function dragRight(delta: number) {
  const total = body.value!.getBoundingClientRect().width - (layout.slidesOpen ? layout.slidesWidth : 0)
  layout.rightShare = Math.min(0.8, Math.max(0.2, layout.rightShare - delta / total))
}
function dragPreview(delta: number) {
  const column = right.value!.getBoundingClientRect().height
  layout.previewHeight = Math.min(column - 120, Math.max(140, previewHeight.value + delta))
}
function dragSlides(delta: number) {
  layout.slidesWidth = Math.min(360, Math.max(140, layout.slidesWidth + delta))
}

// --- Shortcuts ----------------------------------------------------------------

function onShortcut(event: KeyboardEvent) {
  const mod = event.metaKey || event.ctrlKey
  if (!mod) return
  if (event.key.toLowerCase() === 's' && !event.altKey) {
    event.preventDefault()
    if (!readOnly.value) void startSaving()
  } else if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
    event.preventDefault()
    preview.value?.step(event.key === 'ArrowRight' ? 'next' : 'prev')
  } else if (event.key.toLowerCase() === 'k' && !event.altKey) {
    event.preventDefault()
    layout.assistantOpen = true
    if (narrow.value) tab.value = 'assistant'
    void nextTick(() => assistant.value?.focus())
  }
}

const showShortcuts = ref(false)
</script>

<template>
  <div v-if="error" class="fatal">{{ error }} <RouterLink to="/">Back</RouterLink></div>
  <div v-else-if="deck" class="editor-page">
    <header class="topbar">
      <RouterLink to="/" class="brand" title="All decks" aria-label="All decks"><BrandLogo :size="18" /></RouterLink>
      <div class="title">
        <form v-if="editingTitle" @submit.prevent="saveTitle">
          <input v-model="titleDraft" autofocus maxlength="200" @blur="saveTitle" @keydown.esc="editingTitle = false" />
        </form>
        <h1 v-else :title="deck.archived ? 'Archived' : canManage ? 'Double-click to rename' : deck.title" @dblclick="canManage && !deck.archived && startRename()">
          {{ deck.title }}
        </h1>
        <span class="connection" :class="status" :title="statusLabel" data-testid="status">
          <span class="dot" />{{ statusLabel }}
        </span>
        <span v-if="deck.archived" class="tag">Archived · read-only</span>
        <span v-else-if="readOnly" class="tag">View only</span>
      </div>

      <div class="actions">
        <span v-if="notice" class="notice" role="status">{{ notice }}</span>
        <ul class="peers" data-testid="peers">
          <li v-for="peer in peers" :key="peer.clientId" :style="{ background: peer.color }" :title="peer.name">
            {{ peer.name.slice(0, 1).toUpperCase() }}
          </li>
        </ul>
        <template v-if="!readOnly">
          <form v-if="savingVersion" class="save" @submit.prevent="saveVersion">
            <input ref="versionInput" v-model="versionMessage" placeholder="Description (optional)" maxlength="500" @keydown.esc="savingVersion = false" />
            <button class="primary" type="submit">Save</button>
          </form>
          <button v-else class="primary" title="Save version (Ctrl+S)" @click="startSaving">Save version</button>
        </template>
        <button class="present ghost" :disabled="!deck.previewUrl" title="Present in a new tab" @click="present">Present</button>
        <MenuButton label="⋯" title="More actions" class="more">
          <button @click="sharingOpen = true">Share …</button>
          <button @click="drawer = 'versions'">Versions</button>
          <button v-if="canManage" @click="drawer = 'template'">Template <span class="muted">{{ deck.themeVersion ?? 'Default' }}</span></button>
          <button v-if="!readOnly" @click="fileInput?.click()">Insert image …</button>
          <hr />
          <button @click="toggleTheme">{{ theme === 'dark' ? 'Light theme' : 'Dark theme' }}</button>
          <button @click="showShortcuts = true">Keyboard shortcuts</button>
          <RouterLink to="/">All decks</RouterLink>
        </MenuButton>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" multiple hidden @change="uploadImage" />
      </div>
    </header>

    <nav v-if="narrow" class="tabs" role="tablist">
      <button
        v-for="t in (['slides', 'editor', 'preview', 'assistant'] as const)"
        :key="t"
        role="tab"
        :aria-selected="tab === t"
        :class="{ active: tab === t }"
        @click="tab = t"
      >
        {{ { slides: 'Slides', editor: 'Editor', preview: showBriefing ? 'Briefing' : 'Preview', assistant: 'AI' }[t] }}
      </button>
    </nav>
    <div v-else />

    <main ref="body" class="body" :class="{ narrow }">
      <!-- Slide list -->
      <template v-if="narrow ? tab === 'slides' : true">
        <section v-if="narrow || layout.slidesOpen" class="slides" :style="narrow ? {} : { width: `${layout.slidesWidth}px` }">
          <SlideList
            :slides="slides"
            :current="slide"
            :marked="marked"
            :problems="problems"
            :peers="peersBySlide"
            :read-only="readOnly"
            @select="editor?.goToLine($event); narrow && (tab = 'editor')"
            @move="onMove"
            @collapse="layout.slidesOpen = false"
          />
        </section>
        <button v-else class="rail" title="Expand slide list" aria-label="Expand slide list" @click="layout.slidesOpen = true">
          <span>Slides</span>
        </button>
        <SplitHandle v-if="!narrow && layout.slidesOpen" direction="horizontal" label="Width of the slide list" @drag="dragSlides" @reset="layout.slidesWidth = 200" />
      </template>

      <!-- Editor (kept mounted on narrow screens so the CodeMirror state survives tab switches) -->
      <section v-show="narrow ? tab === 'editor' : layout.editorOpen" class="editor" :style="narrow ? {} : { flex: `${1 - layout.rightShare} 1 0` }">
        <div class="editor-host">
          <SlidesEditor
            v-if="synced && provider"
            ref="editor"
            :text="text"
            :awareness="provider.awareness!"
            :read-only="readOnly"
            :highlights="highlights"
            :problems="editorProblems"
            @cursor-line="onCursorLine"
            @images="insertImages"
          />
          <p v-else class="muted loading">Loading deck …</p>
        </div>
        <footer class="statusbar">
          <span>Slide {{ slide }} of {{ slides.length }}</span>
          <button v-if="firstProblem" class="problem" :title="firstProblem.message" @click="editor?.goToLine(slides[firstProblem.index - 1]!.startLine)">
            {{ problems.size === 1 ? '1 slide with a problem' : `${problems.size} slides with problems` }}: slide {{ firstProblem.index }} – {{ firstProblem.message }}
          </button>
          <span v-else class="ok">No problems</span>
          <button v-if="!narrow" class="ghost icon collapse" title="Collapse Markdown editor" aria-label="Collapse Markdown editor" @click="layout.editorOpen = false">«</button>
        </footer>
      </section>
      <button v-if="!narrow && !layout.editorOpen" class="rail" title="Expand Markdown editor" aria-label="Expand Markdown editor" @click="layout.editorOpen = true">
        <span>Markdown</span>
      </button>

      <SplitHandle v-if="!narrow && layout.editorOpen" direction="horizontal" label="Width of preview and AI panel" @drag="dragRight" @reset="layout.rightShare = 0.42" />

      <!-- Preview over assistant -->
      <section v-show="narrow ? tab === 'preview' || tab === 'assistant' : true" ref="right" class="right" :style="narrow ? {} : { flex: layout.editorOpen ? `${layout.rightShare} 1 0` : '1 1 0' }">
        <template v-if="synced && showBriefing">
          <div v-show="!narrow || tab === 'preview'" class="briefing-host">
            <BriefingPane :deck-id="deck.id" :empty="empty" :read-only="readOnly" @phase="draftPhase = $event">
              <PreviewPane ref="preview" v-model:follow="followCursor" :deck-id="deck.id" :slide="slide" :total="slides.length" @navigated="onPreviewNavigated" />
            </BriefingPane>
          </div>
        </template>
        <template v-else>
          <div
            v-show="!narrow || tab === 'preview'"
            class="preview-host"
            :style="narrow || !layout.assistantOpen ? { flex: '1 1 0' } : { height: `${previewHeight}px` }"
          >
            <PreviewPane ref="preview" v-model:follow="followCursor" :deck-id="deck.id" :slide="slide" :total="slides.length" @navigated="onPreviewNavigated" />
          </div>
          <template v-if="!narrow">
            <SplitHandle v-if="layout.assistantOpen" direction="vertical" label="Height of the preview" @drag="dragPreview" @reset="layout.previewHeight = null" />
            <div v-if="layout.assistantOpen" class="assistant-host">
              <AssistantPanel
                ref="assistant"
                :deck-id="deck.id"
                :slides="slides"
                :cursor-slide="slide"
                :read-only="readOnly"
                collapsible
                @proposals="proposals = $event"
                @collapse="layout.assistantOpen = false"
              />
            </div>
            <button v-else class="assistant-rail" title="Open Slidango AI (Ctrl+K)" @click="layout.assistantOpen = true">
              Open Slidango AI <span v-if="marked.size" class="badge ai">open suggestion</span>
            </button>
          </template>
        </template>
        <div v-if="narrow" v-show="tab === 'assistant'" class="assistant-host">
          <AssistantPanel ref="assistant" :deck-id="deck.id" :slides="slides" :cursor-slide="slide" :read-only="readOnly" @proposals="proposals = $event" />
        </div>
      </section>

      <!-- Drawers -->
      <div v-if="drawer" class="scrim" @click="drawer = null" />
      <aside v-if="drawer" class="drawer">
        <VersionsPanel v-if="drawer === 'versions'" ref="versionsPanel" :deck-id="deck.id" :read-only="readOnly" @close="drawer = null" />
        <TemplatePanel v-else :deck="deck" @updated="onTemplateUpdated" @close="drawer = null" />
      </aside>
    </main>

    <ShareDialog
      v-if="sharingOpen"
      :deck-id="deck.id"
      :title="deck.title"
      :can-manage="canManage"
      @changed="reloadDeck"
      @close="sharingOpen = false"
    />

    <div v-if="showShortcuts" class="scrim" @click="showShortcuts = false">
      <div class="dialog" role="dialog" aria-label="Keyboard shortcuts" @click.stop>
        <h2>Keyboard shortcuts</h2>
        <dl>
          <dt><kbd>Ctrl</kbd> + <kbd>S</kbd></dt><dd>Save version</dd>
          <dt><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>←</kbd> / <kbd>→</kbd></dt><dd>Page through the preview</dd>
          <dt><kbd>Ctrl</kbd> + <kbd>K</kbd></dt><dd>Ask Slidango AI</dd>
          <dt><kbd>Ctrl</kbd> + <kbd>Z</kbd></dt><dd>Undo (also moves in the slide list)</dd>
        </dl>
        <p class="muted">On a Mac, use <kbd>⌘</kbd> instead of <kbd>Ctrl</kbd>.</p>
        <button class="primary" @click="showShortcuts = false">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-page { display: grid; grid-template-rows: auto auto minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); height: 100vh; height: 100dvh; background: var(--bg); overflow: hidden; }

/* Top bar */
.topbar { display: flex; align-items: center; gap: var(--space-3); min-height: 48px; padding: 0.3rem var(--space-3); padding-top: calc(0.3rem + env(safe-area-inset-top, 0px)); background: var(--surface-100); color: var(--ink); border-bottom: 1px solid var(--line); min-width: 0; }
.brand { display: flex; padding: var(--space-1); border-radius: var(--radius-sm); }
.title { display: flex; align-items: center; gap: 0.7rem; min-width: 0; flex: 1 1 auto; }
.title h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; }
.title input { padding: 0.2rem 0.5rem; }
.connection { display: flex; align-items: center; gap: 0.35rem; font: 400 11px/1.2 var(--font-mono); color: var(--ink-subtle); white-space: nowrap; }
.connection .dot { width: 0.45rem; height: 0.45rem; border-radius: 50%; background: var(--success); }
.connection.connecting .dot { background: var(--ink-subtle); }
.connection.disconnected { color: var(--danger); }
.connection.disconnected .dot { background: var(--danger); }
.tag { font: 500 11px/1.4 var(--font-mono); border: 1px solid var(--line); border-radius: var(--radius-pill); padding: 0.05rem 0.5rem; color: var(--ink-muted); white-space: nowrap; }
.actions { display: flex; align-items: center; gap: 0.5rem; }
.actions .save { display: flex; gap: 0.4rem; }
.actions .save input { padding: 0.35rem 0.6rem; }
.more :deep(> button) { background: transparent; border-color: var(--line-strong); }
.notice { font-size: 13px; color: var(--ink-muted); }
.peers { display: flex; list-style: none; margin: 0 0 0 0.35rem; padding: 0; }
.peers li { width: 1.6rem; height: 1.6rem; border-radius: var(--radius-pill); color: var(--on-cursor); display: grid; place-items: center; font: 500 11px/1 var(--font-mono); border: 2px solid var(--surface-100); margin-left: -0.35rem; }

/* Tabs (narrow screens) */
.tabs { display: flex; background: var(--surface); border-bottom: 1px solid var(--border); }
.tabs button { flex: 1; border: none; border-radius: 0; background: none !important; padding: 0.6rem 0.25rem; border-bottom: 2px solid transparent; }
.tabs button.active { border-bottom-color: var(--tango); color: var(--ink); }

/* Body */
.body { display: flex; min-height: 0; position: relative; }
.body > section { min-width: 0; min-height: 0; }
.slides { flex: 0 0 auto; }
.rail { flex: 0 0 1.9rem; border: none; border-right: 1px solid var(--border); border-radius: 0; background: var(--surface-2); padding: 0.6rem 0; writing-mode: vertical-rl; font-size: 0.8rem; color: var(--muted); }
.rail { font-family: var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; font-size: 11px; }
.rail:hover:not(:disabled) { color: var(--ink); background: var(--hover); }
.editor { display: flex; flex-direction: column; background: var(--surface); }
.editor-host { flex: 1; min-height: 0; }
.loading { padding: 1rem; }
.statusbar { display: flex; gap: 0.75rem; white-space: nowrap; align-items: center; padding: 0.25rem 0.75rem; border-top: 1px solid var(--border); font: 400 11px/1.4 var(--font-mono); color: var(--muted); background: var(--surface); min-width: 0; }
.statusbar .problem { border: none; background: var(--warning-soft); color: var(--warning); padding: 0.1rem 0.5rem; border-radius: var(--radius-sm); font: 500 11px/1.4 var(--font-mono); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.statusbar .ok { color: var(--success); }
.statusbar .collapse { margin-left: auto; padding: 0 0.4rem; min-width: 0; font-size: 13px; }
.right { display: flex; flex-direction: column; background: var(--surface); }
.preview-host { flex: 0 0 auto; min-height: 0; display: flex; flex-direction: column; }
.preview-host > * { flex: 1; }
.briefing-host { flex: 1; min-height: 0; }
.assistant-host { flex: 1 1 0; min-height: 0; }
.assistant-rail { flex: 0 0 auto; border: none; border-top: 1px solid var(--border); border-radius: 0; background: var(--surface-2); padding: 0.55rem; text-align: left; display: flex; gap: 0.5rem; align-items: center; }
.body.narrow > section { flex: 1 1 0; width: auto !important; }

/* Drawers and dialogs */
.scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 40; display: grid; place-items: center; }
.drawer { position: absolute; top: 0; right: 0; bottom: 0; width: min(24rem, 100%); z-index: 41; box-shadow: var(--shadow); display: flex; }
.drawer > * { flex: 1; }
.dialog { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 1.25rem 1.5rem; width: min(28rem, calc(100vw - 2rem)); box-shadow: var(--shadow); }
.dialog h2 { margin-top: 0; font-size: 20px; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; }
dt { white-space: nowrap; }
dd { margin: 0; }
kbd { font-family: var(--font-mono); font-size: 0.8rem; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 4px; padding: 0 0.3rem; background: var(--surface-2); }

@media (max-width: 1100px) {
  .connection { font-size: 0; gap: 0; }
}
@media (max-width: 900px) {
  .topbar { flex-wrap: wrap; }
  .actions { flex-wrap: wrap; }
  .peers { display: none; }
}
</style>
