import type {
  ApiToken,
  AuthMode,
  CreatedToken,
  DeckAccess,
  DeckRole,
  DeckSharing,
  DirectoryUser,
  InviteLink,
  PendingInvite,
  Person,
  TokenScope,
  Briefing,
  BriefingFields,
  BriefingFile,
  ChatMessage,
  ChatSession,
  CreateDeck,
  Deck,
  LlmSettings,
  Preview,
  Proposal,
  Theme,
  UpdateDeck,
  User,
} from '@slidango/shared'

export interface LlmState {
  empty: boolean
  drafting: boolean
  sessions: ChatSession[]
  messages: ChatMessage[]
  proposals: Proposal[]
}

export interface RunningPreview {
  deckId: string
  themeVersion: string | null
  port: number
  status: string
  lastActive: string
}

export interface Version {
  sha: string
  message: string
  author: string
  date: string
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined || isForm ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(res.status, data.error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

export const api = {
  me: () => request<User>('GET', '/me'),
  authConfig: () => request<{ mode: AuthMode }>('GET', '/auth/config'),
  login: (input: { email: string; password: string; next?: string }) =>
    request<{ user: User; next: string | null }>('POST', '/auth/login', input),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  invite: (token: string) => request<{ email: string; purpose: 'invite' | 'reset'; name: string }>('GET', `/auth/invite/${token}`),
  acceptInvite: (token: string, input: { name: string; password: string }) =>
    request<{ user: User }>('POST', `/auth/invite/${token}`, input),
  changePassword: (input: { current: string; password: string }) => request<{ ok: true }>('POST', '/me/password', input),
  logoutEverywhere: () => request<{ ok: true }>('POST', '/me/logout-everywhere'),
  tokens: () => request<ApiToken[]>('GET', '/me/tokens'),
  createToken: (input: { name: string; scope: TokenScope; expiresInDays: 30 | 90 | 365 | null }) =>
    request<CreatedToken>('POST', '/me/tokens', input),
  revokeToken: (id: string) => request<{ ok: true }>('DELETE', `/me/tokens/${id}`),
  users: () => request<DirectoryUser[]>('GET', '/users'),
  sharing: (id: string) => request<DeckSharing>('GET', `/decks/${id}/sharing`),
  setAccess: (id: string, access: DeckAccess) => request<DeckSharing>('PUT', `/decks/${id}/access`, { access }),
  setMember: (id: string, userId: string, role: DeckRole) => request<DeckSharing>('PUT', `/decks/${id}/members/${userId}`, { role }),
  removeMember: (id: string, userId: string) => request<DeckSharing>('DELETE', `/decks/${id}/members/${userId}`),
  decks: (archived = false) => request<Deck[]>('GET', `/decks${archived ? '?archived=true' : ''}`),
  deck: (id: string) => request<Deck>('GET', `/decks/${id}`),
  createDeck: (input: CreateDeck) => request<Deck>('POST', '/decks', input),
  updateDeck: (id: string, input: UpdateDeck) => request<Deck>('PATCH', `/decks/${id}`, input),
  archiveDeck: (id: string) => request<Deck>('DELETE', `/decks/${id}`),
  unarchiveDeck: (id: string) => request<Deck>('POST', `/decks/${id}/unarchive`),
  preview: (id: string) => request<Preview>('POST', `/decks/${id}/preview`),
  versions: (id: string) => request<Version[]>('GET', `/decks/${id}/versions`),
  saveVersion: (id: string, message: string) => request<Version | null>('POST', `/decks/${id}/versions`, { message }),
  restore: (id: string, sha: string) => request<Version | null>('POST', `/decks/${id}/restore`, { sha }),
  themes: () => request<Theme[]>('GET', '/themes'),
  setDeckTheme: (id: string, version: string) => request<Deck>('POST', `/decks/${id}/theme`, { version }),
  updateMe: (patch: { autoApply?: boolean; name?: string }) => request<User>('PATCH', '/me', patch),
  llmStatus: () => request<{ configured: boolean }>('GET', '/llm/status'),
  llmState: (id: string, session: string | null = null) =>
    request<LlmState>('GET', `/decks/${id}/llm/state${session ? `?session=${session}` : ''}`),
  briefing: (id: string) => request<Briefing>('GET', `/decks/${id}/briefing`),
  saveBriefing: (id: string, fields: BriefingFields) => request<Briefing>('PUT', `/decks/${id}/briefing`, fields),
  uploadBriefingFile: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<BriefingFile>('POST', `/decks/${id}/briefing/files`, form)
  },
  deleteBriefingFile: (id: string, fileId: string) => request('DELETE', `/decks/${id}/briefing/files/${encodeURIComponent(fileId)}`),
  layouts: (id: string) => request<string[]>('GET', `/decks/${id}/layouts`),
  discardDraft: (id: string) => request('POST', `/decks/${id}/llm/draft/discard`),
  proposalAction: (id: string, action: 'apply' | 'reject' | 'undo') => request<Proposal>('POST', `/proposals/${id}/${action}`),
  admin: {
    llmSettings: () => request<LlmSettings & { vision: boolean }>('GET', '/admin/settings'),
    saveLlmSettings: (settings: { baseUrl: string; model: string; apiKey?: string; vision: boolean }) =>
      request<LlmSettings & { vision: boolean }>('PUT', '/admin/settings', settings),
    themes: () => request<Theme[]>('GET', '/admin/themes'),
    uploadTheme: (version: string, changelog: string, file: File) => {
      const form = new FormData()
      form.append('version', version)
      form.append('changelog', changelog)
      form.append('file', file)
      return request<Theme>('POST', '/admin/themes', form)
    },
    setDefaultTheme: (version: string) => request<Theme[]>('PUT', `/admin/themes/${encodeURIComponent(version)}/default`),
    previews: () => request<RunningPreview[]>('GET', '/admin/previews'),
    people: () => request<{ mode: AuthMode; people: Person[]; invites: PendingInvite[] }>('GET', '/admin/people'),
    invite: (email: string, grantAdmin: boolean) => request<InviteLink>('POST', '/admin/invites', { email, grantAdmin }),
    revokeInvite: (id: string) => request<{ ok: true }>('DELETE', `/admin/invites/${id}`),
    resetLink: (id: string) => request<InviteLink>('POST', `/admin/people/${id}/reset`),
    updatePerson: (id: string, patch: { status?: 'active' | 'disabled'; isAdmin?: boolean }) =>
      request<Person>('PATCH', `/admin/people/${id}`, patch),
    logoutPerson: (id: string) => request<{ ok: true }>('POST', `/admin/people/${id}/logout`),
    revokeTokens: (id: string) => request<{ revoked: number }>('POST', `/admin/people/${id}/revoke-tokens`),
  },
  uploadAsset: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ path: string }>('POST', `/decks/${id}/assets`, form)
  },
}
