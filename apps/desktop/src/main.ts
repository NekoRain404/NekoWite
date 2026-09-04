import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { activatePlugin, loadPlugin } from '@nekowite/plugin-host'
import type { PluginMeta } from '@nekowite/plugin-host'
import App from './App.vue'
import { i18n } from './i18n'
import { calloutPlugin } from './plugins/callout'
import { floatboxPlugin } from './plugins/floatbox'
import { statusPlugin } from './plugins/status'
import './styles/tokens.css'
import './styles/components.css'
import './styles/editor-content.css'
import './styles/print.css'
import './style.css'
import './math-dialog.css'

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

void activateBuiltins().then(() => {
  createApp(App).use(createPinia()).use(i18n).mount('#app')
})
