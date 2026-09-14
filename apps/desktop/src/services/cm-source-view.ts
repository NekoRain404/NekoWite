// CodeMirror 6 setup for the markdown source view: GFM parsing, a highlight
// style whose classes mirror editor-content.css typography (all colors via
// --app-* tokens, so dark/light follows data-theme), a fenced-code block
// surface, line numbers/ruler, soft wrap, and the zh search panel.
import { defaultKeymap, historyKeymap, indentWithTab, redo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  highlightActiveLine,
  keymap,
  lineNumbers as lineNumbersGutter,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { tags as highlightTags } from '@lezer/highlight'
import { createZhSearchPanel } from './cm-search-panel'

const mdHighlight = HighlightStyle.define([
  { tag: highlightTags.heading1, class: 'cm-md-h1 cm-md-heading' },
  { tag: highlightTags.heading2, class: 'cm-md-h2 cm-md-heading' },
  { tag: highlightTags.heading3, class: 'cm-md-h3 cm-md-heading' },
  { tag: highlightTags.heading4, class: 'cm-md-h4 cm-md-heading' },
  { tag: highlightTags.heading5, class: 'cm-md-h5 cm-md-heading' },
  { tag: highlightTags.heading6, class: 'cm-md-h6 cm-md-heading' },
  { tag: highlightTags.processingInstruction, class: 'cm-md-mark' },
  { tag: highlightTags.atom, class: 'cm-md-task' },
  { tag: highlightTags.emphasis, class: 'cm-md-emphasis' },
  { tag: highlightTags.strong, class: 'cm-md-strong' },
  { tag: highlightTags.strikethrough, class: 'cm-md-strikethrough' },
  { tag: highlightTags.link, class: 'cm-md-link' },
  { tag: highlightTags.url, class: 'cm-md-url' },
  { tag: highlightTags.monospace, class: 'cm-md-code' },
  { tag: highlightTags.quote, class: 'cm-md-quote' },
  { tag: highlightTags.contentSeparator, class: 'cm-md-hr' },
  { tag: highlightTags.comment, class: 'cm-md-comment' },
  { tag: highlightTags.lineComment, class: 'cm-md-comment' },
  { tag: highlightTags.blockComment, class: 'cm-md-comment' },
  { tag: highlightTags.labelName, class: 'cm-md-label' },
  { tag: highlightTags.string, class: 'cm-md-string' },
  { tag: highlightTags.keyword, class: 'cm-code-keyword' },
  { tag: highlightTags.controlKeyword, class: 'cm-code-keyword' },
  { tag: highlightTags.definitionKeyword, class: 'cm-code-keyword' },
  { tag: highlightTags.moduleKeyword, class: 'cm-code-keyword' },
  { tag: highlightTags.bool, class: 'cm-code-number' },
  { tag: highlightTags.number, class: 'cm-code-number' },
  { tag: highlightTags.literal, class: 'cm-code-number' },
  { tag: highlightTags.regexp, class: 'cm-code-string' },
  { tag: highlightTags.typeName, class: 'cm-code-type' },
  { tag: highlightTags.className, class: 'cm-code-type' },
  { tag: highlightTags.function(highlightTags.variableName), class: 'cm-code-fn' },
  { tag: highlightTags.function(highlightTags.propertyName), class: 'cm-code-fn' },
  { tag: highlightTags.definition(highlightTags.variableName), class: 'cm-code-fn' },
  { tag: highlightTags.propertyName, class: 'cm-code-prop' },
  { tag: highlightTags.variableName, class: 'cm-code-name' },
  { tag: highlightTags.operator, class: 'cm-code-operator' },
  { tag: highlightTags.invalid, class: 'cm-code-invalid' },
])

// Every value goes through --app-* tokens: the editor follows data-theme
// (light/dark) with no reconfiguration.
//
// What DOES go through the tokens is the two values that carry the reading
// experience: the base size and the leading, now read by
// `features/editor/styles/sourcePane.css` as `font-size: var(--app-body-size)`
// on `.cm-editor` and `line-height: var(--app-line-height)` on `.cm-scroller`,
// so a theme change needs no reconfiguration. They used to be literals here
// (`fontSize: '13.5px'`, `lineHeight: '1.7'`, against the rendered pane's 15px —
// an 11 % gap the user could see and could not name), which is why this comment
// said one thing and the code beneath it did another.
//
// What still does NOT go through the tokens is everything below that is a fixed
// size on purpose: the line-number gutter (10px), the content padding
// (24/24/48), the gutter's minWidth and the cursor's hairline (1.5px). These are
// CHROME, measured against the panel rather than the text — a gutter that grew
// with the body size would change the column's proportions at every step, and a
// caret hairline is a hairline at any size. A first version of this comment
// claimed the theme had no absolute values left; a reader who believes that
// stops looking, and there are four.
//
// In the stylesheet rather than here on purpose: a CSS variable is live, so a
// body-size change reaches this editor with no reconfiguration and no view
// rebuild at all — the pane only has to ask CodeMirror to re-measure, which is
// what `SourcePane` does when the setting changes. The face stays monospace:
// unifying the SIZE must not unify the family, and the mono face is what the
// source pane is for.
const sourceTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--app-canvas)',
    color: 'var(--app-text)',
  },
  '.cm-scroller': {
    height: '100%',
    overflow: 'auto',
    overflowAnchor: 'none',
    overscrollBehavior: 'contain',
    fontFamily: 'var(--app-mono-font)',
  },
  '.cm-content': {
    padding: '24px 24px 48px',
    caretColor: 'var(--app-accent)',
  },
  '.cm-line': {
    padding: '0 8px 0 0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--app-accent)',
    borderLeftWidth: '1.5px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--app-canvas)',
    color: 'color-mix(in srgb, var(--app-muted) 72%, transparent)',
    borderRight: '1px solid color-mix(in srgb, var(--app-border) 70%, transparent)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '34px',
    padding: '0 10px 0 8px',
    fontSize: '10px',
    lineHeight: 'inherit',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--app-text) 4%, transparent)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--app-accent) 26%, transparent) !important',
  },
  '.cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--app-accent) 26%, transparent)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--app-code-number) 32%, transparent)',
    borderRadius: '2px',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--app-code-number) 52%, transparent)',
  },
  '.cm-panels': {
    backgroundColor: 'color-mix(in srgb, var(--app-elevated) 82%, var(--app-canvas))',
    color: 'var(--app-text)',
    zIndex: 1,
  },
  '.cm-panels-top': {
    borderBottom: '1px solid color-mix(in srgb, var(--app-border) 88%, transparent)',
  },
  '.cm-placeholder': {
    color: 'color-mix(in srgb, var(--app-muted) 70%, transparent)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--app-elevated)',
    border: '1px solid var(--app-border)',
    borderRadius: 'var(--app-radius-sm)',
    boxShadow: 'var(--app-shadow-card)',
  },
})

