/** The save-state words, named after PetSettingsSaveStatus. */
export const save = {
  en: {
    save: {
      loading: 'reading the stored settings...',
      pending: 'edited, not saved yet',
      saving: 'saving...',
      saved: 'saved',
      invalid: 'a value is outside its allowed range, so nothing was written',
      conflict: 'another window changed these settings - the stored values were reloaded, and this edit was dropped',
      failed: 'the settings could not be written',
    },
  },
  zh: {
    save: {
      loading: '正在读取已保存的设置…',
      pending: '已修改，尚未保存',
      saving: '正在保存…',
      saved: '已保存',
      invalid: '有数值超出允许范围，未写入',
      conflict: '另一个窗口改了这些设置——已重新载入存储值，本次修改未保留',
      failed: '设置未能写入',
    },
  },
} as const
