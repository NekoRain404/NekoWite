/**
 * What the focus probe measures, and the fixture that mounts the surfaces nothing hosts yet.
 *
 * Split out of `probe-focus-ring.mjs` at the line budget, and along the seam it already had: the
 * probe is the METHOD (press a real Tab, read what the engine paints, diff the pixels, hold every
 * claim to a witness) and this file is the SUBJECT — which surfaces are read, where each one's
 * indicator has to appear, and the props each unhosted component needs in order to draw its target
 * element at all. Both halves name their readings after the surface they came from, so a stale
 * fixture reports itself by name rather than as a number nobody can place.
 */
/**
 * The surfaces, and where each one's indicator has to appear.
 *
 * `page` entries are already on screen — the reading is taken on the product's own DOM, in the
 * product's own rail, and those are the strongest readings this file produces. `mount` entries
 * are the ones nothing hosts yet; the component URL is what the dev server serves.
 */
export const PAGE_SURFACES = [
  { name: 'agent transcript', sel: '.agent-timeline', page: 'agent' },
  { name: 'permission arguments', sel: '.agent-perm-args', page: 'agent' },
  { name: 'chat transcript', sel: '.chat-scroll', page: 'chat' },
  // The two the first run of this probe reported and did not own (`src/ui/TabBar.vue`'s roving
  // tab stop, `features/graph`'s canvas). Both are on the page the harness boots — the tab bar is
  // the shell's own, and the graph is the note list column's third body — so both are read on the
  // product's own screens rather than mounted. `prep` is what has to happen before the reading,
  // and it is a pointer gesture, which is why it runs with the rail's click and not in the loop.
  { name: 'tab bar tab', sel: '.tab-bar .tab', page: 'app' },
  { name: 'graph canvas', sel: '.graph-canvas', page: 'app', prep: 'graph' },
]

/**
 * The mounts, one per surface nothing hosts.
 *
 * Each entry carries only what the component needs to DRAW its target element. The fixtures are
 * deliberately thin, and a fixture that goes stale — a prop renamed, an element moved behind
 * another condition — is not a silent pass: the mount either throws or leaves no target on screen,
 * and both are reported as failures that name the surface.
 */
