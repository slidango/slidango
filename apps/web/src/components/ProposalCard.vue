<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DeckSlide, Proposal } from '@slidango/shared'
import { api } from '../api'
import { diffLines } from '../llm'

const props = defineProps<{ proposal: Proposal; slides: DeckSlide[]; readOnly: boolean }>()
const emit = defineEmits<{ changed: [proposal: Proposal] }>()
const busy = ref(false)
const error = ref<string | null>(null)
const open = ref(props.proposal.status === 'open')

const STATUS = { open: 'Open', applied: 'Applied', rejected: 'Discarded', stale: 'Outdated', undone: 'Undone' }

/** Human-readable changes; diffs use the current slide text when the proposal is still open. */
const changes = computed(() =>
  props.proposal.ops.flatMap((op) => {
    const current = (i: number) => (props.proposal.status === 'open' ? (props.slides[i - 1]?.content ?? '') : '')
    if (op.type === 'replace') return [{ label: `Replace slide ${op.index}`, diff: diffLines(current(op.index), op.content) }]
    if (op.type === 'insert') {
      return op.contents.map((c, i) => ({ label: `New slide after ${op.after}${op.contents.length > 1 ? ` (${i + 1})` : ''}`, diff: diffLines('', c) }))
    }
    if (op.type === 'delete') return [{ label: `Delete slide ${op.indexes.join(', ')}`, diff: [] }]
    return [{ label: `Move slide ${op.from} to position ${op.to}`, diff: [] }]
  }),
)

async function act(action: 'apply' | 'reject' | 'undo') {
  busy.value = true
  error.value = null
  try {
    const updated = await api.proposalAction(props.proposal.id, action)
    emit('changed', updated)
    if (updated.status === 'stale') error.value = 'These slides changed in the meantime. Ask for a new suggestion.'
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="proposal" :class="proposal.status" data-testid="proposal">
    <header>
      <strong>Suggestion</strong>
      <span v-if="proposal.source === 'mcp'" class="badge ai" :title="`Made by ${proposal.client ?? 'an MCP client'} with your API token`">{{ proposal.client ?? 'MCP' }}</span>
      <span class="status">{{ STATUS[proposal.status] }}</span>
      <button class="link" @click="open = !open">{{ open ? 'Hide details' : 'Details' }}</button>
    </header>
    <ul class="ops">
      <li v-for="(change, i) in changes" :key="i">
        <div class="label">{{ change.label }}</div>
        <pre v-if="open && change.diff.length" class="diff"><span
          v-for="(line, j) in change.diff"
          :key="j"
          :class="line.kind"
        >{{ line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  ' }}{{ line.text }}
</span></pre>
      </li>
    </ul>
    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="!readOnly" class="actions">
      <template v-if="proposal.status === 'open'">
        <button class="primary" :disabled="busy" @click="act('apply')">Apply</button>
        <button :disabled="busy" @click="act('reject')">Discard</button>
      </template>
      <button v-else-if="proposal.status === 'applied'" :disabled="busy" @click="act('undo')">Undo</button>
    </div>
  </div>
</template>

<style scoped>
.proposal { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0.5rem 0.6rem; background: var(--surface); font-size: 0.85rem; }
.proposal.open { border-color: var(--ai); box-shadow: inset 2px 0 0 var(--ai); }
header { display: flex; gap: 0.5rem; align-items: baseline; }
.status { color: var(--muted); font-size: 0.8rem; }
.link { margin-left: auto; border: none; background: none !important; padding: 0; color: var(--accent); font-size: 0.8rem; }
.ops { list-style: none; margin: 0.4rem 0; padding: 0; display: grid; gap: 0.4rem; }
.label { font-weight: 500; }
.diff { margin: 0.25rem 0 0; font-size: 11.5px; line-height: 1.5; max-height: 16rem; overflow: auto; background: var(--surface-100); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 0.3rem; white-space: pre-wrap; }
.diff .add { background: var(--ai-soft); color: var(--ai); display: block; }
.diff .del { background: var(--danger-soft); color: var(--danger); text-decoration: line-through; display: block; }
.diff .same { color: var(--ink-muted); display: block; }
.actions { display: flex; gap: 0.4rem; }
.error { color: var(--danger); margin: 0.3rem 0; }
</style>
