<script setup lang="ts">
/** Who may see and edit a deck: the access setting plus members with a role. */
import { computed, onMounted, ref } from 'vue'
import type { DeckAccess, DeckRole, DeckSharing, DirectoryUser } from '@slidango/shared'
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

onMounted(async () => {
  dialog.value?.showModal()
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
