/** The multi-character cap and what is absent. */
export const project = {
  en: {
    project: {
      maxCharacters: 'Characters at once',
      maxCharactersNote: 'The cap is the pet host\'s to enforce, so the settings page and the host read one number rather than two.',
      bindingUnavailable: 'Binding a library to a character, and the decoration characters, belong to the multi-character surface, which this build does not have - so there are no controls for them here, and the cap above is stored rather than limiting anything yet.',
    },
  },
  zh: {
    project: {
      maxCharacters: '同时显示角色数',
      maxCharactersNote: '这个上限由桌宠宿主执行，所以设置页和宿主读的是同一个数字，而不是两个。',
      bindingUnavailable: '把知识库绑定到角色、以及装饰角色，都属于多角色功能，本版本还没有——所以这里不提供它们的控件；上面的上限目前也只是保存下来，尚未限制任何东西。',
    },
  },
} as const
