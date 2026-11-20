<script setup lang="ts">
/** Settings → People: who has access, invitations, admin rights, disabling accounts. */
import { computed, onMounted, ref } from 'vue'
import type { AuthMode, InviteLink, PendingInvite, Person } from '@slidango/shared'
import { api } from '../api'
import { currentUser } from '../user'
import MenuButton from './MenuButton.vue'

const mode = ref<AuthMode>('oidc')
const people = ref<Person[]>([])
const invites = ref<PendingInvite[]>([])
const error = ref<string | null>(null)
const filter = ref('')

const email = ref('')
const grantAdmin = ref(false)
/** The last link created; shown until dismissed, since it cannot be retrieved again. */
const link = ref<(InviteLink & { email: string; purpose: 'invite' | 'reset' }) | null>(null)
const copied = ref(false)

const visible = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return q ? people.value.filter((p) => p.name.toLowerCase().includes(q) || p.email.includes(q)) : people.value
})

async function load() {
  const data = await api.admin.people()
  mode.value = data.mode
  people.value = data.people
  invites.value = data.invites
}

async function run(action: () => Promise<unknown>) {
  error.value = null
  try {
    await action()
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
}

const invite = () =>
  run(async () => {
    const created = await api.admin.invite(email.value, grantAdmin.value)
    link.value = { ...created, email: email.value.trim().toLowerCase(), purpose: 'invite' }
    email.value = ''
    grantAdmin.value = false
  })

const reset = (person: Person) =>
  run(async () => {
    link.value = { ...(await api.admin.resetLink(person.id)), email: person.email, purpose: 'reset' }
  })

async function copyLink() {
  if (!link.value) return
  await navigator.clipboard?.writeText(link.value.url)
  copied.value = true
  setTimeout(() => (copied.value = false), 1400)
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const shortDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })
const seen = (value: string | null) => (value ? dateFormat.format(new Date(value)) : 'Never')

onMounted(() => void load())
</script>

