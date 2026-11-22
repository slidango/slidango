<script setup lang="ts">
/** Who may see and edit a deck: the access setting plus members with a role. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DeckAccess, DeckRole, DeckSharing, DirectoryUser, PublicState } from '@slidango/shared'
import { api } from '../api'
import { currentUser } from '../user'

const props = defineProps<{ deckId: string; title: string; canManage: boolean }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const dialog = ref<HTMLDialogElement>()

const sharing = ref<DeckSharing | null>(null)
const directory = ref<DirectoryUser[]>([])
const query = ref('')
const addRole = ref<DeckRole>('editor')
const error = ref<string | null>(null)

const ACCESS: { value: DeckAccess; label: string; hint: string }[] = [
  { value: 'team-edit', label: 'Everyone can edit', hint: 'Every signed-in person sees the deck and can write in it.' },
  { value: 'team-view', label: 'Everyone can view', hint: 'Everyone sees it; only members with Editor or Owner can write.' },
  { value: 'members', label: 'Members only', hint: 'Only the people below see the deck at all (and admins).' },
]
const ROLES: { value: DeckRole; label: string }[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'owner', label: 'Owner' },
]

const memberIds = computed(() => new Set(sharing.value?.members.map((m) => m.userId)))
const candidates = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return []
  return directory.value
    .filter((u) => !memberIds.value.has(u.id) && (u.name.toLowerCase().includes(q) || u.email.includes(q)))
    .slice(0, 6)
})

async function run(action: () => Promise<DeckSharing>) {
  error.value = null
  try {
    sharing.value = await action()
    emit('changed')
  } catch (e) {
    error.value = (e as Error).message
  }
}

const setAccess = (access: DeckAccess) => run(() => api.setAccess(props.deckId, access))
const setRole = (userId: string, role: DeckRole) => {
  if (role === 'owner' && !window.confirm('Transfer ownership? You stay on as editor and can no longer manage sharing.')) return
  return run(() => api.setMember(props.deckId, userId, role))
}
const remove = (userId: string) => run(() => api.removeMember(props.deckId, userId))
const add = (user: DirectoryUser) => {
  query.value = ''
  return run(() => api.setMember(props.deckId, user.id, addRole.value))
}

/** Public link: a static build of the last saved version, for everyone without signing in. */
const pub = ref<PublicState | null>(null)
const copied = ref(false)
const absoluteUrl = computed(() => (pub.value?.url ? new URL(pub.value.url, window.location.origin).href : null))
let poll: ReturnType<typeof setTimeout> | undefined

function watchBuild(state: PublicState) {
  pub.value = state
  clearTimeout(poll)
  if (state.status === 'building') {
    poll = setTimeout(async () => watchBuild(await api.publicState(props.deckId).catch(() => state)), 2000)
  } else if (state.status === 'ready') {
    emit('changed')
  }
}

