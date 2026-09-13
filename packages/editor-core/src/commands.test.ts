import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/prose/state'

import { createEditor } from './editor'
import type { NekoEditor } from './editor'
import { registerBuiltinCommands, setImageInsertHandler } from './commands'
import { runBuiltinCommandOn } from './commands'
import { getCommand } from './registry'

async function setup(markdown: string): Promise<{ editor: NekoEditor; save: () => Promise<string> }> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: await import('./plugins/basic').then((m) => m.basicPlugins) })
  await editor.open(markdown)
  // remark-stringify terminates documents with a newline; trim it so exact
  // assertions compare content.
  return { editor, save: async () => (await editor.save()).replace(/\n$/, '') }
}

function selectAll(editor: NekoEditor): void {
  const view = editor.getView()
  const tr = view.state.tr.setSelection(
    TextSelection.create(view.state.doc, 0, view.state.doc.content.size),
  )
  view.dispatch(tr)
}

describe('builtin toolbar commands', () => {
  it('registers every builtin id and is safe to re-register', () => {
    registerBuiltinCommands()
    registerBuiltinCommands()
    for (const id of ['heading:h1', 'heading:h6', 'bold', 'italic', 'strike', 'inline-code', 'list-unordered', 'list-ordered', 'list-task', 'quote', 'link', 'image', 'code-block', 'hr', 'insert-component']) {
      expect(getCommand(id), id).toBeDefined()
    }
  })

  it('bold wraps the selection', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('bold', editor.getView())
    expect(await save()).toContain('**Hello**')
  })

  it('italic and strike wrap the selection', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('italic', editor.getView())
    // Milkdown's emphasis serializer prefers asterisks.
    expect(await save()).toContain('*Hello*')
    selectAll(editor)
    runBuiltinCommandOn('strike', editor.getView())
    expect(await save()).toContain('~~')
  })

  it('inline-code wraps the selection', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('inline-code', editor.getView())
    expect(await save()).toContain('`Hello`')
  })

  it('heading toggles on and off', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('heading:h2', editor.getView())
    expect(await save()).toContain('## Hello')
    selectAll(editor)
    runBuiltinCommandOn('heading:h2', editor.getView())
    expect(await save()).not.toContain('#')
  })

  it('heading level upgrades from an existing heading', async () => {
    const { editor, save } = await setup('## Hello')
    selectAll(editor)
    runBuiltinCommandOn('heading:h3', editor.getView())
    expect(await save()).toContain('### Hello')
  })

  it('heading:h3 produces a level-3 heading', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('heading:h3', editor.getView())
    expect(await save()).toContain('### Hello')
  })

  it('blockquote toggles on and off', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('quote', editor.getView())
    expect(await save()).toContain('> Hello')
    selectAll(editor)
    runBuiltinCommandOn('quote', editor.getView())
    expect(await save()).not.toContain('>')
  })

  it('blockquote toggles off with a nested selection', async () => {
    const { editor, save } = await setup('> Hello')
    // Selection inside the paragraph, not covering the blockquote itself.
    selectAll(editor)
    runBuiltinCommandOn('quote', editor.getView())
    expect(await save()).not.toContain('>')
  })

  it('unordered list wraps and unwraps', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('list-unordered', editor.getView())
    expect(await save()).toContain('- Hello')
    selectAll(editor)
    runBuiltinCommandOn('list-unordered', editor.getView())
    expect(await save()).toBe('Hello')
  })

  it('ordered list unwraps back to a paragraph', async () => {
    const { editor, save } = await setup('1. Hello')
    selectAll(editor)
    runBuiltinCommandOn('list-ordered', editor.getView())
    expect(await save()).toBe('Hello')
  })

  it('ordered list wraps', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('list-ordered', editor.getView())
    expect(await save()).toContain('1. Hello')
  })

  it('task list produces a checkbox and toggles back', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('list-task', editor.getView())
    expect(await save()).toContain('- [ ] Hello')
    selectAll(editor)
    runBuiltinCommandOn('list-task', editor.getView())
    expect(await save()).toContain('- Hello')
  })

  it('creating a task list is a single undo step', async () => {
    const { editor, save } = await setup('Hello')
    const view = editor.getView()
    selectAll(editor)
    let dispatches = 0
    const orig = view.dispatch.bind(view)
    view.dispatch = (tr) => {
      dispatches += 1
      orig(tr)
    }
    runBuiltinCommandOn('list-task', view)
    expect(await save()).toContain('- [ ] Hello')
    expect(dispatches).toBe(1)
  })

  it('code block converts the paragraph and back', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('code-block', editor.getView())
    expect(await save()).toContain('```\nHello\n```')
    selectAll(editor)
    runBuiltinCommandOn('code-block', editor.getView())
    expect(await save()).toBe('Hello')
  })

  it('code block unwraps from inside the block', async () => {
    const { editor, save } = await setup('```\nHello\n```')
    selectAll(editor)
    runBuiltinCommandOn('code-block', editor.getView())
    expect(await save()).toBe('Hello')
  })


  it('link applies a placeholder href to the selection', async () => {
    const { editor, save } = await setup('Hello')
    selectAll(editor)
    runBuiltinCommandOn('link', editor.getView())
    expect(await save()).toContain('[Hello](https://)')
  })

  it('image inserts a placeholder node when no host handler is registered', async () => {
    const { editor, save } = await setup('')
    runBuiltinCommandOn('image', editor.getView())
    expect(await save()).toContain('![')
  })

  it('image delegates to the host handler and inserts nothing itself', async () => {
    const { editor, save } = await setup('')
    let calls = 0
    setImageInsertHandler(() => {
      calls += 1
    })
    try {
      runBuiltinCommandOn('image', editor.getView())
      expect(calls).toBe(1)
      // The handler owns the insert: a placeholder must not also land in the
      // document, or every pick would add a stray broken image.
      expect(await save()).not.toContain('![')
    } finally {
      setImageInsertHandler(null)
    }
  })

  it('image falls back to the placeholder once the handler is cleared', async () => {
    const { editor, save } = await setup('')
    setImageInsertHandler(() => undefined)
    setImageInsertHandler(null)
    runBuiltinCommandOn('image', editor.getView())
    expect(await save()).toContain('![')
  })

  it('hr inserts a thematic break', async () => {
    const { editor, save } = await setup('')
    runBuiltinCommandOn('hr', editor.getView())
    // Milkdown serializes horizontal rules with asterisks.
    expect(await save()).toContain('***')
  })

  it('insert-component inserts an MDX component node', async () => {
    const { editor, save } = await setup('')
    runBuiltinCommandOn('insert-component', editor.getView())
    expect(await save()).toContain('<Component />')
  })

  it('commands no-op safely when no editor view is available', () => {
    // No createEditor in this test — the provider has no view, so run() must
    // not throw even though the command resolves.
    expect(() => getCommand('bold')?.run()).not.toThrow()
  })
})
