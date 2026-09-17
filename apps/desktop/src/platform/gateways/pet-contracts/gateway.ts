/**
 * The surface the application calls, and the two shapes it reads back.
 *
 * It sits apart from the vocabulary it is built from because it changes for a different
 * reason: when *who talks to whom* changes, not when a state or a setting is added. The
 * pet window cannot start, cancel or re-send a task, and no method here deletes
 * anything — §6.1's single source of truth and §4's rollback, expressed as an interface.
 */
import type {
  PetSettingsDomain,
  PetSettingsLoad,
  PetSettingsPage,
  PetSettingsUpdate,
  PetSettingsWrite,
} from './config'
import type {
  PetAppearance,
  PetCharacterEntry,
  PetHostAppearance,
  PetSettingsChange,
} from './appearance'
import type { PetCatalogueReading } from './catalogue'
import type { PetCareRead } from './care'
import type { PetCapabilityReport } from './platform'
import type { PetTaskKey, PetTaskState } from './task'

/**
 * Whether the feature is on, and whether a pet is on screen right now.
 *
 * Two fields and not one, because §5.1 lists 启用 and 显示 apart and they have
 * different consequences: "the feature is off" means no window, no animation, no
 * timers — and, per §7.1, still no cancelled agent task — while "hidden" is a pet that
 * is running with its drawing stopped and its reminders intact. Collapsing them would
 * make a temporary hide indistinguishable from a disable, and the user's way back
 * would be the wrong one.
 */
export interface PetFeatureState {
  enabled: boolean
  /** Meaningful only while enabled; a disabled feature has nothing to show. */
  visible: boolean
}

/** One task as the host hands it to a window. */
export interface PetTaskProjection {
  key: PetTaskKey
  state: PetTaskState
  /** See {@link PetTaskOutcome.permissionRequestId}: an id to route with, never something to answer with. */
  permissionRequestId: string | null
  /** Host clock, in epoch ms. Injected rather than read (§10.2) so coalescing windows are testable. */
  updatedAt: number
}

/**
 * What the application calls.
 *
 * Every method reads or changes what the *host* knows; none of them reaches an agent,
 * and none can start, cancel or re-send a task. That is §6.1's single source of truth
 * expressed as an interface: the pet window cannot influence a run, so it cannot
 * become a second place where a run's life is decided.
 *
 * No method deletes anything. §4's rollback is the settings switch, and characters,
 * care progress and history outlive it — an erase affordance reachable from a window
 * that is being torn down would be unrecoverable for the user who switches the pet
 * back on.
 */
