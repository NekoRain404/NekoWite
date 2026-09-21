/**
 * E3 — the six settings sections, in a real browser.
 *
 * §10.2's T13 row asks for three things, and this file is what a browser can add to each of them:
 *
 *  - **模型/MCP/命令来源明确.** Every one of these is a *sentence on a page*, so it is exactly the
 *    kind of claim a unit test can assert and still be wrong about: the acceptance is that a person
 *    reading the screen can tell where a value came from. So each section is driven with a backend
 *    that reports more than one origin, and what is asserted is that the page draws them apart —
 *    the variable and path for one, the engine's own words for another, and a `data-origin` on
 *    every row so the distinction is structural rather than a matter of wording.
 *  - **导入不执行脚本.** A browser cannot prove this and this file does not pretend to. The proof is
 *    `R5` (`agent_skills_test.rs`), which runs the payload on purpose first and then shows the
 *    canary absent after an import. What is checked here is the page's half: that reading a folder
 *    produces a file list and a script list and says nothing has run, that pressing *Import* is a
 *    second, separate action, and that the only calls the page makes are the four its client has —
 *    the client has no method that could run anything, so a page that ran something would have to
 *    be reaching past it.
 *  - **禁用真实生效.** The fake backend here *moves* the skill between two lists, exactly as
 *    `skills.rs` does, so a switch that only hid the row would leave the numbers wrong. After the
 *    switch, the row is asserted to be gone from the found list and present in the switched-off
 *    list — the skill was not hidden, it was *put* somewhere else. The fake exists to make that
 *    observable in a browser; the real move is R5's.
 *
 * ## Why the sections are mounted here rather than found in the settings dialog
 *
 * Putting them into the settings tree is T16's (the task table puts navigation there), and until
 * that exists there is nothing in the running application to drive. So this spec mounts a section
 * in the page the dev server is already serving, exactly as E1 does for the panel and E4 for the
 * registry. Every assertion below stays true once the dialog hosts them; what this file does not
 * cover is the wiring.
 *
 * Vue is imported by URL rather than by name: a page has no import map, and the component has to be
 * compiled against the *same* Vue instance the dev server serves.
 */
import { expect, test, type Page } from '@playwright/test'

// Type-only, and that is the point: `vue-tsc` runs over `e2e/**` in this project, so annotating
// each fake with the section's own client port is the one place these components are checked
// against a caller. The imports are erased at run time — a page has no import map — but every
// method, argument and return shape below has to match what the component declares.
import type {
  AgentRuntimeClient,
  AgentRuntimeReadout,
} from '/src/features/agent-settings/components/AgentRuntimeSettings.vue'
import type { AgentProviderClient } from '/src/features/agent-settings/components/AgentProviderSettings.vue'
import type {
  AgentProfileReadout,
  ProfileUpdate,
} from '/src/features/agent-settings/services/agent-settings-policy.ts'
import type {
  AgentSkillsClient,
  SkillEntryView,
  SkillPreviewView,
  SkillRefusal,
  SkillScopeView,
} from '/src/features/agent-settings/components/AgentSkillsSettings.vue'
import type {
  AgentCommandsClient,
  AgentCommandsReadout,
} from '/src/features/agent-settings/components/AgentCommandsSettings.vue'
import type {
  AgentMcpClient,
  AgentMcpReadout,
} from '/src/features/agent-settings/components/AgentMcpSettings.vue'
import type {
  AgentPermissionClient,
  GrantsReadout,
  PermissionReadout,
} from '/src/features/agent-settings/services/agent-permission-ipc'

const SECTIONS = {
  runtime: { url: '/src/features/agent-settings/components/AgentRuntimeSettings.vue', host: 'e2e-runtime' },
  provider: { url: '/src/features/agent-settings/components/AgentProviderSettings.vue', host: 'e2e-provider' },
  skills: { url: '/src/features/agent-settings/components/AgentSkillsSettings.vue', host: 'e2e-skills' },
  commands: { url: '/src/features/agent-settings/components/AgentCommandsSettings.vue', host: 'e2e-commands' },
  mcp: { url: '/src/features/agent-settings/components/AgentMcpSettings.vue', host: 'e2e-mcp' },
  permission: { url: '/src/features/agent-settings/components/AgentPermissionSettings.vue', host: 'e2e-permission' },
} as const

type SectionName = keyof typeof SECTIONS

/** What the page's fake backend records, so a test can ask what the page actually did. */
interface Harness {
  calls: { method: string; args: unknown[] }[]
  unmount(): void
}

declare global {
  interface Window {
    __agentSettings?: Harness
  }
}

/**
 * Put one section on screen with a fake backend built inside the page.
 *
 * The payloads are passed as plain data and the client is assembled in the browser, because a
 * function cannot cross the `evaluate` boundary — and because the fake has to *mutate* its own state
 * when the page changes something, which is what makes "the next read reflects it" true here as it
 * is with the real backend.
 */
