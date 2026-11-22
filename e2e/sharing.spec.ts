import { type Browser, type Page, expect, test } from '@playwright/test'
import { dumpFrames, recordConsole } from './debug'
import { baseURL } from '../playwright.config'

/** Signs in like oauth2-proxy: one session cookie for the app domain and all preview subdomains. */
async function userPage(browser: Browser, email: string, name: string): Promise<Page> {
  const context = await browser.newContext()
  const value = encodeURIComponent(`${email}|${name}`)
  await context.addCookies([{ name: 'e2e-user', value, domain: `.${new URL(baseURL).hostname}`, path: '/', sameSite: 'Lax' }])
  const page = await context.newPage()
  recordConsole(page)
  pages.push(page)
  return page
}

const pages: Page[] = []
test.afterEach(async ({}, testInfo) => {
  for (const page of pages.splice(0)) await dumpFrames(page, testInfo)
})

async function createDeck(page: Page, title: string): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByPlaceholder('Title').fill(title)
  await page.getByLabel('Start with').selectOption('empty')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await expect(page.getByTestId('status')).toHaveText('Connected')
  return page.url().split('/decks/')[1]!
}

test('members-only decks are invisible to others until shared, viewers cannot edit', async ({ browser }) => {
  const olivia = await userPage(browser, 'olivia@example.com', 'Olivia')
  const oscar = await userPage(browser, 'oscar@example.com', 'Oscar')
  // Oscar must have signed in once to be offered in the share dialog.
  await oscar.goto('/')

  const deckId = await createDeck(olivia, 'Board Deck')
  await olivia.getByRole('button', { name: 'More actions' }).click()
  await olivia.getByRole('menu').getByRole('button', { name: 'Share' }).click()
  const share = olivia.getByRole('dialog', { name: /Share/ })
  await share.getByText('Members only').click()
  await expect(share.locator('.option.active')).toContainText('Members only')

  await oscar.goto('/')
  await expect(oscar.getByTestId('decks')).not.toContainText('Board Deck')
  await oscar.goto(`/decks/${deckId}`)
  await expect(oscar.locator('.fatal')).toBeVisible()

  await share.getByLabel('Add a person').fill('oscar')
  await share.getByLabel('Role for the new member').selectOption('viewer')
  await share.getByRole('button', { name: /Oscar/ }).click()
  await expect(share.locator('.members')).toContainText('Oscar')

  await oscar.goto(`/decks/${deckId}`)
  await expect(oscar.getByText('View only')).toBeVisible()
  await expect(oscar.getByRole('button', { name: 'Save version' })).toHaveCount(0)
  // The editor is read-only: typing changes nothing (the cursor still drives the preview).
  const before = await oscar.locator('.cm-content').textContent()
  await oscar.locator('.cm-content').click()
  await oscar.keyboard.type('should not appear')
  await expect(oscar.locator('.cm-content')).toHaveText(before!)
})

test('an API token lets an MCP client suggest changes that the owner applies', async ({ browser, request }) => {
  const olivia = await userPage(browser, 'olivia@example.com', 'Olivia')
  const deckId = await createDeck(olivia, 'MCP Deck')

  // Create a token in the account dialog; it is shown once.
  await olivia.goto('/')
  await olivia.getByRole('button', { name: 'Account' }).click()
  await olivia.getByRole('menu').getByRole('button', { name: /API tokens/ }).click()
  await olivia.getByLabel('Name').fill('Claude Code')
  await olivia.getByRole('button', { name: 'Create', exact: true }).click()
  const token = (await olivia.locator('.secret code').textContent())!.trim()
  expect(token).toMatch(/^sld_/)
  await expect(olivia.locator('.snippet').first()).toContainText('claude mcp add --transport http slidango')

  // An MCP client (here: plain JSON-RPC over HTTP) proposes a new slide.
  const call = await request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'propose_changes',
        arguments: {
          deck_id: deckId,
          summary: 'Add an agenda slide',
          operations: [{ type: 'insert', after: 1, contents: ['# Agenda\n\n- Numbers\n- Plans'] }],
        },
      },
    },
  })
  expect(call.ok()).toBe(true)
  expect(JSON.stringify(await call.json())).toContain('open')

  // The suggestion appears in the editor, marked with the client's name, and can be applied.
  await olivia.goto(`/decks/${deckId}`)
  const card = olivia.getByTestId('proposal').filter({ hasText: 'Claude Code' })
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(card).toContainText('Applied')
  await expect(olivia.locator('.cm-content')).toContainText('# Agenda')
})

test('a public deck is listed on the signed-out start page and plays without signing in', async ({ browser }) => {
  test.setTimeout(240_000)
  const olivia = await userPage(browser, 'olivia@example.com', 'Olivia')
  const deckId = await createDeck(olivia, 'Open Keynote')
  await olivia.locator('.cm-content').click()
  await olivia.keyboard.press('ControlOrMeta+End')
  await olivia.keyboard.type('\n\nSaved for the public\n')
  await olivia.getByRole('button', { name: 'Save version' }).click()
  await olivia.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(olivia.getByRole('status')).toHaveText('Version saved.')

  await olivia.getByRole('button', { name: 'More actions' }).click()
  await olivia.getByRole('menu').getByRole('button', { name: 'Share' }).click()
  olivia.once('dialog', (dialog) => void dialog.accept())
  await olivia.getByLabel('Public link').check()
  const link = olivia.getByTestId('public-link').locator('.link a')
  await expect(link).toBeVisible({ timeout: 180_000 })
  expect(await link.getAttribute('href')).toBe('/p/open-keynote/')
  await expect(link).toHaveText(`${new URL(baseURL).origin}/p/open-keynote/`)

  // A visitor without any session: the start page lists the deck, the link plays it.
  const visitor = await (await browser.newContext()).newPage()
  pages.push(visitor)
  await visitor.goto('/')
  const card = visitor.getByTestId('public-decks').locator('li').filter({ hasText: 'Open Keynote' })
  await expect(card).toContainText('Olivia')
  await card.getByRole('link', { name: 'Open Keynote' }).click()
  await expect(visitor).toHaveURL(/\/p\/open-keynote\//)
  await expect(visitor.locator('.slidev-layout').first()).toContainText('Saved for the public', { timeout: 30_000 })

  // Everything else still needs a login (SSO here: off to oauth2-proxy).
  await visitor.goto(`/decks/${deckId}`)
  await expect(visitor).toHaveURL(/\/oauth2\/sign_in\?rd=/)
})
