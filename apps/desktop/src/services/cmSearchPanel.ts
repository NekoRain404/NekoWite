// Chinese-labeled search panel for the source view (@codemirror/search).
// Adapted from Memoir's search panel: find/replace fields, case/word/regexp
// toggles, live match count, and Enter/Esc key handling via the
// "search-panel" keymap scope.
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from '@codemirror/search'
import type { EditorState } from '@codemirror/state'
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view'

const MATCH_CAP = 999

interface MatchStats {
  current: number
  total: number
  overflow: boolean
}

function countMatches(state: EditorState, query: SearchQuery): MatchStats {
  if (!query.search || !query.valid) return { current: 0, total: 0, overflow: false }
  let total = 0
  let current = 0
  const selection = state.selection.main
  const cursor = query.getCursor(state)
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    total += 1
    if (step.value.from === selection.from && step.value.to === selection.to) current = total
    if (total >= MATCH_CAP) return { current, total, overflow: true }
  }
  return { current, total, overflow: false }
}

function formatCount(stats: MatchStats, query: SearchQuery): string {
  if (!query.search) return ''
  if (!query.valid) return '正则无效'
  if (stats.total === 0) return '无结果'
  const total = stats.overflow ? `${MATCH_CAP}+` : String(stats.total)
  return `${stats.current > 0 ? stats.current : '–'} / ${total}`
}

function elt<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'value' && node instanceof HTMLInputElement) {
      node.value = value
      continue
    }
    node.setAttribute(key, value)
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

function pressed(button: HTMLButtonElement): boolean {
  return button.getAttribute('aria-pressed') === 'true'
}

function setPressed(button: HTMLButtonElement, on: boolean): void {
  button.setAttribute('aria-pressed', on ? 'true' : 'false')
  button.classList.toggle('is-active', on)
}

/** Toggle button that keeps the editor focus on click. */
function toggle(label: string, glyph: string, on: boolean, onClick: () => void): HTMLButtonElement {
  const button = elt('button', {
    type: 'button',
    class: 'nw-search-toggle',
    'aria-label': label,
    title: label,
    'aria-pressed': on ? 'true' : 'false',
  })
  button.textContent = glyph
  button.classList.toggle('is-active', on)
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', onClick)
  return button
}

export function createZhSearchPanel(view: EditorView): Panel {
  let query = getSearchQuery(view.state)

  const searchField = elt('input', {
    class: 'nw-search-field',
    value: query.search,
    placeholder: '查找',
    'aria-label': '查找',
    'main-field': 'true',
    autocomplete: 'off',
    spellcheck: 'false',
  })
  const replaceField = elt('input', {
    class: 'nw-search-field',
    value: query.replace,
    placeholder: '替换为',
    'aria-label': '替换为',
    autocomplete: 'off',
    spellcheck: 'false',
  })
  const count = elt('span', { class: 'nw-search-count', 'aria-live': 'polite' })

  const caseButton = toggle('区分大小写', 'Aa', query.caseSensitive, commit)
  const wordButton = toggle('全字匹配', 'ab', query.wholeWord, commit)
  const regexpButton = toggle('正则表达式', '.*', query.regexp, commit)

  function actionButton(label: string, name: string, onClick: () => void): HTMLButtonElement {
    const button = elt('button', {
      type: 'button',
      class: 'nw-search-action',
      name,
      'aria-label': label,
      title: label,
    })
    button.textContent = label
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', onClick)
    return button
  }

  const navGroup = elt('div', { class: 'nw-search-group' }, [
    actionButton('上一个', 'previous', () => findPrevious(view)),
    actionButton('下一个', 'next', () => findNext(view)),
  ])

  const closeButton = elt('button', {
    type: 'button',
    class: 'nw-search-close',
    'aria-label': '关闭（Esc）',
    title: '关闭（Esc）',
  })
  closeButton.textContent = '✕'
  closeButton.addEventListener('mousedown', (event) => event.preventDefault())
  closeButton.addEventListener('click', () => closeSearchPanel(view))

  const dom = elt(
    'div',
    { class: 'nw-search', role: 'search', 'aria-label': '查找与替换' },
    [
      searchField,
      count,
      navGroup,
      elt('div', { class: 'nw-search-group' }, [caseButton, wordButton, regexpButton]),
      replaceField,
      elt('div', { class: 'nw-search-group' }, [
        actionButton('替换', 'replace', () => replaceNext(view)),
        actionButton('全部替换', 'replaceAll', () => replaceAll(view)),
      ]),
      closeButton,
    ],
  )

  function commit(): void {
    const next = new SearchQuery({
      search: searchField.value,
      replace: replaceField.value,
      caseSensitive: pressed(caseButton),
      wholeWord: pressed(wordButton),
      regexp: pressed(regexpButton),
    })
    if (next.eq(query)) return
    query = next
    view.dispatch({ effects: setSearchQuery.of(next) })
    refresh()
  }

  function refresh(): void {
    count.textContent = formatCount(countMatches(view.state, query), query)
    const invalid = Boolean(query.search) && query.regexp && !query.valid
    searchField.classList.toggle('is-invalid', invalid)
  }

  searchField.addEventListener('input', commit)
  replaceField.addEventListener('input', commit)
  dom.addEventListener('keydown', (event) => {
    if (runScopeHandlers(view, event, 'search-panel')) {
      event.preventDefault()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (event.target === replaceField) {
      replaceNext(view)
      return
    }
    ;(event.shiftKey ? findPrevious : findNext)(view)
  })

  return {
    dom,
    top: true,
    mount() {
      searchField.select()
    },
    update(update: ViewUpdate) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery) && !effect.value.eq(query)) {
            query = effect.value
            searchField.value = query.search
            replaceField.value = query.replace
            setPressed(caseButton, query.caseSensitive)
            setPressed(wordButton, query.wholeWord)
            setPressed(regexpButton, query.regexp)
          }
        }
      }
      if (update.docChanged || update.selectionSet) refresh()
    },
    destroy() {},
  }
}
