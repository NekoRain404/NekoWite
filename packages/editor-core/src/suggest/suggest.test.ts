import { describe, expect, it } from 'vitest'

import { basicPlugins, createEditor } from '../editor'

describe('suggestion ghost text', () => {
  it('decoration does not mutate doc', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello ')
    editor.setSuggestion('world')
    const md = await editor.save()
    expect(md).not.toContain('world')
    editor.destroy()
  })

  it('acceptSuggestion inserts text into doc', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello ')
    editor.setSuggestion('world')
    const inserted = editor.acceptSuggestion()
    expect(inserted).toBe('world')
    const md = await editor.save()
    expect(md).toContain('world')
    editor.destroy()
  })

  it('rejectSuggestion leaves doc untouched', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello ')
    editor.setSuggestion('world')
    editor.rejectSuggestion()
    const md = await editor.save()
    expect(md).not.toContain('world')
    editor.destroy()
  })

  it('hasSuggestion toggles', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hi')
    expect(editor.hasSuggestion()).toBe(false)
    editor.setSuggestion('x')
    expect(editor.hasSuggestion()).toBe(true)
    editor.destroy()
  })

  it('hasSuggestion is false for an empty suggestion', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hi')
    editor.setSuggestion('')
    expect(editor.hasSuggestion()).toBe(false)
    editor.destroy()
  })

  it('clears suggestion when the user types', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello ')
    editor.setSuggestion('world')
    expect(editor.hasSuggestion()).toBe(true)
    const view = editor.getView()
    view.dispatch(view.state.tr.insertText('X'))
    expect(editor.hasSuggestion()).toBe(false)
    editor.destroy()
  })

  it('onSuggestionChange fires accepted once on accept', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello ')
    const events: string[] = []
    editor.onSuggestionChange((s) => events.push(s))
    editor.setSuggestion('world')
    editor.acceptSuggestion()
    expect(events).toEqual(['accepted'])
    editor.destroy()
  })

  it('onSuggestionChange fires cleared once when typing clears', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello ')
    const events: string[] = []
    editor.onSuggestionChange((s) => events.push(s))
    editor.setSuggestion('world')
    const view = editor.getView()
    view.dispatch(view.state.tr.insertText('X'))
    expect(events).toEqual(['cleared'])
    editor.destroy()
  })

  it('onSuggestionChange fires rejected once on reject', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello ')
    const events: string[] = []
    editor.onSuggestionChange((s) => events.push(s))
    editor.setSuggestion('world')
    editor.rejectSuggestion()
    expect(events).toEqual(['rejected'])
    editor.destroy()
  })
})
