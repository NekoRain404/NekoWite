/** The provider section: the profile’s provider and model, and what the engine is handed. */
export const provider = {
  en: {
    provider: {
      section: {
        title: 'Provider and model',
        hint: 'Which provider and model this profile is set to, and every place that setting can come from.',
      },
      loading: 'Reading the profile...',
      unreadable: 'The profile could not be read from the backend.',
      identity: { agent: 'Engine', profile: 'Profile' },
      mismatch: 'This profile belongs to another engine. Nothing here can be shown under this one, and credentials, model ids and configuration are never moved between engines.',
      mode: {
        label: 'Configuration',
        appManaged: 'This app owns the profile: it injects the roots the engine reads, and it is the side that writes.',
        userConfig: 'This profile reuses your own configuration. This app reads what is there and writes nothing - not a document and not a credential.',
        readOnly: 'Settings is read-only for this profile.',
      },
      fields: { provider: 'Provider', modelId: 'Model', empty: 'nothing chosen yet' },
      action: {
        save: 'Save',
        applied: 'Saved.',
        failed: 'This change could not be sent to the backend.',
        unsaved: 'This change has not been saved.',
      },
      switchPlan: {
        title: 'Switching configuration mode',
        movesNothing: 'Switching does not move or overwrite a file. Both modes leave every file where it is; what changes is who writes from then on.',
      },
      changes: {
        'roots-are-injected': 'The engine will be started with HOME and the XDG roots pointing into this app’s own profile.',
        'roots-are-the-users': 'The engine will be started with your own environment, and this app will not inject a root.',
        'host-starts-writing': 'This app begins writing this profile’s configuration.',
        'host-stops-writing': 'This app stops writing this profile’s configuration.',
        'credentials-move-to-the-engine': 'Credentials for this profile become the engine’s own: this app stops holding them, and stops reporting them.',
      },
      sources: {
        title: 'Where the settings come from',
        hint: 'Every source that actually takes effect, including the ones this app does not set - it cannot claim to have closed a search path it does not own.',
        injected: 'Set by this app',
        engineDiscovery: 'The engine’s own discovery',
        discovery: {
          reused: 'This profile is your own installation, so the engine reads everything it normally would. Nothing here narrows it.',
          project: 'The folder you open contributes its own configuration: an opencode.json or an .opencode directory in it, and in every folder above it, is merged into this profile - providers, permission rules and more. This app leaves that merge on.',
          managed: 'The machine’s managed configuration folder, /etc/opencode, is merged into this profile as well, and a system administrator may have put providers, models or permission rules there. No supported switch turns that off.',
        },
      },
      credentials: {
        title: 'Credentials',
        hint: 'Names only. A value is never sent to this page, and the placeholder below is what is shown in its place.',
        none: 'This profile holds no credentials.',
        hostFile: 'Stored in a file this app owns:',
        notEncrypted: 'That file is a file with owner-only permissions. It is not encrypted, and it is not a system keychain.',
        placeholder: 'value is stored',
        form: {
          editHint: 'Type a new value to replace one, or empty a field to remove that credential. Fields you leave alone are kept as they are. Only what you type here is sent; the stored values are never read back.',
          save: 'Save credentials',
          saved: 'Saved.',
          failed: 'The credentials were not saved.',
        },
      },
    },
  },
  zh: {
    provider: {
      section: {
        title: '供应商与模型',
        hint: '该配置档设定的供应商与模型，以及这个设定可能来自的每一处。',
      },
      loading: '正在读取配置档……',
      unreadable: '未能从后端读取配置档。',
      identity: { agent: '引擎', profile: '配置档' },
      mismatch: '该配置档属于另一个引擎。任何内容都不会在当前引擎下显示——凭据、模型标识与配置也从不在引擎之间搬移。',
      mode: {
        label: '配置',
        appManaged: '该配置档由本应用拥有：引擎读取的根目录由本应用注入，写入的一方也是本应用。',
        userConfig: '该配置档复用你自己的配置。本应用只读取其中的内容，不写入任何东西——不写文档，也不写凭据。',
        readOnly: '对该配置档，设置页是只读的。',
      },
      fields: { provider: '供应商', modelId: '模型', empty: '尚未选择' },
      action: {
        save: '保存',
        applied: '已保存。',
        failed: '未能把这次改动发送到后端。',
        unsaved: '这次改动尚未保存。',
      },
      switchPlan: {
        title: '切换配置模式',
        movesNothing: '切换不会移动或覆盖任何文件。两种模式都让每个文件留在原处；改变的是从现在起由谁写入。',
      },
      changes: {
        'roots-are-injected': '引擎将以指向本应用自己配置档的 HOME 与 XDG 根目录启动。',
        'roots-are-the-users': '引擎将以你自己的环境启动，本应用不再注入根目录。',
        'host-starts-writing': '本应用开始写入该配置档的配置。',
        'host-stops-writing': '本应用停止写入该配置档的配置。',
        'credentials-move-to-the-engine': '该配置档的凭据改由引擎自己持有：本应用不再保存，也不再报告它们。',
      },
      sources: {
        title: '设置的来源',
        hint: '每一处真正生效的来源，也包括本应用没有设置的那些——它不能声称关掉了自己不拥有的搜索路径。',
        injected: '由本应用设置',
        engineDiscovery: '引擎自己的发现',
        discovery: {
          reused: '该配置档就是你自己的安装，引擎会照常读取它平时读取的一切。这里没有任何收窄。',
          project: '你打开的文件夹也会提供配置：该文件夹及其每一级上级目录里的 opencode.json 或 .opencode 目录都会合并进此配置档——包括供应商、权限规则等。本应用不关闭这一合并。',
          managed: '这台机器的受管配置目录 /etc/opencode 同样会合并进此配置档，系统管理员可能在其中放置了供应商、模型或权限规则。没有任何受支持的开关能关闭它。',
        },
      },
      credentials: {
        title: '凭据',
        hint: '这里只有名字。值从不发送到本页面，下面显示的占位符就是用来代替它的。',
        none: '该配置档没有保存任何凭据。',
        hostFile: '保存在本应用拥有的文件中：',
        notEncrypted: '那是一个仅有属主权限的普通文件。它没有加密，也不是系统钥匙串。',
        placeholder: '已保存值',
        form: {
          editHint: '填入新值即可替换，清空某一项即可删除该凭据。没有改动的项会原样保留。只有你在这里输入的内容会被发送，已保存的值不会被读回。',
          save: '保存凭据',
          saved: '已保存。',
          failed: '凭据没有保存成功。',
        },
      },
    },
  },
} as const
