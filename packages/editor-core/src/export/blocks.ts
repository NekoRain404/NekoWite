import type { RenderNode } from './pipeline'

/**
 * The two containers whose structure the exporter has to build itself.
 *
 * Lists and tables both carry state that mdast records once and that a naive
 * renderer loses: a list item's GFM task state and a table's per-column
 * alignment. Each container renders its own children through the `render`
 * function it is handed rather than importing the node dispatcher, which is
 * what keeps the dependency one-way — `render.ts` calls these, these never call
 * back into it.
 */

export type RenderNodes = (nodes: RenderNode[]) => string

export function renderList(node: RenderNode, render: RenderNodes): string {
  const tag = node.ordered ? 'ol' : 'ul'
  const start = node.ordered && typeof node.start === 'number' && node.start !== 1
    ? ` start="${node.start}"`
    : ''
  const items = (node.children ?? []) as RenderNode[]
  // GFM marks a task item with `checked: true|false`; there is no other way to
  // tell `- [x] a` from `- a` after parsing, so the state has to be carried
  // into the markup or it is lost (the literal `[x]` is consumed by remark-gfm).
  const hasTasks = items.some((item) => typeof item.checked === 'boolean')
  const rendered = items
    .map((item) => {
      const inner = render((item.children ?? []) as RenderNode[])
      if (typeof item.checked !== 'boolean') return `<li>${inner}</li>`
      const checked = item.checked ? ' checked' : ''
      return (
        `<li class="task-list-item">` +
        `<input type="checkbox" disabled${checked}>` +
        `<span class="task-list-item-body">${inner}</span></li>`
      )
    })
    .join('')
  const listClass = hasTasks ? ' class="contains-task-list"' : ''
  return `<${tag}${start}${listClass}>${rendered}</${tag}>`
}

export function renderTable(node: RenderNode, render: RenderNodes): string {
  const rows = (node.children ?? []) as RenderNode[]
  // mdast carries GFM column alignment on the TABLE, one entry per column. It
  // was declared on the node type and never read, so a right-aligned column of
  // numbers exported left-aligned: the alignment the author set in the editor
  // was simply not in the file they handed to someone else.
  const align = Array.isArray(node.align) ? node.align : []
  const alignStyle = (index: number): string => {
    const value = align[index]
    return value === 'left' || value === 'center' || value === 'right'
      ? ` style="text-align: ${value}"`
      : ''
  }
  const renderRow = (row: RenderNode, tag: 'th' | 'td'): string => {
    const cells = (row.children ?? []) as RenderNode[]
    const cellHtml = cells
      .map((cell, index) => `<${tag}${alignStyle(index)}>${render((cell.children ?? []) as RenderNode[])}</${tag}>`)
      .join('')
    return `<tr>${cellHtml}</tr>`
  }
  // One <thead> and ONE <tbody> holding every data row. Emitting a <tbody> per
  // row was accidental (the wrapper was chosen inside the per-row loop), so a
  // 100-row table produced 99 row groups — which is what `tbody + tbody` CSS,
  // copy/paste and DOM tooling see, none of which matches the Markdown table
  // the author wrote.
  const [head, ...body] = rows
  const headHtml = head ? `<thead>${renderRow(head, 'th')}</thead>` : ''
  const bodyHtml = body.length > 0 ? `<tbody>${body.map((r) => renderRow(r, 'td')).join('')}</tbody>` : ''
  return `<table>${headHtml}${bodyHtml}</table>`
}