async function open(page: Page, section: SectionName, payload: unknown): Promise<void> {
  // The app's default locale is Chinese and these sections carry their own English copy today; the
  // pin is here so a later move into the catalogue does not change what is asserted. Everything
  // asserted below is a fact — a variable, a path, a file name — rather than a translation of one.
  await page.addInitScript(() => {
    localStorage.setItem('nekowite.locale', 'en')
  })
  await page.goto('/')
  await page.evaluate(
    async ({ section: name, url, hostId, data }) => {
      const source = await (await fetch('/src/main.ts')).text()
      const vueUrl = source.match(/["']([^"']*\/deps\/vue\.js[^"']*)["']/)?.[1]
      if (vueUrl === undefined) throw new Error('the dev server serves no vue dependency')
      const vue = (await import(/* @vite-ignore */ vueUrl)) as typeof import('vue')
      const component = (await import(/* @vite-ignore */ url)) as { default: unknown }

      window.__agentSettings?.unmount()

      const state: Harness = { calls: [], unmount: () => undefined }
      const record = (method: string, ...args: unknown[]): void => {
        state.calls.push({ method, args })
      }
      // The state the fake reads from, and *rewrites* when the page changes something — which is
      // what makes the next `read` reflect the change, as the real backend's does. `skills` and
      // `disabled` are the two lists a switch moves an entry between.
      const initial = data as Record<string, unknown>
      const skills = [...((initial.skills ?? []) as SkillEntryView[])]
      const disabled = [...((initial.disabled ?? []) as SkillEntryView[])]
      // The directories the engine's rules name, as `agent_skills_read` answers them for an
      // app-managed profile: the profile's own, and the two another tool owns — which this launch's
      // `OPENCODE_DISABLE_EXTERNAL_SKILLS` stops the engine reading. A payload may override the
      // list, which is what the tests about per-scope empty states and about a profile with nowhere
      // to import into do.
      const scopes = (initial.scopes ?? [
        {
          id: 'engine-global',
          label: 'This app’s profile, read by the engine',
          root: '/home/someone/profile/XDG_CONFIG_HOME/skills',
          suppressedBy: null,
        },
        {
          id: 'claude-code',
          label: 'Another tool’s directory (.claude)',
          root: '/home/someone/profile/HOME/.claude/skills',
          suppressedBy: 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
        },
        {
          id: 'agents-directory',
          label: 'Another tool’s directory (.agents)',
          root: '/home/someone/profile/HOME/.agents/skills',
          suppressedBy: 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
        },
      ]) as SkillScopeView[]
      const importScope = (initial.importScope === undefined ? 'engine-global' : initial.importScope) as string | null

      // One client per section, each annotated with the port that section declares. The annotation
      // is what makes this file evidence rather than a description: a component whose `read` grew a
      // parameter, or whose readout lost a field, fails to compile here.
      const readOnce = <T>(answer: T) => async (): Promise<T> => {
        record('read')
        return answer
      }
      const clients = {
        runtime: { read: readOnce(initial as unknown as AgentRuntimeReadout) } satisfies AgentRuntimeClient,
        provider: {
          read: readOnce(initial as unknown as AgentProfileReadout),
          write: async (write) => {
            record('write', write)
            // Annotated rather than inferred: the applied arm is one of three, and a bare literal
            // would be widened to `string` without something to check it against.
            const applied: ProfileUpdate = { status: 'applied', fields: write.fields }
            return applied
          },
        } satisfies AgentProviderClient,
        commands: { read: readOnce(initial as unknown as AgentCommandsReadout) } satisfies AgentCommandsClient,
        mcp: { read: readOnce(initial as unknown as AgentMcpReadout) } satisfies AgentMcpClient,
        permission: {
          read: readOnce(initial as unknown as PermissionReadout),
          // The grant half, driven from the same payload so one object describes the whole page.
          // The list is *rewritten* on revoke, which is what makes "the next read reflects the
          // engine" true here as it is with the real backend — and the arm is the payload's, so a
          // test can put the page in `unsupported` or `not-running` without a second switch.
          grants: async () => (initial.grants ?? { kind: 'not-running' }) as GrantsReadout,
          revoke: async (grantId) => {
            record('revoke', grantId)
            const answer = (initial.grants ?? { kind: 'not-running' }) as GrantsReadout
            if (answer.kind !== 'listed') return answer
            return { kind: 'listed', grants: answer.grants.filter((grant) => grant.id !== grantId) }
          },
        } satisfies AgentPermissionClient,
        skills: {
          read: async () => {
            record('read')
            return { scopes, importScope, skills: [...skills], disabled: [...disabled] }
          },
          preview: async (source) => {
            record('preview', source)
            // A payload with no preview answers as a refusal, which is a shape the page renders:
            // `'kind' in answer` has to be handed an object, never nothing.
            return (initial.preview ?? { kind: 'missing', path: source }) as SkillPreviewView | SkillRefusal
          },
          import: async (source, replace) => {
            record('import', source, replace)
            // A refused name is refused once. The second, explicit action is the one that replaces,
            // which is what the backend does with `Overwrite::Replace`.
            if (initial.importRefusal === undefined) return null
            return (replace ? (initial.replaceResult ?? null) : initial.importRefusal) as SkillRefusal | null
          },
          setEnabled: async (skillName, scope, enabled) => {
            record('setEnabled', skillName, scope, enabled)
            if (initial.setEnabledRefusal !== undefined) return initial.setEnabledRefusal as SkillRefusal
            // The move `skills.rs` performs, so a page that only hid the row would leave the two
            // lists disagreeing with what is on screen.
            const moving = skills.find((entry) => entry.name === skillName)
            if (moving === undefined) return null
            skills.splice(skills.indexOf(moving), 1)
            const stored: SkillEntryView = {
              ...moving,
              surface: { kind: 'disabled' },
              directory: `/store/disabled/${skillName}-0`,
            }
            disabled.push(stored)
            return null
          },
        } satisfies AgentSkillsClient,
      }

      const host = document.createElement('div')
      host.id = hostId
      host.style.cssText =
        'position: fixed; top: 0; left: 0; width: 540px; max-height: 100vh; overflow: auto; z-index: 60;'
      document.body.append(host)
      // The identity is the provider section's business; the others take only their client, and
      // handing them props they do not declare would put them in the DOM as attributes.
      const app = vue.createApp(
        component.default as never,
        name === 'provider'
          ? { client: clients[name], agentId: 'opencode', profileId: 'default' }
          : { client: clients[name] },
      )
      app.mount(host)
      state.unmount = () => app.unmount()
      window.__agentSettings = state
    },
    { section, url: SECTIONS[section].url, hostId: SECTIONS[section].host, data: payload },
  )
  await expect(page.locator(`#${SECTIONS[section].host} .settings-section`)).toBeAttached()
}

const calls = (page: Page) => page.evaluate(() => window.__agentSettings?.calls ?? [])

/** Only the calls the client actually has. Anything else would be a page reaching past its port. */
async function calledMethods(page: Page): Promise<string[]> {
  return (await calls(page)).map((call) => call.method)
}

const row = (page: Page, selector: string) => page.locator(selector)

test.describe('where a model comes from', () => {
  test('names the mode, the provider and every source, and never shows a credential value', async ({ page }) => {
    await open(page, 'provider', {
      profileId: 'default',
      agentId: 'opencode',
      mode: 'app-managed',
      root: '/home/someone/.local/share/nekowite/agent-profiles/default',
      revision: 'r1',
      provider: 'iapp',
      modelId: 'iapp/deepseek-v4-flash',
      editable: true,
      sources: [
        { kind: 'injected', variable: 'XDG_CONFIG_HOME', path: '/home/someone/.config' },
        // A `DiscoverySurface` id, not a sentence: the page's own copy is where the wording
        // lives, and the IPC layer refuses anything outside `DISCOVERY_SURFACES` before it could
        // reach the component. `project` is the surface this one is about — the folder a session
        // runs in and every folder above it.
        { kind: 'engine-discovery', what: 'project' },
      ],
      credentials: [{ name: 'NWK_TEST_KEY', value: 'sk-live-NEVER-PRINTED' }],
      credentialStorage: {
        kind: 'host-file',
        path: '/home/someone/.local/share/nekowite/agent-profiles/default/credentials.json',
        mode: '600',
        encrypted: false,
        keychain: false,
      },
    })

    // The two sources read differently, which is the whole point: one is something this app set,
    // the other is something it does not own and cannot claim to have closed (§8.1).
    await expect(row(page, '[data-test="provider-source-injected"]')).toContainText(
      'XDG_CONFIG_HOME = /home/someone/.config',
    )
    // The engine-discovery row draws the surface's own sentence, and the assertion is on the file
    // name in it — a fact, the way the row above is a variable and a path — not on the wording
    // around it.
    await expect(row(page, '[data-test="provider-source-engine-discovery"]')).toContainText(
      'opencode.json',
    )
    // §8.1: the storage is stated rather than implied — a file, with a mode, and not a keychain.
    await expect(row(page, '[data-test="provider-credential-storage"]')).toContainText('600')
    await expect(row(page, '[data-test="provider-credential-warning"]')).toContainText('not encrypted')
    // A credential's value is never sent to the page, and the assertion is on the whole document so
    // that a value reaching the DOM by any route fails it.
    expect(await page.locator(`#${SECTIONS.provider.host}`).innerText()).not.toContain('sk-live-NEVER-PRINTED')
  })

  test('shows nothing for a profile that belongs to another engine', async ({ page }) => {
    // §3.4's Profile row: credentials, model ids and configuration are never moved between engines,
    // so rendering one engine's model under another's heading is the confusion that row prevents.
    await open(page, 'provider', {
      profileId: 'default',
      agentId: 'acme',
      mode: 'app-managed',
      root: '/home/someone/.local/share/nekowite/agent-profiles/default',
      revision: 'r1',
      provider: 'iapp',
      modelId: 'iapp/deepseek-v4-flash',
      editable: true,
      sources: [],
      credentials: [],
      credentialStorage: { kind: 'none' },
    })
    await expect(row(page, '[data-test="provider-mismatch"]')).toBeVisible()
    await expect(row(page, '[data-test="provider-field-provider"]')).toHaveCount(0)
    await expect(row(page, '[data-test="provider-save"]')).toHaveCount(0)
  })
})

test.describe('where a command comes from', () => {
  test('draws the session list and the file list as the different things they are', async ({ page }) => {
    await open(page, 'commands', {
      session: { sessionId: 'ses_abc', commands: [{ name: 'init', description: 'Initialise', hint: null }] },
      sources: [
        {
          origin: { kind: 'engine', what: 'the project .opencode/command directory' },
          commands: [{ name: 'deploy', description: 'Deploy', hint: 'a branch name' }],
        },
      ],
      appCommands: [{ name: 'Insert selection', description: 'Into the open note', hint: null }],
      limits: ['undo-redo', 'parameters'],
    })

    await expect(row(page, '[data-test="commands-session-id"]')).toContainText('ses_abc')
    await expect(row(page, '[data-test="command-session-init"]')).toHaveCount(1)
    await expect(row(page, '[data-test="command-source-0"]')).toHaveAttribute('data-origin', 'engine')
    await expect(row(page, '[data-test="command-source-0"]')).toContainText('deploy')
    // §3.4.6 and §4.1: the unsupported things are named rather than left to be discovered.
    await expect(row(page, '[data-test="command-limit-undo-redo"]')).toContainText('Undo and redo')
    // Nothing on this page runs anything — there is no control at all, and no call but `read`.
    expect(await calledMethods(page)).toEqual(['read'])
  })

  test('says a session has published nothing rather than showing an empty list', async ({ page }) => {
    await open(page, 'commands', {
      session: null,
      sources: [],
      appCommands: [],
      limits: [],
    })
    await expect(row(page, '[data-test="commands-session-none"]')).toContainText('has not published')
    await expect(row(page, '[data-test="commands-sources-empty"]')).toBeVisible()
  })
})

test.describe('where an MCP server comes from', () => {
  test('names each server’s origin and warns about every local one', async ({ page }) => {
    await open(page, 'mcp', {
      servers: [
        {
          name: 'local-thing',
          origin: { kind: 'engine', what: 'the engine’s own configuration file' },
          transport: 'local',
          enabled: true,
          command: ['npx', '-y', '@playwright/mcp'],
          credentials: ['API_TOKEN'],
          diagnostic: null,
        },
        {
          name: 'remote-thing',
          origin: { kind: 'host', variable: null, path: '/home/someone/profile' },
          transport: 'http',
          enabled: true,
          command: null,
          credentials: [],
          diagnostic: 'connected',
        },
      ],
      transports: [
        { transport: 'local', advertised: true },
        { transport: 'http', advertised: true },
        { transport: 'sse', advertised: false },
      ],
    })

    await expect(row(page, '[data-test="mcp-row-local-thing"]')).toHaveAttribute('data-transport', 'local')
    await expect(row(page, '[data-test="mcp-row-local-thing"] [data-origin]')).toHaveAttribute('data-origin', 'engine')
    await expect(row(page, '[data-test="mcp-row-remote-thing"] [data-origin]')).toHaveAttribute('data-origin', 'host')
    // §4.2: 启动本地 MCP 等于执行程序，需单独信任 — and the sentence is on the local server only,
    // because a remote one is not a program this machine runs.
    await expect(row(page, '[data-test="mcp-row-local-thing"] [data-test="mcp-trust"]')).toContainText(
      'runs a program',
    )
    await expect(row(page, '[data-test="mcp-row-remote-thing"] [data-test="mcp-trust"]')).toHaveCount(0)
    // A credential is a name; the value never reaches the page.
    await expect(row(page, '[data-test="mcp-row-local-thing"]')).toContainText('API_TOKEN')
    // The engine starts servers, so this page has no control over one.
    expect(await page.locator(`#${SECTIONS.mcp.host} button`).count()).toBe(0)
  })
})

test.describe('what the runtime has actually been measured to do', () => {
  test('keeps "running" and "a model will answer" apart', async ({ page }) => {
    // The fixture is in the **page's** vocabulary, not the wire's — `open` hands it straight to the
    // client as an `AgentRuntimeReadout`, so the port's narrowing never runs and a fixture written
    // in the wire's shape fails in a way that looks like a missing element: `capabilities[].standing`
    // comes out `undefined`, and Vue omits an attribute whose binding is undefined, so the rows draw
    // and the `[data-standing]` locator finds none of them.
    //
    // The three fields that did move are the page's own, and each moved for a reason worth keeping
    // straight: `version` is `reportedVersion` (the registration's answer, which this host may not
    // have), `update.policy` is `updatePolicy`, and the flat `protocol` is a two-armed `handshake`
    // — because the protocol version is a fact of the handshake, and the handshake is per
    // incarnation, so a page that drew it unconditionally was drawing it when there was none.
    // `authorization` is gone: no ACP field carries an authorization state and this host never calls
    // `authenticate`, so it could only have asserted a fact nothing had stated. What replaced it is
    // the engine's own advertised `authMethods`, inside the handshake, drawn as a report.
    await open(page, 'runtime', {
      agentId: 'opencode',
      displayName: 'OpenCode',
      source: 'bundled',
      program: '/opt/nekowite/opencode',
      reportedVersion: '1.18.29',
      adapterId: 'opencode',
      process: 'ready',
      updatePolicy: 'reported-only',
      handshake: {
        status: 'read',
        protocolVersion: 1,
        agentName: 'OpenCode',
        agentVersion: '1.18.29',
        authMethods: [{ id: 'login', name: 'Log in' }],
      },
      // `host` is the page's third subject and it is **required** — `agent-runtime-ipc.ts:186` makes a
      // row without it a *rejection of the whole readout*, not a row whose member is missing, so a
      // fixture that omits it leaves the page with nothing to draw and every later locator fails with
      // "not found". That is the same trap the paragraph above describes from the other side, and it
      // caught this file on 2026-09-18 when the member was added: the fixture was right when it was
      // written and the page moved. The three values below are `capabilities.rs`'s `host_offer` for
      // these three features, read out of it rather than invented — a fixture that guessed would
      // assert a claim about the shipped command surface that is not true of it.
      capabilities: [
        { feature: 'slash-commands', declared: 'not-advertised', standing: 'advertised', detail: null, host: { status: 'control' } },
        { feature: 'audio-attachments', declared: 'not-advertised', standing: 'not-advertised', detail: 'not advertised by this engine', host: { status: 'nothing' } },
        { feature: 'session-config-options', declared: 'advertised', standing: 'unverified', detail: 'no session has been opened in this run', host: { status: 'command', command: 'agent_set_config_option' } },
      ],
    })

    await expect(row(page, '[data-test="runtime-program"]')).toContainText('/opt/nekowite/opencode')
    await expect(row(page, '[data-test="runtime-version"]')).toContainText('1.18.29')
    // §3.1.4: 进程就绪 is not 模型可用, and the page says it next to the states it could be confused with.
    await expect(row(page, '[data-test="runtime-process"]')).toContainText('Running')
    await expect(row(page, '[data-test="runtime-not-a-model"]')).toContainText('not a model')
    await expect(row(page, '[data-test="runtime-source"]')).toContainText('Bundled with NekoWite')
    // §3.4.6: 未实测 is a third answer, not a synonym for "does not support it".
    const standings = await page.locator(`#${SECTIONS.runtime.host} [data-standing]`).allInnerTexts()
    expect(new Set(standings.map((line) => line.trim())).size).toBe(3)
    // The report's other half, on the rows where it disagrees with the finding: two of the three
    // fixture rows are disagreements and `audio-attachments` is not — so the count is the
    // comparison reaching the screen rather than the field rendering under every row.
    const host = `#${SECTIONS.runtime.host}`
    await expect(page.locator(`${host} [data-declaration]`)).toHaveCount(2)
    await expect(
      page.locator(`${host} [data-test="runtime-capability-session-config-options"] [data-declaration]`),
    ).toContainText('on file as advertising this feature')
    await expect(
      page.locator(`${host} [data-test="runtime-capability-audio-attachments"] [data-declaration]`),
    ).toHaveCount(0)
  })
})

test.describe('importing a skill', () => {
  const READOUT = {
    skills: [
      {
        name: 'demo',
        description: 'A demo skill.',
        directory: '/home/someone/skills/demo',
        scope: 'engine-global',
        scopeLabel: 'This app’s profile',
        owner: 'managed',
        conflicts: [],
        surface: { kind: 'offered' },
        disable: { kind: 'per-skill' },
      },
    ],
    disabled: [],
    preview: {
      name: 'demo',
      description: 'A demo skill.',
      files: [
        { path: 'SKILL.md', bytes: 120 },
        { path: 'scripts/run.sh', bytes: 64 },
      ],
      scripts: [{ path: 'scripts/run.sh', bytes: 64 }],
      totalBytes: 184,
    },
  }

  test('reads a folder first, names its scripts, and imports only on a second action', async ({ page }) => {
    await open(page, 'skills', READOUT)
    await row(page, '[data-test="skills-source"]').fill('/home/someone/incoming/demo')
    // `skills-preview` names two different things: the *button* that reads the folder, and the
    // *panel* it draws the answer into. Each locator below therefore says which one it means.
    // The button is what gets clicked; the panel is what the assertions are about.
    await row(page, 'button[data-test="skills-preview"]').click()

    await expect(row(page, 'div[data-test="skills-preview"]')).toBeVisible()
    await expect(row(page, '[data-test="skills-scripts"]')).toContainText('scripts/run.sh')
    // The sentence the acceptance turns on. The proof is R5's canary; this is the page saying it,
    // and the call record below is the page not having done anything else.
    await expect(row(page, '[data-test="skills-nothing-run"]')).toContainText('has been run')
    expect(await calledMethods(page)).toEqual(['read', 'preview'])

    await row(page, '[data-test="skills-confirm"]').click()
    // The trailing `read` is the page re-reading after a change, which is what every client here
    // promises and what the sibling test below asserts of a switch-off (`read`, `setEnabled`,
    // `read`). The claim this sequence makes is unchanged: an import, and nothing that could run
    // anything.
    await expect
      .poll(() => calledMethods(page))
      .toEqual(['read', 'preview', 'import', 'read'])
    // `import` was sent the path and "do not replace"; there is no argument that could run a script.
    // Named rather than taken as the last call, because the re-read above comes after it.
    const sent = (await calls(page)).filter((call) => call.method === 'import').at(-1)
    expect(sent?.args).toEqual(['/home/someone/incoming/demo', false])
  })

  test('opens the replace path only after the name was refused', async ({ page }) => {
    // §8.2: 覆盖必须确认并保留可恢复副本. The confirmation is a second control that only exists once
    // the first attempt has failed, so replacing can never be the default path through the form.
    await open(page, 'skills', {
      ...READOUT,
      importRefusal: { kind: 'name-taken', name: 'demo', directory: '/home/someone/skills/demo' },
      replaceResult: null,
    })
    await row(page, '[data-test="skills-source"]').fill('/home/someone/incoming/demo')
    await row(page, 'button[data-test="skills-preview"]').click()
    await expect(row(page, '[data-test="skills-replace"]')).toHaveCount(0)

    await row(page, '[data-test="skills-confirm"]').click()
    await expect(row(page, '[data-test="skills-preview-refusal"]')).toContainText('already installed')
    await expect(row(page, '[data-test="skills-replace-warning"]')).toContainText('recoverable')
    await row(page, '[data-test="skills-replace"]').click()
    await expect
      .poll(async () => (await calls(page)).filter((call) => call.method === 'import').map((call) => call.args[1]))
      .toEqual([false, true])
  })
})

test.describe('switching a skill off', () => {
  const ENTRY = {
    name: 'noisy',
    description: 'A skill.',
    directory: '/home/someone/profile/skills/noisy',
    scope: 'engine-global',
    scopeLabel: 'This app’s profile',
    owner: 'managed',
    conflicts: [],
    surface: { kind: 'offered' },
    // The scope's own fact, and not a decoration: `SkillEntryView.suppressedBy` is required, and
    // the page reads it to choose between "the engine skips this directory when {variable} is
    // set" and "this launch sets it". A fixture that leaves it out is not the shape a backend
    // hands over, and the page then takes the second sentence with nothing to put in it —
    // drawing a literal `{variable}` to the reader.
    suppressedBy: null,
    disable: { kind: 'per-skill' },
  }

  test('moves the skill out of what the engine finds, rather than hiding the row', async ({ page }) => {
    await open(page, 'skills', { skills: [ENTRY], disabled: [], preview: null })
    await expect(row(page, '[data-test="skill-row-noisy"]')).toBeVisible()

    await row(page, '[data-test="skill-disable-noisy"]').click()

    // The row is *gone from the found list* and *present in the switched-off list*: it was moved,
    // not hidden. A page that only hid it would fail the second assertion.
    await expect(row(page, '[data-test="skill-row-noisy"]')).toHaveCount(0)
    await expect(row(page, '[data-test="skill-off-noisy"]')).toBeVisible()
    await expect(row(page, '[data-test="skill-off-noisy"] [data-surface="disabled"]')).toContainText(
      'outside every directory',
    )
    // And the switch that put it there is not drawn on the switched-off row's own terms: the way
    // back is a separate control, so "off" is not a state a second click on the same button undoes.
    await expect(row(page, '[data-test="skill-enable-noisy"]')).toBeVisible()
    expect((await calls(page)).map((call) => call.method)).toEqual(['read', 'setEnabled', 'read'])
  })

  test('draws no control where the backend says there is no switch', async ({ page }) => {
    // §8.2: 不能仅隐藏 UI 项目而声称已禁用. Two of the three arms have nothing this app can throw,
    // so they draw the reason and no control — which is what there is to assert about them.
    await open(page, 'skills', {
      skills: [
        {
          ...ENTRY,
          name: 'borrowed',
          scope: 'claude-code',
          owner: 'foreign',
          disable: { kind: 'engine-switch', variable: 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS' },
        },
        {
          // The third arm of `DisableMechanism`: a directory whose contents nothing this host does
          // can switch off. It is a path the *engine's configuration* declares, which is what a
          // second engine's adapter could hand over and what this page's own backend does not
          // return today — the settings page's scope list has neither that arm nor a project's,
          // because a project needs a folder this dialog does not have. The page's arm is asserted
          // here all the same: it is what stands wherever a directory with no switch turns up.
          ...ENTRY,
          name: 'declared-one',
          scope: 'declared-0',
          owner: 'foreign',
          scopeLabel: 'Declared in the engine’s configuration',
          disable: { kind: 'none' },
        },
      ],
      disabled: [],
      preview: null,
    })

    await expect(row(page, '[data-test="skill-disable-borrowed"]')).toHaveCount(0)
    await expect(row(page, '[data-test="skill-disable-declared-one"]')).toHaveCount(0)
    const notes = page.locator('[data-test="skill-no-switch"]')
    await expect(notes.nth(0)).toContainText('OPENCODE_DISABLE_CLAUDE_CODE_SKILLS')
    await expect(notes.nth(1)).toContainText('would only hide the row')
    // Nothing was sent, because there was nothing to send.
    expect(await calledMethods(page)).toEqual(['read'])
  })

  test('reports a duplicate name as a conflict and names no winner', async ({ page }) => {
    await open(page, 'skills', {
      skills: [
        { ...ENTRY, conflicts: ['/home/someone/notes/.opencode/skills/noisy'] },
      ],
      disabled: [],
      preview: null,
    })
    const conflict = row(page, '[data-test="skill-conflict"]')
    await expect(conflict).toContainText('/home/someone/notes/.opencode/skills/noisy')
    // What was observed of the pinned engine is not a precedence, so the page nominates no winner
    // and gives the one next move that is true either way: remove one of them.
    await expect(conflict).toContainText('remove one')
  })
})

test.describe('what the skills page says instead of drawing a control', () => {
  test('gives every directory its own state, and never calls an unread one empty', async ({ page }) => {
    // One directory with a skill, one that is empty, and one this launch stopped the engine
    // reading. The three answers are different and each is drawn where it belongs: "no skills" is a
    // claim about contents, and a page that made it for a directory nothing is looking at would be
    // the flattering-direction claim §8.2 exists to prevent.
    await open(page, 'skills', {
      skills: [
        {
          name: 'demo',
          description: 'A demo skill.',
          directory: '/home/someone/profile/XDG_CONFIG_HOME/skills/demo',
          scope: 'engine-global',
          scopeLabel: 'This app’s profile',
          owner: 'managed',
          conflicts: [],
          surface: { kind: 'offered' },
          suppressedBy: null,
          disable: { kind: 'per-skill' },
        },
      ],
      disabled: [],
      // The default list has both compatible-tool directories suppressed, which is the launch
      // this app makes. `.agents` is turned back on here so that the three states are all on
      // screen at once: one directory with a skill, one the engine reads and finds nothing in, and
      // one it is not reading at all.
      scopes: [
        {
          id: 'engine-global',
          label: 'This app’s profile, read by the engine',
          root: '/home/someone/profile/XDG_CONFIG_HOME/skills',
          suppressedBy: null,
        },
        {
          id: 'claude-code',
          label: 'Another tool’s directory (.claude)',
          root: '/home/someone/profile/HOME/.claude/skills',
          suppressedBy: 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
        },
        {
          id: 'agents-directory',
          label: 'Another tool’s directory (.agents)',
          root: '/home/someone/profile/HOME/.agents/skills',
          suppressedBy: null,
        },
      ],
    })

    await expect(row(page, '[data-test="skill-scope-engine-global"]')).toContainText(
      '/home/someone/profile/XDG_CONFIG_HOME/skills',
    )
    await expect(row(page, '[data-test="skill-row-demo"]')).toBeVisible()
    // A directory the engine reads and finds nothing in.
    await expect(row(page, '[data-test="skill-scope-empty-agents-directory"]')).toContainText(
      'no skills in this directory',
    )
    // And one it is not reading at all: the sentence is the scope's, and it names the switch —
    // never "no skills found", which would be a claim about a directory nobody looked at.
    await expect(row(page, '[data-test="skill-scope-unread-claude-code"]')).toContainText(
      'OPENCODE_DISABLE_EXTERNAL_SKILLS',
    )
    await expect(row(page, '[data-test="skill-scope-empty-claude-code"]')).toHaveCount(0)
  })

  test('states the project scope and the declared paths rather than drawing either', async ({ page }) => {
    // §5.2's 「不可用选项要说明原因」. Two directories this page cannot manage, both with the reason
    // the backend really has: a project needs a folder the dialog does not have, and `skills.paths`
    // lives in a document this page does not parse. Neither is drawn as a control, and there is no
    // `input`, `button` or `select` anywhere in the block that says so.
    await open(page, 'skills', { skills: [], disabled: [] })

    const project = row(page, '[data-test="skills-project-scope"]')
    await expect(project).toContainText('.opencode/skills')
    await expect(project).toContainText('which project')
    const declared = row(page, '[data-test="skills-declared-scope"]')
    await expect(declared).toContainText('skills.paths')
    const block = page.locator('[data-test="skills-unmanaged"]')
    expect(await block.locator('input, button, select, [role="switch"]').count()).toBe(0)
    expect(await calledMethods(page)).toEqual(['read'])
  })

  test('says why there is no import form when this profile has nowhere to install', async ({ page }) => {
    // A profile reusing the user's own installation: no directory in its scope list is this app's,
    // so the form would have exactly one outcome — a refusal. The sentence says what such a profile
    // would need instead.
    await open(page, 'skills', {
      skills: [],
      disabled: [],
      scopes: [
        {
          id: 'claude-code',
          label: 'Another tool’s directory (.claude)',
          root: '/home/someone/.claude/skills',
          suppressedBy: null,
        },
      ],
      importScope: null,
    })

    await expect(row(page, '[data-test="skills-no-import"]')).toContainText('nothing here to import into')
    await expect(row(page, '[data-test="skills-source"]')).toHaveCount(0)
    await expect(row(page, 'button[data-test="skills-preview"]')).toHaveCount(0)
  })
})

test.describe('what a permission prompt can and cannot promise', () => {
  test('shows the engine’s own options and refuses to claim isolation', async ({ page }) => {
    // `written` is the state this app reaches for a profile it manages, and the only one that
    // draws rules — the other two are profiles where this app wrote nothing, and the page says so
    // rather than showing rules the engine was never given.
    await open(page, 'permission', {
      state: 'written',
      rules: [
        {
          tool: 'edit',
          action: 'ask',
          origin: { kind: 'host', variable: null, path: '/profiles/default/XDG_CONFIG_HOME/opencode/opencode.json' },
        },
        {
          tool: 'bash',
          action: 'ask',
          origin: { kind: 'host', variable: null, path: '/profiles/default/XDG_CONFIG_HOME/opencode/opencode.json' },
        },
      ],
      // Empty, and it is the honest value: the offered options arrive with a request, and this
      // page is read with no session running.
      optionKinds: [],
      limits: ['not-a-sandbox', 'no-isolation', 'stale-requests', 'no-silent-approval'],
      // An empty persistent store cannot establish absence of temporary ACP grants.
      grants: { kind: 'listed', grants: [] },
    })

    await expect(row(page, '[data-test="permission-state"]')).toContainText('asks before it changes your files')
    await expect(row(page, '[data-test="permission-rule-edit"]')).toContainText('ask')
    // §6.3: the options come from the engine, and this app adds none of its own.
    await expect(row(page, '[data-test="permission-no-invention"]')).toContainText('no option of its own')
    // §6.3's closing paragraph, on screen: an unbuilt sandbox must not be displayed as one.
    await expect(row(page, '[data-test="permission-limit-not-a-sandbox"]')).toContainText('not a sandbox')
    await expect(row(page, '[data-test="permission-limit-no-isolation"]')).toContainText('nothing here is isolated')
    // Only listed persistent rows can be revoked through this page.
    await expect(row(page, '[data-test="grants-empty"]')).toContainText('no saved permission rules')
    await expect(row(page, '[data-test="grants-empty"]')).toContainText('does not mean there are no active temporary grants')
    expect(await page.locator(`#${SECTIONS.permission.host} button`).count()).toBe(0)
  })

  test('never draws "cannot ask" as "you have granted nothing"', async ({ page }) => {
    // The two arms that are not a list. Either one rendered as an empty list would be this page
    // claiming consent it never established, which is the defect this surface exists to remove.
    await open(page, 'permission', {
      state: 'written',
      rules: [],
      optionKinds: [],
      limits: ['not-a-sandbox'],
      grants: { kind: 'unsupported' },
    })
    await expect(row(page, '[data-test="grants-unsupported"]')).toContainText('does not report the permissions')
    await expect(page.locator('[data-test="grants-empty"]')).toHaveCount(0)

    await open(page, 'permission', {
      state: 'written',
      rules: [],
      optionKinds: [],
      limits: ['not-a-sandbox'],
      grants: { kind: 'not-running' },
    })
    await expect(row(page, '[data-test="grants-not-running"]')).toContainText('No agent is running')
    await expect(page.locator('[data-test="grants-empty"]')).toHaveCount(0)
  })

  test('revokes one grant and shows what the engine holds afterwards', async ({ page }) => {
    await open(page, 'permission', {
      state: 'written',
      rules: [],
      optionKinds: [],
      limits: ['not-a-sandbox'],
      grants: {
        kind: 'listed',
        grants: [
          { id: 'psv_1', projectId: 'global', action: 'edit', resource: '*' },
          { id: 'psv_2', projectId: 'global', action: 'bash', resource: '*' },
        ],
      },
    })

    await expect(row(page, '[data-test="grant-psv_1"]')).toContainText('edit')
    await expect(row(page, '[data-test="grant-psv_1"]')).toContainText('global')
    await page.click('[data-test="grant-revoke-psv_1"]')

    // The list is the engine's own answer after the removal, not this page's edit of a copy.
    await expect(page.locator('[data-test="grant-psv_1"]')).toHaveCount(0)
    await expect(row(page, '[data-test="grant-psv_2"]')).toContainText('bash')
    const calls = await page.evaluate(() => window.__agentSettings?.calls ?? [])
    expect(calls.some((call) => call.method === 'revoke' && call.args[0] === 'psv_1')).toBe(true)
  })
})
