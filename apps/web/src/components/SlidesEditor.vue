<script setup lang="ts">
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint'
import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet } from '@codemirror/view'
import { EditorView, basicSetup } from 'codemirror'
import { yCollab } from 'y-codemirror.next'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'

export interface Highlight {
  /** 0-based, inclusive line range. */
  from: number
  to: number
  kind: 'replace' | 'delete' | 'insert' | 'move'
}

export interface Problem {
  /** 0-based line */
  line: number
  message: string
}

const props = defineProps<{ text: Y.Text; awareness: Awareness; readOnly: boolean; highlights: Highlight[]; problems: Problem[] }>()
const emit = defineEmits<{ cursorLine: [line: number]; images: [files: File[]] }>()
const host = ref<HTMLElement>()
let view: EditorView | undefined

const slidesHighlight = HighlightStyle.define([
  // Design system: ink for structure, tango only for links, frontmatter and --- in ink-subtle.
  { tag: tags.heading, color: 'var(--ink)', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--tango)' },
  { tag: tags.url, color: 'var(--ink-muted)' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.meta], color: 'var(--ink-subtle)' },
  { tag: tags.monospace, color: 'var(--ink-muted)' },
  { tag: tags.comment, color: 'var(--ink-subtle)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--ink-muted)' },
  { tag: tags.quote, color: 'var(--ink-muted)' },
])

// Slides touched by open proposals get a tinted background.
const setHighlights = StateEffect.define<Highlight[]>()
const highlightField = StateField.define<{ ranges: Highlight[]; decorations: DecorationSet }>({
  create: () => ({ ranges: [], decorations: Decoration.none }),
  update(value, tr) {
    let ranges = value.ranges
    for (const effect of tr.effects) if (effect.is(setHighlights)) ranges = effect.value
    if (ranges === value.ranges && !tr.docChanged) return value
    const builder = new RangeSetBuilder<Decoration>()
    const doc = tr.state.doc
    const lines = new Map<number, Highlight['kind']>()
    for (const range of ranges) for (let l = range.from; l <= range.to; l++) lines.set(l, range.kind)
    for (const [line, kind] of [...lines].sort((a, b) => a[0] - b[0])) {
      if (line >= doc.lines) continue
      builder.add(doc.line(line + 1).from, doc.line(line + 1).from, Decoration.line({ class: `cm-proposal-${kind}` }))
    }
    return { ranges, decorations: builder.finish() }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

const imagesOf = (data: DataTransfer | null) => [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/'))

// Dropped or pasted images are uploaded by the page and inserted at the cursor.
const imageHandlers = EditorView.domEventHandlers({
  paste(event) {
    const files = imagesOf(event.clipboardData)
    if (!files.length || props.readOnly) return false
    event.preventDefault()
    emit('images', files)
    return true
  },
  drop(event, editor) {
    const files = imagesOf(event.dataTransfer)
    if (!files.length || props.readOnly) return false
    event.preventDefault()
    const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos !== null) editor.dispatch({ selection: { anchor: pos } })
    emit('images', files)
    return true
  },
})

onMounted(() => {
  const undoManager = new Y.UndoManager(props.text)
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.text.toString(),
      extensions: [
        basicSetup,
        // Slidev uses `---` as slide separator, so lines above it are not setext headings.
        markdown({ extensions: [{ remove: ['SetextHeading'] }] }),
        syntaxHighlighting(slidesHighlight),
        EditorView.lineWrapping,
        EditorState.readOnly.of(props.readOnly),
        yCollab(props.text, props.awareness, { undoManager }),
        highlightField,
        imageHandlers,
        lintGutter(),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            const state = update.state
            emit('cursorLine', state.doc.lineAt(state.selection.main.head).number - 1)
          }
        }),
      ],
    }),
  })
})

watch(
  () => props.highlights,
  (highlights) => view?.dispatch({ effects: setHighlights.of(highlights) }),
  { deep: true },
)

