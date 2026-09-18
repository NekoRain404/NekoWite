/** The agent panel's command menu — the list the engine publishes for a session. */
export const agent = {
  en: {
    agent: {
      commandMenu: {
        aria: 'Command suggestions',
        waiting: 'Waiting for this session to publish its commands',
        empty: 'This session has no commands',
        noMatch: 'No command matches',
        unavailable: 'The command list could not be received',
      },
      /* The panel's own copy (T16), beside the command menu's and the permission prompt's. The
         panel carries no sentence of its own, so every word it draws is read from here by the
         caller that mounts it (`src/app/AgentRailBody.vue`). `state`, `result` and `status` are
         keyed by the contract's own unions, so a state, a stop reason or a tool status added to
         `agent-contracts` without a sentence here is a typecheck failure rather than a blank. */
      panel: {
        notice: {
          gap: 'Part of this session’s record did not arrive, so what is below may be missing events.',
          resync: 'Reload the session',
          /* Frames that arrived and were refused by the reducer, which is a different thing from
             the hole above: a refusal is usually the *transport* re-sending what the view already
             has (`duplicate-sequence`, which is what a reload produces), so this sentence says
             what happened and names the reason rather than claiming content is missing. `{reason}`
             is the reducer's own word for the refusal and is not translated — a sentence per
             refusal would be this app explaining seven states only the reducer can tell apart.
             Phrased with the count after a noun so that one frame reads as well as twelve. */
          dropped: 'Frames this window refused for this session: {n} (last: {reason}).',
        },
        bar: {
          /* The title until the engine names the session. `{engine}` is the registration's own
             `displayName`, or the agent id when the registry has not answered: the engine's name
             is a fact the backend owns, so this sentence carries it rather than a constant. */
          untitled: 'New {engine} session',
          state: {
            idle: 'Idle',
            starting: 'Starting',
            ready: 'Ready',
            running: 'Working',
            waitingPermission: 'Waiting for you',
            completed: 'Finished',
            cancelled: 'Stopped',
            failed: 'Failed',
          },
          result: {
            endTurn: 'Answered',
            maxTokens: 'Stopped at the engine’s token ceiling',
            maxTurnRequests: 'Stopped at the engine’s request ceiling',
            refusal: 'The engine declined to continue',
            cancelled: 'Stopped before it finished',
            unrecognised: 'Ended for a reason this version does not know',
          },
          /* The one control §5.3 puts in this strip beyond the title. It is drawn only when the
             engine's own report says it answers `session/list` — see `AgentPanel` — so the words
             answer "what does pressing this show", not "what could it show in principle". */
          history: 'Sessions this engine holds',
          /* What the engine reported spending on the turn it last finished. Every counter is
             optional on the wire (P0 §6.3 measured the field set changing between two identical
             turns), so each sentence is drawn only for a number the engine actually sent: `total`
             when it sent one, `input`/`output` when it sent those instead, and nothing at all
             when it sent no usage. None of them is ever computed from the others — the engine's
             own total is not the sum of its parts. `detail` is the hover text, where the counters
             are named and exact rather than the rounded headline the strip has room for. */
          usage: {
            total: '{n} tokens',
            input: '{n} in',
            output: '{n} out',
            detail: {
              input: 'input {n}',
              output: 'output {n}',
              total: 'total {n}',
              thought: 'reasoning {n}',
              cachedRead: 'cache read {n}',
              cachedWrite: 'cache write {n}',
            },
          },
          /* The other half of the turn's stats: how long the turn took, as this window's own
             stopwatch measured it (`services/agent-turn-stats.ts` — the wire carries no
             duration). One arm per rung of Zed's own formatter (`duration_alt_display`,
             `crates/util/src/time.rs:3-15`), and the arm is chosen by which rungs are above
             zero, so `45s`, `2m 3s` and `1h 2m 3s` are three sentences rather than one with two
             empty slots. Nothing here rounds up: a wall clock that claimed a tenth of a second
             would be claiming a precision it does not have. */
          elapsed: {
            hours: '{h}h {m}m {s}s',
            minutes: '{m}m {s}s',
            seconds: '{s}s',
          },
        },
        /* The panel's options menu: the control in the bar and the box it opens, which carry the
           same name because they are one thing. `label` is the accessible name of both — the
           trigger's (`AgentSessionBar`) and the menu's (`AgentPanelMenu`) — so there is one place
           to write it and no way for the two to disagree.

           `settings` is the door the panel had none of: it is the only way to the agents tree
           that starts from the session whose engine is wrong. It is not `agent.settings....`'s
           section title reused, because what the row says is where the press goes, and the
           section's own title is what the page is called once you are there. */
        menu: {
          label: 'Agent options',
          settings: 'Agent settings',
        },
        /* The session history menu (T17): the rows an engine's `session/list` answer draws.
           Every row is the engine's own facts — its title, its folder, its last-activity stamp —
           and the sentences here are only what this app can say *of* them: which one is open,
           that one was recorded elsewhere, when one was last touched, and why there is nothing
           to show. `untitled` is deliberately a statement about the engine rather than a name
           for the session: a title this app invented for a session that had none would be a fact
           the engine never stated. */
        history: {
          list: 'Sessions',
          loading: 'Reading the sessions this engine holds...',
          empty: 'This engine holds no sessions.',
          unreadable: 'The engine’s sessions could not be read: {reason}',
          /* An engine that names a further page has not shown the whole table, and a list that
             read as complete would be the one answer worse than a short one. */
          more: 'This is the first page. The engine named more sessions after these.',
          /* The control the sentence above became. The sentence is the button's `title` —
             it explains why the list is short — and these are what the button says and does:
             an action while it can act, a state while the read is in flight, and the engine's
             own reason when the page could not be read. */
          moreLoad: {
            load: 'Read the next page',
            loading: 'Reading the next page...',
            failed: 'The next page could not be read: {reason}',
          },
          /* The find box over the rows. It narrows what the engine already sent and asks the
             engine nothing (`filterSessionRows`), which is why `noMatch` is a sentence about this
             search rather than about the engine's table: this app has not looked for such a
             session and must not say the engine holds none. */
          search: {
            label: 'Search these sessions',
            placeholder: 'Search these sessions...',
            clear: 'Clear the search',
            noMatch: 'No session matches',
          },
          /* The one entry in this list that is not a row: a new session on the same engine. The
             note is the consequence, and it is what a reader needs before pressing — the session
             they are in is neither replaced nor taken away by this. */
          newSession: {
            label: 'New session',
            note: 'Starts a new session on this engine. The one open now keeps running and stays in this list.',
          },
          untitled: 'The engine sent no title for this session',
          current: 'Open now',
          elsewhere: 'Recorded in another folder: {cwd}',
          age: {
            now: 'just now',
            minutes: '{n} min ago',
            hours: '{n} h ago',
            days: '{n} d ago',
          },
          /* The action on a row's engine record, and the whole of what this app says about it.
             **Nothing here may read as "delete".** The engine was measured keeping a closed
             session in its list (`agent_session_lifecycle_test.rs` §4.4) — removing one is
             `session/delete`, which the pinned engine answers `-32601` for — so the question says
             what is about to happen, the note says what will *not*, and the sentence after a
             success says why the row the reader is looking at is still there. A user who presses
             this and sees the row still present must not conclude it failed. */
          free: {
            label: 'Free this session on the engine',
            confirm: 'Free this session on the engine?',
            note: 'The engine stops serving it and cancels anything it was running. It keeps the session in its list: removing one is a different method this engine does not implement, so this row will still be here afterwards.',
            confirmAction: 'Free it',
            cancel: 'Keep it',
            done: 'The engine let it go. The row is still in this list — that is the engine’s answer, not a failure.',
            /* {reason} names its own refuser, and this lead-in must not name one for it. Two
               things can refuse here and they are different facts: the engine (its own sentence
               arrives, classified by the transport) and this app, which refuses a session it
               never opened before the engine is asked at all — that sentence names this app.
               It said 「The engine would not free it:」 and so blamed the engine for §6.1's
               boundary; the action is also no longer offered on rows this app cannot act on
               (see `AgentSessionHistoryMenu`), which leaves this arm for the engine and for the
               race where the host's table moved under the list. */
            failed: 'It was not freed: {reason}',
          },
        },
        /* The transcript's first line, drawn only while the transcript is empty. It names the
           engine and offers the one mechanism this panel really has: `/` opens the engine's own
           command list (T8). There is deliberately no `@` clause - `prompt()` takes no context
           slot and nothing in the composer triggers `@`, and a sentence about a feature that
           cannot be reached is the one thing this tree must not carry. */
        empty: {
          line: 'Message {engine} — / for commands',
        },
        timeline: {
          aria: 'Agent transcript',
          you: 'You',
          /* Names the list of files under the reader's own turn. The names in it are the files'
             own — a vault path or an image's name — so this is what says what the list IS: the
             engine's replay of a restored session carries no attachments, and a host row written
             before this feature existed records none, so the list appears only on a turn of this
             run whose send really carried something. */
          attached: 'Files attached to this message',
          thoughtOpen: 'Hide the reasoning',
          thoughtClosed: 'Show the reasoning',
          jump: 'Back to the end',
          /* The follow switch. Both sentences name the action the press will take rather than the
             state the control is in — `aria-pressed` says which state that is, and a tooltip that
             repeated it would leave a reader who has never used the control with no answer to the
             only question they have. `follow` names the switch for a screen reader while it is
             off, and stops being reachable the moment it is on (`followStop` takes over), so the
             accessible name is always the action. */
          follow: 'Follow the newest output',
          followStop: 'Stop following the newest output',
          /* The transcript's other three controls. Zed draws these under each message
             (`render_thread_controls`) and this panel draws one row for the whole log, so each
             sentence says *which* one it acts on: 「the newest answer」 and 「your last message」
             are the difference between a label and a guess. `copied` is the press landing, and
             `copyFailed` is the clipboard refusing — a reader who is not told would paste a
             stale buffer believing it was the answer. */
          copy: 'Copy the newest answer',
          copied: 'Copied',
          copyFailed: 'The answer could not be copied — the clipboard refused it',
          toUser: 'Go to your last message',
          toTop: 'Go to the beginning',
          /* The transcript's find box (Zed: `conversation_view/thread_search_bar.rs`, whose
             placeholder is "Search this thread…"). It searches the conversation on screen, so
             every sentence here is about *this* one — the history list's box beside it says
             "these sessions" for the same reason. `count` is the field's own answer to "where am
             I": the visible form is "3/5", which read aloud is two numbers, so the label says
             what they are. `noMatch` is the sentence that stands where the count would be, and it
             is deliberately not "0/0": the reader typed something and the honest answer is a
             sentence, not a zero. What the search does and does not cover is stated in
             `services/agent-conversation-search.ts`, and not here — a sentence about the scope of
             a find box in a 220px rail would be longer than the box. */
          search: {
            open: 'Find in this conversation',
            close: 'Close the search',
            label: 'Search this conversation',
            placeholder: 'Search this conversation…',
            previous: 'Previous match',
            next: 'Next match',
            clear: 'Clear the search',
            count: 'Match {index} of {total}',
            noMatch: 'No line of this conversation matches',
          },
          tool: {
            status: {
              pending: 'Queued',
              inProgress: 'Running',
              completed: 'Done',
              failed: 'Failed',
              cancelled: 'Cancelled',
            },
            expand: 'Show what this call carried',
            collapse: 'Hide it',
            args: 'Arguments',
            output: 'Output',
            argsAbsent: 'This call was made with no arguments',
            argsUnreadable: 'The engine sent arguments this app could not read',
            outputAbsent: 'This call produced no output',
            outputUnreadable: 'This call produced output this app could not read',
            /* The proposed change, and the four things about it this app must not round off.
               `added`/`removed` are counts this app derived by comparing the block's own two
               texts — ACP carries no hunks — so they are this app's arithmetic over the engine's
               data, and the sentences say what they are instead of implying the engine sent them.
               `identical` is drawn as a sentence rather than left as an empty row set: a call
               that asks to touch a file while proposing the same text on both sides is a fact the
               reader has to be told. `noOriginal` claims only what was received — the schema's
               own gloss for an absent original is "a new file", but that same field deserializes
               default-on-error, so an original this host could not read arrives identically, and
               this sentence is what a surface can say without choosing between the two. */
            diff: {
              label: 'Proposed change',
              added: '+{n}',
              removed: '−{n}',
              identical: 'The engine sent the same text on both sides, so this proposal changes nothing in this file.',
              noOriginal: 'The engine sent no original text for this file, so every line below is shown as added.',
              partial: 'This app compared the first {n} lines a side; the file continues past them and the change may too.',
              beyond: 'This app compared the first {n} lines a side and they contain no change — the two sides differ past them.',
              folded: '{n} unchanged lines',
              reveal: 'Show these {n} unchanged lines',
              undrawn: 'The engine attached content of a kind this version does not draw.',
            },
          },
        },
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
      /* The rail's own states, drawn by the shell around the panel: what it says while the
         engine is coming up, and what it offers when it did not. The two ways out are the
         rollback §12 asks for — ask again, or go back to the chat panel — and a refusal is shown
         in the backend's own sentence rather than summarised into one this file invented. */
      rail: {
        starting: 'Starting the agent engine...',
        noVault: 'The agent works inside one folder. Open a folder to use it.',
        refused: 'The agent engine could not be started.',
        retry: 'Try again',
        useChat: 'Back to the chat panel',
        unknownFailure: 'The request was refused without a reason this app could read.',
        stopFailed: 'The agent engine could not be stopped: {reason}',
        /* A session the user picked out of the engine's history and the engine would not hand
           back. The rail keeps the session that is open — a failed load is not a reason to take a
           live conversation off the screen — so this sentence is the only place the refusal can be
           read, and it carries the engine's own reason rather than a summary of it. */
        resumeFailed: 'The session could not be reopened: {reason}',
        /* And the same for a session that never existed: the engine would not open one while it
           was already serving another. Nothing was taken away by the attempt — the session the
           reader was in is still open and still on screen — so this sentence is the only place
           the refusal can be read. */
        newSessionFailed: 'A new session could not be opened: {reason}',
        /* The pet's click on a task, when this window cannot put that session on screen
           (`app/pet-task-link.ts` decides that; `AppShell.vue`'s `taskUnavailableSentence` words
           these). Four sentences rather than one, because each names a different fact and a reason
           that is only sometimes true is not a reason: the engine is not running at all, it is
           still coming up, it is running for another folder, or it is running for this task's own
           folder under another engine. A click may not *start* one — that is the decision these
           sentences exist to state — so the refusal is what the reader gets instead of a session
           they did not ask for. The first and the last name the folder, which the pet's row never
           showed. */
        taskUnavailable: {
          noRuntime: 'The session this task belongs to is not open in this window: no agent engine is running here for {vault}.',
          starting: 'The session this task belongs to is not open in this window yet: the agent engine is still starting. Click the task again in a moment.',
          elsewhere: 'The session this task belongs to is not open in this window: this window is running its agent for {showing} instead.',
          otherEngine: 'The session this task belongs to is not open in this window: the agent running here for that folder is {engine}.',
        },
      },
      permission: {
        argumentsPending: 'The engine has not sent the arguments yet',
        argumentsUnreadable: 'The engine sent arguments this app could not read',
        expired: 'No longer waiting — this request has already been resolved',
        /* Shown under the options, and only when the engine offered a lasting grant. The engine's
           own label for that option is "Always allow", which does not say how long: it is the one
           answer whose consequence is invisible afterwards, because the question stops arriving
           and this app is never told again. Measured — see the report.
           The three slots name where what the engine wrote is read back and taken back, and the
           names are the ones those places wear there: `settings.section.agents` on the settings
           rail, `agent.settings.permission.section.title` on the page, and
           `agent.settings.permission.grants.title` on the list itself. A sentence that denied that
           list existed shipped until the page landed — «this app … has no surface that lists or
           takes it back» — and a reader decides on this sentence, so it is drawn from the same
           catalogue the page is. */
        lastingGrant: '“Always allow” is not just this once. The engine stops asking about this tool and writes the grant down, so it outlives this session — and this app is never told again. What it wrote is listed in Settings, under {section} → {page}, in “{surface}”, and can be taken back there.',
      },
      registry: {
        section: {
          title: 'Agents',
          hint: 'Engines this app may start. A bundled engine is always here; other ACP agents are programs you point at and switch on yourself.',
        },
        list: {
          loading: 'Reading the registry...',
          unreadable: 'The registry could not be read from the backend.',
          retry: 'Try again',
          empty: 'No agents are registered.',
          adapter: 'Adapter',
          version: 'Reported version: {version} - reported, never acted on by this page.',
          versionUnknown: 'No version has been reported for this program yet.',
        },
        provenance: {
          bundled: 'Bundled with NekoWite',
          managed: 'Installed by NekoWite',
          external: 'Your own installation',
        },
        standing: {
          bundled: 'Shipped with the app. A file at this path was executable when it was checked, and that is all the check proves - a running engine is not sandboxed.',
          managed: 'Installed into this app’s own directory and pinned by it. Registered is not the same as sandboxed.',
          external: 'Not verified by NekoWite. Registration proves only that a program can be launched: it is not a sandbox, it keeps its own credentials, and it runs with your privileges.',
        },
        update: {
          hostManaged: 'Updates: the app may fetch and switch a new version of this program.',
          reportedOnly: 'Updates: NekoWite never replaces a program you installed. A newer version may be reported here, and nothing more.',
        },
        programState: {
          launchable: 'A file at {path} was executable when this was checked.',
          notAbsolute: '{path} is not an absolute path, so it is refused: a bare program name would be looked up in this app’s own working directory.',
          missing: 'There is no file at {path} now. The registration stays - restore or move the program, or remove the entry yourself.',
          notAFile: 'Something is at {path} and it is not a file.',
          notExecutable: 'The file at {path} has no executable bit, so it cannot be started.',
        },
        control: { enable: 'Switch on', disable: 'Switch off' },
        fields: {
          agentId: 'Id',
          displayName: 'Name',
          program: 'Program path (absolute)',
          args: 'Arguments',
          argsHint: 'One argument per line. A space inside a line stays inside that argument - this is never joined into a command line.',
          adapter: 'Adapter',
        },
        add: { title: 'Add a program', submit: 'Add', added: 'Added {agentId}.' },
        action: { failed: 'This change could not be sent to the backend.' },
        ownerUnknown: 'no engine yet',
        refusal: {
          id: '{value} cannot be an id: this app stores it and puts it in a path, so only letters, digits, dot, dash and underscore are allowed.',
          argument: 'Argument {index} contains a NUL byte, which no program can receive.',
          environment: 'The variable {name} cannot be given to a program.',
          unknownAdapter: 'No adapter answers to {adapterId}, so this engine’s differences would have no owner.',
          duplicateAgent: '{agentId} is already registered.',
          unknownAgent: 'No registration is called {agentId}.',
          profileUnbound: 'Profile {profileId} belongs to {owner}, and credentials, models and configuration are not moved between engines.',
          disabled: '{agentId} is switched off.',
          alreadyRunning: 'An engine is already running for {agentId} on this profile and library.',
          instanceRunning: 'A task is running on {agentId}. Stop it before switching the registration off.',
          isDefault: '{agentId} is the engine a new session starts on, so it cannot be switched off or removed.',
          launchFailed: 'The engine could not be started ({code}): {message}',
        },
        engine: {
          title: 'Engine for a new session',
          current: 'The open session is on {engine}.',
          none: 'No session is open.',
          choose: 'Engine',
          creates: 'A new session will be started on {engine}. The open session keeps its engine, its authorization and its history.',
          keeps: '{engine} is already the engine of the open session.',
          start: 'Start a new session on {engine}',
          /* Drawn when the caller has no gateway to open a session with: the same facts, and no
             select or button whose click nothing answers. */
          elsewhere: 'A new session is opened from the agent panel, which is where its engine is chosen. This page can register engines and switch them off; it has no session, and no gateway to open one with.',
        },
      },
      /* The ACP catalogue: what the public registry publishes, and the one thing this app does about
         it. Two rules run through every sentence here.

         **A listing is not a measurement.** What an engine can do is established by a handshake and
         a session negotiation, and a catalogue entry describes a program nobody has run — so no
         sentence here offers a feature, a capability or a slash command, and `unverified` says why.

         **Nothing is offered that cannot be done.** The registry publishes three distribution kinds
         and this app acts on one: a package manager's invocation, where the *manager* owns the
         artifact's provenance. The other two would make NekoWite the downloader, and §3.3's digest
         check has no anchor for an entry that arrives over a network (§3.3: 不能从同一不可信响应同时获取
         二进制和摘要便声称可信). So the archive arms state the reason and draw no control — the failure
         「不能让按钮看起来可用、点击后才发现不支持」. `gates.untransferable` carries which checks those are. */
      catalogue: {
        section: {
          title: 'Available agents',
          hint: 'Engines published in the Agent Client Protocol registry. This app reads the listing; it does not install anything from it.',
        },
        list: {
          loading: 'Reading the registry...',
          unreadable: 'The catalogue could not be read.',
          retry: 'Try again',
          empty: 'The registry listed no agents.',
          version: 'Listing v{version}',
        },
        freshness: {
          current: 'Read from the registry just now.',
          stale: 'This listing is out of date: {detail}',
          unavailable: 'The registry could not be reached: {detail}',
        },
        standing: {
          viaManager: 'Runs through {manager}. The package manager fetches and verifies it — this app does not, and records the result as your own installation.',
          archiveOnly: 'Only published as a download for {platform}. Using it would make NekoWite the downloader, which this app does not do: {reason}',
          unsupported: 'Published for {published} only, and not for this machine.',
          unrecognised: 'Published as {kinds}, which this app cannot read.',
        },
        /* What the registry never says, drawn on every row whatever its standing is. The rule is
           §3.4's capability row: only a handshake and a session negotiation establish these. */
        unverified: 'What this engine can do is not known from the registry. Features, slash commands and configuration are established by talking to it, after it is registered and started.',
        gates: {
          title: 'Why there is no install button',
          hint: 'Installing a third-party binary is a supply-chain decision. §3.3 requires a download to pass these checks first, and these are the ones a registry entry cannot support: {checks}',
        },
        action: {
          use: 'Use this program',
          used: 'Added {agentId}. Start it from the registry list above.',
        },
        defects: {
          title: 'This entry cannot be used',
        },
        license: 'Licence: {license}',
        licenseLink: 'Read the terms',
        repository: 'Source',
        website: 'Website',
      },
      /* The agent settings tree (T13), beside the panel's commandMenu/permission and the registry
         page's own keys. `origin` and `retry` are shared: they say "this app set it" and "try
         again", which are one fact each however many pages draw them. The sentences a page shows
         next to a *fact* — a path, a variable, an engine's own words — carry a slot name here and
         the page substitutes the value, because a path is data and does not go through a
         translator. */
      settings: {
        retry: 'Try again',
        origin: {
          host: 'Set by this app',
          engine: 'The engine’s own discovery',
          session: 'Published by the engine for this session',
        },
        runtime: {
          section: {
            title: 'Runtime',
            hint: 'What this app knows about the engine it starts: which program, from where, and which of its claims have actually been checked.',
          },
          loading: 'Reading the runtime...',
          unreadable: 'The runtime could not be read from the backend.',
          facts: {
            agent: 'Engine',
            source: 'Source',
            program: 'Program',
            version: 'Reported version',
            versionUnknown: 'not reported yet',
            adapter: 'Adapter',
          },
          provenance: {
            bundled: 'Bundled with NekoWite',
            managed: 'Installed by NekoWite',
            external: 'Your own installation',
          },
          /* The two states a read of the instance slot can be taken in. `starting` and `failed`
             are deliberately absent: the slot is filled only after a start has returned, so a start
             in flight is not a state anything can be read in, and a failed start answers its caller
             rather than leaving a state behind. Copy for an arm nothing can produce is a field the
             page would be asserting, which is the defect this page was rebuilt to remove. */
          process: {
            label: 'Process',
            stopped: 'Not running',
            ready: 'Running',
          },
          /* §3.1.4's own clause, and it needs no data: it exists to stop the process line above it
             being read as "a model will answer". It used to sit under `authorization`, beside a
             state nothing could answer — the sentence was the true half of that pair. */
          notAModel: 'A running process is a running process. It is not a model: nothing here means a prompt would be answered.',
          /* Drawn only when the handshake answered, which is the only time either sentence is
             true. The old pair drew `Not negotiated in this runtime` from a readout that had no
             handshake in it at all — a claim about the engine made without asking one. */
          protocol: {
            label: 'Protocol',
            version: 'Version',
            negotiated: 'Negotiated with the engine in this runtime',
          },
          /* What stands in for the protocol line and the capability list when there is no
             handshake. Two sentences for the backend's two ids, because they send a user to
             different places — an app that has not started an engine, and an engine running before
             its first session — and because the page could not tell them apart on its own: both
             read `Running` on the process line above. */
          notNegotiated: {
            noEngine: 'No engine is running, so nothing has been negotiated with one. The protocol version and the list below are both read off the handshake, and starting an engine for a folder is what performs it.',
            notYet: 'This engine is running and has not been asked yet. This app performs the handshake when it opens a session, and no session has been opened in this runtime.',
          },
          /* The engine's own advertisement, reported and not acted on. ACP has no
             "is-authenticated" field, and this app never calls `authenticate` — so a page that drew
             an authorization *state* would be inventing one, and a page that drew these methods as
             buttons would be offering a login nothing here can perform. The note under the list is
             what keeps the second from happening. */
          authorization: {
            label: 'Authentication the engine advertises',
            none: 'This engine advertised no authentication method in its handshake.',
            reportedNotUsed: 'Reported by the engine, and not acted on: this app never authenticates with an engine. The ways it can be authenticated are the engine’s own, and a credential for it lives in its profile rather than here.',
          },
          engineReport: {
            label: 'The engine’s own report',
          },
          capabilities: {
            title: 'What this engine reported',
            hint: 'The install declaration is only a start-time hint. Each line below is what this runtime’s handshake reported, or that nothing has been measured - which is not the same answer as "not supported". Three of the eleven are facts about a session response, so a page with no session reads them as not measured rather than as absent.',
            advertised: 'Advertised by this engine version',
            notAdvertised: 'This engine version does not advertise it',
            unverified: 'Not measured for this engine',
            /* The same three arms as short clauses, for the sentence that names both halves at
               once: the full sentence for the finding is already drawn on the line above it. */
            finding: {
              advertised: 'advertising it',
              notAdvertised: 'not advertising it',
              unverified: 'not measured',
            },
            /* The report's other half: what this build has on file about the engine version it was
               measured against. It is drawn only where it disagrees with the finding above it, and
               `disagrees` is the sentence that says so — which is the only place these three labels
               are read. The subject is spelled out in it because the failure this whole page
               refuses is a reader taking the file's claim for the engine's answer. */
            declared: {
              advertised: 'advertising this feature',
              notAdvertised: 'not advertising this feature',
              unverified: 'never having measured it',
              disagrees: 'Two claims, and they disagree: the engine version this build was measured against is on file as {declared}, and this runtime reported {finding}.',
            },
            /* A report that arrives with no rows at all. Drawn in place of the list, because a
               heading over an empty list reads as an answer — and the answer it reads as is "this
               engine can do nothing", which nobody gave. */
            empty: 'The backend answered with no capability rows. That is not the same answer as an engine that can do nothing: it is nothing having been reported for any feature.',
          },
          update: {
            label: 'Updates',
            hostManaged: 'This app may fetch and switch a new version of this program.',
            reportedOnly: 'NekoWite never replaces a program you installed. A newer version may be reported here, and nothing more.',
          },
        },
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
        /* The engine's own configuration document (`agent_config_document` /
           `agent_config_edit`). Four states with four sentences, because a user's next move is
           different in each: a document this app may write, a document that is not there yet and
           that saving a member creates, a document this app may not write, and a profile whose
           engine reads the user's own installation. The last two draw no form — a control that
           cannot work is not drawn — and the second draws the same form as the first, with its own
           sentence, because creating the engine's file is a bigger thing than changing a member of
           one and the user is told which they are doing. */
        config: {
          section: {
            title: 'Engine configuration',
            hint: 'The file the engine itself reads. NekoWite shows it as the engine wrote it and changes one member at a time, at the revision it read.',
          },
          loading: 'Reading the engine configuration…',
          unreadable: 'The engine configuration could not be read from the backend. That is a fact about this window, not about the file.',
          none: 'This profile reuses your own installation, so the engine reads that installation’s configuration. It is a file NekoWite did not write and does not open here; edit it where it lives, or switch this profile to app-managed above.',
          creates: 'This file is not on disk yet, so there is nothing here to preserve — no comments and no members of the engine’s. Saving a member below creates it, with that member as its whole content, and the engine reads it from then on.',
          readOnly: 'The document is there and this profile is one NekoWite does not write into, so it is shown and not edited.',
          document: {
            title: 'The document',
            path: 'File',
            exists: 'On disk.',
            absent: 'Not written yet.',
            text: 'No text was returned for this document.',
            textHint: 'Shown as written, comments and all. Nothing here parses it — an edit names one member and its value, and every other byte of the file is left alone.',
          },
          edit: {
            title: 'Set a member',
            hint: 'One member of this document, at the revision that was just read. If the file changed since then, the change is refused rather than merged.',
            member: 'Member',
            memberHint: 'The member’s name at the document’s root, exactly as the engine spells it. One name, not a dotted path — a key containing a dot is a key like any other.',
            value: 'Value',
            valueHint: 'A JSON value: a string needs its quotes, an object its braces. This is the only thing here that is parsed as JSON.',
            save: 'Apply',
            noMember: 'A member has to be named.',
            invalidValue: 'That is not a JSON value.',
            applied: 'Applied.',
            conflict: 'The file changed since this page read it. Nothing was written — the document above has been reloaded, so what is on screen is what is there.',
            conflictCreated: 'Something else created this file between this page reading the folder and this save. Nothing was written — what is above is the file that is there now, and it is not this app’s.',
            failed: 'This change could not be sent to the backend.',
          },
          /* The structured half of the same page: a provider block, built from fields rather than
             typed as JSONC. The sentences are long on purpose where a user is about to write into a
             file this app only splices — what is written, and exactly which bytes are left alone. */
          provider: {
            title: 'Add a provider',
            hint: 'Writes one block into this document, under the provider id you give it: the address the engine calls, the models it may use, and a reference to a key rather than the key itself. Everything else in the file — the other providers, the comments, the members this app has never heard of — is left byte for byte.',
            id: 'Provider id',
            idHint: 'Letters, digits, dots, dashes and underscores. It is the block’s name in the file and part of the name the key is stored under: {name}.',
            name: 'Name',
            nameHint: 'What the engine calls this provider. Blank uses the id.',
            baseUrl: 'Base URL',
            baseUrlHint: 'The engine appends /models and its request path to this. No trailing slash is needed.',
            key: 'API key',
            /* `{'{'}` is a literal brace to the message compiler — the reference is written into a
               configuration file and has to be shown as it is written there, not as a placeholder. */
            keyHint: 'Stored in this profile’s credential file (mode 0600), never in the document: the block carries {\'{\'}env:…{\'}\'} and the engine reads the value from the environment this app starts it with.',
            keyTyped: 'Saving stores this value, replacing whatever is stored now, and the block names it.',
            keyStored: 'A key is stored under {name}. Its value is not shown on this page and is not sent to it, and the block keeps naming it: saving changes nothing about the key.',
            keyNone: 'No key is stored for this provider and none was typed, so the block will name none and requests to it go out unauthenticated. That is what an endpoint on your own machine wants; type a value to store one.',
            keyUnread: 'The keys this profile stores could not be read, and whether the block names one depends on that, so nothing will be written until the read lands. The read is what tells a key that is stored from a key that was never set.',
            keyRetry: 'Read them again',
            keyRemove: 'Remove the stored key',
            keyKeep: 'Keep the stored key',
            keyRemoving: 'Saving removes the key stored under {name} and writes a block that names none.',
            allowPrivate: 'Allow a local or private address for the fetch',
            allowPrivateHint: 'The fetch is this app making the request, and it refuses a loopback or private address by default. The engine is not bound by that — it talks to whatever the block says.',
            fetch: 'Fetch models',
            fetching: 'Asking the endpoint…',
            fetched: '{n} models listed by the endpoint.',
            fetchNeedsKey: 'The list is fetched with the key in the field above, so it has to be there first. With the field empty, the request would go out with the key this app has stored for its own AI provider — or with none at all — and the answer would be about an address reached with a credential the engine never uses.',
            fetchFailed: 'The endpoint could not be reached.',
            models: 'Models',
            modelsEmpty: 'No models yet. Fetch them from the endpoint, or type an id below.',
            modelHint: 'Ticked ids become the models the engine has for this provider. A model the endpoint lists but this block does not declare is one the engine cannot use.',
            manual: 'A model id that was not listed',
            manualAdd: 'Add',
            preview: 'What this saves',
            previewHint: 'The value of provider.{id}, exactly as it is written. What this page shows is what is sent — nothing is added to it afterwards.',
            save: 'Save provider',
            replaces: 'Saving with an id the file already has replaces that provider’s block — the other providers, and every comment around them, are still left alone.',
            problem: 'Nothing was written: {reason}',
            credentialFailed: 'The key could not be stored, so nothing was written to the document either. {reason}',
            removalFailed: 'The block was written and no longer names the key, but the stored key could not be removed. {reason}',
            editFailed: 'The provider could not be written to the document. {reason}',
            applied: 'The provider was written.',
            conflict: 'The file changed since this page read it, so nothing was written. Reload and save again.',
            conflictCreated: 'Something else created this file first, so nothing was written. What is above is the file that is there now.',
          },
        },
        skills: {
          section: {
            title: 'Skills',
            hint: 'Skill folders the engine finds, where each one comes from, and what this app may do about it.',
          },
          loading: 'Reading skills...',
          unreadable: 'The skill list could not be read from the backend.',
          list: {
            empty: 'The engine finds no skills in any directory it reads.',
            emptyScope: 'The engine finds no skills in this directory.',
            scope: 'Scope',
            directory: 'Directory',
            noDescription: 'no description',
          },
          unmanaged: {
            title: 'Not managed here',
            project: 'A project’s own skills are not listed, and it is not because they are missing: the engine reads `.opencode/skills` from the folder a session runs in. This dialog is about an engine profile rather than about a folder — it opens with or without a vault, and which project a page like this should manage is not something it can answer — so no project is drawn and nothing here switches one off. Open the project and the engine reads its skills as it always did.',
            declared: 'Folders the engine’s own configuration declares (`skills.paths`) are not listed either: that member lives in a document this page does not read, and a second parser for it would be a second answer about the same file. A skill reachable only through one is installed and working — it is simply not in this list.',
          },
          owner: {
            managed: 'This app owns this directory',
            engine: 'The engine discovered it',
            foreign: 'Another tool’s directory',
          },
          surface: {
            offered: 'The engine reads it and will offer it to the model.',
            undescribed: 'It has no description, so the engine filters it out and never surfaces it. It is installed and inert until one is added.',
            suppressed: 'The engine is not reading this directory at all: the switch {variable} is set in its environment.',
            unusable: 'The engine cannot use it: {reason}',
            disabled: 'Switched off by this app. It is stored outside every directory the engine reads.',
          },
          conflict: 'The same name is also defined at {directories}. Both are loaded, and which one wins is not determined by anything shown here - remove one of them.',
          disable: {
            label: 'Enabled',
            enable: 'Switch on',
            disable: 'Switch off',
            noSwitch: 'There is no switch this app can throw for this directory. Any control here would only hide the row, so there is none.',
            engineSwitch: 'Only the engine can stop reading this directory: it skips it when {variable} is set in its own environment. This launch does not set that variable.',
            engineSwitchSet: 'There is no control here: {variable} belongs to the environment the engine is launched in, and this launch sets it. The row above is what that means for this skill; it is not a setting this page can change.',
          },
          disabledList: {
            title: 'Switched off',
            hint: 'Kept in this app’s own store, outside every directory the engine scans. Switching one on puts it back where the engine reads.',
          },
          import: {
            title: 'Import a skill folder',
            hint: 'A folder containing SKILL.md. It is read first and installed second; nothing in it is ever run by this app.',
            target: 'Installed into',
            noTarget: 'There is nothing here to import into. An import installs into a directory this app owns, and this profile has none: every directory the engine reads for it is one this app does not write in. A profile this app manages has one of its own, and that is where an import would land.',
            source: 'Folder path',
            preview: 'Read it',
            confirm: 'Import',
            replace: 'Import and replace the existing copy',
            replaceWarning: 'A skill with this name is already installed. Importing over it moves the existing folder into this app’s store first, so the copy that is there now stays recoverable.',
            done: 'Imported {name}.',
            failed: 'The import could not be sent to the backend.',
          },
          preview: {
            title: 'What would be installed',
            description: 'Description',
            files: 'Files',
            scripts: 'Scripts and data',
            noScripts: 'Nothing but SKILL.md. There is no script to run.',
            total: 'Total',
            nothingRun: 'None of this has been run. The list is what the folder contains, and importing it copies those bytes without executing anything.',
          },
          refusal: {
            'relative-path': 'That is not an absolute path, so it would be resolved against this app’s own working directory rather than where you meant.',
            'store-inside-scope': 'This app’s store for switched-off skills is inside a directory the engine scans, so a switched-off skill would still be found. It refuses to run that way.',
            'unknown-scope': 'No directory this engine reads is called `{scope}`.',
            'not-managed': 'This app does not own that directory, so it will not write in it. Only its own profile directory can be imported into.',
            'no-switch': 'There is no switch for that directory that would change what the engine reads, so the change was refused rather than pretended.',
            'outside-scope': 'That skill is not inside the directory it claims to be in, so nothing was moved.',
            'escapes-scope': 'This entry is a link whose target leaves the directory it was found in: {directory}. The engine would read the target, so the entry is shown as unusable rather than hidden.',
            missing: 'There is no file at {path}.',
            'no-manifest': 'There is no SKILL.md at {path}, so there is nothing the engine would read.',
            symlink: 'The folder contains a symbolic link ({path}). A link points somewhere that is not part of the folder being imported, so the import was refused.',
            'not-a-file': '{path} is neither a file nor a directory.',
            'too-many-files': 'This skill has more files than this app will import at once.',
            'file-too-large': 'One file is larger than this app will import: {path}',
            'skill-too-large': 'This skill is larger in total than this app will import.',
            'no-frontmatter': 'SKILL.md does not start with a frontmatter block, so the engine would not read a name from it.',
            'unterminated-frontmatter': 'The frontmatter block in SKILL.md is never closed.',
            'frontmatter-line': 'A line of the frontmatter could not be read: {message}',
            'name-missing': 'SKILL.md declares no name, and the engine requires one.',
            'name-shape': '`{name}` is not a skill name. The engine wants lowercase words joined by hyphens, at most 64 bytes, matching the folder.',
            'name-mismatch': 'The frontmatter says `{name}` and the folder is `{folder}`. The engine refuses a skill where those disagree.',
            'description-missing': 'SKILL.md declares no description. The engine drops skills without one and never surfaces them, so installing this would add something that could never work.',
            'description-too-long': 'The description is longer than the engine’s limit of 1024 characters.',
            'field-control': '`{key}` contains a control character, which no page and no log line can hold.',
            'name-taken': 'A skill called `{name}` is already installed at {directory}.',
            'no-such-skill': 'There is no skill called `{name}` in `{scope}` any more. It was read a moment ago and it is not there now — a rename, a removal, or another window — so nothing was moved. Reload the list and try again.',
            'store-occupied': 'A copy with that name is already in this app’s store, and it would be overwritten.',
            'same-directory': 'That folder is already where it would be installed.',
            'scan-too-large': 'The scan of that directory did not finish, so its answer would have been a partial one.',
            io: 'The filesystem refused: {message}',
          },
        },
        commands: {
          section: {
            title: 'Commands',
            hint: 'Where every command comes from. This app publishes none of the engine’s commands and re-implements none of them.',
          },
          loading: 'Reading the command list...',
          unreadable: 'The command list could not be read from the backend.',
          session: {
            title: 'From this session',
            none: 'This session has not published a command list yet. It arrives as a notification after a session starts, not with the session itself.',
            session: 'Session',
            published: 'published by the engine',
            description: 'Description',
          },
          sources: {
            title: 'Read by the engine, from files',
            hint: 'The engine discovers these itself. This app shows what it found and does not interpret a template or re-run a command.',
            empty: 'No command files were found.',
            commands: 'Commands',
          },
          app: {
            title: 'This app’s own commands',
            hint: 'Insert selection, open changes and the rest live in their own panel and never take the engine’s slash namespace, so a command name cannot collide with the engine’s.',
          },
          limits: {
            title: 'What is not available',
            undoRedo: 'Undo and redo are not part of ACP and this engine does not offer them over it. This app does not simulate them by deleting its own transcripts.',
            unpublished: 'A command the engine has not published is not offered here. Running one through a native terminal entry point shows the engine’s own error rather than a success this app invented.',
            parameters: 'A command is called by sending its name and arguments as a prompt. There is no form for a command’s arguments here, because the protocol does not describe one.',
            unnamed: 'A command with no description is listed by name only. This app does not write one for it.',
          },
        },
        mcp: {
          section: {
            title: 'MCP servers',
            hint: 'Servers the engine connects to, where each one is configured, and what starting one would mean.',
          },
          loading: 'Reading the MCP configuration...',
          unreadable: 'The MCP configuration could not be read from the backend.',
          list: {
            empty: 'No MCP servers are configured for this profile.',
            name: 'Server',
            transport: 'Transport',
            state: 'State',
            on: 'On',
            off: 'Switched off in the configuration',
            command: 'Program',
          },
          transport: { local: 'Local program', http: 'HTTP', sse: 'Server-sent events' },
          credentials: {
            label: 'Credentials',
            none: 'none configured',
            namesOnly: 'Names only. A value is never sent to this page.',
          },
          diagnostic: { label: 'Last diagnostic', none: 'nothing reported' },
          capabilities: {
            title: 'What this engine advertised',
            hint: 'From the handshake, for this engine version. An unadvertised transport is named as such rather than hidden.',
            advertised: 'Advertised',
            notAdvertised: 'Not advertised by this engine version',
          },
          trust: 'Starting this server runs a program. The engine starts it; this app neither starts it nor sandboxes it, and a configured server is not a trusted one. Enable it only if you would run that command yourself.',
          doesNotStart: 'This page reports and writes nothing. Servers are started by the engine when it opens a session, so there is no control here to start one.',
        },
        permission: {
          section: {
            title: 'Permissions',
            hint: 'What the engine asks about, where those settings come from, and what this app does not promise about them.',
          },
          loading: 'Reading the permission configuration...',
          unreadable: 'The permission configuration could not be read from the backend.',
          /* One per state of the consent default. The second and third are the ones a user most
             needs said out loud, because both are profiles where the list below is empty and the
             engine may ask anything — an empty list that reads as "nothing to see" is the one
             answer worse than no page. */
          states: {
            written: 'This app wrote the rules below into the engine’s own configuration, so the engine asks before it changes your files or runs a command.',
            engineOwn: 'The engine’s own configuration already carries permission rules, so this app wrote none and does not override them. What those rules ask about cannot be read from here; the document below is where they are.',
            notThisHost: 'This profile reuses your own engine installation, so this app wrote no permission rules for it and cannot say what the engine will ask.',
          },
          rules: {
            title: 'What the engine asks about',
            empty: 'This profile has no rules from this app to show. That is not the same as the engine asking nothing: for a profile reusing your own installation, or one whose configuration carries its own rules, what the engine asks is not this app’s to report.',
            tool: 'Tool',
            action: 'Action',
          },
          options: {
            title: 'What a request can answer',
            hint: 'These are the engine’s own option kinds, as they arrive with a request. Each request carries its own options, and the prompt renders those rather than a list kept here.',
            none: 'This page never lists them: the options arrive with each request, and the prompt renders what that request carried.',
            noInvention: 'This app adds no option of its own. If the engine does not offer a permanent allow, there is no permanent allow to give.',
          },
          limits: {
            title: 'What this does not mean',
            notASandbox: 'ACP is not a sandbox. The working directory, this app’s file allow-list and a prompt that says "only this library" do not constrain the engine’s own shell, plugins, MCP servers or network access. The honest description of this integration is an agent inside a workspace you trust.',
            noIsolation: 'No Linux sandbox has been built or verified for this integration, so nothing here is isolated. A page or a prompt claiming otherwise would be describing a feature that does not exist.',
            staleRequests: 'A request belongs to one runtime, library, session and run. Answering a request that has already been resolved, or that belongs to a session that has ended, is refused rather than applied to whatever is in front of the user now.',
            noSilentApproval: 'A dangerous request that is never answered is never approved. Waiting is not consent, and nothing here grants a permission because a prompt was left alone.',
          },
          /* The grants the user actually gave. `unsupported` and `notRunning` are separate
             sentences on purpose: either one drawn as an empty list would be this page claiming
             "you have granted nothing" from a question it never managed to ask. */
          grants: {
            title: 'Lasting permissions you have given',
            hint: 'Each row is one "Always allow" you answered. The engine wrote it down itself, keyed by the tool it covers, what that answer applies to, and the engine’s own project key — so it outlives the session you gave it in and the engine stops asking. This list is the engine’s, read from the engine; revoking asks the engine to drop the row, and it asks again from the next tool call on.',
            loading: 'Reading the engine’s saved permissions...',
            unreadable: 'The engine was asked for its saved permissions and did not answer. Nothing is being claimed about them here — try again, or check that the agent is still running.',
            unsupported: 'This agent does not report the permissions it has written down, so this page cannot list or revoke them. That is not the same as having given none: nothing here has asked.',
            notRunning: 'No agent is running, so there is nothing to ask. Start a session and this list is read from the engine itself — a profile’s saved permissions live in the engine’s own database, not in this app.',
            empty: 'The engine holds no lasting permission for this profile. This is the engine’s own answer, not an empty list standing in for one it could not give.',
            project: 'Project',
            revoke: 'Revoke',
            revoking: 'Revoking...',
            failed: 'The engine did not remove it:',
          },
        },
        /* The tree's own page (T16): the one control that reaches the shell — which panel the
           right rail shows — and the statements for the parts of this tree that have no host
           half yet. Every absence below is named with what it is and what it would take,
           because a page that drew a control it cannot carry out would be the one claim this
           feature must not make (§13's rule the registry and pet-integration pages follow). */
        agents: {
          section: {
            title: 'Agents',
            hint: 'Which panel the right rail shows, the engines this app may start and the profile of the one it starts, and what this build cannot do with an engine yet.',
          },
          panel: {
            label: 'Show the agent panel in the right rail',
            hint: 'Off, the rail keeps the chat panel it has always had. On, the rail shows the agent panel for the folder this app has open instead — the chat panel is unmounted, so a reply still streaming is cancelled, and switching this off is how you get it back.',
          },
          /* The pair the mounted pages are about, stated on the page: the registry readout is the
             only thing that pairs a profile with an engine, so when it cannot be read the profile
             page is not drawn — and that absence is said here rather than left as a gap. */
          profile: {
            showing: 'The pages below are about {agent} and its profile {profile}.',
            unknown: 'The engine registry could not be read, so the profile of the engine this app starts is not shown here. The registry above says why.',
          },
          /* One sentence per section that is not mounted: the section derives these from
             `AGENT_SETTINGS_SECTIONS`, so a page whose client lands and stops being absent takes
             its sentence out of this block rather than leaving a claim that went stale. `other` is
             what a newly listed section says before it has a sentence of its own — the row is never
             blank, and the key is never unreachable. */
          gaps: {
            title: 'Not connected in this build',
            intro: 'Each of these would be a page of its own. The half it needs is missing, and a control that can only fail is not drawn:',
            /* `runtime` and `capabilities` were rows here, and both were removed by the same
               change that mounted §3.1.4's page. They said the state of a running engine was
               answered nowhere and that a capability report needed a session — and both halves
               stopped being true when `agent_runtime_read` landed: ACP makes `initialize` a
               connection's first request, so the negotiated half belongs to the incarnation, and a
               settings dialog has the incarnation without ever having a session. A gap sentence has
               a shelf life of about one commit; these two reached it. */
            commands: 'Commands — the list an engine publishes for a session. It reaches the agent panel as it arrives and belongs to that one session, and there is no read of it a settings page can make.',
            mcp: 'MCP servers — the list, the configuration and the transports. Nothing was built for MCP in this build at all.',
            engine: 'Choosing the engine a new session starts on. Engines can be added and switched off above, but a session always starts on the default one: the backend’s start call takes a folder and nothing else, so nothing in this window opens a session on another engine yet.',
            other: 'This section needs a host half this build does not have.',
          },
        },
      },
      /* What the editor pane owes the reader about what the agent produced for the note it has
         open. The surface these words belong to is mounted inside the editor pane, so every
         sentence here answers a question the reader is asking with their own paragraph in front
         of them: what did the agent produce, what does applying it do to MY text, and what
         happened after I chose. `conflict` is the copy `AgentEditConflictView` draws; the words
         live here rather than inside that component because a surface that carried its own
         sentences could not be mounted in a Chinese window without shipping English ones. */
      note: {
        title: 'What the agent proposes for this note',
        /* An unwritten proposal is the whole subject of this block: §7.2 gives it the verbs
           apply/discard, and the sentence says so before the reader presses anything, because
           "did it already do this?" is the question a change that has not landed raises. */
        unwritten: 'Nothing has been written yet. Applying it puts the agent’s version in this note; keeping yours leaves the note untouched.',
        edit: {
          row: 'The agent produced a version of {path}',
          apply: 'Use the agent’s version',
          discard: 'Keep mine',
        },
        /* What became of the answer. Three facts, told apart on purpose: the text is in the note
           and on the file, the text is in the note and the file does not have it, and nothing was
           written. Folding the second into the first is how a user finds out on their next
           restart that a paragraph only ever existed in this window. */
        outcome: {
          saved: 'The agent’s version is in the note, and the file has it.',
          saveFailed: 'The agent’s version is in the note, but the file does not have it. Saving the note again will write it.',
          discarded: 'Nothing was written. The note is as you left it.',
        },
        /* Why nothing was written. Codes in, sentences out — the same arrangement the change
           review uses, and for the same reason: the service returns a reason and this is the one
           layer that owns the language. */
        refused: {
          noteNotOpen: 'No tab holds this note any more, so there is nothing to write into.',
          targetChanged: 'The editor answered about a different note than the one asked about, so nothing was written.',
          vaultMismatch: 'This note belongs to another vault than the session the answer was produced under.',
          identityChanged: 'The session that produced this answer is not the session this window is on any more.',
          writeUnavailable: 'Nothing can take the text: the pane that owns this note is not available.',
        },
        conflict: {
          title: 'This note changed while the agent was working',
          moved: 'was edited after the request went out',
          agentText: 'What the agent produced',
          noteText: 'What the note holds now',
          apply: 'Use the agent’s version',
          discard: 'Keep my version',
          kept: 'Your text is handed back to the window either way: applying replaces it in the note, and nothing else holds a copy.',
        },
        /* §7.3's insertion: the SVG the run staged for this note, verified before anything is
           drawn. `where` says the spot out loud — an image placed at the end of a document rather
           than at the caret is a decision, and a reader who was not told would think the app had
           put it where they were looking. */
        svg: {
          row: 'The agent produced {name} for this note',
          verified: 'Verified preview. The file is copied into this vault as it is; what is below is what the checks allowed.',
          where: 'It will be placed at the end of this note.',
          name: 'File name',
          insert: 'Put it in this note',
          discard: 'Leave it out',
          previewAlt: 'Preview of {name}',
          /* Why the artifact may not be previewed. Codes in, sentences out: each names the thing
             that is wrong rather than echoing the value that was refused, which would only put the
             hostile string in front of the reader. */
          unreadable: 'The file the agent wrote could not be read, so nothing is offered for it.',
          refused: {
            notSvg: 'That file is not an SVG.',
            tooLarge: 'That file is larger than this app will parse ({size} of {limit} bytes).',
            incompleteRead: 'That file is still being written: it declares {size} bytes and {read} were read.',
            declaration: 'That file carries a {kind} declaration, which this app does not hand to a parser.',
            malformed: 'That file is not well-formed XML.',
            tooComplex: 'That file has more elements ({elements}) than this app will walk ({limit}).',
            tooDeep: 'That file nests deeper ({depth}) than this app will descend ({limit}).',
            foreignNamespace: '{element} belongs to another XML vocabulary ({namespace}).',
            unsafeElement: '{element} is not on the list of elements this app renders.',
            unsafeAttribute: '{element} carries {attribute}, which this app does not render.',
            externalReference: '{element} points at {attribute}, which would make the preview fetch something.',
          },
          /* Why nothing was placed. The first is the ordinary case and says the whole of it: the
             note is untouched. The rest name what has to change before it can be. */
          outcome: {
            inserted: 'The image is in this note and the file is in the vault.',
            moveFailed: 'The image was not copied into the vault, so the note was left alone.',
            moveElsewhere: 'The vault named the file {saved} rather than {planned}, so the note was left alone.',
            noteWriteFailed: 'The image is in the vault, but the note could not be saved with the link in it.',
            noteNotOpen: 'No tab holds this note any more, so there was nowhere to put it.',
            targetChanged: 'The editor answered about a different note than the one asked about.',
            vaultMismatch: 'This note belongs to another vault than the session the plan was made under.',
            anchorOutOfRange: 'The spot this was being placed at is not in the note.',
            identityChanged: 'The session that produced this artifact is not the session this window is on any more.',
            revisionChanged: 'The note was edited while the image was being placed. Nothing was inserted.',
            anchorMoved: 'The text at the spot this was being placed at changed. Nothing was inserted.',
            invalidFileName: 'That is not a usable file name.',
            nameUnavailable: 'That name is taken in this folder, and no free variant of it was found.',
            attachmentNotSaved: 'The file is not in the vault, so the note was left alone.',
          },
        },
      },
      /* The run's changed files, and the three answers about them. Every sentence here is about a
         fact the review service decided: `agent-change-review.ts` returns codes, and this is the one
         layer that owns the language. The refusals each name a different thing to do, which is why
         they are not one sentence. */
      changes: {
        title: 'What this run changed',
        empty: 'Nothing has changed yet.',
        /* One line for the whole list, and it is what a collapsed strip still shows. The counts are
           filled in by the caller, which is the layer that can count the rows it drew. */
        summary: '{files} changed · {kept} kept · {putBack} put back · {toReview} to review',
        collapse: 'Hide the list',
        expand: 'Show the list',
        attribution: {
          agent: 'A tool call of this session wrote this file',
          external: 'This file changed on disk, and nothing in this session claims it',
          reported: 'The engine named this file; no call and no disk change confirmed it',
        },
        verdict: {
          followsDisk: 'No unsaved edits in this note',
          unsavedEdits: 'This note has unsaved edits',
        },
        offer: {
          view: 'Review',
          keep: 'Keep',
          recover: 'Reject',
        },
        /* Why a rejection is not on the row. Codes in, sentences out — the same arrangement the
           note proposals use, and for the same reason: a code the user cannot read would leave them
           believing the write happened. */
        refused: {
          notAgentChange: 'Nothing here recorded a change to put back.',
          writeInFlight: 'The agent is still writing this file.',
          noBaseline: 'No request named this file, so the version to put back was never kept.',
          vaultMismatch: 'This note belongs to another vault than the session that changed it.',
          unsavedEdits: 'This note has unsaved edits. Both texts are below; the note’s own keep-or-reload prompt is where they are settled.',
          resultUnstated: 'The call did not say what it left in this file, so there is nothing to check the note against.',
          changedSince: 'This note is no longer what the agent left: it was edited after the change.',
        },
        decision: {
          kept: 'Kept',
          rejected: 'Put back',
        },
        written: {
          saved: 'The note is back and the file has it.',
          saveFailed: 'The note is back, but the file does not have it. Saving the note again will write it.',
          unavailable: 'Nothing took the text: the pane that owns this note is not available.',
        },
        /* What the HOST's own recovery answered, for a note no tab holds. A second copy tree beside
           `written` rather than a reuse of it, because the two writers answer different questions:
           the note's save says what became of the buffer, and this says what the host did with the
           file — and every sentence below is about the file alone. */
        recovered: {
          recovered: 'The file is back at the version the request was made against, and the version it replaced was kept in the note’s history.',
          warning: 'The version it replaced could not be kept in the history.',
          refused: {
            noBaseline: 'This host did not perform that write, so it holds no version to put back.',
            baselineStale: 'The file moved between the version this host recorded and the agent’s write, so the text it holds is not the one to restore.',
            unavailable: 'The file could not be read where the change should be: it was deleted, renamed, or is not text this app can read.',
            changedSinceRecorded: 'The file is no longer what the agent left: it was edited after the change. Putting the version back would take that edit away.',
            alreadyAtBaseline: 'The file already holds the version to put back, so there is nothing to do.',
            writeRefused: 'The app’s own save refused it: a read-only file, a path that left the vault, or a file that is not text.',
          },
          unreachable: 'The host could not be asked:',
        },
        unsavedBuffer: 'Your unsaved text',
        /* The file's text as the call said it left it — shown beside the user's when the buffer has
           unsaved edits, because that is the one case where the file's own text is not on screen. */
        agentVersion: 'What the call left in the file',
        /* The other arm of that block, and the honest one: the call stated no text for this file,
           so there is nothing to put beside the user's own. An empty block would read as an empty
           file the agent had in fact changed. */
        diskUnread: 'No text for this file is recorded here, so only your unsaved text is shown.',
      },
    },
  },
  zh: {
    agent: {
      commandMenu: {
        aria: '命令建议',
        waiting: '正在等待本会话公布命令',
        empty: '本会话没有可用命令',
        noMatch: '没有匹配的命令',
        unavailable: '未能收到命令列表',
      },
      panel: {
        notice: {
          gap: '本会话的记录缺了一段，下面的内容可能缺少事件。',
          resync: '重新载入会话',
          /* 到达但被 reducer 拒收的帧，和上面那个洞不是一回事：拒收通常是因为传输层把本视图已有的
             帧又送了一遍（`duplicate-sequence`，也就是点一次重新载入会产生的那些），所以这句话只
             说发生了什么并给出原因，而不会宣称内容有缺失。`{reason}` 是 reducer 自己的词，不翻译
             ——为七种只有 reducer 分得清的状态各写一句话，等于本应用替它解释。 */
          dropped: '本窗口拒收的帧数：{n}（最近一次：{reason}）。',
        },
        bar: {
          untitled: '新建 {engine} 会话',
          state: {
            idle: '空闲',
            starting: '正在启动',
            ready: '就绪',
            running: '进行中',
            waitingPermission: '等待你的授权',
            completed: '已结束',
            cancelled: '已停止',
            failed: '失败',
          },
          result: {
            endTurn: '已回答',
            maxTokens: '达到引擎的 token 上限而停止',
            maxTurnRequests: '达到引擎的请求次数上限而停止',
            refusal: '引擎拒绝继续',
            cancelled: '未完成即被停止',
            unrecognised: '以本版本未知的原因结束',
          },
          history: '该引擎保存的会话',
          /* 引擎就上一轮说了它花了多少。线上的每个计数器都是可选的（P0 §6.3 实测：同样的两次
             运行，字段集合并不相同），所以每条句子只在引擎真的送来了那个数字时才画出来：送了合计
             就用 `total`，只送了输入输出就用那两个，什么都没送就什么都不画。任何一个数都不会由
             其他数算出来——引擎自己的合计并不等于各部分之和。`detail` 是悬停文字，那里的计数器
             有名字、是精确值，而横条上只有放得下的约数。 */
          usage: {
            total: '{n} tokens',
            input: '输入 {n}',
            output: '输出 {n}',
            detail: {
              input: '输入 {n}',
              output: '输出 {n}',
              total: '合计 {n}',
              thought: '推理 {n}',
              cachedRead: '缓存读取 {n}',
              cachedWrite: '缓存写入 {n}',
            },
          },
          /* 轮次统计的另一半：这一轮花了多久，由本窗口自己的秒表量出（`services/agent-turn-stats.ts`
             ——线上没有任何时长字段）。按 Zed 自己的格式化器的三档各写一句
             （`duration_alt_display`，`crates/util/src/time.rs:3-15`），由哪几档大于零决定用哪一句，
             所以 `45s`、`2m 3s`、`1h 2m 3s` 是三句话，而不是一句带两个空槽的话。这里一律不进位：
             秒表声称有十分之一秒的精度，就是声称了它没有的精度。 */
          elapsed: {
            hours: '{h}小时{m}分{s}秒',
            minutes: '{m}分{s}秒',
            seconds: '{s}秒',
          },
        },
        /* 面板的选项菜单：状态栏里的控件和它打开的盒子，两者同名，因为它们是同一件事。`label`
           同时是两者的无障碍名称——触发器（`AgentSessionBar`）和菜单（`AgentPanelMenu`）——
           所以这句话只有一个地方可写，也不会互相对不上。

           `settings` 是面板以前没有的那扇门：它是唯一一条从「引擎配置不对的那次会话」出发、
           通往智能体设置树的路径。它没有复用 `agent.settings....` 的节标题，因为这行说的是
           按下去会去哪里，而节标题是到了那里之后那一页叫什么。 */
        menu: {
          label: '智能体选项',
          settings: '智能体设置',
        },
        /* 会话历史菜单（T17）：引擎对 `session/list` 的回答所画出的行。每一行都是引擎自己的
           事实——它的标题、它所在的文件夹、它的最后活动时间——这里的话只是本应用对这些事实能
           说的部分：哪一个是当前打开的、哪一个记录在别处、某个会话上次被碰是什么时候，以及为什
           么什么都没有。`untitled` 刻意是对引擎的陈述而不是替它起的名字：本应用为没有标题的会话
           编一个标题，就是在陈述引擎从未说过的事。 */
        history: {
          list: '会话',
          loading: '正在读取该引擎保存的会话……',
          empty: '该引擎没有保存任何会话。',
          unreadable: '未能读取该引擎的会话列表：{reason}',
          more: '这只是第一页，引擎在后面还列出了更多会话。',
          /* 上面那句话变成的控件。那句话现在是按钮的 `title`（它解释了列表为什么这么短），
             这里则是按钮说什么、做什么：能动手时是一个动作，读取中是一个状态，读不到时是引擎
             自己的原因。 */
          moreLoad: {
            load: '读取下一页',
            loading: '正在读取下一页……',
            failed: '未能读取下一页：{reason}',
          },
          search: {
            label: '搜索这些会话',
            placeholder: '搜索这些会话……',
            clear: '清除搜索',
            noMatch: '没有匹配的会话',
          },
          newSession: {
            label: '新会话',
            note: '在该引擎上开始一个新会话。当前打开的会话会继续运行，并保留在这个列表中。',
          },
          untitled: '引擎没有为该会话提供标题',
          current: '当前打开',
          elsewhere: '记录在另一个文件夹中：{cwd}',
          age: {
            now: '刚刚',
            minutes: '{n} 分钟前',
            hours: '{n} 小时前',
            days: '{n} 天前',
          },
          /* 针对某一行「引擎侧记录」的操作，本应用对此说的全部内容。**这里任何一句话都不能读起
             来像「删除」。**实测中引擎会保留已关闭的会话（`agent_session_lifecycle_test.rs` §4.4）
             ——从列表中移除走的是 `session/delete`，而该引擎对它回答 `-32601`——因此提问说的是即将
             发生什么，说明说的是不会发生什么，成功之后那句话解释为什么这一行还在。按下去之后看到
             该行仍在，用户不能以为自己失败了。 */
          free: {
            label: '让引擎释放该会话',
            confirm: '要让引擎释放这个会话吗？',
            note: '引擎将不再为它服务，并会取消它当时正在运行的内容。引擎仍会把它留在自己的列表中：从列表中移除会话是另一个方法，而该引擎并未实现，因此这一行之后依然在。',
            confirmAction: '释放',
            cancel: '保留',
            done: '引擎已经释放了它。这一行仍然在这个列表里——这是引擎自己的回答，不是失败。',
            failed: '未能释放该会话：{reason}',
          },
        },
        empty: {
          line: '给 {engine} 发消息——输入 / 查看命令',
        },
        timeline: {
          aria: '智能体记录',
          you: '你',
          attached: '这条消息附带的文件',
          thoughtOpen: '收起思考过程',
          thoughtClosed: '展开思考过程',
          jump: '回到末尾',
          /* 跟随开关。两句写的都是按下之后会发生什么，而不是当前处于什么状态——状态由
             `aria-pressed` 说明，提示语再重复一遍只会让第一次用这个控件的读者得不到答案。 */
          follow: '跟随最新输出',
          followStop: '停止跟随最新输出',
          /* 记录区另外三个控件。Zed 把它们画在每条消息下面（`render_thread_controls`），本面板
             是为整个记录画一行，所以每句都要说明它作用在**哪一个**上：『最新的回答』和『你上一条
             消息』正是标签与猜测之间的差别。`copied` 是按下生效，`copyFailed` 是剪贴板拒绝——不
             告诉读者，他们就会把旧内容当成回答粘贴出去。 */
          copy: '复制最新的回答',
          copied: '已复制',
          copyFailed: '未能复制该回答——剪贴板拒绝了这次操作',
          toUser: '跳到你上一条消息',
          toTop: '跳到开头',
          /* 记录区的查找框（Zed：`conversation_view/thread_search_bar.rs`，占位文案是
             "Search this thread…"）。它查的是屏幕上这一段对话，所以每句都写「这段对话」；旁边的
             历史列表查找框写「这些会话」，理由相同。`count` 是这个框对「我在哪一条」的回答：可见
             形式是 "3/5"，读出来是两个数字，所以标签要把它们是什么说出来。`noMatch` 是占住计数
             位置的那句话，它刻意不是 "0/0"——读者确实输入了内容，诚实的回答是一句话而不是一个零。
             搜索覆盖什么、不覆盖什么写在 `services/agent-conversation-search.ts` 里，不写在这里：
             220px 宽的侧栏里，一句解释查找框范围的话会比这个框本身还长。 */
          search: {
            open: '在这段对话中查找',
            close: '关闭查找',
            label: '搜索这段对话',
            placeholder: '搜索这段对话……',
            previous: '上一个匹配',
            next: '下一个匹配',
            clear: '清除搜索',
            count: '第 {index} 个匹配，共 {total} 个',
            noMatch: '这段对话中没有匹配的内容',
          },
          tool: {
            status: {
              pending: '排队中',
              inProgress: '执行中',
              completed: '完成',
              failed: '失败',
              cancelled: '已取消',
            },
            expand: '展开这次调用的内容',
            collapse: '收起',
            args: '参数',
            output: '输出',
            argsAbsent: '这次调用没有参数',
            argsUnreadable: '引擎发送了本应用无法读取的参数',
            outputAbsent: '这次调用没有输出',
            outputUnreadable: '这次调用产生了本应用无法读取的输出',
            /* 引擎提议的改动，以及本应用不能含糊掉的四件事。`added`/`removed` 是本应用对
               区块自带两段文本做比较得出的计数——ACP 不传 hunk——所以那是本应用在引擎的数据上
               算出来的，句子要说明它是什么，而不是暗示是引擎发来的。`identical` 写成一句话而
               不是留成空列表：一次调用要求动这个文件、两侧文本却相同，这件事必须告诉读者。
               `noOriginal` 只声明收到的东西——schema 对「没有原文」的注解是「新文件」，但同一
               个字段是 default-on-error 反序列化的，本应用读不出来的原文会以同样的样子到达，
               这句话是两者都不得罪的说法。 */
            diff: {
              label: '提议的改动',
              added: '+{n}',
              removed: '−{n}',
              identical: '引擎两侧发送的文本相同，所以这次提议不会改动这个文件里的任何内容。',
              noOriginal: '引擎没有发送这个文件的原文，所以下面每一行都按新增显示。',
              partial: '本应用只比较了每一侧的前 {n} 行；文件在这之后还有内容，改动也可能还在后面。',
              beyond: '本应用只比较了每一侧的前 {n} 行，这些行里没有任何改动——两侧的差异在这些行之后。',
              folded: '{n} 行未改动',
              reveal: '展开这 {n} 行未改动的内容',
              undrawn: '引擎附带了本版本不绘制的内容块。',
            },
          },
        },
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
      rail: {
        starting: '正在启动智能体引擎……',
        noVault: '智能体在一个文件夹内工作。打开一个文件夹才能使用。',
        refused: '智能体引擎未能启动。',
        retry: '重试',
        useChat: '回到聊天面板',
        unknownFailure: '请求被拒绝，且没有给出本应用能读到的原因。',
        stopFailed: '智能体引擎未能停止：{reason}',
        resumeFailed: '未能重新打开该会话：{reason}',
        newSessionFailed: '未能打开新会话：{reason}',
        taskUnavailable: {
          noRuntime: '这条任务所属的会话没有在这个窗口中打开：本窗口没有为该文件夹（{vault}）运行智能体引擎。',
          starting: '这条任务所属的会话还没有在这个窗口中打开：智能体引擎仍在启动。请稍后再点一次这条任务。',
          elsewhere: '这条任务所属的会话没有在这个窗口中打开：本窗口正在为 {showing} 运行智能体。',
          otherEngine: '这条任务所属的会话没有在这个窗口中打开：本窗口为该文件夹运行的是 {engine}。',
        },
      },
      permission: {
        argumentsPending: '引擎还没有发送参数',
        argumentsUnreadable: '引擎发送了本应用无法读取的参数',
        expired: '已不再等待——该请求已被处理',
        lastingGrant: '「始终允许」不只是这一次。引擎不会再就这个工具发问，并会把这次授权记录下来，因此它在本次会话结束后依然有效——本应用不会再收到通知。它记下的授权列在「设置 → {section} → {page}」的「{surface}」中，也可以在那里收回。',
      },
      registry: {
        section: {
          title: '智能体',
          hint: '本应用可以启动的引擎。随应用附带的内置引擎始终在此；其他 ACP 智能体是你自己指定的程序，需要你手动开启。',
        },
        list: {
          loading: '正在读取注册表...',
          unreadable: '未能从后端读取注册表。',
          retry: '重试',
          empty: '还没有注册任何智能体。',
          adapter: '适配器',
          version: '报告版本：{version}——仅作报告，本页不会据此执行任何操作。',
          versionUnknown: '尚未收到该程序的版本信息。',
        },
        provenance: {
          bundled: '随 NekoWite 附带',
          managed: '由 NekoWite 安装',
          external: '你自己安装的程序',
        },
        standing: {
          bundled: '随应用一起分发。检查时该路径上有一个可执行文件，而这也只是检查能证明的全部——运行中的引擎并不在沙箱里。',
          managed: '安装在本应用自己的目录中，并由本应用锁定版本。已注册不等于已隔离。',
          external: '未经 NekoWite 验证。注册只能证明该程序可以被启动：它不是沙箱，它保留自己的凭据，并且以你的权限运行。',
        },
        update: {
          hostManaged: '更新：本应用可以下载并切换该程序的新版本。',
          reportedOnly: '更新：NekoWite 不会替换你自己安装的程序。这里最多只会报告存在更新的版本，仅此而已。',
        },
        programState: {
          launchable: '检查时 {path} 处有一个可执行文件。',
          notAbsolute: '{path} 不是绝对路径，因此被拒绝：只写程序名会在本应用自己的工作目录里查找。',
          missing: '{path} 处现在没有文件。注册项会保留——请恢复或移动该程序，或自行删除这一项。',
          notAFile: '{path} 处有东西，但它不是文件。',
          notExecutable: '{path} 处的文件没有可执行权限，无法启动。',
        },
        control: { enable: '启用', disable: '停用' },
        fields: {
          agentId: '标识',
          displayName: '名称',
          program: '程序路径（绝对路径）',
          args: '启动参数',
          argsHint: '一行一个参数。行内的空格属于那个参数本身——这里永远不会被拼成一条命令行。',
          adapter: '适配器',
        },
        add: { title: '添加程序', submit: '添加', added: '已添加 {agentId}。' },
        action: { failed: '未能把这次改动发送到后端。' },
        ownerUnknown: '尚未有引擎',
        refusal: {
          id: '{value} 不能作为标识：本应用会保存它并把它放进路径，因此只允许字母、数字、点、短横线和下划线。',
          argument: '第 {index} 个参数含有 NUL 字节，任何程序都无法接收。',
          environment: '变量 {name} 无法传给程序。',
          unknownAdapter: '没有适配器响应 {adapterId}，这个引擎的差异就没有归属。',
          duplicateAgent: '{agentId} 已经注册过了。',
          unknownAgent: '没有名为 {agentId} 的注册项。',
          profileUnbound: '配置档 {profileId} 属于 {owner}，凭据、模型和配置不会在引擎之间搬移。',
          disabled: '{agentId} 已停用。',
          alreadyRunning: '{agentId} 已经在该配置档和该库上运行着一个引擎。',
          instanceRunning: '{agentId} 上还有任务在运行。请先停止任务，再停用该注册项。',
          isDefault: '{agentId} 是新建会话所用的引擎，因此不能停用或删除。',
          launchFailed: '引擎无法启动（{code}）：{message}',
        },
        engine: {
          title: '新建会话使用的引擎',
          current: '当前打开的会话使用 {engine}。',
          none: '当前没有打开的会话。',
          choose: '引擎',
          creates: '将在 {engine} 上新建一个会话。当前会话仍保留它自己的引擎、授权与历史。',
          keeps: '{engine} 已经是当前会话使用的引擎。',
          start: '在 {engine} 上新建会话',
          elsewhere: '新会话由智能体面板打开，引擎也在那里选择。本页可以注册引擎、停用引擎；它没有会话，也没有可以用来打开会话的网关。',
        },
      },
      /* ACP 目录：公开注册表发布了什么，以及本应用对此做的唯一一件事。这里每一句话都受两条规则约束。

         **列表不是实测。** 引擎能做什么由握手与会话协商确定，而目录条目描述的是一个谁都没运行过的程序
         ——所以这里没有一句话提供功能、能力或斜杠命令，`unverified` 说明了原因。

         **做不到的事不提供。** 注册表发布三种分发方式，本应用只对其中一种采取行动：包管理器的调用，
         其产物的来源由**包管理器**负责。另外两种会让 NekoWite 变成下载方，而 §3.3 的摘要校验对一份来自
         网络的条目没有锚点（§3.3：不能从同一不可信响应同时获取二进制和摘要便声称可信）。因此归档类条目
         说明理由、不画任何控件——正是「不能让按钮看起来可用、点击后才发现不支持」所指的失败。
         `gates.untransferable` 承载的是这些校验里无法落地的那几个。 */
      catalogue: {
        section: {
          title: '可用的智能体',
          hint: '发布在 Agent Client Protocol 注册表中的引擎。本应用只读取这份列表，不从中安装任何东西。',
        },
        list: {
          loading: '正在读取注册表…',
          unreadable: '无法读取目录。',
          retry: '重试',
          empty: '注册表中没有列出任何智能体。',
          version: '列表 v{version}',
        },
        freshness: {
          current: '刚从此注册表读取。',
          stale: '这份列表已过期：{detail}',
          unavailable: '无法访问注册表：{detail}',
        },
        standing: {
          viaManager: '通过 {manager} 运行。由包管理器获取并校验——本应用不做这件事，并把结果记录为「你自己的安装」。',
          archiveOnly: '只发布了面向 {platform} 的下载包。使用它会让 NekoWite 成为下载方，而本应用不做这件事：{reason}',
          unsupported: '只发布了 {published} 的版本，没有本机的。',
          unrecognised: '以 {kinds} 形式发布，本应用无法识别。',
        },
        /* 注册表从不会说的东西，无论某行状态如何都会画出来。规则来自 §3.4 的能力行：只有握手与
           会话协商才能确定这些。 */
        unverified: '注册表无法说明这个引擎能做什么。功能、斜杠命令与配置，都要在它注册并启动之后、通过和它对话才能确定。',
        gates: {
          title: '为什么没有安装按钮',
          hint: '安装第三方二进制是一个供应链决策。§3.3 要求一次下载先通过这些校验，而以下是注册表条目无法支持的校验：{checks}',
        },
        action: {
          use: '使用这个程序',
          used: '已添加 {agentId}。请在上面的注册表列表中启动它。',
        },
        defects: {
          title: '此条目无法使用',
        },
        license: '许可证：{license}',
        licenseLink: '阅读条款',
        repository: '源码',
        website: '网站',
      },
      /* 智能体设置树（T13），与面板的 commandMenu/permission、注册表页自己的键并列。`origin` 与
         `retry` 是共用的——它们各自只表达一个事实，无论多少页面画出来。凡是紧挨着**事实**（一个路径、
         一个变量、引擎自己的话）的句子，槽位名留在这里、由页面填入值：路径是数据，数据不过翻译。 */
      settings: {
        retry: '重试',
        origin: {
          host: '由本应用设置',
          engine: '引擎自己的发现规则',
          session: '由引擎为该会话发布',
        },
        runtime: {
          section: {
            title: '运行时',
            hint: '本应用对它启动的引擎知道些什么：哪个程序、来自哪里，以及它自称的能力里哪些真的被实测过。',
          },
          loading: '正在读取运行时……',
          unreadable: '未能从后端读取运行时。',
          facts: {
            agent: '引擎',
            source: '来源',
            program: '程序',
            version: '报告版本',
            versionUnknown: '尚未收到',
            adapter: '适配器',
          },
          provenance: {
            bundled: '随 NekoWite 附带',
            managed: '由 NekoWite 安装',
            external: '你自己安装的程序',
          },
          process: {
            label: '进程',
            stopped: '未运行',
            ready: '运行中',
          },
          notAModel: '进程在跑就是进程在跑。它不等于模型可用：这里没有任何一条意味着提问会被回答。',
          protocol: {
            label: '协议',
            version: '版本',
            negotiated: '本次运行时已与引擎完成协商',
          },
          notNegotiated: {
            noEngine: '当前没有引擎在运行，因此还没有和任何引擎协商过。协议版本与下面这份列表都是从握手里读出来的，而为某个文件夹启动引擎正是做这次握手的地方。',
            notYet: '该引擎正在运行，但还没有被问过。本应用会在打开会话时做这次握手，而本次运行时还没有打开过会话。',
          },
          authorization: {
            label: '该引擎声明的认证方式',
            none: '该引擎在握手里没有声明任何认证方式。',
            reportedNotUsed: '这是引擎自己报告的，本应用不会据此做任何事：本应用从不与引擎做认证。能怎么认证是引擎自己的事，它的凭据在它的配置档里，而不在这里。',
          },
          engineReport: {
            label: '引擎自己的报告',
          },
          capabilities: {
            title: '该引擎报告了什么',
            hint: '安装声明只是启动前的提示。下面每一行都是本次运行时握手报告的结果，或者是「尚未实测」——后者和「不支持」不是同一个答案。十一项里有三项要等会话响应才能回答，所以没有会话的页面会把它们读作尚未实测，而不是读作没有。',
            advertised: '该引擎版本声明支持',
            notAdvertised: '该引擎版本未声明支持',
            unverified: '尚未对该引擎实测',
            /* 同三个分支的短说法，供同时点出两个主张的那句话使用：上面的整句已经画在它上面一行了。 */
            finding: {
              advertised: '声明支持',
              notAdvertised: '未声明支持',
              unverified: '尚未实测',
            },
            /* 这份报告的另一半：本构建对它实测过的那一个引擎版本，档案里记着什么。只有当它与上面的
               实测结果不一致时才会画出来，也就是说这三条短语只在那句「disagrees」里被读到。句子里
               把主语写全，因为这一整页要挡的失败正是读者把档案里的说法当成引擎的回答。 */
            declared: {
              advertised: '声明支持此功能',
              notAdvertised: '声明不支持此功能',
              unverified: '从未实测过它',
              disagrees: '这里有两个主张，而它们并不一致：本构建实测过的那一个引擎版本，档案里记的是「{declared}」，而本次运行时报告的是「{finding}」。',
            },
            /* 一行都没有的报告。画在列表的位置上，因为一个标题配一张空列表会被读成一个答复——而它
               被读成的那句是「这个引擎什么都做不了」，这句话没有人说过。 */
            empty: '后端返回的报告里一行都没有。这和「这个引擎什么都做不了」不是同一个答复：它只是任何一项都还没有被报告过。',
          },
          update: {
            label: '更新',
            hostManaged: '本应用可以下载并切换该程序的新版本。',
            reportedOnly: 'NekoWite 不会替换你自己安装的程序。这里最多只会报告存在更新的版本，仅此而已。',
          },
        },
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
        /* 引擎自己的配置文件。四种状态、四句话，因为用户的下一步在每种状态里都不一样：
           本应用可写的文件、还不存在而保存一个成员就会创建出来的文件、本应用无权写的文件，以及配置
           文件属于用户自己那套安装的配置档。后两种都不画表单——画不出来的控件就不画；第二种画的是
           第一种那张表单，只是多一句话：创建引擎的文件比改它一个成员是更大的动作，用户有权知道
           自己正在做的是哪一件。 */
        config: {
          section: {
            title: '引擎配置',
            hint: '引擎自己读取的那个文件。NekoWite 按引擎写下的原样显示，并按读到的修订逐个成员修改。',
          },
          loading: '正在读取引擎配置……',
          unreadable: '无法从后端读取引擎配置。这是关于本窗口的事实，而不是关于那个文件的事实。',
          none: '该配置档复用你自己那套安装，因此引擎读取的是那套安装的配置文件。它不是 NekoWite 写的，这里也不打开它；请在它所在的位置编辑，或者把上面的配置档改为「本应用管理」。',
          creates: '磁盘上还没有这个文件，因此这里也没有任何需要保留的东西——没有注释，也没有引擎写下的成员。保存下面的成员会创建它，该成员就是文件的全部内容；此后引擎就会读取它。',
          readOnly: '文件存在，但该配置档是本应用不写入的那种，因此这里只显示、不修改。',
          document: {
            title: '文件内容',
            path: '文件',
            exists: '已在磁盘上。',
            absent: '尚未写出。',
            text: '该文件没有返回文本内容。',
            textHint: '按原样显示，注释也在。这里没有任何解析——一次修改只指定一个成员和它的值，文件其余部分一个字节都不动。',
          },
          edit: {
            title: '设置一个成员',
            hint: '针对刚读到的修订，改这个文档里的一个成员。如果文件在那之后变过，修改会被拒绝，而不是被合并。',
            member: '成员名',
            memberHint: '文档根下的成员名，按引擎自己的拼写写。是一个名字，不是点分路径——名字里带点也是普通的名字。',
            value: '值',
            valueHint: '一个 JSON 值：字符串要带引号，对象要带花括号。这里是整个页面唯一会按 JSON 解析的东西。',
            save: '应用',
            noMember: '必须指定一个成员名。',
            invalidValue: '这不是一个 JSON 值。',
            applied: '已应用。',
            conflict: '文件在本页读取之后变过，因此什么都没写入——上面的内容已经重新读取，屏幕上显示的就是文件里现在的内容。',
            conflictCreated: '在本页读过这个目录之后、这次保存之前，别的东西创建了这个文件。什么都没写入——上面显示的就是现在磁盘上的文件，它不是本应用写的。',
            failed: '这次修改没能发送到后端。',
          },
          provider: {
            title: '添加供应商',
            hint: '往这个文档里写入一个块，键就是你填的供应商标识：引擎要调用的地址、可用的模型，以及对密钥的引用（而不是密钥本身）。文件里其他内容——别的供应商、注释、本应用从没听说过的成员——一个字节都不动。',
            id: '供应商标识',
            idHint: '字母、数字、点、短横线和下划线。它既是文件里这个块的名字，也是密钥存放名的一部分：{name}。',
            name: '名称',
            nameHint: '引擎显示这个供应商时用的名字。留空则用标识。',
            baseUrl: '接口地址',
            baseUrlHint: '引擎会在它后面拼接 /models 以及请求路径。末尾不需要斜杠。',
            key: 'API Key',
            keyHint: '存放在本配置档的凭据文件里（权限 0600），不会写进文档：块里写的是 {\'{\'}env:…{\'}\'}，值由本应用启动引擎时通过环境变量给它。',
            keyTyped: '保存会把这个值存下来，替换当前已存的那个，并让块引用它。',
            keyStored: '{name} 下已经存有密钥。它的值不会显示在本页，也不会发到本页，块会继续引用它：保存不改动这个密钥。',
            keyNone: '这个供应商没有存密钥，也没有填写，因此块不会引用任何密钥，发往它的请求会不带认证。本机上的服务端点正是这样用；要存一个就填上值。',
            keyUnread: '本配置档存了哪些密钥没能读出来，而块是否引用密钥正取决于这一点，所以在读到之前不会写入任何内容。这个读取正是用来区分「已存的密钥」和「从未设置过密钥」的。',
            keyRetry: '重新读取',
            keyRemove: '删除已存的密钥',
            keyKeep: '保留已存的密钥',
            keyRemoving: '保存会删除 {name} 下存的密钥，并写入一个不引用任何密钥的块。',
            allowPrivate: '允许「获取模型」访问本机/内网地址',
            allowPrivateHint: '获取模型是本应用发的请求，默认拒绝本机与内网地址。引擎不受这条限制——块里写什么地址，它就连什么地址。',
            fetch: '获取模型',
            fetching: '正在请求服务商……',
            fetched: '服务商列出了 {n} 个模型。',
            fetchNeedsKey: '这个列表是用上面那栏里的密钥去获取的，所以要先填密钥。留空的话，请求会带上本应用自己 AI 设置里存的密钥——或者干脆不带认证——取回的结果就属于一次用「引擎根本不会用的凭据」发出的请求。',
            fetchFailed: '没能连上服务商。',
            models: '模型',
            modelsEmpty: '还没有模型。从服务商获取，或者在下面手动填一个标识。',
            modelHint: '勾选的标识会成为引擎在这个供应商下可用的模型。服务商列了、但这个块没声明的模型，引擎是用不了的。',
            manual: '服务商没有列出的模型标识',
            manualAdd: '添加',
            preview: '将要保存的内容',
            previewHint: 'provider.{id} 的值，与写入时完全一致。这里显示什么就发送什么，之后不会再添加别的东西。',
            save: '保存供应商',
            replaces: '如果文件里已经有这个标识，保存会用新内容替换那个供应商的块——其他供应商和它们周围的注释依旧一个字节都不动。',
            problem: '什么都没写入：{reason}',
            credentialFailed: '密钥没能存下去，因此文档也没有写入。{reason}',
            removalFailed: '块已经写入、不再引用该密钥，但已存的密钥没能删除。{reason}',
            editFailed: '供应商没能写进文档。{reason}',
            applied: '供应商已写入。',
            conflict: '文件在本页读取之后变过，因此什么都没写入。请刷新后重新保存。',
            conflictCreated: '别的东西先创建了这个文件，因此什么都没写入。上面显示的是现在磁盘上的文件。',
          },
        },
        skills: {
          section: {
            title: 'Skills',
            hint: '引擎找到的技能目录、每一个来自哪里，以及本应用可以对其做什么。',
          },
          loading: '正在读取技能……',
          unreadable: '未能从后端读取技能列表。',
          list: {
            empty: '在引擎读取的所有目录中都没有找到技能。',
            emptyScope: '引擎在这个目录里没有找到技能。',
            scope: '范围',
            directory: '目录',
            noDescription: '没有描述',
          },
          unmanaged: {
            title: '这里不管理',
            project: '项目自己的技能不在这里列出，原因不是找不到：引擎会从「会话所在目录」下的 `.opencode/skills` 读取技能。本对话框讲的是引擎配置档而不是某个目录——打开它时可能开着仓库也可能没有，而像这样的一页到底该管理哪个项目，是它回答不了的问题——因此这里不画任何项目，也不会从这里关闭任何一个。打开那个项目，引擎照旧读取它的技能。',
            declared: '引擎自己在配置里声明的目录（`skills.paths`）同样不在这里列出：那个成员位于本页不读取的文档里，为它再写一个解析器只会对同一个文件给出第二种答案。只能通过声明路径才够到的技能是装好的、在工作的——只是不在这个列表里。',
          },
          owner: {
            managed: '该目录归本应用所有',
            engine: '由引擎发现',
            foreign: '另一个工具的目录',
          },
          surface: {
            offered: '引擎会读取它，并把它提供给模型。',
            undescribed: '它没有描述，因此引擎会把它过滤掉，永远不会呈现出来。在补上描述之前，它装了也等于没有。',
            suppressed: '引擎根本没有读取该目录：它的环境里设置了开关 {variable}。',
            unusable: '引擎无法使用它：{reason}',
            disabled: '已由本应用关闭。它保存在引擎读取的任何目录之外。',
          },
          conflict: '同名技能还定义在 {directories}。两者都会被加载，而哪一个生效并不是这里显示的任何一个东西能决定的——删掉其中一个。',
          disable: {
            label: '启用',
            enable: '启用',
            disable: '停用',
            noSwitch: '对那个目录，本应用没有任何开关可扳。这里的任何控件都只会把这一行藏起来，所以干脆没有。',
            engineSwitch: '只有引擎自己能停止读取该目录：在它自己的环境里设置 {variable} 时它会跳过。本次启动没有设置那个变量。',
            engineSwitchSet: '这里没有控件：{variable} 属于启动引擎时使用的环境，而本次启动设置了它。上一行写的就是它对这条技能的影响；它不是此页面能更改的设置。',
          },
          disabledList: {
            title: '已停用',
            hint: '保存在本应用自己的仓库里，位于引擎扫描的任何目录之外。重新启用会把它放回引擎读取的位置。',
          },
          import: {
            title: '导入技能目录',
            hint: '一个包含 SKILL.md 的目录。先读取、后安装；本应用永远不会运行其中的任何东西。',
            target: '将安装到',
            noTarget: '这里没有可以导入进去的位置。导入会写进本应用自己的目录，而这个配置档没有这样的目录：引擎为它读取的每个目录都不是本应用可以写入的。由本应用管理的配置档有这样一个目录，导入会落到那里。',
            source: '目录路径',
            preview: '先读一遍',
            confirm: '导入',
            replace: '导入并替换已有的那一份',
            replaceWarning: '已经安装了同名技能。覆盖会先把现有目录移进本应用的仓库，因此当前这一份仍然可以找回。',
            done: '已导入 {name}。',
            failed: '未能把这次导入发送到后端。',
          },
          preview: {
            title: '将会安装的内容',
            description: '描述',
            files: '文件',
            scripts: '脚本与数据',
            noScripts: '除了 SKILL.md 什么都没有。没有可运行的脚本。',
            total: '合计',
            nothingRun: '这些内容一样都没有被运行过。这份列表就是该目录里有什么；导入只是复制这些字节，不会执行任何东西。',
          },
          refusal: {
            'relative-path': '那不是绝对路径，因此会被解析到本应用自己的工作目录下，而不是你指的那个位置。',
            'store-inside-scope': '本应用用来存放已停用技能的仓库，位于引擎会扫描的目录之内——那样一来「已停用」的技能仍会被找到。本应用拒绝以这种方式运行。',
            'unknown-scope': '该引擎读取的目录里没有叫 `{scope}` 的。',
            'not-managed': '那个目录不归本应用所有，因此它不会往里写。只有本应用自己的配置档目录可以被导入。',
            'no-switch': '那个目录没有任何能改变引擎读取结果的开关，因此这次改动被拒绝，而不是假装完成。',
            'outside-scope': '该技能并不在它自称所在的目录里，因此什么都没有被移动。',
            'escapes-scope': '这一项是一个链接，其目标落在它被发现的那个目录之外：{directory}。引擎会去读目标，因此这一项显示为不可用，而不是被藏起来。',
            missing: '{path} 处没有文件。',
            'no-manifest': '{path} 处没有 SKILL.md，因此没有引擎会读取的东西。',
            symlink: '该目录中包含一个符号链接（{path}）。链接指向的地方并不属于正在被导入的那棵树，因此导入被拒绝。',
            'not-a-file': '{path} 既不是文件也不是目录。',
            'too-many-files': '该技能的文件数量超过了本应用一次导入的上限。',
            'file-too-large': '有一个文件超过了本应用导入的大小上限：{path}',
            'skill-too-large': '该技能的总大小超过了本应用导入的上限。',
            'no-frontmatter': 'SKILL.md 没有以 frontmatter 块开头，因此引擎不会从中读到名称。',
            'unterminated-frontmatter': 'SKILL.md 里的 frontmatter 块没有闭合。',
            'frontmatter-line': 'frontmatter 中有一行无法读取：{message}',
            'name-missing': 'SKILL.md 没有声明名称，而引擎要求必须有。',
            'name-shape': '`{name}` 不是合法的技能名。引擎要求小写单词用短横线连接、不超过 64 字节，并且与目录名一致。',
            'name-mismatch': 'frontmatter 里写的是 `{name}`，而目录名是 `{folder}`。两者不一致时，引擎会拒绝该技能。',
            'description-missing': 'SKILL.md 没有声明描述。引擎会丢弃没有描述的技能并且永不呈现，因此安装它等于添加了一个永远不可能生效的东西。',
            'description-too-long': '描述长度超过了引擎 1024 个字符的上限。',
            'field-control': '`{key}` 中带有控制字符，任何页面和日志行都无法承载。',
            'name-taken': '名为 `{name}` 的技能已经安装在 {directory}。',
            'no-such-skill': '`{scope}` 里已经没有名为 `{name}` 的技能了。片刻之前还读到过，现在不在了——可能是改名、删除，或者另一个窗口——因此什么都没有被移动。重新读取列表再试一次。',
            'store-occupied': '本应用的仓库中已有同名副本，继续写入会把它覆盖。',
            'same-directory': '那个目录已经在它将被安装到的位置上了。',
            'scan-too-large': '对该目录的扫描没有完成，因此它的结果会是残缺的。',
            io: '文件系统拒绝了这次操作：{message}',
          },
        },
        commands: {
          section: {
            title: '命令',
            hint: '每一条命令来自哪里。本应用不发布引擎的命令，也不重新实现其中任何一条。',
          },
          loading: '正在读取命令列表……',
          unreadable: '未能从后端读取命令列表。',
          session: {
            title: '来自本会话',
            none: '本会话还没有发布命令列表。它是在会话开始之后以通知形式到达的，而不是随会话本身一起返回。',
            session: '会话',
            published: '由引擎发布',
            description: '描述',
          },
          sources: {
            title: '由引擎从文件读取',
            hint: '这些由引擎自己发现。本应用只显示找到了什么，不解释模板，也不代为执行命令。',
            empty: '没有找到任何命令文件。',
            commands: '命令数',
          },
          app: {
            title: '本应用自己的命令',
            hint: '「插入选区」「打开变更」等等位于它们自己的面板中，永远不占用引擎的斜杠命名空间，因此命令名不会和引擎的撞车。',
          },
          limits: {
            title: '不可用的部分',
            undoRedo: '撤销与重做不属于 ACP，该引擎也不通过它提供。本应用不会靠删除自己的聊天记录来假装实现。',
            unpublished: '引擎没有发布的命令这里不提供。通过原生终端入口执行它会显示引擎自己的报错，而不是本应用编出来的成功。',
            parameters: '调用命令的方式是把命令名和参数作为提示发送。这里没有参数表单，因为协议并没有描述这样一种东西。',
            unnamed: '没有描述的命令只显示名字。本应用不会替它写一条。',
          },
        },
        mcp: {
          section: {
            title: 'MCP 服务器',
            hint: '引擎会连接的服务器、每一个配置在哪里，以及启动一个意味着什么。',
          },
          loading: '正在读取 MCP 配置……',
          unreadable: '未能从后端读取 MCP 配置。',
          list: {
            empty: '该配置档没有配置任何 MCP 服务器。',
            name: '服务器',
            transport: '传输方式',
            state: '状态',
            on: '已启用',
            off: '在配置中已关闭',
            command: '程序',
          },
          transport: { local: '本地程序', http: 'HTTP', sse: '服务器发送事件' },
          credentials: {
            label: '凭据',
            none: '没有配置',
            namesOnly: '只有名字。值从不发送到本页面。',
          },
          diagnostic: { label: '最近一次诊断', none: '没有任何报告' },
          capabilities: {
            title: '该引擎声明了什么',
            hint: '来自握手，针对该引擎版本。未声明的传输方式会被如实说明，而不是藏起来。',
            advertised: '已声明',
            notAdvertised: '该引擎版本未声明',
          },
          trust: '启动这个服务器就是在运行一个程序。启动它的是引擎；本应用既不启动它，也不把它关进沙箱，而「配置过」不等于「可信」。只有当你自己愿意运行那条命令时，再启用它。',
          doesNotStart: '本页面只做报告，不写入任何东西。服务器由引擎在打开会话时启动，因此这里没有能启动它们的控件。',
        },
        permission: {
          section: {
            title: '权限',
            hint: '引擎会为什么询问、这些设置的来源，以及本应用对它们不作哪些承诺。',
          },
          loading: '正在读取权限配置……',
          unreadable: '未能从后端读取权限配置。',
          states: {
            written: '本应用把下面的规则写进了引擎自己的配置，因此引擎在改动你的文件或执行命令之前会先询问。',
            engineOwn: '引擎自己的配置里已经有权限规则，因此本应用没有写入，也不会覆盖它们。那些规则问了什么，这里读不到；它们就在下面这个文件里。',
            notThisHost: '该配置档案复用你自己的引擎安装，因此本应用没有为它写入任何权限规则，也无法说明引擎会问什么。',
          },
          rules: {
            title: '引擎会询问什么',
            empty: '这个配置档案里没有本应用写下的规则可显示。这不等于引擎什么都不问：对于复用你自己安装的配置档案，或者配置里已自带规则的配置档案，引擎会问什么是本应用报告不了的。',
            tool: '工具',
            action: '动作',
          },
          options: {
            title: '一次请求可以回答什么',
            hint: '这些是引擎自己的选项种类，随请求一起到达。每一次请求都带着它自己的选项，提示框渲染的是那些，而不是这里保留的一份列表。',
            none: '本页不列这些：选项随每次请求一起到达，提示框渲染的是那一次请求实际带来的选项。',
            noInvention: '本应用不添加自己的任何选项。如果引擎没有提供「永久允许」，那就没有永久允许可以给。',
          },
          limits: {
            title: '这不意味着什么',
            notASandbox: 'ACP 不是沙箱。工作目录、本应用的文件白名单，以及一句写着「只操作此库」的提示词，都约束不了引擎自己的 shell、插件、MCP 服务器或网络访问。对这套集成诚实的描述是：一个运行在你所信任的工作区里的智能体。',
            noIsolation: '这套集成没有构建也没有验证过任何 Linux 沙箱，因此这里没有任何东西是被隔离的。任何相反的说法，都是在描述一个并不存在的功能。',
            staleRequests: '一次请求属于某一个运行时、库、会话与任务。回答一个已经处理过的请求，或属于已经结束会话的请求，会被拒绝，而不是套用到用户眼前的东西上。',
            noSilentApproval: '危险请求如果始终无人回答，就永远不会被批准。等待不是同意，这里也不会因为提示被放着不管就授予权限。',
          },
          grants: {
            title: '你已给出的长期授权',
            hint: '每一行都是你回答过的一次「始终允许」。引擎自己把它记了下来，以它覆盖的工具、该授权适用的范围和引擎自己的项目键为索引——因此它比你给出它的那次会话活得更久，引擎也不再询问。这份列表是引擎的，从引擎读来；撤销即是请引擎删掉那一行，此后下一次工具调用它就会重新询问。',
            loading: '正在读取引擎保存的授权…',
            unreadable: '已向引擎询问它保存的授权，但没有得到回答。这里对它们不做任何断言——请重试，或确认智能体仍在运行。',
            unsupported: '这个智能体不上报它记录下来的授权，因此本页无法列出或撤销它们。这与「你什么都没给过」不是一回事：这里什么都没问到。',
            notRunning: '没有智能体在运行，无处可问。开始一次会话后，这份列表会从引擎本身读来——配置档案的授权保存在引擎自己的数据库里，不在本应用里。',
            empty: '引擎在这个配置档案下没有任何长期授权。这是引擎自己的回答，不是用一个空列表来代替它给不出的答案。',
            project: '项目',
            revoke: '撤销',
            revoking: '正在撤销…',
            failed: '引擎没有删掉它：',
          },
        },
        agents: {
          section: {
            title: '智能体',
            hint: '右侧栏显示哪个面板、本应用可以启动哪些引擎以及所启动引擎的配置档案，还有当前构建在引擎上还做不到什么。',
          },
          panel: {
            label: '在右侧栏显示智能体面板',
            hint: '关闭时，右栏保留原来的聊天面板。打开后，右栏改为显示智能体面板，在本应用已打开的文件夹内工作——聊天面板会被卸载，正在流式返回的回复会被取消；关掉这个开关就能把它找回来。',
          },
          profile: {
            showing: '下面各页讲的是 {agent} 及其配置档案 {profile}。',
            unknown: '未能读取引擎注册表，因此本应用所启动引擎的配置档案不在这里显示。上面的注册表页说明了原因。',
          },
          gaps: {
            title: '当前构建尚未接通的部分',
            intro: '下面每一条本来都会是独立的一页设置。它们需要的那一半还不存在，而一个只能失败的控件不会被画出来：',
            commands: '命令——引擎为某个会话发布的列表。它随发布到达智能体面板，且只属于那一个会话，设置页没有可以调用的读取。',
            mcp: 'MCP 服务器——列表、配置与传输方式。当前构建里完全没有为 MCP 实现任何东西。',
            engine: '选择新会话使用哪个引擎。上面已经可以添加引擎、停用引擎，但会话总是启动在默认引擎上：后端的启动调用只接收一个文件夹，因此这个窗口目前无法在另一个引擎上打开会话。',
            other: '这一节需要的后端一半，当前构建还没有。',
          },
        },
      },
      note: {
        title: '智能体为这篇笔记提出的内容',
        unwritten: '还没有写入任何东西。应用会把智能体的版本放进这篇笔记；保留你的版本则完全不动它。',
        edit: {
          row: '智能体为 {path} 生成了一个版本',
          apply: '采用智能体的版本',
          discard: '保留我的版本',
        },
        outcome: {
          saved: '智能体的版本已经在笔记里，文件里也有了。',
          saveFailed: '智能体的版本已经在笔记里，但文件里还没有。再保存一次这篇笔记就会写进去。',
          discarded: '没有写入任何东西，笔记和你离开时一样。',
        },
        refused: {
          noteNotOpen: '已经没有标签页打开这篇笔记了，没有可以写入的地方。',
          targetChanged: '编辑器回答的是另一篇笔记，因此什么都没有写入。',
          vaultMismatch: '这篇笔记属于另一个库，与该答案产生时的会话不是同一个。',
          identityChanged: '产生这个答案的会话已经不是这个窗口当前所在的会话。',
          writeUnavailable: '没有东西可以接收这段文字：持有这篇笔记的窗格现在不可用。',
        },
        conflict: {
          title: '你思考期间这篇笔记被改动了',
          moved: '在请求发出之后被编辑过',
          agentText: '智能体产出的内容',
          noteText: '笔记现在的内容',
          apply: '采用智能体的版本',
          discard: '保留我的版本',
          kept: '无论选哪个，你的文字都会交回给窗口：应用会把它从笔记里替换掉，除此之外没有别处保存它。',
        },
        svg: {
          row: '智能体为这篇笔记产出了 {name}',
          verified: '已通过校验的预览。文件会原样复制进这个库；下面显示的是各项检查放行的内容。',
          where: '它会被放在这篇笔记的末尾。',
          name: '文件名',
          insert: '放进这篇笔记',
          discard: '不放进',
          previewAlt: '{name} 的预览',
          unreadable: '读不到智能体写出的那个文件，因此不为它提供任何操作。',
          refused: {
            notSvg: '那个文件不是 SVG。',
            tooLarge: '那个文件比本应用愿意解析的上限还大（{size}／{limit} 字节）。',
            incompleteRead: '那个文件还在写入：它声明有 {size} 字节，实际读到 {read} 字节。',
            declaration: '那个文件带有 {kind} 声明，本应用不会把它交给解析器。',
            malformed: '那个文件不是良构的 XML。',
            tooComplex: '那个文件的元素数（{elements}）超过本应用愿意遍历的上限（{limit}）。',
            tooDeep: '那个文件的嵌套深度（{depth}）超过本应用愿意下探的上限（{limit}）。',
            foreignNamespace: '{element} 属于另一个 XML 词汇表（{namespace}）。',
            unsafeElement: '{element} 不在本应用绘制元素的名单上。',
            unsafeAttribute: '{element} 带有 {attribute}，本应用不绘制它。',
            externalReference: '{element} 指向 {attribute}，那会让预览去取外部内容。',
          },
          outcome: {
            inserted: '图片已经在笔记里，文件也已经在库里。',
            moveFailed: '图片没有复制进库里，因此笔记保持原样。',
            moveElsewhere: '库把文件命名为 {saved}，而不是 {planned}，因此笔记保持原样。',
            noteWriteFailed: '图片已经在库里，但这篇笔记没能带着链接保存成功。',
            noteNotOpen: '已经没有标签页打开这篇笔记了，无处可放。',
            targetChanged: '编辑器回答的是另一篇笔记，不是被问的那一篇。',
            vaultMismatch: '这篇笔记属于另一个库，与该计划产生时的会话不是同一个。',
            anchorOutOfRange: '要放置的位置不在这篇笔记里。',
            identityChanged: '产出这个文件的会话已经不是这个窗口当前所在的会话。',
            revisionChanged: '放置图片期间这篇笔记被编辑过，因此什么都没有插入。',
            anchorMoved: '要放置的位置上的文字变了，因此什么都没有插入。',
            invalidFileName: '那不是可用的文件名。',
            nameUnavailable: '那个名字在这个文件夹里已被占用，也没有找到可用的变体。',
            attachmentNotSaved: '文件不在库里，因此笔记保持原样。',
          },
        },
      },
      changes: {
        title: '这次运行改动的文件',
        empty: '还没有任何改动。',
        summary: '改动 {files} · 保留 {kept} · 已撤回 {putBack} · 待处理 {toReview}',
        collapse: '收起列表',
        expand: '展开列表',
        attribution: {
          agent: '本会话的一次工具调用写了这个文件',
          external: '这个文件在磁盘上变了，本会话没有任何记录指认它',
          reported: '引擎点名了这个文件，但没有工具调用、也没有磁盘变化佐证',
        },
        verdict: {
          followsDisk: '这篇笔记没有未保存的编辑',
          unsavedEdits: '这篇笔记有未保存的编辑',
        },
        offer: {
          view: '查看',
          keep: '保留',
          recover: '撤回',
        },
        refused: {
          notAgentChange: '这里没有记录过可以撤回的改动。',
          writeInFlight: '智能体还在写这个文件。',
          noBaseline: '没有任何请求点名过这个文件，因此没有留下可撤回的版本。',
          vaultMismatch: '这篇笔记属于另一个库，与改动它的会话不是同一个。',
          unsavedEdits: '这篇笔记有未保存的编辑。两个版本都在下面；在哪里取舍由笔记自己的「保留本地／重新载入」提示决定。',
          resultUnstated: '这次调用没有说明它在文件里留下了什么，因此没有东西可以拿来比对该笔记。',
          changedSince: '这篇笔记已经不是智能体留下的那一版：改动之后又被编辑过。',
        },
        decision: {
          kept: '已保留',
          rejected: '已撤回',
        },
        written: {
          saved: '笔记已经还原，文件里也有了。',
          saveFailed: '笔记已经还原，但文件里还没有。再保存一次这篇笔记就会写进去。',
          unavailable: '没有东西可以接收这段文字：持有这篇笔记的窗格现在不可用。',
        },
        /* 宿主自己的恢复给出的答案，用于没有标签页打开的笔记。与 `written` 并列而不是复用它：
           两个写入者回答的是不同的问题——笔记的保存说的是缓冲区怎么了，这里说的是宿主把文件
           怎么了，下面每一句都只讲文件。 */
        recovered: {
          recovered: '文件已经回到提出请求时的版本，被替换掉的那一版也留在了笔记的历史里。',
          warning: '被替换掉的那一版没能留在历史里。',
          refused: {
            noBaseline: '那次写入不是本宿主执行的，因此它没有可还原的版本。',
            baselineStale: '从本宿主记录的那一版到智能体写入之间，文件变动过，所以它手里的文本不是该还原的那一份。',
            unavailable: '在改动应该留下的位置读不到这个文件：它被删除、改名了，或者不是本应用能读的文本。',
            changedSinceRecorded: '这个文件已经不是智能体留下的那一版：改动之后又被编辑过。还原会带走那次编辑。',
            alreadyAtBaseline: '文件已经是待还原的那一版了，没有什么可做。',
            writeRefused: '应用自己的保存拒绝了：文件只读、路径离开了库，或者不是文本文件。',
          },
          unreachable: '没能问到宿主：',
        },
        unsavedBuffer: '你未保存的文字',
        agentVersion: '这次调用在文件里留下的内容',
        diskUnread: '这里没有记下这个文件的内容，因此只显示你未保存的文字。',
      },
    },
  },
} as const
