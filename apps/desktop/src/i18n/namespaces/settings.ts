/**
 * The settings dialog — its section list, every section body, and the font-family names the
 * appearance section offers. Each subtree lives in ./settings/, and the desktop pet's pages
 * are split again under ./settings/pet/.
 */
import { settingsShell } from './settings/shell'
import { pluginsPage } from './settings/plugins-page'
import { general } from './settings/general'
import { appearance } from './settings/appearance'
import { editor } from './settings/editor'
import { exportPage } from './settings/export'
import { pet } from './settings/pet'
import { fontNames } from './settings/font-names'

export const settings = {
  en: {
    settings: {
      ...settingsShell.en,
      ...pluginsPage.en,
      ...general.en,
      ...appearance.en,
      ...editor.en,
      ...exportPage.en,
      ...pet.en,
    },

    font: {
      ...fontNames.en,
    },
  },
  zh: {
    settings: {
      ...settingsShell.zh,
      ...pluginsPage.zh,
      ...general.zh,
      ...appearance.zh,
      ...editor.zh,
      ...exportPage.zh,
      ...pet.zh,
    },

    font: {
      ...fontNames.zh,
    },
  },
} as const
