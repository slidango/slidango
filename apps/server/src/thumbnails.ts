import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser } from 'playwright-core'

export type ColorScheme = 'light' | 'dark'
const SCHEMES: ColorScheme[] = ['light', 'dark']

export interface ThumbnailOptions {
  enabled: boolean
  /** Where the images live (one light and one dark JPEG per deck). */
  dir: string
  /** Chromium to use; empty = the one Playwright installed (development). */
  chromiumPath?: string
  /** Waits this long after the last trigger, so a burst of saves renders once. */
  delayMs?: number
  /** Origin of a ready Slidev preview for the deck, starting one if needed; null if it can't run. */
  preview: (deckId: string) => Promise<string | null>
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void }
}

/** Slide 1 of each deck as a small image for the deck overview, light and dark. */
export class Thumbnails {
  private timers = new Map<string, NodeJS.Timeout>()
  private queue: string[] = []
  private running = false
  private browser: Promise<Browser> | null = null
  private closeTimer: NodeJS.Timeout | null = null
  private unavailable = false

  constructor(private opts: ThumbnailOptions) {}

  file(deckId: string, scheme: ColorScheme) {
    return join(this.opts.dir, `${deckId}-${scheme}.jpg`)
  }

  /** Time of the last capture (ms), for cache busting; null when there is none yet. */
  async version(deckId: string): Promise<number | null> {
    try {
      return Math.round((await stat(this.file(deckId, 'light'))).mtimeMs)
    } catch {
      return null
    }
  }

  /** Renders slide 1 soon. Called after a saved version, a template switch, or when the last editor leaves. */
  schedule(deckId: string) {
    if (!this.opts.enabled || this.unavailable) return
    clearTimeout(this.timers.get(deckId))
    const timer = setTimeout(() => {
      this.timers.delete(deckId)
      if (!this.queue.includes(deckId)) this.queue.push(deckId)
      void this.drain()
    }, this.opts.delayMs ?? 1500)
    timer.unref()
    this.timers.set(deckId, timer)
  }

  async close() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.queue = []
    await this.closeBrowser()
  }

  /** One capture at a time: each needs a Slidev preview and a browser page. */
  private async drain() {
    if (this.running) return
    this.running = true
    try {
      for (let deckId = this.queue.shift(); deckId; deckId = this.queue.shift()) {
        await this.capture(deckId).catch((err: Error) =>
          this.opts.log.warn({ deckId, err: err.message }, 'thumbnail failed'),
        )
      }
    } finally {
      this.running = false
      this.scheduleBrowserClose()
    }
  }

  private async capture(deckId: string) {
    const origin = await this.opts.preview(deckId)
    if (!origin) return
    const browser = await this.launch()
    if (!browser) return
    await mkdir(this.opts.dir, { recursive: true })
    const rendered: [tmp: string, target: string][] = []
    for (const colorScheme of SCHEMES) {
      // A fresh context per scheme: Slidev remembers the scheme in localStorage.
      const context = await browser.newContext({ viewport: { width: 960, height: 540 }, colorScheme })
      try {
        const page = await context.newPage()
        await page.goto(`${origin}/1?embedded=true`, { waitUntil: 'load', timeout: 45_000 })
        await page.waitForSelector('.slidev-layout', { timeout: 30_000 })
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        await page.waitForTimeout(600) // slide transition, late images
        const target = this.file(deckId, colorScheme)
        const tmp = `${target}.tmp`
        await page.screenshot({ path: tmp, type: 'jpeg', quality: 82 })
        rendered.push([tmp, target])
      } finally {
        await context.close()
      }
    }
    // version() (and with it the overview's thumbnailAt) keys on the light image, so it goes in
    // last: once a client sees a version, both schemes exist. Otherwise a dark-mode overview can
    // ask for the dark image before it is written, get a 404 and drop the <img>.
    for (const [tmp, target] of rendered.reverse()) await rename(tmp, target)
    this.opts.log.info({ deckId }, 'thumbnail updated')
  }

  private async launch(): Promise<Browser | null> {
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = null
    if (!this.browser) {
      this.browser = import('playwright-core').then(({ chromium }) =>
        chromium.launch({
          executablePath: this.opts.chromiumPath || undefined,
          args: ['--disable-dev-shm-usage', '--disable-gpu'],
        }),
      )
      this.browser.catch(() => {})
    }
    try {
      return await this.browser
    } catch (err) {
      // No Chromium (e.g. a development machine without Playwright browsers): stop trying.
      this.unavailable = true
      this.browser = null
      this.opts.log.warn(
        { err: (err as Error).message.split('\n')[0] },
        'thumbnails disabled: Chromium could not start (set CHROMIUM_PATH or THUMBNAILS=off)',
      )
      return null
    }
  }

  private scheduleBrowserClose() {
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = setTimeout(() => void this.closeBrowser(), 120_000)
    this.closeTimer.unref()
  }

  private async closeBrowser() {
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = null
    const browser = this.browser
    this.browser = null
    if (browser) await (await browser.catch(() => null))?.close().catch(() => {})
  }

  async remove(deckId: string) {
    for (const scheme of SCHEMES) {
      const file = this.file(deckId, scheme)
      if (existsSync(file)) await rm(file, { force: true })
    }
  }
}
