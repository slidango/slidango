<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChatMessage, ChatSession, DeckSlide, Proposal } from '@slidango/shared'
import { api } from '../api'
import { streamLlm } from '../llm'
import { currentUser } from '../user'
import MenuButton from './MenuButton.vue'
import ProposalCard from './ProposalCard.vue'

const props = defineProps<{ deckId: string; slides: DeckSlide[]; cursorSlide: number; readOnly: boolean; collapsible?: boolean }>()
const emit = defineEmits<{ proposals: [proposals: Proposal[]]; collapse: [] }>()

const messages = ref<ChatMessage[]>([])
const sessions = ref<ChatSession[]>([])
// Each browser tab is its own session: a new tab starts a new conversation, a reload keeps it.
const storageKey = `assistant-session:${props.deckId}`
const sessionId = ref<string | null>(readSession())
const proposals = ref(new Map<string, Proposal>())
const input = ref('')
const streaming = ref<string | null>(null)
const error = ref<string | null>(null)
const configured = ref(true)
const list = ref<HTMLElement>()
const content = ref<HTMLElement>()
const textarea = ref<HTMLTextAreaElement>()
let controller: AbortController | null = null

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

const autoApply = computed({
  get: () => currentUser.value?.autoApply ?? false,
  set: async (value: boolean) => (currentUser.value = await api.updateMe({ autoApply: value })),
})

function readSession(): string | null {
  try {
    return sessionStorage.getItem(storageKey)
  } catch {
    return null
  }
}

function useSession(id: string | null) {
  sessionId.value = id
  try {
    if (id) sessionStorage.setItem(storageKey, id)
    else sessionStorage.removeItem(storageKey)
  } catch {
    // Without storage a reload simply starts a new conversation.
  }
}

async function openSession(id: string | null) {
  if (streaming.value !== null || id === sessionId.value) return
  useSession(id)
  messages.value = []
  error.value = null
  await load()
  textarea.value?.focus()
}

async function load() {
  if (streaming.value !== null) return
  const session = sessionId.value
  const state = await api.llmState(props.deckId, session)
  // The user switched conversations while this request ran.
  if (session !== sessionId.value) return
  const openExternal = (list: Proposal[]) => list.filter((p) => p.source === 'mcp' && p.status === 'open').length
  // New messages, or a new suggestion from an MCP client, scroll into view.
  const grew = state.messages.length !== messages.value.length || openExternal(state.proposals) > openExternal([...proposals.value.values()])
  sessions.value = state.sessions
  messages.value = state.messages
  proposals.value = new Map(state.proposals.map((p) => [p.id, p]))
  if (grew) scrollDown()
}

function scrollDown() {
  stickToBottom = true
  void nextTick(() => list.value?.scrollTo({ top: list.value.scrollHeight }))
}

/**
 * Keeps the newest message in view while the panel resizes (the preview above settles its height
 * after the first render, and the user drags dividers). Only while the list is scrolled to the end,
 * so reading older messages is never interrupted.
 */
let stickToBottom = true
function onScroll() {
  const el = list.value
  if (el) stickToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
}
const resizeObserver = new ResizeObserver(() => {
  if (stickToBottom && list.value) list.value.scrollTop = list.value.scrollHeight
})
// Both the list's box (panel resizes) and its content (cards render their diff late) count.
watch([list, content], (els, olds) => {
  for (const el of olds ?? []) if (el) resizeObserver.unobserve(el)
  for (const el of els) if (el) resizeObserver.observe(el)
})

async function send() {
  const text = input.value.trim()
  if (!text || streaming.value !== null) return
  input.value = ''
  error.value = null
  messages.value.push({ id: `local-${Date.now()}`, role: 'user', content: { text }, userName: currentUser.value?.name ?? null, createdAt: new Date().toISOString() })
  streaming.value = ''
  scrollDown()
  controller = new AbortController()
  try {
    await streamLlm(
      `/decks/${props.deckId}/llm/chat`,
      { message: text, cursorSlide: props.cursorSlide, sessionId: sessionId.value },
      (event) => {
        if (event.type === 'text') {
          streaming.value += event.delta
          scrollDown()
        } else if (event.type === 'session') useSession(event.session.id)
        else if (event.type === 'proposal') proposals.value.set(event.proposal.id, event.proposal)
        else if (event.type === 'error') error.value = event.message
      },
      controller.signal,
    )
  } catch (e) {
    if ((e as Error).name !== 'AbortError') error.value = (e as Error).message
  } finally {
    streaming.value = null
    controller = null
    await load()
  }
}

function onProposalChanged(proposal: Proposal) {
  proposals.value.set(proposal.id, proposal)
  proposals.value = new Map(proposals.value)
}

watch(proposals, (value) => emit('proposals', [...value.values()]), { deep: true })

/** Suggestions from MCP clients (Claude Code etc.) have no chat message; show open and recent ones on top. */
const external = computed(() =>
  [...proposals.value.values()]
    .filter((p) => p.source === 'mcp' && (p.status === 'open' || Date.now() - new Date(p.createdAt).getTime() < 15 * 60_000))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
)

// The chat is per person; polling keeps several tabs of the same person in step.
const timer = setInterval(() => void load(), 5000)
onMounted(async () => {
  configured.value = (await api.llmStatus()).configured
  await load()
})
onBeforeUnmount(() => {
  resizeObserver.disconnect()
  clearInterval(timer)
  controller?.abort()
})

defineExpose({ focus: () => textarea.value?.focus() })
</script>