export const MOUNTS = [
  {
    name: 'changes buffer text',
    url: '/src/features/agent/components/AgentChangesView.vue',
    sel: '.agent-changes-text',
    props: {
      rows: [
        {
          path: 'notes/probe.md',
          attribution: 'agent',
          toolCallId: 'probe-call-1',
          tool: 'edit',
          status: 'completed',
          verdict: {
            kind: 'unsaved-edits',
            bufferText: '# probe\n\nthe unsaved buffer, which is the element under measurement',
            diskText: '# probe\n\nwhat the file holds',
          },
          offers: ['view', 'merge', 'recover'],
          refused: null,
        },
      ],
      labels: {
        title: 'Changes',
        empty: 'Nothing has changed yet',
        close: 'Close',
        attribution: {
          agent: 'The agent changed this file',
          external: 'This file changed outside the agent',
          reported: 'The engine reported this file',
        },
        verdict: { followsDisk: 'No unsaved edits', unsavedEdits: 'This note has unsaved edits' },
        offer: { view: 'View', merge: 'Merge', recover: 'Recover' },
        refused: {
          notAgentChange: 'Nothing recorded a change to put back',
          writeInFlight: 'The agent is still writing this file',
          unsavedEdits: 'Deal with the unsaved edits first',
        },
        unsavedBuffer: 'Your unsaved text',
        diskUnread: 'The file was not read',
      },
    },
  },
  {
    name: 'conflict texts',
    url: '/src/features/agent/components/AgentEditConflictView.vue',
    sel: '.agent-conflict-text',
    all: true,
    props: {
      conflicts: [
        {
          status: 'conflict',
          path: 'notes/probe.md',
          agentText: '# probe\n\nrewritten by the agent',
          noteText: '# probe\n\nwhat was typed while it thought',
          baselineRevision: 'r1',
          currentRevision: 'r7',
        },
      ],
      labels: {
        title: 'This note changed while the agent was working',
        moved: 'was edited after the request went out',
        agentText: 'What the agent produced',
        noteText: 'What the note holds now',
        apply: 'Use the agent version',
        discard: 'Keep my version',
        kept: 'Your text is kept when you apply.',
      },
    },
  },
  {
    name: 'native terminal screen',
    url: '/src/features/agent/components/AgentNativeTerminal.vue',
    sel: '.agent-native-screen',
    props: {
      session: {
        sessionId: 'probe-terminal',
        program: 'opencode',
        args: [],
        install: 'bundled',
        state: 'running',
      },
      // Built in the page, not passed in: WebDriver serializes the fixture as JSON, and the
      // functions a transport is made of do not survive the trip — the first run of this probe
      // reported `props.transport.subscribe is not a function` and mounted nothing. `stubTransport`
      // is the page's own no-op, so the component still draws its screen and the reading is about
      // the screen rather than about a transport that was never there.
      stubTransport: true,
      labels: {
        title: 'Terminal',
        program: 'Program',
        profile: 'Profile',
        state: { running: 'Running', exited: 'Exited', failed: 'Failed' },
        ended: { code: 'exit code', signal: 'signal', unknown: 'no status' },
        rights: 'This runs with your own rights.',
        managed: 'Managed by this app.',
        elided: 'Part of a line was cut',
        dropped: 'Earlier output was dropped',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        close: 'Close',
        confirm: { title: 'Close?', body: 'It is still running.', keep: 'Keep', confirm: 'Close' },
        unavailable: 'The host refused',
        refusal: {},
      },
    },
  },
  {
    name: 'pet task rows box',
    url: '/src/features/desktop-pet/components/PetTaskList.vue',
    sel: '.pet-task__scroll',
    // Enough rows to put something below the fold, which is the reason the box is focusable at
    // all: a box that fits its content is a tab stop nothing needs.
    props: {
      now: 1_700_000_000_000,
      tasks: Array.from({ length: 12 }, (_, i) => ({
        key: {
          agentId: 'probe-agent',
          profileId: 'probe-profile',
          runtimeEpoch: 'probe-epoch-1',
          vaultId: 'probe-vault',
          sessionId: `probe-session-${i}`,
          runId: `probe-run-${i}`,
        },
        state: i % 3 === 0 ? 'working' : i % 3 === 1 ? 'waiting-input' : 'turn-finished',
        permissionRequestId: null,
        updatedAt: 1_700_000_000_000 - i * 1000,
      })),
    },
  },
]

/**
 * The mount script, run in the page.
 *
 * Vue comes from the dev server's own transform of `main.ts` rather than from a URL written here,
 * which is the existing specs' device and is load-bearing: a second copy of Vue would compile the
 * SFCs against a different runtime and the components would silently not be the ones the app
 * ships.
 */
