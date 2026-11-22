<script setup lang="ts">
/** The own account: name, password, signing out everywhere and API tokens for MCP clients. */
import { computed, onMounted, ref } from 'vue'
import type { ApiToken, CreatedToken, TokenScope } from '@slidango/shared'
import { api } from '../api'
import { authMode, currentUser } from '../user'

const props = defineProps<{ initialTab?: 'profile' | 'tokens' }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const tab = ref<'profile' | 'tokens'>(props.initialTab ?? 'profile')

// --- Profile ---
const name = ref(currentUser.value?.name ?? '')
const nameSaved = ref<string | null>(null)
async function saveName() {
  nameSaved.value = null
  try {
    currentUser.value = await api.updateMe({ name: name.value })
    nameSaved.value = 'Saved.'
  } catch (e) {
    nameSaved.value = (e as Error).message
  }
}

const current = ref('')
const next = ref('')
const repeat = ref('')
const passwordMessage = ref<{ ok: boolean; text: string } | null>(null)
async function changePassword() {
  passwordMessage.value = null
  if (next.value !== repeat.value) {
    passwordMessage.value = { ok: false, text: 'The new passwords don’t match.' }
    return
  }
  try {
    await api.changePassword({ current: current.value, password: next.value })
    current.value = next.value = repeat.value = ''
    passwordMessage.value = { ok: true, text: 'Password changed. Other sessions were signed out.' }
  } catch (e) {
    passwordMessage.value = { ok: false, text: (e as Error).message }
  }
}

async function logoutEverywhere() {
  await api.logoutEverywhere()
  window.location.href = authMode.value === 'local' ? '/' : '/oauth2/sign_out'
}

// --- Tokens ---
const tokens = ref<ApiToken[]>([])
const tokenName = ref('')
const tokenScope = ref<TokenScope>('write')
const tokenExpiry = ref<'30' | '90' | '365' | 'never'>('90')
const created = ref<CreatedToken | null>(null)
const tokenError = ref<string | null>(null)
const copied = ref<string | null>(null)

