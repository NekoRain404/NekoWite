import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { isSourceCommand, runSourceCommand } from './sourceCommands'

/**
 * A minimal stand-in for a CodeMirror view: a real `EditorState` plus a
 * `dispatch` that applies the transaction spec, so every command is exercised
 * against genuine CodeMirror change/selection semantics without a DOM.
 */
function makeView(doc: string, anchor = 0, head = anchor) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
  const view = {
    get state() {
      return state
    },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => {
      state = state.update(spec).state
    },
    focus: () => undefined,
  }
  return {
    view: view as unknown as EditorView,
    doc: () => state.doc.toString(),
    caret: () => state.selection.main,
  }
}

function run(doc: string, id: string, anchor: number, head = anchor) {
  const harness = makeView(doc, anchor, head)
  const handled = runSourceCommand(harness.view, id)
  return { handled, ...harness }
}

describe('isSourceCommand', () => {
  it('claims the Markdown-shaped builtins', () => {
    for (const id of [
      'heading:h1',
      'heading:h6',
      'bold',
      'italic',
      'strike',
      'inline-code',
      'list-unordered',
      'list-ordered',
      'list-task',
      'quote',
      'link',
      'code-block',
      'hr',
      'insert-component',
    ]) {
      expect(isSourceCommand(id), id).toBe(true)
    }
  })

  it('does not claim plugin or out-of-range ids', () => {
    for (const id of ['math.insert', 'table.insert', 'image', 'heading:h7', 'heading:', 'nope']) {
      expect(isSourceCommand(id), id).toBe(false)
    }
  })
})

describe('runSourceCommand', () => {
  it('bold wraps the selection and a second press unwraps it', () => {
    const first = run('Hello', 'bold', 0, 5)
    expect(first.handled).toBe(true)
    expect(first.doc()).toBe('**Hello**')

    const second = run(first.doc(), 'bold', 0, first.doc().length)
    expect(second.doc()).toBe('Hello')
  })

  it('bold with an empty caret inserts the pair and parks the caret inside', () => {
    const { doc, caret } = run('ab', 'bold', 1)
    expect(doc()).toBe('a****b')
    expect(caret().from).toBe(3)
  })

  it.each([
    ['italic', '*ab*'],
    ['strike', '~~ab~~'],
    ['inline-code', '`ab`'],
  ])('%s wraps %s', (id, expected) => {
    const { doc } = run('ab', id, 0, 2)
    expect(doc()).toBe(expected)
  })

  it('heading prefixes the line and toggles back to a paragraph', () => {
    const first = run('Title', 'heading:h2', 0)
    expect(first.doc()).toBe('## Title')
    const same = run(first.doc(), 'heading:h2', 0)
    expect(same.doc()).toBe('Title')
    const changed = run('## Title', 'heading:h3', 0)
    expect(changed.doc()).toBe('### Title')
  })

  it('heading applies to every selected line', () => {
    const { doc } = run('one\ntwo\nthree', 'heading:h1', 0, 12)
    expect(doc()).toBe('# one\n# two\n# three')
  })

  it.each([
    ['list-unordered', '- '],
    ['list-ordered', '1. '],
    ['list-task', '- [ ] '],
    ['quote', '> '],
  ])('%s prefixes every selected line and toggles off', (id, prefix) => {
    const on = run('one\ntwo', id, 0, 7)
    expect(on.doc()).toBe(`${prefix}one\n${prefix}two`)
    const off = run(on.doc(), id, 0, on.doc().length)
    expect(off.doc()).toBe('one\ntwo')
  })

  it('link wraps a selection and keeps the text selected', () => {
    const { doc, caret } = run('Hello', 'link', 0, 5)
    expect(doc()).toBe('[Hello](https://)')
    expect(caret().from).toBe(1)
    expect(caret().to).toBe(6)
  })

  it('link with an empty caret inserts placeholder text and parks on the URL', () => {
    const { doc, caret } = run('', 'link', 0)
    expect(doc()).toBe('[text](https://)')
    // Just before the closing paren, so the first keystroke types the URL.
    expect(caret().from).toBe('[text](https://)'.length - 1)
  })

  it('hr lands on its own line, spaced when the current line has text', () => {
    expect(run('', 'hr', 0).doc()).toBe('---\n')
    expect(run('text', 'hr', 4).doc()).toBe('text\n\n---\n')
  })

  it('code-block fences the selection and unfences on a second press', () => {
    const on = run('code', 'code-block', 0, 4)
    expect(on.doc()).toBe('```\ncode\n```')
    const off = run(on.doc(), 'code-block', 0, on.doc().length)
    expect(off.doc()).toBe('code')
  })

  it('insert-component writes JSX source', () => {
    expect(run('', 'insert-component', 0).doc()).toBe('<Component />\n')
  })

  it('reports unhandled ids instead of mutating the document', () => {
    const { handled, doc } = run('keep me', 'math.insert', 0)
    expect(handled).toBe(false)
    expect(doc()).toBe('keep me')
  })
})

describe('runSourceCommand selection edges', () => {
  it('bold ignores the newline a select-all leaves at the end', () => {
    // `hello\n` selected end to end: the closing marker must not land on the
    // next line.
    const { doc } = run('hello\n', 'bold', 0, 6)
    expect(doc()).toBe('**hello**\n')
  })

  it.each([
    ['list-unordered', '- '],
    ['quote', '> '],
  ])('%s ignores the empty line a trailing newline creates', (id, prefix) => {
    const { doc } = run('one\ntwo\n', id, 0, 8)
    expect(doc()).toBe(`${prefix}one\n${prefix}two\n`)
  })

  it('heading ignores the empty line a trailing newline creates', () => {
    const { doc } = run('Title\n', 'heading:h2', 0, 6)
    expect(doc()).toBe('## Title\n')
  })

  it('link ignores the trailing newline', () => {
    const { doc } = run('hello\n', 'link', 0, 6)
    expect(doc()).toBe('[hello](https://)\n')
  })

  it('still prefixes a genuinely blank line inside the selection', () => {
    const { doc } = run('one\n\ntwo', 'quote', 0, 8)
    expect(doc()).toBe('> one\n> \n> two')
  })
})
