/** The live preview panel. */
export const preview = {
  en: {
    preview: {
      title: 'Preview',
      loading: 'Reading the pet settings...',
      off: 'The desktop pet is switched off.',
      noCharacter: 'No character is selected.',
      bubble: 'Show a bubble',
      bubbleText: 'A run finished.',
      caption: '{size} px, bubbles last {seconds}s',
      scaled: 'Drawn at {pct}% to fit this panel.',
      reduced: 'Motion is reduced, so the pet holds still.',
    },
  },
  zh: {
    preview: {
      title: '预览',
      loading: '正在读取桌宠设置…',
      off: '桌宠已关闭。',
      noCharacter: '尚未选择角色。',
      bubble: '显示气泡',
      bubbleText: '一轮执行结束。',
      caption: '{size} px，气泡停留 {seconds} 秒',
      scaled: '按 {pct}% 缩放以放进面板。',
      reduced: '已减少动效，桌宠保持静止。',
    },
  },
} as const