<template>
  <section>
    <h2>People</h2>
    <p v-if="mode === 'oidc'" class="muted">
      People sign in through single sign-on and appear here after their first visit. You can make them admins or disable them.
    </p>
    <p v-else class="muted">Invite people with a link you pass on yourself (no email is sent). Links are valid for 7 days and work once.</p>

    <form v-if="mode === 'local'" class="invite" @submit.prevent="invite">
      <input v-model="email" type="email" required maxlength="200" placeholder="name@example.com" aria-label="Email to invite" />
      <label class="check"><input v-model="grantAdmin" type="checkbox" /> Admin</label>
      <button class="primary" type="submit">Create invite link</button>
    </form>

    <div v-if="link" class="link" role="status">
      <p>
        {{ link.purpose === 'invite' ? 'Invite link' : 'Password reset link' }} for <strong>{{ link.email }}</strong>, valid until
        {{ shortDate.format(new Date(link.expiresAt)) }}. Copy it now: it is shown only once.
      </p>
      <div class="secret">
        <code>{{ link.url }}</code>
        <button class="ghost" @click="copyLink">{{ copied ? 'Copied' : 'Copy' }}</button>
      </div>
      <button class="ghost dismiss" @click="link = null">Dismiss</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <input v-if="people.length > 8" v-model="filter" type="search" class="filter" placeholder="Filter people" aria-label="Filter people" />

    <table>
      <thead>
        <tr><th>Person</th><th>Role</th><th>Status</th><th>Last seen</th><th>Tokens</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="person in visible" :key="person.id" :class="{ disabled: person.status === 'disabled' }">
          <td>
            <strong>{{ person.name }}</strong>
            <span v-if="person.id === currentUser?.id" class="badge">you</span>
            <div class="muted email">{{ person.email }}</div>
          </td>
          <td>{{ person.isAdmin ? 'Admin' : 'Member' }}</td>
          <td>
            <span v-if="person.status === 'disabled'" class="status off">Disabled</span>
            <span v-else-if="mode === 'local' && !person.hasPassword" class="status pending">Invited</span>
            <span v-else class="status on">Active</span>
          </td>
          <td class="muted nowrap">{{ seen(person.lastSeenAt) }}</td>
          <td class="muted">{{ person.activeTokens || '–' }}</td>
          <td class="actions">
            <MenuButton label="⋯" :title="`Actions for ${person.name}`">
              <button
                :disabled="person.id === currentUser?.id"
                @click="run(() => api.admin.updatePerson(person.id, { isAdmin: !person.isAdmin }))"
              >
                {{ person.isAdmin ? 'Remove admin rights' : 'Make admin' }}
              </button>
              <button v-if="mode === 'local'" @click="reset(person)">{{ person.hasPassword ? 'Password reset link' : 'New invite link' }}</button>
              <button @click="run(() => api.admin.logoutPerson(person.id))">Sign out everywhere</button>
              <button v-if="person.activeTokens" @click="run(() => api.admin.revokeTokens(person.id))">Revoke all API tokens</button>
              <hr />
              <button
                :disabled="person.id === currentUser?.id"
                @click="run(() => api.admin.updatePerson(person.id, { status: person.status === 'active' ? 'disabled' : 'active' }))"
              >
                {{ person.status === 'active' ? 'Disable account' : 'Enable account' }}
              </button>
            </MenuButton>
          </td>
        </tr>
      </tbody>
    </table>
  </section>

  <section v-if="invites.length">
    <h2>Open links</h2>
    <table>
      <thead>
        <tr><th>Email</th><th>Kind</th><th>Valid until</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="item in invites" :key="item.id">
          <td>{{ item.email }}<span v-if="item.grantAdmin" class="badge">admin</span></td>
          <td>{{ item.purpose === 'invite' ? 'Invitation' : 'Password reset' }}</td>
          <td class="muted nowrap">{{ shortDate.format(new Date(item.expiresAt)) }}</td>
          <td class="actions"><button @click="run(() => api.admin.revokeInvite(item.id))">Revoke</button></td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
section + section { border-top: 1px solid var(--border); margin-top: 1rem; padding-top: 0.5rem; }
h2 { font-size: 1.05rem; margin: 0.6rem 0 0.3rem; }
p { margin: 0 0 0.6rem; }
.invite { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.8rem; }
.invite input[type='email'] { flex: 0 1 20rem; min-width: 0; }
.check { display: flex; gap: 0.35rem; align-items: center; font-size: 13px; color: var(--ink-muted); }
.link { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 0.75rem; margin-bottom: 0.8rem; background: var(--surface-100); }
.secret { display: flex; gap: 0.5rem; align-items: center; background: var(--code-bg); color: var(--code-ink); border-radius: var(--radius-sm); padding: 0.4rem 0.4rem 0.4rem 0.7rem; }
.secret code { flex: 1; word-break: break-all; font-size: 12.5px; }
.secret button { color: var(--code-muted); }
.secret button:hover { color: var(--code-ink) !important; background: rgba(255, 255, 255, 0.08) !important; }
.dismiss { margin-top: 0.4rem; }
.filter { margin: 0.4rem 0; width: min(18rem, 100%); }
.error { color: var(--danger); }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font: 500 12px/1.3 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); background: var(--surface-2); }
th, td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
.email { font-size: 12.5px; }
.badge { margin-left: 0.4rem; }
.nowrap { white-space: nowrap; }
.actions { width: 1%; text-align: right; }
.actions :deep(.menu-button) { display: inline-flex; }
tr.disabled td { color: var(--ink-subtle); }
.status::before { content: ''; display: inline-block; width: 0.45rem; height: 0.45rem; border-radius: 50%; margin-right: 0.4rem; vertical-align: 0.05em; background: currentColor; }
.status.on { color: var(--success); }
.status.off { color: var(--danger); }
.status.pending { color: var(--ink-muted); }
</style>