// Module-level gate shared between the split-drag coordinator (EditorPane →
// SourcePane.setMeasureSuppressed) and the decoration plugin below. While the
// split handle is being dragged the source pane's width changes every frame;
// suppressing the per-frame decoration rebuild and measure keeps the drag fluid
// instead of re-traversing visibleRanges + syntaxTree on each resize.
const measureGate = { suppressed: false }

function setMeasureSuppressed(suppressed: boolean): void {
  measureGate.suppressed = suppressed
}

function isMeasureSuppressed(): boolean {
  return measureGate.suppressed
}

export { setMeasureSuppressed, isMeasureSuppressed }

const codeBlockLine = Decoration.line({ class: 'cm-md-codeblock' })

function decorateCodeBlocks(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') return
        const first = view.state.doc.lineAt(node.from)
        const last = view.state.doc.lineAt(Math.max(node.from, node.to - 1))
        for (let number = first.number; number <= last.number; number += 1) {
          const line = view.state.doc.line(number)
          builder.add(line.from, line.from, codeBlockLine)
        }
      },
    })
  }
  return builder.finish()
}

const fencedCodeHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = decorateCodeBlocks(view)
    }
    update(update: ViewUpdate) {
      // During a split drag, widths change every frame and would otherwise
      // rebuild the whole decoration set (traversing visibleRanges + the
      // syntax tree) on each resize. Hold the stale set until the drag ends,
      // then let the trailing measure refresh it.
      if (isMeasureSuppressed()) return
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = decorateCodeBlocks(update.view)
      }
    }
  },
  { decorations: (value) => value.decorations },
)

export interface SourceExtensionsOptions {
  /** Show the line-number gutter. Default true. */
  lineNumbers?: boolean
  /** Soft-wrap long lines. Default true. */
  softWrap?: boolean
}

export const SOURCE_EXT_DEFAULTS: Required<SourceExtensionsOptions> = {
  lineNumbers: true,
  softWrap: true,
}

// Ctrl+Shift+Z redo. CodeMirror's own `historyKeymap` binds that chord only
// under its `linux` platform flag, so on Windows — where Ctrl+Shift+Z is what
// every other editor uses — redo silently did nothing while Ctrl+Z undone-work
// could not be restored. Binding it here (ahead of the bundled history keymap)
// makes redo work everywhere; Mod-y from that keymap still applies.
const redoKeymap = [
  { key: 'Ctrl-Shift-z', mac: 'Cmd-Shift-z', run: redo, preventDefault: true },
]

export function sourceExtensions(opts: SourceExtensionsOptions = {}): Extension[] {
  const { lineNumbers, softWrap } = { ...SOURCE_EXT_DEFAULTS, ...opts }
  return [
    // NOTE: `history()` is deliberately NOT part of this set. The undo stack is
    // owned by the CodeMirror host (services/codeMirrorHost.ts), which keeps it
    // in its own compartment so that mirroring a different document into the same
    // view can rebuild the stack instead of inheriting the previous note's
    // deletable history. `historyKeymap` below still drives undo/redo; it just
    // resolves against the stack the host installs.
    // GFM base so strikethrough / task lists / tables parse with proper tags.
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(mdHighlight),
    fencedCodeHighlighter,
    ...(lineNumbers ? [lineNumbersGutter()] : []),
    highlightActiveLine(),
    ...(softWrap ? [EditorView.lineWrapping] : []),
    search({ top: true, createPanel: createZhSearchPanel }),
    keymap.of([...redoKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    sourceTheme,
  ]
}
