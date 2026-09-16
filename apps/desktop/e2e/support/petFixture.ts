/**
 * The fixtures the two desktop-pet specs drive, in one place.
 *
 * Split from the specs because they are the *data* the two share — the same tasks, the same Chinese
 * lines, the same spritesheet geometry — and because a payload that is written twice is a payload
 * that drifts. The mechanics are not here: a page has no import map, so anything that has to run
 * inside the browser is written inside the spec's own `evaluate` callback (the convention
 * `e2e/support/editorHarness.ts` set, for the same reason), and this file holds only values that
 * cross the boundary as plain data.
 *
 * The imports are type-only and are erased at run time. `tsconfig.json` maps `/src/*` onto the
 * real files precisely so a spec that names a module which no longer exists is a typecheck
 * failure, and `pet-contracts.ts` is frozen (D1): every payload below is checked against the
 * contract the product ships rather than against a shape written here.
 */
import type {
  PetTaskKey,
  PetTaskProjection,
  PetTaskState,
} from '/src/platform/gateways/pet-contracts'

/**
 * The grid `sprite-slicer.ts` slices on: `FIXED_GRID_COLS`/`ROWS` are 8x9 and the sheet is cut at
 * `naturalWidth / COLS` by `naturalHeight / ROWS`. A fixture that is not a multiple of that grid
 * measures the fixture, not the slicer.
 *
 * Every row is drawn, because `SpritePlayer.placement()` indexes the clips array with the state's
 * row and clips are the sheet's *drawn* row blocks — a sparse sheet collapses that index space, and
 * state 7 would draw whichever block is seventh. The states this fixture exercises are the ones
 * upstream's `DEFAULT_ANIMATION_CONFIG` maps: idle → row 0, working → 7, waiting → 6.
 */
export const SHEET = {
  cols: 8,
  rows: 9,
  /** Cell size in the sheet, in sheet pixels. Big enough to hold a shape and a transparent margin. */
  cell: 24,
  /** Frames drawn per row. The rest of the row stays transparent, as a sparse sheet's does. */
  frames: 3,
  /** How far the shape is inset inside its cell: the transparent gutter that splits frames. */
  inset: 4,
} as const

/** A working line about a real kind of note, at the length a note title actually has. */
export const LONG_CN_WORKING =
  '正在整理《分布式一致性协议》的中文笔记：先把第三章的引用段落重新编号，再校对术语表里「共识」与「法定人数」两处译法，稍候片刻。'

/** A waiting line: this one names the files the permission is about, in Chinese. */
export const LONG_CN_WAITING =
  '需要你确认：这条命令会覆写 12 个既有文件，其中 3 个还有未提交的改动，请逐条核对后决定。'

/** A failure line, in the same voice as the rest. */
export const LONG_CN_FAILED =
  '这一轮执行失败了：工具在第三步返回了非零退出码，详情与完整的输出都在主面板里。'

/**
 * A vault path as long as a real one, in Chinese with the separators a path has.
 *
 * The two specs that put this on screen are about wrapping: a CJK string has no spaces to break at
 * and a path has almost no break opportunities either, so this is the content that decides whether
 * a row overflows rather than the word "test".
 */
export const LONG_PATH =
  '/home/user/文档/研究项目/分布式系统/一致性协议/2026-秋季学期/第三章-共识算法与法定人数/笔记.md'

/**
 * Markup, to be shown as text and never interpreted (§5.2: 纯文本模板).
 *
 * Deliberately a real tag with a real handler rather than the string "html": a surface that
 * inserted this with `innerHTML` would run it, and one that escaped it renders four characters a
 * user can see. Either way the assertion — no `img` element, no `onerror` attribute — is about the
 * behaviour and not about the wording.
 */
export const MARKUP_AS_TEXT = '<img src=x onerror="window.__petXss = true">'

/** One task's identity, complete: §6.1's tuple, and no part of it defaulted away. */
export function petKey(overrides: Partial<PetTaskKey> = {}): PetTaskKey {
  return {
    agentId: 'memory',
    profileId: 'default',
    runtimeEpoch: 'epoch-1',
    vaultId: 'memoir://demo',
    sessionId: 'session-1',
    runId: 'run-1',
    ...overrides,
  }
}

/** One task as the host hands it to a window. */
export function petTask(
  state: PetTaskState,
  overrides: Partial<PetTaskKey> & { permissionRequestId?: string | null; updatedAt?: number } = {},
): PetTaskProjection {
  const { permissionRequestId = null, updatedAt = 1_700_000_000_000, ...key } = overrides
  return { key: petKey(key), state, permissionRequestId, updatedAt }
}

/**
 * Six tasks, which is one more than the default five-row cap — so a list that silently dropped one
 * would be visible rather than exactly fitting. Two of them share a `sessionId` across two agents,
 * which is §3.1.1's collision, and one is the waiting task that §6.3 says must not be swallowed by
 * anything else.
 *
 * Returned by a function rather than as a constant because the consumer is a `page.evaluate`
 * payload, and structured-cloning a frozen module constant into a browser is the kind of thing
 * that works until something mutates it.
 */
export function petTasks(): PetTaskProjection[] {
  return [
    petTask('working', { sessionId: 'shared-session', runId: 'run-a', agentId: 'memory' }),
    petTask('waiting-input', {
      sessionId: 'shared-session',
      runId: 'run-b',
      agentId: 'opencode',
      permissionRequestId: 'request-1',
      updatedAt: 1_700_000_000_500,
    }),
    petTask('failed', { sessionId: 'session-3', runId: 'run-c', updatedAt: 1_700_000_001_000 }),
    petTask('turn-finished', { sessionId: 'session-4', runId: 'run-d', updatedAt: 1_700_000_001_500 }),
    petTask('stopped', { sessionId: 'session-5', runId: 'run-e', updatedAt: 1_700_000_002_000 }),
    petTask('cancelled', { sessionId: 'session-6', runId: 'run-f', updatedAt: 1_700_000_002_500 }),
  ]
}

/**
 * The lines the list speaks, keyed by agent and state the way `PetMessagePhrases` is.
 *
 * Two agents with two different lines for the same state, so a row that fell back to a default
 * phrase for either of them is distinguishable from one that resolved the right phrase.
 */
export function petPhrases(): Record<string, Record<string, string[]>> {
  return {
    memory: {
      working: [LONG_CN_WORKING],
      'waiting-input': [LONG_CN_WAITING],
      failed: [LONG_CN_FAILED],
    },
    opencode: {
      // A long Chinese sentence with a vault path inside it: the two things a row has to wrap that
      // have no break opportunities a Latin sentence would have had.
      working: [`正在重排 ${LONG_PATH} 第十二章的引用顺序，同时核对三条外部链接是否仍然可达。`],
      'waiting-input': [LONG_CN_WAITING],
      failed: [LONG_CN_FAILED],
    },
  }
}

/** The states the two specs name, in the order §6.2 lists them. */
export const SETTLED_STATES: readonly PetTaskState[] = [
  'turn-finished',
  'stopped',
  'failed',
  'cancelled',
]
