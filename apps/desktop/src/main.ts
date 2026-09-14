import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { activatePlugin, loadPlugin } from '@nekowite/plugin-host'
import type { PluginMeta } from '@nekowite/plugin-host'
import App from './App.vue'
import { i18n } from './i18n'
import { calloutPlugin } from './plugins/callout'
import { floatboxPlugin } from './plugins/floatbox'
import { statusPlugin } from './plugins/status'
import './styles/tokens.css'
// The colour half of tokens.css (brief 75), and it has to load AFTER it: the
// dark block repeats the radius ladder, and a re-point must keep coming after
// the declaration it repeats. `styles/tokens.test.ts` simulates the cascade
// over these two files in this import order and asserts that it still matches
// this list — move one, move the other.
import './styles/palettes.css'
// The component layer, in two sheets and one order: the controls a user
// operates, then the surfaces they sit in and the editor-core dialog
// passthroughs. `styles/components.test.ts` reads both as one sheet and asserts
// this order against this list — move one, move the other.
import './styles/components.css'
import './styles/surfaces.css'
// The editor content layer, likewise: the text, then the constructs the editor
// draws. `styles/editorTypography.test.ts` reads both as one sheet and checks
// them against this list the same way.
import './styles/editor-content.css'
import './styles/editor-blocks.css'
import './styles/print.css'
import './style.css'
import './math-dialog.css'
// The motion layer, in two sheets and one order: the surface lifecycle first,
// then the press vocabulary and the global prefers-reduced-motion switch — last
// on purpose, so the switch's `!important` sweep outranks every component's
// scoped styles.
import './styles/surface-motion.css'
import './styles/motion.css'

async function activateBuiltins(): Promise<void> {
  const builtins: { meta: PluginMeta; definition: typeof calloutPlugin }[] = [
    {
      meta: { id: 'nekowite.builtin.callout', name: 'Callout', version: '1', main: '@nekowite/builtin-callout' },
      definition: calloutPlugin,
    },
    {
      meta: { id: 'nekowite.builtin.status', name: 'Status', version: '1', main: '@nekowite/builtin-status' },
      definition: statusPlugin,
    },
    {
      meta: { id: 'nekowite.builtin.floatbox', name: 'FloatBox', version: '1', main: '@nekowite/builtin-floatbox' },
      definition: floatboxPlugin,
    },
  ]
  const results = await Promise.all(
    builtins.map(({ meta, definition }) =>
      loadPlugin(meta, async () => ({ default: definition })),
    ),
  )
  for (const result of results) {
    const res = await activatePlugin(result)
    if (!res.ok) console.warn(`[NekoWite] plugin activation failed: ${res.id}`, res.error)
    else console.info(`[NekoWite] plugin activated: ${res.id}`)
  }
}

const pinia = createPinia()
setActivePinia(pinia)
void activateBuiltins().then(() => {
  createApp(App).use(pinia).use(i18n).mount('#app')
})