<template>
  <aside class="assistant" data-testid="assistant">
    <header>
      <h2>Slidango AI</h2>
      <label class="muted auto" title="Apply suggestions without confirming (you can still undo)">
        <input v-model="autoApply" type="checkbox" /> Apply directly
      </label>
      <button
        v-if="messages.length"
        class="ghost icon"
        title="New conversation"
        aria-label="New conversation"
        :disabled="streaming !== null"
        @click="openSession(null)"
      >+</button>
      <MenuButton v-if="sessions.length" label="History" title="Earlier conversations">
        <template #label>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 3.5V8l3 2M2.2 8A5.8 5.8 0 1 0 4 3.8M2 1.8v3h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </template>
        <button :disabled="streaming !== null" @click="openSession(null)">+ New conversation</button>
        <hr />
        <button
          v-for="session in sessions"
          :key="session.id"
          class="session"
          :class="{ current: session.id === sessionId }"
          :disabled="streaming !== null"
          @click="openSession(session.id)"
        >
          <span class="session-title">{{ session.title || 'Untitled' }}</span>
          <span class="session-date">{{ dateFormat.format(new Date(session.updatedAt)) }}</span>
        </button>
      </MenuButton>
      <button v-if="collapsible" class="ghost icon" title="Collapse Slidango AI" aria-label="Collapse Slidango AI" @click="emit('collapse')">⌄</button>
    </header>
    <p v-if="!configured" class="hint">No LLM configured. An admin can set one up under Settings → Slidango AI on the overview page.</p>
    <div ref="list" class="messages" @scroll.passive="onScroll">
      <div ref="content" class="messages-inner">
      <div v-for="proposal in external" :key="proposal.id" class="message assistant external">
        <div class="author">{{ proposal.client ?? 'MCP client' }} · via your API token</div>
        <div v-if="proposal.summary" class="text">{{ proposal.summary }}</div>
        <ProposalCard :proposal="proposal" :slides="slides" :read-only="readOnly" @changed="onProposalChanged" />
      </div>
      <p v-if="messages.length === 0 && streaming === null && external.length === 0" class="muted empty">
        Ask for changes, e.g. “Shorten slide {{ cursorSlide }} to three bullets”. Suggestions show up here and in the editor.
        Only you can see this history.<template v-if="sessions.length"> Earlier conversations are under the clock icon.</template>
      </p>
      <div v-for="message in messages" :key="message.id" class="message" :class="message.role">
        <div v-if="message.role === 'user'" class="author">{{ message.userName ?? 'Someone' }}</div>
        <div v-if="message.content.text" class="text">{{ message.content.text }}</div>
        <ProposalCard
          v-if="message.content.proposalId && proposals.get(message.content.proposalId)"
          :proposal="proposals.get(message.content.proposalId)!"
          :slides="slides"
          :read-only="readOnly"
          @changed="onProposalChanged"
        />
      </div>
      <div v-if="streaming !== null" class="message assistant">
        <div class="text">{{ streaming || '…' }}</div>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      </div>
    </div>
    <form v-if="!readOnly" class="composer" @submit.prevent="send">
      <textarea
        ref="textarea"
        v-model="input"
        rows="3"
        :placeholder="`Message (cursor on slide ${cursorSlide})`"
        :disabled="!configured"
        @keydown.enter.exact.prevent="send"
      />
      <button v-if="streaming !== null" type="button" @click="controller?.abort()">Stop</button>
      <button v-else class="primary" type="submit" :disabled="!input.trim() || !configured">Send</button>
    </form>
  </aside>
</template>

<style scoped>
.assistant { height: 100%; display: flex; flex-direction: column; background: var(--surface); min-width: 0; }
header { display: flex; gap: 0.5rem; align-items: center; padding: 0.3rem 0.4rem 0.3rem 0.75rem; border-bottom: 1px solid var(--border); background: var(--surface-2); }
h2 { font-size: 14px; font-weight: 600; margin: 0; flex: 1; }
.auto { font-size: 0.8rem; display: flex; gap: 0.3rem; align-items: center; }
.hint { margin: 0; padding: 0.5rem 0.75rem; font-size: 0.85rem; background: var(--warning-soft); color: var(--warning); }
.messages { flex: 1; min-height: 0; overflow: auto; }
.messages-inner { padding: 0.6rem 0.75rem 1rem; display: flex; flex-direction: column; gap: 0.6rem; }
.empty { font-size: 0.85rem; }
.message { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.9rem; }
.message.user { align-items: flex-end; }
.message.user .text { background: var(--surface-100); color: var(--ink); border: 1px solid var(--line); border-radius: 12px 12px 2px 12px; padding: 0.4rem 0.6rem; max-width: 90%; white-space: pre-wrap; }
.message.assistant .text { white-space: pre-wrap; border-left: 2px solid var(--ai); padding-left: 0.6rem; }
.author { font: 500 11px/1.2 var(--font-mono); color: var(--muted); }
.error { color: var(--danger); font-size: 0.85rem; }
.composer { display: flex; gap: 0.4rem; padding: 0.5rem 0.75rem; border-top: 1px solid var(--border); align-items: flex-end; }
textarea { flex: 1; font: inherit; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 0.4rem 0.5rem; resize: vertical; min-width: 0; }
.session { display: flex; flex-direction: column; align-items: flex-start; gap: 0.1rem; max-width: 18rem; }
.session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.session-date { font: 400 11px/1.3 var(--font-mono); color: var(--ink-subtle); }
.session.current .session-title { color: var(--ink); font-weight: 600; }
</style>