const mcpUrl = `${window.location.origin}/mcp`
const claudeCode = computed(
  () => `claude mcp add --transport http slidango ${mcpUrl} \\\n  --header "Authorization: Bearer ${created.value?.token ?? 'sld_…'}"`,
)
const jsonConfig = computed(() =>
  JSON.stringify(
    { mcpServers: { slidango: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${created.value?.token ?? 'sld_…'}` } } } },
    null,
    2,
  ),
)

async function loadTokens() {
  tokens.value = await api.tokens()
}
async function createToken() {
  tokenError.value = null
  try {
    created.value = await api.createToken({
      name: tokenName.value,
      scope: tokenScope.value,
      expiresInDays: tokenExpiry.value === 'never' ? null : (Number(tokenExpiry.value) as 30 | 90 | 365),
    })
    await loadTokens()
  } catch (e) {
    tokenError.value = (e as Error).message
  }
}
async function revoke(token: ApiToken) {
  await api.revokeToken(token.id)
  if (created.value?.id === token.id) created.value = null
  await loadTokens()
}
async function copy(text: string, what: string) {
  await navigator.clipboard?.writeText(text)
  copied.value = what
  setTimeout(() => (copied.value = null), 1400)
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })
const date = (value: string | null) => (value ? dateFormat.format(new Date(value)) : '–')

onMounted(() => {
  dialog.value?.showModal()
  void loadTokens()
})
</script>

<template>
  <dialog ref="dialog" class="account" aria-labelledby="account-title" @close="emit('close')" @click.self="dialog?.close()">
    <div class="frame">
      <header>
        <h1 id="account-title">Account</h1>
        <nav class="tabs" role="tablist">
          <button role="tab" :aria-selected="tab === 'profile'" :class="{ active: tab === 'profile' }" @click="tab = 'profile'">Profile</button>
          <button role="tab" :aria-selected="tab === 'tokens'" :class="{ active: tab === 'tokens' }" @click="tab = 'tokens'">API tokens</button>
        </nav>
        <button class="ghost icon close" aria-label="Close" title="Close (Esc)" @click="dialog?.close()">✕</button>
      </header>

      <div class="body">
        <template v-if="tab === 'profile'">
          <section>
            <h2>Name</h2>
            <form v-if="authMode === 'local'" class="row" @submit.prevent="saveName">
              <input v-model="name" required maxlength="100" aria-label="Name" />
              <button type="submit">Save</button>
              <span v-if="nameSaved" class="muted">{{ nameSaved }}</span>
            </form>
            <p v-else class="muted">{{ currentUser?.name }} · comes from your single sign-on account.</p>
            <p class="muted small">{{ currentUser?.email }}</p>
          </section>

          <section v-if="authMode === 'local'">
            <h2>Password</h2>
            <form class="stack" @submit.prevent="changePassword">
              <input type="email" :value="currentUser?.email" autocomplete="username" hidden readonly />
              <label>Current password<input v-model="current" type="password" autocomplete="current-password" required /></label>
              <label>New password<input v-model="next" type="password" autocomplete="new-password" required minlength="10" /></label>
              <label>Repeat new password<input v-model="repeat" type="password" autocomplete="new-password" required minlength="10" /></label>
              <div class="row">
                <button type="submit">Change password</button>
                <span v-if="passwordMessage" :class="passwordMessage.ok ? 'ok' : 'error'">{{ passwordMessage.text }}</span>
              </div>
            </form>
          </section>

          <section>
            <h2>Sessions</h2>
            <p class="muted">Signs you out on every device, including this one.</p>
            <button @click="logoutEverywhere">Sign out everywhere</button>
          </section>
        </template>

        <template v-else>
          <section>
            <p class="muted">
              Tokens let tools like Claude Code, Claude Desktop or your own scripts work in Slidango on your behalf: over
              <code>{{ mcpUrl }}</code> (MCP) or the API. A token can do what you can do, never more, and never admin tasks.
            </p>
          </section>

          <section v-if="created" class="created">
            <h2>Copy your token now</h2>
            <p class="muted">It is shown only once. Treat it like a password.</p>
            <div class="secret">
              <code>{{ created.token }}</code>
              <button class="ghost" @click="copy(created.token, 'token')">{{ copied === 'token' ? 'Copied' : 'Copy' }}</button>
            </div>
            <h3>Claude Code</h3>
            <div class="snippet">
              <pre>{{ claudeCode }}</pre>
              <button class="ghost" @click="copy(claudeCode.replace('\\\n  ', ''), 'cc')">{{ copied === 'cc' ? 'Copied' : 'Copy' }}</button>
            </div>
            <h3>Other MCP clients</h3>
            <div class="snippet">
              <pre>{{ jsonConfig }}</pre>
              <button class="ghost" @click="copy(jsonConfig, 'json')">{{ copied === 'json' ? 'Copied' : 'Copy' }}</button>
            </div>
            <button class="done" @click="created = null">Done</button>
          </section>

          <section v-else>
            <h2>New token</h2>
            <form class="new" @submit.prevent="createToken">
              <label>Name<input v-model="tokenName" required maxlength="60" placeholder="e.g. Claude Code" /></label>
              <label>
                Access
                <select v-model="tokenScope">
                  <option value="write">Read and suggest changes</option>
                  <option value="read">Read only</option>
                </select>
              </label>
              <label>
                Expires
                <select v-model="tokenExpiry">
                  <option value="30">in 30 days</option>
                  <option value="90">in 90 days</option>
                  <option value="365">in a year</option>
                  <option value="never">never</option>
                </select>
              </label>
              <button class="primary" type="submit">Create</button>
            </form>
            <p v-if="tokenError" class="error">{{ tokenError }}</p>
          </section>

          <section>
            <h2>Your tokens</h2>
            <table v-if="tokens.length">
              <thead>
                <tr><th>Name</th><th>Token</th><th>Access</th><th>Last used</th><th>Expires</th><th /></tr>
              </thead>
              <tbody>
                <tr v-for="token in tokens" :key="token.id">
                  <td>{{ token.name }}</td>
                  <td><code>{{ token.prefix }}…</code></td>
                  <td>{{ token.scope === 'write' ? 'Read + suggest' : 'Read only' }}</td>
                  <td class="muted">{{ date(token.lastUsedAt) }}</td>
                  <td class="muted">{{ token.expiresAt ? date(token.expiresAt) : 'Never' }}</td>
                  <td class="actions"><button @click="revoke(token)">Revoke</button></td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">No tokens yet.</p>
          </section>
        </template>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.account { border: 1px solid var(--line); padding: 0; border-radius: var(--radius-lg); width: min(46rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); box-shadow: var(--shadow); background: var(--surface); color: var(--text); }
.frame { display: flex; flex-direction: column; max-height: calc(100dvh - 2rem); }
header { display: flex; align-items: center; gap: 1rem; padding: 0.8rem 0.8rem 0 1.25rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
h1 { font-size: 20px; margin: 0 0 0.6rem; }
.tabs { display: flex; gap: 0.2rem; flex: 1; align-self: flex-end; }
.tabs button { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none !important; padding: 0.45rem 0.7rem; color: var(--muted); font-weight: 500; }
.tabs button:hover { color: var(--text); }
.tabs button.active { color: var(--ink); border-bottom-color: var(--tango); }
.close { margin-bottom: 0.6rem; }
.body { overflow: auto; padding: 0.5rem 1.25rem 1.25rem; }
section + section { border-top: 1px solid var(--border); margin-top: 1rem; padding-top: 0.5rem; }
h2 { font-size: 15px; margin: 0.6rem 0 0.5rem; }
h3 { font: 500 12px/1.3 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-muted); margin: 1rem 0 0.4rem; }
p { margin: 0 0 0.5rem; }
.small { font-size: 13px; }
.row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.row input { flex: 0 1 18rem; }
.stack { display: grid; gap: 0.5rem; max-width: 22rem; }
label { display: grid; gap: 0.2rem; font-size: 13px; color: var(--ink-muted); }
.new { display: grid; grid-template-columns: 1.4fr 1.2fr 1fr auto; gap: 0.6rem; align-items: end; }
.ok { color: var(--success); }
.error { color: var(--danger); }
.secret, .snippet { display: flex; gap: 0.5rem; align-items: flex-start; background: var(--code-bg); color: var(--code-ink); border-radius: var(--radius-md); padding: 0.6rem 0.6rem 0.6rem 0.8rem; }
.secret code { flex: 1; word-break: break-all; font-size: 13px; }
.snippet pre { flex: 1; margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.secret button, .snippet button { color: var(--code-muted); }
.secret button:hover, .snippet button:hover { color: var(--code-ink) !important; background: rgba(255, 255, 255, 0.08) !important; }
.done { margin-top: 1rem; }
table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
th { font: 500 12px/1.3 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); background: var(--surface-2); }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
td.actions { text-align: right; width: 1%; }
@media (max-width: 640px) { .new { grid-template-columns: 1fr; } }
</style>
