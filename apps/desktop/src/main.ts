import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { activatePlugin, loadPlugin } from '@nekowite/plugin-host'
import type { PluginMeta } from '@nekowite/plugin-host'
import App from './App.vue'
import { calloutPlugin } from './plugins/callout'
import { statusPlugin } from './plugins/status'
import 'mathlive/static.css'
import './style.css'

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
  createApp(App).use(createPinia()).mount('#app')
})
