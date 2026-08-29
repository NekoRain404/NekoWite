import { defineComponent, h } from 'vue'
import { definePlugin } from '@nekowite/plugin-host'
import type { NekoEditor } from '@nekowite/editor-core'
import { insertMdxComponent } from '@nekowite/editor-core'

type EditorView = ReturnType<NekoEditor['getView']>

export const Callout = defineComponent({
  props: {
    type: { type: String, default: 'info' },
    children: { type: String, default: '' },
  },
  setup(props) {
    return () =>
      h(
        'aside',
        { class: `callout callout-${props.type}` },
        [h('div', { innerHTML: props.children })],
      )
  },
})

let activeView: EditorView | null = null

export function setCalloutView(view: EditorView | null): void {
  activeView = view
}

function insertCallout(): void {
  if (!activeView) return
  insertMdxComponent(activeView, {
    name: 'Callout',
    props: { type: 'info' },
    children: 'note',
  })
}

export const calloutPlugin = definePlugin({
  name: 'Callout',
  components: { Callout },
  toolbar: [{ id: 'callout.insert', label: '插入 Callout', run: insertCallout }],
})