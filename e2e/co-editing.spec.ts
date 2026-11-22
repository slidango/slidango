import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Browser, type Page, expect, test } from '@playwright/test'
import { dumpFrames, recordConsole } from './debug'
import { baseURL, dataDir } from '../playwright.config'

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

// Line text without the remote-cursor widgets y-codemirror renders inline.
const editorText = (page: Page) =>
  page.locator('.cm-content').evaluate((el) =>
    [...el.querySelectorAll('.cm-line')]
      .map((line) => {
        const copy = line.cloneNode(true) as HTMLElement
        copy.querySelectorAll('.cm-ySelectionCaret, .cm-widgetBuffer').forEach((n) => n.remove())
        return copy.textContent
      })
      .join('\n'),
  )

test('two users type concurrently and converge in both browsers and on disk', async ({ browser }) => {
  const alice = await userPage(browser, 'alice@example.com', 'Alice')
  const bob = await userPage(browser, 'bob@example.com', 'Bob')

  await alice.goto('/')
  await alice.getByRole('button', { name: 'New deck' }).click()
  await alice.getByPlaceholder('Title').fill('E2E Deck')
  await alice.getByRole('button', { name: 'Create' }).click()
  await expect(alice.getByRole('heading', { name: 'E2E Deck' })).toBeVisible()
  const deckId = alice.url().split('/decks/')[1]!

  await bob.goto(`/decks/${deckId}`)
  for (const page of [alice, bob]) {
    await expect(page.getByTestId('status')).toHaveText('Connected')
    await expect(page.getByTestId('peers').locator('li')).toHaveCount(2)
  }

  // Both start typing at the same moment at opposite ends of the document.
  await alice.locator('.cm-content').click()
  await alice.keyboard.press('ControlOrMeta+End')
  await bob.locator('.cm-content').click()
  await bob.keyboard.press('ControlOrMeta+Home')
  await Promise.all([
    alice.keyboard.type('\n---\n\n# Von Alice\n', { delay: 15 }),
    bob.keyboard.type('<!-- Bob war hier -->\n', { delay: 15 }),
  ])

  await expect.poll(() => editorText(alice)).toContain('# Von Alice')
  await expect.poll(() => editorText(alice)).toContain('<!-- Bob war hier -->')
  await expect.poll(async () => (await editorText(alice)) === (await editorText(bob))).toBe(true)

  const final = await editorText(alice)
  const slidesPath = join(dataDir, 'decks', deckId, 'slides.md')
  await expect.poll(() => readFile(slidesPath, 'utf8'), { timeout: 2000 }).toBe(final)
})

test('preview follows the cursor without reloading and drives the editor back', async ({ browser }) => {
  const page = await userPage(browser, 'carol@example.com', 'Carol')
  await page.goto('/')
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByPlaceholder('Title').fill('Preview Deck')
  await page.getByLabel('Start with').selectOption('empty')
  await page.getByRole('button', { name: 'Create' }).click()

  const frame = page.locator('[data-testid=preview] iframe')
  const preview = page.frameLocator('[data-testid=preview] iframe')
  await expect(preview.getByRole('heading', { name: 'Preview Deck' })).toBeVisible({ timeout: 60_000 })
  const src = await frame.getAttribute('src')
  expect(src).toMatch(/\/1\?embedded=true$/)

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\n---\n\n# Live getippt\n\n---\n\n# Dritte\n')
  // The preview jumps via postMessage: same document, no reload.
  await expect(page.getByTestId('preview-position')).toHaveText('3 / 3')
  await expect(preview.getByRole('heading', { name: 'Dritte' })).toBeVisible({ timeout: 10_000 })
  expect(await frame.getAttribute('src')).toBe(src)

  // Navigating in the preview moves the editor.
  await page.getByRole('button', { name: 'Previous slide' }).click()
  await expect(page.getByTestId('preview-position')).toHaveText('2 / 3')
  await expect(page.locator('.statusbar')).toContainText('Slide 2 of 3')

  // Reorder in the slide list; Ctrl+Z undoes it like typing.
  const list = page.getByTestId('slide-list')
  await list.getByRole('button', { name: /Dritte/ }).dragTo(list.getByRole('button', { name: /Live getippt/ }))
  await expect(list.locator('.slide .title')).toHaveText(['Preview Deck', 'Dritte', 'Live getippt'])
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(list.locator('.slide .title')).toHaveText(['Preview Deck', 'Live getippt', 'Dritte'])

  // A pasted screenshot is uploaded and shows up in the preview.
  await page.keyboard.press('ControlOrMeta+End')
  await page.locator('.cm-content').evaluate((el) => {
    // 1×1 PNG
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([png], 'image.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect.poll(() => editorText(page)).toMatch(/!\[Image\]\(\/image-[a-z0-9]+\.png\)$/)
  const image = preview.locator('img[alt="Image"]')
  await expect(image).toBeVisible({ timeout: 10_000 })
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)

  await page.getByRole('button', { name: 'Save version' }).click()
  await page.getByPlaceholder('Description (optional)').fill('Drei Folien')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Version saved.')
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menu').getByRole('button', { name: 'Versions' }).click()
  await expect(page.getByTestId('versions')).toContainText('Drei Folien')

  // The overview shows slide 1, rendered after the saved version, and links straight to the presentation.
  await page.goto('/')
  const card = page.getByTestId('deck-item').filter({ hasText: 'Preview Deck' })
  await expect(async () => {
    await page.reload()
    await expect(card.locator('img')).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 60_000 })
  await expect.poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(960)
  const present = card.getByRole('link', { name: 'Present' })
  await expect(present).toHaveAttribute('href', `${baseURL.replace('//slides.', '//preview-deck.slides.')}`)
  await expect(present).toHaveAttribute('target', '_blank')
})
