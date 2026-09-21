/** The composer: prompt box, send/stop, context picker, attachments and the session config row. */
export const composer = {
  en: {
    composer: {
      placeholder: 'Ask the agent to do something in this folder',
      send: 'Send',
      stop: 'Stop',
      /* Shortened for the one-row composer bar (T16). Both facts stay: the reference editor's
         bar has no sentence because its left side carries attachment and search controls,
         which this app does not have - so the space holds what this app can honestly say
         instead of being emptied to look like a layout it cannot fill. The one control this
         app does have at that end is the `+` (`context` below), and it puts a path or the
         reader's own selected words in the message rather than an attachment in the turn. */
      hint: 'Enter sends. The engine works inside the folder you opened.',
      hintBusy: 'Enter cannot send while this turn is running — the text stays here.',
      /* The `+` at the left of the bar: what the message can be given, inserted into the
         message at the caret. Two kinds are offered — the files of the folder the engine works
         in, as vault-relative paths, and the passage the reader has selected in the editor, as
         its own words. Nothing here may say the model was SHOWN a file: a prompt is text, so a
         path is all a turn can carry, and the engine's own tools decide what to do with it. A
         folder cannot be inserted, only walked into, which is why there is no sentence for
         choosing one. */
      context: {
        add: 'Add a file from this folder, or the text you have selected, to the message',
        noFolder: 'No folder is open for the agent to read',
        list: 'Files in this folder',
        reading: 'Reading the folder…',
        empty: 'Nothing in this folder',
        up: 'Up one folder',
        /* Drawn only when the editor really holds a selection, and first in the list when it
           is: the reader who has just highlighted a passage is the one pressing this control.
           The wording names what the reader can see in front of them rather than "context", so
           that what the row will add is never in doubt. */
        selection: 'Add the text you have selected',
        unreadable: 'The folder could not be read: {detail}',
      },
      /* What the message is carrying beside its words: one chip per attachment, and the
         sentences for the two ways a control can be absent or a gesture refused.
         `attachOnly` is the state that is easiest to get wrong and the reason this block
         exists at all - an engine that reads embedded files and not images still gets a `+`
         and still gets its pasted screenshots refused, and a reader who was not told would
         believe the model had seen one. */
      attach: {
        strip: 'Attached to this message',
        /* The chip's own control: what pressing it takes away. Named with the attachment, so
           the tooltip is not one of a row of identical "Remove"s. */
        remove: 'Remove {name}',
        /* The chip's accessible name, for a reader who cannot see the file's icon. */
        label: '{name}, attached to this message',
        /* Why something the reader offered is not in the message. `{detail}` is the engine's
           own sentence about what its handshake reported, kept verbatim: this app's reading of
           the report would be a second account of a fact the engine already stated. */
        refused: '{name} was not attached: {detail}',
        unreported: '{name} was not attached: {detail}',
        /* The three refusals the message's own budget produces, and the one a file that could
           not be read produces. Same shape as the above: a refusal names what was left out. */
        tooMany: 'This message already holds the most attachments it can send ({max}).',
        tooLarge: '{name} is larger than the {max} one attachment may be.',
        noRoom: 'This message already holds {max} of attachments; {name} did not fit.',
        unreadable: '{name} could not be read, so there is nothing to send in it.',
        /* An image of a format this build attaches nothing of. `{formats}` is the allowlist
           itself, spelled from it rather than retyped, so the list a reader is asked to convert
           to cannot go stale. `unreadable` said this sentence's job once, about a file the app
           had imported itself: the bytes were there and the reason was the format, so the
           format is what is named now — with the one thing that does work, and the note that
           pasting and dropping read the same list (so it is not the way round it). */
        unsupportedImage: '{name} was not attached: this app attaches only the image formats it can read ({formats}), and this file is not one of them. Convert it to one of them and attach it again — pasting and dropping take the same list.',
        /* The one refusal that is not about this message: the shared intake's own budgets —
           how many files a paste may bring, how many bytes it may weigh, the session's running
           total — which are spent before the message is consulted at all. Said as the budget
           being spent rather than as a number, because the three caps it covers carry three
           different numbers and naming one of them would be wrong two times in three. */
        intake: '{name} was not attached: the composer’s paste budget is already spent.',
        /* The `@` menu: the same folder the `+` walks, opened by typing a note's name. Its
           four "nothing to show" states are separate sentences for the reason the `/` menu's
           are: a list still being read, a vault with no notes, a word that matches none and an
           index that could not be walked are four different things to do about it. */
        mention: {
          list: 'Notes in this folder',
          noMatch: 'No note in this folder matches',
          empty: 'This folder has no notes to name',
          reading: 'Reading the folder…',
          unreadable: 'The folder could not be listed, so no note can be named.',
          /* The field's own tooltip: how the `@` menu is learned about. There is no room for
             it in the composer's one-row hint, which is already the sentence that gets
             ellipsised first at the rail's narrow end - and a reference affordance nobody can
             find is the failure this line exists to avoid. `@` alone is punctuation to a
             screen reader, so the sentence spells the trigger out. */
          hint: "Type {'@'} to name a note in this folder",
        },
      },
      /* The bar's right-hand group: the options the session's engine reported, one control
         each. Every word the controls themselves show is the engine's — a value's name, an
         option's name, the order they arrive in — and this block is only what this app can
         say of its own: that the group is a group, why one control cannot be used, what the
         one option the handle carries without a name is called, and the picker's furniture. */
      config: {
        group: 'Session options',
        /* Drawn on a control whose option the engine reported and no call in this app's
           contract addresses: it is plainly unusable rather than looking usable and failing
           when it is pressed. */
        unavailable: 'This app cannot change this option yet.',
        /* A value that was chosen and did not take. The reason is the host's or the engine's
           own sentence, reported rather than summarised. */
        failed: 'The change did not take: {reason}',
        /* The control the session handle carries without a name: `projectModels` projects the
           model option's choices and keeps its id privately, so the engine's own word for the
           option never reaches this window. The *value* shown is still the engine's. */
        model: 'Model',
        picker: {
          /* Names the list for a screen reader, after the option's own name. */
          list: 'Choose from this option’s values',
          filter: 'Type to filter',
          noMatch: 'No value matches',
          /* What the engine said the option is set to, when it named no value at all. */
          unknown: 'Unknown',
        },
      },
    },
  },
  zh: {
    composer: {
      placeholder: '让智能体在这个文件夹里做点什么',
      send: '发送',
      stop: '停止',
      hint: '回车发送。引擎在你打开的文件夹内工作。',
      hintBusy: '本轮运行期间回车不会发送——文字会留在这里。',
      context: {
        add: '把这个文件夹里的文件、或你选中的文字加进消息',
        noFolder: '还没有打开可供智能体读取的文件夹',
        list: '这个文件夹里的文件',
        reading: '正在读取文件夹……',
        empty: '这个文件夹里没有内容',
        up: '上一级文件夹',
        selection: '加入你选中的文字',
        unreadable: '无法读取该文件夹：{detail}',
      },
      attach: {
        strip: '这条消息已附加',
        remove: '移除 {name}',
        label: '{name}，已附加到这条消息',
        refused: '{name} 没有附加：{detail}',
        unreported: '{name} 没有附加：{detail}',
        tooMany: '这条消息已经持有能发送的附件上限（{max}）。',
        tooLarge: '{name} 超过了单个附件允许的 {max}。',
        noRoom: '这条消息已持有 {max} 的附件，{name} 放不下。',
        unreadable: '无法读取 {name}，里面没有可发送的内容。',
        /* 本版本根本附加不了的图片格式。{formats} 就是那份允许清单本身，从清单拼出来而不是
           另抄一遍，免得让读者转格式的那份名单和真正拦下他的判据各说各话。这句话以前归
           unreadable 管，说的却是本应用自己刚导入的文件：字节一直在，原因是格式，所以现在
           点名的是格式——附带唯一管用的做法，并说明粘贴和拖入读的是同一份名单，省得读者
           再试一遍才知道。 */
        unsupportedImage: '{name} 没有附加：本应用只能附加自己读得了的图片格式（{formats}），这个文件不在其中。把它转成其中的一种再附加——粘贴和拖入读的是同一份名单。',
        /* 唯一一条不是在说这条消息的拒绝：共享入口自己的额度——一次粘贴能带几个文件、能有多
           重、本次会话累计多少——在这些问题上根本还没轮到这条消息。写成额度已用尽而不是写成
           一个数字，因为它覆盖的三个上限各自不同，写任何一个都会有三分之二是错的。 */
        intake: '{name} 没有附加：输入框这一轮粘贴的额度已经用完了。',
        mention: {
          list: '这个文件夹里的笔记',
          noMatch: '这里没有匹配的笔记',
          empty: '这个文件夹里没有可以点名的笔记',
          reading: '正在读取文件夹……',
          unreadable: '无法列出这个文件夹，因此没有笔记可以点名。',
          hint: "输入 {'@'} 点名这个文件夹里的笔记",
        },
      },
      config: {
        group: '会话选项',
        unavailable: '本应用还不能更改这个选项。',
        failed: '更改没有生效：{reason}',
        model: '模型',
        picker: {
          list: '从这个选项的值中选择',
          filter: '输入以筛选',
          noMatch: '没有匹配的值',
          unknown: '未知',
        },
      },
    },
  },
} as const