export interface PetGateway {
  /** The switch, and whether anything is showing. */
  feature(): Promise<PetFeatureState>
  /**
   * Hide or show the pet, returning the state the host ended up in.
   *
   * It returns the state rather than nothing because a request to show a disabled
   * feature does not do anything, and the caller has to be able to tell: the answer is
   * the same channel the truth comes back on, instead of a silent no-op that looks
   * like success.
   */
  setVisible(visible: boolean): Promise<PetFeatureState>
  /** What this machine was verified to do, each with what happens where it cannot (§7.2). */
  capabilities(): Promise<PetCapabilityReport[]>
  /**
   * What the care ledger settled, or the fact that it settled nothing (§8).
   *
   * Read-only, and there is deliberately no `settle` beside it: rewards are settled from the
   * runtime's own completion events, never from a window (`care_ledger.rs` is the only place a
   * decision is made, and it is idempotent per run key so a replay cannot pay twice). A window that
   * could settle would be a second way to earn, which is exactly what §6.1's single source of truth
   * forbids.
   *
   * The two arms are not a record with a flag: `empty` is the answer for a ledger nothing has
   * settled into, and it is a different answer from a summary of zeroes — see {@link PetCareRead}.
   */
  care(): Promise<PetCareRead>
  /**
   * Every task the pet shows.
   *
   * The order is not part of the contract: §6.3's ranking — attention needed, then
   * working, then a brief completion, then idle — is a display rule computed from
   * `state` and `updatedAt`, and fixing it here would put a display decision in the
   * host.
   */
  tasks(): Promise<PetTaskProjection[]>
  /** Call `onTasks` with the current list now, and on every change after that. Resolves with the unsubscribe. */
  subscribe(onTasks: (tasks: PetTaskProjection[]) => void): Promise<() => void>
  /**
   * Call `onFeature` with the current state now, and on every change after that. Resolves with
   * the unsubscribe.
   *
   * A second channel beside {@link subscribe}, added when the window host reported the gap it
   * closes: `feature()` answers when it is asked, and the only push channel carried tasks — so a
   * hide performed from the settings page reached a mounted window on that window's next read,
   * which nothing was going to make. §7.1 makes the settings page the way *back* to a hidden pet
   * on a desktop with no tray (「无托盘的 Linux 环境仍能从主设置恢复隐藏桌宠」), and a way back
   * that needs the window to ask again is not one.
   *
   * Separate from {@link subscribe} rather than merged into one callback because the two change
   * for different reasons and at different rates: a task list moves with the agent, and the
   * feature state moves when the user touches a switch. Both push the whole state rather than a
   * delta, so a subscriber that missed a frame is stale for one frame and not wrong for ever —
   * and so the first delivery, which is the current state rather than a replay, needs no special
   * case.
   */
  subscribeFeature(onFeature: (state: PetFeatureState) => void): Promise<() => void>
  /** Read one domain, and the revision a write has to be based on. */
  readSettings(domain: PetSettingsDomain): Promise<PetSettingsLoad>
  /** Write one domain, refused when the revision it was based on has moved on (§5.3). */
  updateSettings(write: PetSettingsWrite): Promise<PetSettingsUpdate>
  /**
   * Ask the host to bring the main window up focused on a settings page (§5.1). The
   * pet names a page and never a window, a label or a URL: §7.1 gives the host the
   * window identity, and a front end that could choose one could choose the wrong one.
   */
  openSettings(page: PetSettingsPage): Promise<void>
  /**
   * What the pet window draws, and the `character` domain's values it draws it with (§5.1's
   * 角色与动画).
   *
   * One read rather than a settings read plus a library read, because the window needs them
   * *together* to draw one frame and because the spritesheet's path has to be handed out by the
   * host that granted it to `asset://` — a window that resolved a path itself would be a window
   * that could ask for any file.
   *
   * The three arms are the three things to draw: nothing (a choice nobody made), the reason a
   * chosen character cannot be produced, or the sheet and the values.
   */
  appearance(): Promise<PetAppearance>
  /**
   * Every character the library holds (§8).
   *
   * Read-only, and the list is the library's own: the *choice* is a settings value the page is
   * already editing, so this never reports which one is selected. An empty list is an empty
   * library — a host that could not read one rejects, which is a different thing to say.
   */
  library(): Promise<PetCharacterEntry[]>
  /**
   * Import one character pack the user picks (§8's 导入).
   *
   * No path crosses this boundary: the host opens the dialog, which is a gesture by the user, and
   * resolves the source itself — the rule `commands/fs.rs`'s dialogs already keep. `null` is the
   * user closing the dialog, which is not an error.
   */
  importCharacter(): Promise<PetCharacterEntry | null>
  /**
   * What the online catalogue offers right now (§8's 在线角色库).
   *
   * Read-only, and deliberately not cached on either side: a browse is a user opening a page, and a
   * copy of a document whose whole purpose is to change would make the first paint fast and every
   * install after it resolve against a list that may have moved.
   */
  catalogue(): Promise<PetCatalogueReading>
  /**
   * Download one catalogue offer and install it (§8's transfer rules).
   *
   * The argument is a **slug** and nothing else — no address, no host, no path. That is §7.1's
   * shape ("a caller names a character, never a window") applied to a download, and it is why an
   * offer carries no URL: the address is resolved on the host side from a catalogue the host read,
   * so a window cannot point this app's downloader anywhere.
   *
   * A refusal rejects with the host's own sentence — which of §8's four checks refused, and with
   * what — rather than resolving to null, because "the user closed a dialog" is the only thing
   * `null` means anywhere in this contract ({@link importCharacter}) and a failed download is not
   * that.
   */
  adoptCharacter(slug: string): Promise<PetCharacterEntry>
  /**
   * Send a click on a task back to the session it belongs to (§6.2's 点击返回任务).
   *
   * The key and nothing else: no URL, no path, no window label, no command. §6.3 requires a
   * notification's action to be a limited target the host issued, and this is that target — the
   * key the window read from {@link PetGateway.tasks}. What the main window does with a key it no
   * longer recognises is that window's business.
   */
  openTask(key: PetTaskKey): Promise<void>
}

