/** The agent panel's command menu — the list the engine publishes for a session. */
import { commandMenu } from './agent/command-menu'
import { panel } from './agent/panel'
import { rail } from './agent/rail'
import { permission } from './agent/permission'
import { registry } from './agent/registry'
import { catalogue } from './agent/catalogue'
import { settings } from './agent/settings'
import { note } from './agent/note'
import { changes } from './agent/changes'
import { permissionEditor } from './agent/permission-editor'

export const agent = {
  en: {
    agent: {
      ...commandMenu.en,
      ...panel.en,
      ...rail.en,
      ...permission.en,
      ...registry.en,
      ...catalogue.en,
      ...settings.en,
      ...note.en,
      ...changes.en,
      ...permissionEditor.en,
    },
  },
  zh: {
    agent: {
      ...commandMenu.zh,
      ...panel.zh,
      ...rail.zh,
      ...permission.zh,
      ...registry.zh,
      ...catalogue.zh,
      ...settings.zh,
      ...note.zh,
      ...changes.zh,
      ...permissionEditor.zh,
    },
  },
} as const