export const MOUNT_SCRIPT = `
const done = arguments[arguments.length - 1];
const spec = arguments[0];
(async function () {
  const source = await (await fetch('/src/main.ts')).text();
  const found = source.match(/["']([^"']*[/]deps[/]vue[.]js[^"']*)["']/);
  if (!found) { done({ why: 'the dev server serves no vue dependency' }); return; }
  const vue = await import(found[1]);
  try {
    const mod = await import(spec.url);
    const host = document.createElement('div');
    host.className = 'nkw-focus-host';
    host.setAttribute('data-nkw-focus-host', spec.name);
    // **One at a time, and one host on the page.** A fixed overlay big enough to draw the
    // component in is also big enough to cover the next one: the first version mounted all four
    // at once, offset by eight pixels each, and every surface but the last read as a sliver of
    // itself — the ring of the one underneath was painted and then hidden behind the one on top,
    // and the pixel diff called that "no indicator". The reading was the instrument's, not the
    // engine's, and it took a control whose ring is not in question (the last host, the pet rows
    // box, the only one nothing covered) to see it.
    host.style.cssText =
      'position: fixed; top: 40px; left: 40px; width: 420px; z-index: 40;' +
      'background: var(--app-canvas, #ffffff);';
    // **Inside the themed root, not beside it.** AppShell carries data-theme on its own
    // element and palettes.css keys every colour off it, so a host appended to document.body
    // renders under the :root default while the app renders under the chosen theme — the first
    // version measured every ring in the LIGHT accent while the rail it was comparing against was
    // in the dark one, and the two readings were not the same reading.
    const themed = document.querySelector('[data-theme]') || document.body;
    themed.append(host);
    const props = Object.assign({}, spec.props);
    // The one fixture that cannot come through the wire, built here. A terminal with no transport
    // cannot draw, and the component is right to refuse rather than pretend.
    if (props.stubTransport) {
      delete props.stubTransport;
      props.transport = {
        write: function () { return Promise.resolve(); },
        resize: function () { return Promise.resolve(); },
        close: function () { return Promise.resolve(); },
        subscribe: function () { return function () {}; }
      };
    }
    const app = vue.createApp({ render: function () { return vue.h(mod.default, props); } });
    app.mount(host);
    window.__nkwFocusHost = { app: app, host: host };
    done({ name: spec.name, url: spec.url, ok: true, stubbed: Boolean(spec.props.stubTransport) });
  } catch (error) {
    done({ name: spec.name, url: spec.url, ok: false, why: String(error && error.message ? error.message : error) });
  }
})();
`

/** Take the previous host off the page, so the next reading has the screen to itself. */
export const UNMOUNT_SCRIPT = `
const held = window.__nkwFocusHost;
if (!held) return { unmounted: false };
held.app.unmount();
held.host.remove();
window.__nkwFocusHost = null;
return { unmounted: true, left: document.querySelectorAll('.nkw-focus-host').length };
`

/**
 * The stops this task gave a ring, one per class, read as pixels.
 *
 * The census says whose ring each stop declares and whether layout leaves it on screen; this is
 * the reading that cannot lie about either, because it is a screenshot diff around the element's
 * own box before and after focus. The previous defect survived precisely here — a declaration
 * said the ring was there and no pixel changed — so the stops that were repaired are measured
 * the way that defect was found rather than only the way the list was made.
 *
 * One per CLASS rather than one per stop: the three window controls and the four stops that share
 * a rule with a sibling differ in nothing this reading can see. Each entry names the class the
 * rule was written for, and the file it was written in, so a reading with no pixels under it says
 * where to look. An entry whose element is not on this page is reported as absent rather than
 * skipped silently — the chat panel's session tool is not on the agent page.
 */
export const RING_PIXEL_STOPS = [
  { name: 'title bar sidebar toggle', sel: '.tb-btn', rule: 'ui/TitleBar.vue' },
  { name: 'window controls', sel: '.tb-window-btn', rule: 'ui/TitleBar.vue' },
  { name: 'sidebar group header', sel: '.group-header', rule: 'styles/components.css' },
  { name: 'sidebar footer buttons', sel: '.footer-btn', rule: 'styles/components.css' },
  { name: 'graph toolbar toggles', sel: '.graph-toggle input', rule: 'styles/components.css' },
  { name: 'status bar buttons', sel: '.status-btn', rule: 'styles/components.css' },
  { name: 'heading anchor', sel: '.nk-heading-anchor', rule: 'styles/editor-content.css' },
  { name: 'image retry button', sel: '.neko-image-error-retry', rule: 'styles/editor-blocks.css' },
  { name: 'rail close button', sel: '.rail-close', rule: 'ui/InfoRail.vue' },
  { name: 'chat session tools', sel: '.chat-tool', rule: 'features/chat/components/ChatSessionBar.vue' },
]
