import type { Page, TestInfo } from '@playwright/test'

/** On failure, prints what each frame shows; preview problems are otherwise invisible. */
export async function dumpFrames(page: Page, testInfo: TestInfo) {
  if (testInfo.status === testInfo.expectedStatus) return
  for (const frame of page.frames()) {
    const text = await frame.locator('body').innerText({ timeout: 2000 }).catch((e: Error) => `<${e.message.split('\n')[0]}>`)
    console.log(`[frame] ${frame.url()} -> ${JSON.stringify(text.slice(0, 300))}`)
  }
}

export function recordConsole(page: Page) {
  page.on('console', (m) => m.type() === 'error' && !/fonts\.googleapis|jsdelivr|CERT/.test(m.text()) && console.log(`[console] ${m.text().slice(0, 300)}`))
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`))
  page.on('response', (r) => r.status() >= 400 && console.log(`[http ${r.status()}] ${r.url().slice(0, 150)}`))
}
