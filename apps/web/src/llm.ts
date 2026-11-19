import type { LlmEvent } from '@slidango/shared'

/** POSTs to an LLM endpoint and calls `onEvent` for each Server-Sent Event. */
export async function streamLlm(path: string, body: unknown, onEvent: (event: LlmEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? res.statusText)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let end: number
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (chunk.startsWith('data: ')) onEvent(JSON.parse(chunk.slice(6)) as LlmEvent)
    }
  }
}

export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

/** Line diff (LCS); slides are short, so the quadratic table is fine. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ kind: 'del', text: a[i++]! })
    else out.push({ kind: 'add', text: b[j++]! })
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! })
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! })
  return out
}
