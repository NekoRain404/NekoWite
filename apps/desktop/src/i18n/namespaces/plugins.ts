/**
 * The plugin host: load failures, the permission and integrity prompts, and plugin-initiated
 * AI writes.
 */
export const plugins = {
  en: {
    plugin: {
      loadFailed: 'Plugin failed to load: {id} ({error})',
      loadingDisabled:
        'Vault plugins are disabled under the current security policy (CSP blocks in-window module loading). Expected until process/WebView isolation is implemented.',
      genericName: 'a plugin',
      writeSummary: 'Plugin “{name}” wants to insert content at the cursor',
      writeDenied: 'The write from plugin “{name}” was refused (the AI write permission may be set to “never write”).',
      openSummary: 'Plugin “{name}” wants to replace the whole document',
      syncWriteDenied: 'Plugin “{name}” used a write that cannot ask for permission, and nothing is granted yet: have it use the insert API, or set the AI write permission to “write without asking”.',
      aiEmptyPrompt: 'A plugin asked the AI with an empty prompt.',
      aiTimedOut: 'A plugin\'s AI call timed out (60 seconds).',
      aiEmpty: 'The AI call from plugin \u201c{name}\u201d returned nothing.',
      aiDisabled: 'AI features are switched off in Settings \u2192 AI, so the plugin cannot use the model.',
      permissionSkipped: 'Plugin “{name}” requested sensitive permissions but was not approved; skipped.',
      permissionTitle: 'Plugin permission request',
      permissionBody:
        'Plugin “{name}” requests access to: {perms}. It runs in the same process as the app (no sandbox isolation) — only allow it if you trust the plugin.',
      permissionAllow: 'Allow',
      permissionDeny: 'Deny',
      integrityTitle: 'Plugin code changed',
      integrityBody:
        'The plugin “{name}” changed since you approved it (its manifest or code fingerprint differs). Re-approve it only if you trust the new version; otherwise deny and reinstall it.',
      integrityDigest: 'Recorded: {expected}\nCurrent: {actual}',
      integrityAllow: 'Re-approve',
      integrityDeny: 'Deny',
      permissionAi: 'AI capability',
      permissionFs: 'File read/write',
      permissionNetwork: 'Network access',
      permissionClipboard: 'Clipboard',
      floatboxChildren: 'Float content',
    },
  },
  zh: {
    plugin: {
      loadFailed: '插件加载失败：{id}（{error}）',
      loadingDisabled:
        '当前安全策略下不会加载库内插件（CSP 阻止在窗口内加载模块）。在实现进程/WebView 隔离前，这是预期行为。',
      genericName: '插件',
      writeSummary: '插件「{name}」要往光标处插入内容',
      writeDenied: '插件「{name}」的写入被拒绝（可能是当前的 AI 写入权限设置为「禁止写入」）。',
      openSummary: '插件「{name}」要替换整篇文档',
      syncWriteDenied: '插件「{name}」用了无法询问的写入接口，而当前权限尚未授权：请让插件改用插入接口，或把 AI 写入权限改为「直接写入」。',
      aiEmptyPrompt: '插件调用 AI 时提示词为空。',
      aiTimedOut: '插件调用 AI 超时（60 秒）。',
      aiEmpty: '插件「{name}」的 AI 调用没有返回内容。',
      aiDisabled: 'AI 功能已在“设置 → AI”里关闭，插件无法调用 AI。',
      permissionSkipped: '插件「{name}」请求敏感权限但未获授权，已跳过加载。',
      permissionTitle: '插件权限请求',
      permissionBody:
        '插件「{name}」请求访问以下能力：{perms}。当前插件与主应用同进程运行（无沙箱隔离），仅在信任该插件时允许。',
      permissionAllow: '允许',
      permissionDeny: '拒绝',
      integrityTitle: '插件代码已变更',
      integrityBody:
        '插件「{name}」自你上次批准后已发生变化（清单或代码指纹不一致）。仅当你信任新版本时才重新批准；否则请拒绝并重新安装。',
      integrityDigest: '已记录：{expected}\n当前：{actual}',
      integrityAllow: '重新批准',
      integrityDeny: '拒绝',
      permissionAi: 'AI 能力',
      permissionFs: '文件读写',
      permissionNetwork: '网络访问',
      permissionClipboard: '剪贴板',
      floatboxChildren: '浮动内容',
    },
  },
}
