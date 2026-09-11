import { it } from 'vitest'
import { createEditor } from './editor'

it('probe mdx in heading', async () => {
  for (const md of ['# Title <Callout type="info" />\n', '# Before\n\n# Title <Callout />\n\n# After\n', '# Title <Callout /> tail\n']) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    try {
      let opened = 'ok'
      try {
        await ed.open(md)
      } catch (e) {
        opened = 'THREW: ' + String(e)
      }
      const json = JSON.stringify(ed.getView().state.doc.toJSON())
      const saved = await ed.save()
      console.log('PROBE md=' + JSON.stringify(md) + ' open=' + opened)
      console.log('   doc=' + json)
      console.log('   saved=' + JSON.stringify(saved))
    } finally {
      ed.destroy()
      el.remove()
    }
  }
})
