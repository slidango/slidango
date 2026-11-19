import { ref } from 'vue'

export interface AppError {
  id: number
  message: string
}

/** Errors no component handled itself; App.vue shows them as dismissible notices. */
export const appErrors = ref<AppError[]>([])
let nextId = 1

export function reportError(error: unknown) {
  if ((error as Error)?.name === 'AbortError') return
  const message = error instanceof Error ? error.message : String(error)
  if (appErrors.value.some((e) => e.message === message)) return
  appErrors.value.push({ id: nextId++, message })
  if (appErrors.value.length > 3) appErrors.value.shift()
}

export function dismissError(id: number) {
  appErrors.value = appErrors.value.filter((e) => e.id !== id)
}
