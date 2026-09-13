import { defineComponent, h } from 'vue'
import { definePlugin } from '@nekowite/plugin-host'
import type { NekoEditor } from '@nekowite/editor-core'
import {
  insertMdxComponent,
  mdxComponentToMarkdown,
  registerMarkdownCommand,
} from '@nekowite/editor-core'
import { t } from '../i18n'

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

const CALLOUT_ID = 'callout.insert'

export const calloutPlugin = definePlugin({
  name: 'Callout',
  components: { Callout },
  toolbar: [{ id: CALLOUT_ID, label: t('command.callout.insert'), run: insertCallout }],
})

// Source mode has no MDX node to insert, so the same component is written as
// its JSX source. Produced through the serializer's own helper so the two
// forms cannot drift apart.
registerMarkdownCommand(CALLOUT_ID, () => {
  const text = mdxComponentToMarkdown({
    name: 'Callout',
    props: { type: 'info' },
    children: 'note',
  })
  return { text, caret: text.indexOf('note') }
})
