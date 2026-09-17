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
          thoughtOpen: 'Hide the reasoning',
          thoughtClosed: 'Show the reasoning',
          jump: 'Back to the end',
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
             app does have at that end is the `+` (`context` below), and it adds a path to the
             message rather than an attachment to the turn. */
          hint: 'Enter sends. The engine works inside the folder you opened.',
          hintBusy: 'Enter cannot send while this turn is running — the text stays here.',
          /* The `+` at the left of the bar: the files of the folder the engine works in, inserted
             into the message as vault-relative paths. Nothing here may say the model was SHOWN a
             file - a prompt is text, so a path is all a turn can carry, and the engine's own tools
             decide what to do with it. A folder cannot be inserted, only walked into, which is why
             there is no sentence for choosing one. */
          context: {
            add: 'Add a file from this folder to the message',
            noFolder: 'No folder is open for the agent to read',
            list: 'Files in this folder',
            reading: 'Reading the folder…',
            empty: 'Nothing in this folder',
            up: 'Up one folder',
            unreadable: 'The folder could not be read: {detail}',
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
      },
      permission: {
        argumentsPending: 'The engine has not sent the arguments yet',
        argumentsUnreadable: 'The engine sent arguments this app could not read',
        expired: 'No longer waiting — this request has already been resolved',
        /* Shown under the options, and only when the engine offered a lasting grant. The engine's
           own label for that option is "Always allow", which does not say how long: it is the one
           answer whose consequence is invisible afterwards, because the question stops arriving
           and this app is never told again. Measured — see the report. */
        lastingGrant: '“Always allow” is not just this once. The engine stops asking about this tool and writes the grant down, so it outlives this session; this app is never told again and has no surface that lists or takes it back.',
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
          process: {
            label: 'Process',
            stopped: 'Not running',
            starting: 'Starting',
            ready: 'Running',
            failed: 'Failed to start',
          },
          authorization: {
            label: 'Authorization',
            unknown: 'Nothing has been reported about credentials',
            required: 'The engine has no credentials for any provider yet',
            configured: 'The engine reports credentials for a provider',
            notAModel: 'A running process is a running process. It is not a model: nothing here means a prompt would be answered.',
          },
          protocol: {
            label: 'Protocol',
            version: 'Version',
            none: 'not negotiated',
            negotiated: 'Negotiated with the engine in this runtime',
            notNegotiated: 'Not negotiated in this runtime',
          },
          capabilities: {
            title: 'What has been measured',
            hint: 'The install declaration is only a start-time hint. Each line below is what the handshake reported, or that nothing was measured - which is not the same answer as "not supported".',
            advertised: 'Advertised by this engine version',
            notAdvertised: 'This engine version does not advertise it',
            unverified: 'Not measured for this engine',
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
            scope: 'Scope',
            directory: 'Directory',
            noDescription: 'no description',
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
            runtime: 'Runtime — the process state, the authorization and the protocol version. The registry above answers which program, from where, and what it reported about itself; the state of a running engine is answered nowhere, and a settings page has no session to ask about one.',
            skills: 'Skills — discovery, preview, import and the switch that moves one out of the engine’s reach. `skills.rs` does all of that and has its own tests, but nothing builds a library from it and no command exposes one, so there is no state to read and nothing a window could install.',
            commands: 'Commands — the list an engine publishes for a session. It reaches the agent panel as it arrives and belongs to that one session, and there is no read of it a settings page can make.',
            mcp: 'MCP servers — the list, the configuration and the transports. Nothing was built for MCP in this build at all.',
            capabilities: 'What a model takes and what a session may do. A capability report belongs to one running session — the installation’s claim joined with what that runtime negotiated — so a settings page is not a place it can be shown: it has no session, and the answer would stop being true the moment the runtime changed.',
            engine: 'Choosing the engine a new session starts on. Engines can be added and switched off above, but a session always starts on the default one: the backend’s start call takes a folder and nothing else, so nothing in this window opens a session on another engine yet.',
            other: 'This section needs a host half this build does not have.',
          },
        },
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
        },
        empty: {
          line: '给 {engine} 发消息——输入 / 查看命令',
        },
        timeline: {
          aria: '智能体记录',
          you: '你',
          thoughtOpen: '收起思考过程',
          thoughtClosed: '展开思考过程',
          jump: '回到末尾',
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
          },
        },
        composer: {
          placeholder: '让智能体在这个文件夹里做点什么',
          send: '发送',
          stop: '停止',
          hint: '回车发送。引擎在你打开的文件夹内工作。',
          hintBusy: '本轮运行期间回车不会发送——文字会留在这里。',
          context: {
            add: '把这个文件夹里的文件加进消息',
            noFolder: '还没有打开可供智能体读取的文件夹',
            list: '这个文件夹里的文件',
            reading: '正在读取文件夹……',
            empty: '这个文件夹里没有内容',
            up: '上一级文件夹',
            unreadable: '无法读取该文件夹：{detail}',
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
      },
      permission: {
        argumentsPending: '引擎还没有发送参数',
        argumentsUnreadable: '引擎发送了本应用无法读取的参数',
        expired: '已不再等待——该请求已被处理',
        lastingGrant: '「始终允许」不只是这一次。引擎不会再就这个工具发问，并会把这次授权记录下来，因此它在本次会话结束后依然有效；本应用不会再收到通知，也没有任何地方能列出或收回它。',
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
            starting: '正在启动',
            ready: '运行中',
            failed: '启动失败',
          },
          authorization: {
            label: '授权',
            unknown: '尚未收到任何关于凭据的报告',
            required: '该引擎还没有任何供应商的凭据',
            configured: '该引擎报告已有某供应商的凭据',
            notAModel: '进程在跑就是进程在跑。它不等于模型可用：这里没有任何一条意味着提问会被回答。',
          },
          protocol: {
            label: '协议',
            version: '版本',
            none: '未协商',
            negotiated: '本次运行时已与引擎完成协商',
            notNegotiated: '本次运行时尚未协商',
          },
          capabilities: {
            title: '已经实测到的',
            hint: '安装声明只是启动前的提示。下面每一行都是握手时报告的结果，或者是「什么都没测过」——后者和「不支持」不是同一个答案。',
            advertised: '该引擎版本声明支持',
            notAdvertised: '该引擎版本未声明支持',
            unverified: '尚未对该引擎实测',
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
            scope: '范围',
            directory: '目录',
            noDescription: '没有描述',
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
            runtime: '运行时——进程状态、授权与协议版本。上面的注册表页回答了哪个程序、来自哪里、它自称了什么；而运行中引擎的状态没有任何地方回答，设置页也没有可以询问的会话。',
            skills: 'Skills——发现、预览、导入，以及把某个 Skill 移出引擎视野的开关。`skills.rs` 这些都有，也有自己的测试，但没有任何地方用它建起库，也没有命令暴露它，因此没有可读的状态，也没有窗口能装下的东西。',
            commands: '命令——引擎为某个会话发布的列表。它随发布到达智能体面板，且只属于那一个会话，设置页没有可以调用的读取。',
            mcp: 'MCP 服务器——列表、配置与传输方式。当前构建里完全没有为 MCP 实现任何东西。',
            capabilities: '模型接受什么、一个会话能做哪些事。能力报告属于某一个运行中的会话——安装声明与那次运行时协商出的结果合并而成——因此设置页不是显示它的地方：设置页没有会话，而那个答案在运行时变化的一刻就不再成立。',
            engine: '选择新会话使用哪个引擎。上面已经可以添加引擎、停用引擎，但会话总是启动在默认引擎上：后端的启动调用只接收一个文件夹，因此这个窗口目前无法在另一个引擎上打开会话。',
            other: '这一节需要的后端一半，当前构建还没有。',
          },
        },
      },
    },
  },
} as const