/**
 * The host surface the pet *window* draws and routes with, and nothing more.
 *
 * The same object as {@link PetGateway} plus the one channel a window needs and a settings page
 * does not: {@link PetWindowGateway.subscribeSettings}. It is declared here rather than beside the
 * code that first used it because three layers name it and they may not all reach each other —
 * the entry (app), the window's composable and root (feature), and the double (platform). A port
 * declared in a feature would have the platform's double importing a feature to implement it,
 * which is the direction §9 forbids; a port declared in the contract is a shape all three can see.
 *
 * It is narrower than the composition's own object (`PetHostConnection`, which adds the window
 * lifecycle: open, disable, close-own). That is the point: the entry holds one of these, so the
 * *teardown* — creating and closing character windows, which is the cap and the rollback — stays
 * one call away from the window that must not reach it.
 *
 * {@link PetWindowGateway.setClickThrough} is the one operation from that group that is here
 * rather than there, and the difference is the argument: it is not a teardown. It changes the
 * input region of the window that asks and no other — the host reads the caller off the window the
 * IPC arrived from, so there is nothing for a caller to name and nothing it could turn off that it
 * does not own. What it does need is the window itself: §7.2's 鼠标穿透 is a property of the
 * surface, and the surface is the only thing that knows whether it has anything to be clicked on.
 */
export interface PetWindowGateway extends PetGateway {
  /**
   * Hear that a settings domain was written, wherever the write came from.
   *
   * The window draws from settings and the settings page is another window; without this the only
   * way to learn that the character changed would be to ask again on a timer. A change carries the
   * domain and the revision, so a listener re-reads what it draws and nothing else — and it is a
   * pure notification rather than a state, so there is no first delivery to make.
   */
  subscribeSettings(onChange: (change: PetSettingsChange) => void): Promise<() => void>
  /**
   * Whether clicks that land on **the calling window** reach it or pass through to what is below
   * (§7.2's 鼠标穿透).
   *
   * `true` asks the compositor to let them through. A request is always about the caller: no
   * argument names a window, so this cannot be pointed at somebody else's — the same shape as
   * `closeOwn` on the composition's own object, and for the same reason.
   *
   * It is a *window-wide* switch and not a shape — see `usePetClickThrough` for why the window's
   * own policy is written in terms of what it has on screen rather than in terms of where the
   * pointer is — and it is deliberately not the renderer's pixel hit test: §7.2 forbids presenting
   * one as the other, and the two are different machinery on every platform.
   */
  setClickThrough(ignore: boolean): Promise<void>
  /**
   * The *app's* own appearance, as the host last heard it: its theme, colour scheme, accent,
   * contrast and body size (§1's 「保留现有主题、强调色」, §5.2's 「默认跟随宿主主题」).
   *
   * The read a page of its own cannot make for itself. The app's appearance lives in the app
   * window's store, §7.1 keeps this window out of it, and `app/desktop-pet-entry.test.ts` fails on
   * an import graph that reaches `stores/` — so what this answers with is what the app *published*
   * (`app/pet-host-appearance-link.ts` → `desktop_pet_publish_host_appearance`), relayed by the
   * host. It is the fourth read of the same kind here, after `appearance`'s own three facts: each
   * one exists because the window draws something whose setting it cannot read.
   *
   * A read that carries nothing is a real answer — see {@link PetHostAppearance}: the reading rule
   * turns it into the app's own defaults, which is what the pet drew with before any of this
   * crossed.
   */
  hostAppearance(): Promise<PetHostAppearance>
  /**
   * Hear that the app changed its appearance, wherever the change was made.
   *
   * Listen-only, exactly like {@link subscribeSettings}: a *change* has no current value to
   * deliver, and the state a listener wants is the one its own {@link hostAppearance} read already
   * answers. Without this channel a window that was already open would keep the appearance it
   * mounted with — the user changes the accent in Settings, and the pet beside it does not move
   * until something else makes it re-read, which nothing would.
   */
  subscribeHostAppearance(onChange: (appearance: PetHostAppearance) => void): Promise<() => void>
}