async function setPublic(value: boolean) {
  error.value = null
  if (value && !window.confirm('Make this deck public? Anyone with the link can watch the last saved version, without signing in. Speaker notes are left out.')) {
    return
  }
  try {
    watchBuild(await api.setPublic(props.deckId, value))
    emit('changed')
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function copyLink() {
  if (!absoluteUrl.value) return
  await navigator.clipboard.writeText(absoluteUrl.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

const builtAt = computed(() =>
  pub.value?.builtAt ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(pub.value.builtAt)) : null,
)

onBeforeUnmount(() => clearTimeout(poll))

onMounted(async () => {
  dialog.value?.showModal()
  api.publicState(props.deckId).then(watchBuild, () => {})
  try {
    ;[sharing.value, directory.value] = await Promise.all([api.sharing(props.deckId), props.canManage ? api.users() : Promise.resolve([])])
  } catch (e) {
    error.value = (e as Error).message
  }
})
</script>

<template>
  <dialog ref="dialog" class="share" aria-labelledby="share-title" @close="emit('close')" @click.self="dialog?.close()">
    <div class="frame">
      <header>
        <h1 id="share-title">Share “{{ title }}”</h1>
        <button class="ghost icon" aria-label="Close" title="Close (Esc)" @click="dialog?.close()">✕</button>
      </header>
      <div v-if="sharing" class="body">
        <fieldset :disabled="!canManage">
          <legend class="eyebrow">Access</legend>
          <label v-for="option in ACCESS" :key="option.value" class="option" :class="{ active: sharing.access === option.value }">
            <input type="radio" name="access" :value="option.value" :checked="sharing.access === option.value" @change="setAccess(option.value)" />
            <span>
              <strong>{{ option.label }}</strong>
              <span class="muted">{{ option.hint }}</span>
            </span>
          </label>
        </fieldset>

        <section v-if="pub?.allowed" class="public" data-testid="public-link">
          <label class="option" :class="{ active: pub.public }">
            <input type="checkbox" :checked="pub.public" :disabled="!canManage" aria-label="Public link" @change="setPublic(($event.target as HTMLInputElement).checked)" />
            <span>
              <strong>Public link</strong>
              <span class="muted">Anyone with the link can watch the last saved version, signed in or not. It also shows on the start page for visitors. Speaker notes stay private.</span>
            </span>
          </label>
          <div v-if="pub.public" class="public-state">
            <template v-if="pub.status === 'building'">
              <span class="spinner" aria-hidden="true" /> Building the public version …
            </template>
            <template v-else-if="pub.status === 'error'">
              <span class="error">The public version could not be built.</span>
              <details><summary>Log</summary><pre>{{ pub.error }}</pre></details>
            </template>
            <template v-if="pub.url">
              <div class="link">
                <a :href="pub.url" target="_blank" rel="noopener">{{ absoluteUrl }}</a>
                <button class="ghost" @click="copyLink">{{ copied ? 'Copied' : 'Copy' }}</button>
              </div>
              <span class="muted small">Version of {{ builtAt }}. Save a version to update it.</span>
            </template>
          </div>
        </section>

        <div class="eyebrow members-title">Members</div>
        <div v-if="canManage" class="add">
          <input v-model="query" type="search" placeholder="Add a person by name or email" aria-label="Add a person" />
          <select v-model="addRole" aria-label="Role for the new member">
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <ul v-if="candidates.length" class="candidates" role="listbox">
            <li v-for="user in candidates" :key="user.id">
              <button type="button" @click="add(user)">
                <strong>{{ user.name }}</strong> <span class="muted">{{ user.email }}</span>
              </button>
            </li>
          </ul>
        </div>
        <ul class="members">
          <li v-for="member in sharing.members" :key="member.userId">
            <span class="who">
              <strong>{{ member.name }}</strong>
              <span v-if="member.userId === currentUser?.id" class="badge">you</span>
              <span class="muted email">{{ member.email }}</span>
            </span>
            <template v-if="canManage && member.role !== 'owner'">
              <select :value="member.role" :aria-label="`Role of ${member.name}`" @change="setRole(member.userId, ($event.target as HTMLSelectElement).value as DeckRole)">
                <option v-for="role in ROLES" :key="role.value" :value="role.value">{{ role.label }}</option>
              </select>
              <button class="ghost icon" :title="`Remove ${member.name}`" :aria-label="`Remove ${member.name}`" @click="remove(member.userId)">✕</button>
            </template>
            <span v-else class="role">{{ ROLES.find((r) => r.value === member.role)?.label }}</span>
          </li>
        </ul>
        <p v-if="!canManage" class="muted">Only the owner and admins can change sharing.</p>
        <p v-if="error" class="error">{{ error }}</p>
      </div>
      <p v-else-if="error" class="error body">{{ error }}</p>
    </div>
  </dialog>
</template>

<style scoped>
.share { border: 1px solid var(--line); padding: 0; border-radius: var(--radius-lg); width: min(34rem, calc(100vw - 2rem)); box-shadow: var(--shadow); background: var(--surface); color: var(--text); }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.9rem 0.8rem 0.6rem 1.25rem; border-bottom: 1px solid var(--border); }
h1 { font-size: 18px; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.body { padding: 0.9rem 1.25rem 1.25rem; }
.public { margin: 0 0 1rem; display: grid; gap: 0.5rem; }
.public .option input { accent-color: var(--tango-fill); }
.public-state { display: grid; gap: 0.35rem; font-size: 14px; padding: 0 0.2rem; }
.public-state .link { display: flex; align-items: center; gap: 0.5rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 0.3rem 0.3rem 0.3rem 0.7rem; }
.public-state .link a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 13px/1.4 var(--font-mono); }
.public-state .small { font-size: 12.5px; }
.public-state pre { white-space: pre-wrap; font-size: 11px; max-height: 12rem; overflow: auto; }
.spinner { display: inline-block; width: 0.8rem; height: 0.8rem; border: 2px solid var(--line); border-top-color: var(--tango); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -0.1em; margin-right: 0.3rem; }
@keyframes spin { to { transform: rotate(360deg); } }
fieldset { border: none; padding: 0; margin: 0 0 1rem; display: grid; gap: 0.4rem; }
legend { margin-bottom: 0.4rem; }
.option { display: flex; gap: 0.6rem; align-items: flex-start; padding: 0.55rem 0.7rem; border: 1px solid var(--line); border-radius: var(--radius-md); cursor: pointer; }
.option.active { border-color: var(--ink-muted); background: var(--surface-100); }
.option input { margin-top: 0.2rem; accent-color: var(--tango-fill); }
.option span { display: grid; gap: 0.1rem; font-size: 14px; }
.option .muted { font-size: 13px; }
fieldset:disabled .option { cursor: default; opacity: 0.75; }
.members-title { margin: 0.4rem 0 0.5rem; }
.add { position: relative; display: flex; gap: 0.5rem; margin-bottom: 0.6rem; }
.add input { flex: 1; min-width: 0; }
.candidates { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 5; list-style: none; margin: 0; padding: 0.3rem; background: var(--surface-card); border: 1px solid var(--line); border-radius: var(--radius-md); box-shadow: var(--shadow-pop); }
.candidates button { width: 100%; text-align: left; border: none; background: none; padding: 0.45rem 0.6rem; font-weight: 400; }
.candidates button:hover { background: var(--hover) !important; }
.members { list-style: none; margin: 0; padding: 0; }
.members li { display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0; border-bottom: 1px solid var(--border); }
.who { flex: 1; min-width: 0; display: flex; gap: 0.4rem; align-items: baseline; flex-wrap: wrap; }
.email { font-size: 12.5px; }
.role { font-size: 13px; color: var(--ink-muted); }
.error { color: var(--danger); }
</style>
