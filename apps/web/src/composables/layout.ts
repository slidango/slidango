import { reactive, watch } from 'vue'

export interface EditorLayout {
  /** Width of the right column (preview + assistant) as a share of editor + right column. */
  rightShare: number
  /** Height of the preview within the right column; null = exactly its 16:9 height. */
  previewHeight: number | null
  slidesOpen: boolean
  assistantOpen: boolean
  slidesWidth: number
}

const DEFAULTS: EditorLayout = { rightShare: 0.42, previewHeight: null, slidesOpen: true, assistantOpen: true, slidesWidth: 180 }

const KEY = 'slidango:layout'
const LEGACY_KEY = 'slidev-collab:layout' // before the rename to Slidango

function load(): EditorLayout {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY) ?? '{}') as Partial<EditorLayout> & { view?: string }
    delete stored.view // left over from the removed view presets
    return { ...DEFAULTS, ...stored }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Pane sizes of the editor page, remembered per browser. */
export function useEditorLayout() {
  const layout = reactive(load())
  watch(layout, (value) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(value))
    } catch {
      // Private mode or blocked storage: the layout just isn't remembered.
    }
  })
  return { layout }
}