watch(
  () => props.problems,
  (problems) => {
    if (!view) return
    const doc = view.state.doc
    const diagnostics: Diagnostic[] = problems
      .filter((p) => p.line < doc.lines)
      .map((p) => {
        const line = doc.line(p.line + 1)
        return { from: line.from, to: Math.max(line.from, line.to), severity: 'warning', message: p.message }
      })
    view.dispatch(setDiagnostics(view.state, diagnostics))
  },
  { deep: true },
)

onBeforeUnmount(() => view?.destroy())

defineExpose({
  /** Inserts text at the cursor (replacing a selection) and focuses the editor. */
  insert(text: string) {
    if (!view) return
    view.dispatch(view.state.replaceSelection(text))
    view.focus()
  },
  /** Moves the cursor to a 0-based line and scrolls it to the top. */
  goToLine(line: number, focus = true) {
    if (!view) return
    const pos = view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) })
    if (focus) view.focus()
  },
  /**
   * Replaces the whole text as one editor change (only the differing middle),
   * so it syncs like typing and Ctrl+Z undoes it.
   */
  replaceAll(next: string) {
    if (!view) return
    const current = view.state.doc.toString()
    let start = 0
    while (start < current.length && start < next.length && current[start] === next[start]) start++
    let end = 0
    while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end++
    view.dispatch({ changes: { from: start, to: current.length - end, insert: next.slice(start, next.length - end) } })
  },
  focus() {
    view?.focus()
  },
})
</script>

<template>
  <div ref="host" class="slides-editor" data-testid="editor" />
</template>

<style scoped>
.slides-editor { height: 100%; overflow: hidden; }
.slides-editor :deep(.cm-editor) { height: 100%; }
/* Open AI proposals are tinted teal: teal always means "the AI wrote this". */
.slides-editor :deep(.cm-proposal-replace) { background: var(--ai-soft); }
.slides-editor :deep(.cm-proposal-delete) { background: var(--danger-soft); text-decoration: line-through; }
.slides-editor :deep(.cm-proposal-insert) { box-shadow: inset 2px 0 0 var(--ai); background: var(--ai-soft); }
.slides-editor :deep(.cm-proposal-move) { background: var(--ai-soft); }
.slides-editor :deep(.cm-diagnostic-warning) { border-left-color: var(--warning); }
.slides-editor :deep(.cm-lintRange-warning) { background-image: none; text-decoration: underline wavy var(--danger); text-underline-offset: 3px; }
.slides-editor :deep(.cm-editor) { background: var(--surface-card); color: var(--ink); }
.slides-editor :deep(.cm-gutters) { background: var(--surface-card); border-right: 1px solid var(--border); color: var(--ink-subtle); }
.slides-editor :deep(.cm-activeLineGutter) { background: var(--hover); color: var(--ink); }
.slides-editor :deep(.cm-activeLine) { background: color-mix(in srgb, var(--ink) 3%, transparent); }
.slides-editor :deep(.cm-cursor) { border-left: 2px solid var(--ink); }
.slides-editor :deep(.cm-selectionBackground), .slides-editor :deep(.cm-focused .cm-selectionBackground) { background: color-mix(in srgb, var(--tango) 22%, transparent) !important; }
.slides-editor :deep(.cm-scroller) { font-family: var(--font-mono); font-size: 14px; line-height: 22px; font-variant-ligatures: none; }
/* No ligatures: Markdown like `<!--` or `->` must look exactly as typed. */
/* Remote cursors: 2px caret in the person's colour, pill label with the name in mono 11px. */
.slides-editor :deep(.cm-ySelectionCaret) { border-left-width: 2px; border-right: none; margin-left: -1px; margin-right: -1px; }
.slides-editor :deep(.cm-ySelectionCaretDot) { display: none; }
.slides-editor :deep(.cm-ySelectionInfo) { font: 500 11px/1.2 var(--font-mono); color: var(--on-cursor); padding: 2px 6px; border-radius: var(--radius-pill); top: -1.25em; left: -1px; box-shadow: var(--shadow-pop); opacity: 1; }
.slides-editor :deep(.cm-panels), .slides-editor :deep(.cm-tooltip) { background: var(--surface-card); color: var(--ink); border-color: var(--line); }
</style>
