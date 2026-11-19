import { type Browser, type Page, expect, test } from '@playwright/test'
import { dumpFrames, recordConsole } from './debug'
import { baseURL } from '../playwright.config'

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

test('briefing → outline → first draft → chat proposal → apply → undo', async ({ browser }) => {
  const page = await userPage(browser, 'dana@example.com', 'Dana')
  await page.goto('/')
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByPlaceholder('Title').fill('Kaffee Deck')
  await expect(page.getByLabel('Start with')).toHaveValue('assistant')
  await page.getByRole('button', { name: 'Create' }).click()

  // An empty deck shows the briefing instead of the preview.
  const briefing = page.getByTestId('briefing')
  await briefing.getByLabel('Topic *').fill('Kaffee')
  await briefing.getByLabel('Goal *').fill('Mehr Kaffeepausen')
  await briefing.getByRole('button', { name: 'Create outline' }).click()
  const outline = page.getByTestId('outline')
  await expect(outline.getByLabel('Title')).toHaveCount(2)
  await expect(outline.getByLabel('Title').first()).toHaveValue('Kaffee im Team')

  await briefing.getByRole('button', { name: 'Write first draft' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'First draft done (2 slides)' })).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('# Drei Gründe')
  await expect(page.getByTestId('slide-list').locator('.slide')).toHaveCount(2)
  const preview = page.frameLocator('[data-testid=preview] iframe')
  await expect(preview.getByRole('heading', { name: 'Kaffee im Team' })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Keep' }).click()

  // Chat: the proposal shows as a card and as highlighted lines in the editor.
  const assistant = page.getByTestId('assistant')
  await assistant.getByPlaceholder(/Message/).fill('Kürze Folie 2')
  await assistant.getByRole('button', { name: 'Send' }).click()
  const card = assistant.getByTestId('proposal')
  await expect(card).toContainText('Replace slide 2')
  await expect(card).toContainText('+ # Ein Grund: Kaffee macht wach')
  await expect(page.locator('.cm-proposal-replace').first()).toBeVisible()

  await card.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(card).toContainText('Applied')
  await expect(page.locator('.cm-content')).toContainText('# Ein Grund: Kaffee macht wach')
  await expect(page.locator('.cm-proposal-replace')).toHaveCount(0)

  await card.getByRole('button', { name: 'Undo' }).click()
  await expect(card).toContainText('Undone')
  await expect(page.locator('.cm-content')).toContainText('# Drei Gründe')
  // A reload keeps the conversation; a new one starts empty, the old one stays reachable.
  await page.reload()
  await expect(assistant.getByText('Kürze Folie 2')).toBeVisible()
  await assistant.getByRole('button', { name: 'New conversation' }).click()
  await expect(assistant.getByText('Kürze Folie 2')).toHaveCount(0)
  await assistant.getByRole('button', { name: 'Earlier conversations' }).click()
  await assistant.getByRole('button', { name: /Kürze Folie 2/ }).click()
  await expect(assistant.getByTestId('proposal')).toContainText('Undone')

  // Another tab is another session and starts with an empty chat.
  const other = await page.context().newPage()
  await other.goto(page.url())
  await expect(other.getByTestId('assistant').getByPlaceholder(/Message/)).toBeVisible()
  await expect(other.getByTestId('assistant').getByText('Kürze Folie 2')).toHaveCount(0)
  await other.close()
})
