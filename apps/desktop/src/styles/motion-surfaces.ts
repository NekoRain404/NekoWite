/**
 * Every file that renders motion, and the vocabulary for saying so.
 *
 * Split out of `motion.test.ts` when that file crossed the line budget with 70
 * tests in it, because the list and its rules are read by four separate guard
 * files now and a list two readers keep in step by hand is a list that drifts.
 * The list, the regexes and the reason for each entry are unchanged; only the
 * file they live in is.
 */

// Every file that renders motion, and the list every guard reads. A path
// here is worth exactly what the file behind it is worth, which is why the
// list itself is the first thing asserted: `../ui/AppSidebar.vue` stayed listed
// through the split that turned it into a 16-line re-export with no CSS, and
// three guards went on reading it as an empty string and reporting success.
//
// The three panel components that were mid-split (SettingsPanel, FileTree,
// NoteListPanel) were absent because their ad-hoc literals were waiting on the
// follow-up pass. The splits landed and the literals are gone, so they are here
// now, along with the feature components that were never listed at all — the
// list only ever grows, and an entry that stops rendering motion is a defect in
// the entry, not a reason to delete it quietly.
export const MOTION_SURFACE = [
  './tokens.css',
  // Both halves of the component layer, for the reason the motion sheets below
  // are listed joined: several guards here are *negative*, and `.dialog` — the
  // shared arrival — lives in the second half now. Naming only the first would
  // check its absence in a file that never had it.
  './components.css',
  './surfaces.css',
  // The layer's first half. Split out of motion.css for the reason both files'
  // headers give; the list above is what the guards read, and this list is what
  // they check, so both have to carry it.
  './surface-motion.css',
  // The shell's share: the three openable panels and the content that follows
  // them. Added when they moved off keyframes onto transitions, which is
  // exactly the moment a listed file became worth listing.
  '../app/appShell.css',
  // Both halves of the editor content layer; the hover-revealed chrome — the
  // code block's copy button, the image node's handle — is in the second.
  './editor-content.css',
  './editor-blocks.css',
  './motion.css',
  '../components/AppToast.vue',
  // The toolbar's dropdowns: the button, the panel and the `menu` transition
  // moved here when the word toolbar crossed §13.1's hard stop, and this list
  // follows the motion rather than the component it used to live in.
  '../components/ToolbarMenu.vue',
  // The dialogs moved onto the shared arrival this round. They declare no
  // transition of their own — `.dialog` / `.dialog-overlay` carry it — and the
  // first two also carry a direction of their own, being anchored to a bottom
  // edge where the rest are centred.
  '../components/AiWriteDialog.vue',
  '../components/ConflictDialog.vue',
  '../components/PermissionDialog.vue',
  '../components/PluginIntegrityDialog.vue',
  '../components/RenameDialog.vue',
  '../ui/AttachmentsPanel.vue',
  // The sidebar, listed where it now lives. The old `../ui/AppSidebar.vue` path
  // is a one-stage shim whose own header says this list moves with the feature.
  '../features/sidebar/components/AppSidebar.vue',
  '../features/sidebar/components/SidebarGroup.vue',
  '../features/sidebar/components/SidebarNavigation.vue',
  '../features/sidebar/components/SidebarReferences.vue',
  '../features/sidebar/components/SidebarTrash.vue',
  '../features/chat/components/ChatComposer.vue',
  '../features/chat/components/ChatMessageRow.vue',
  '../features/chat/components/ChatSessionBar.vue',
  // The two transcripts, and they were the third instance of the same failure
  // in one day: a guard that is green because it is not looking. Both had
  // gained an animated element — the 「N new messages」 jump control, one each in
  // the chat transcript and the agent timeline — and neither file was on this
  // list, so every per-file guard below ran over a set that did not contain
  // them and the animation's only cover was the global reduced-motion sweep.
  // Adding the file is the whole fix: the rules they are now held to are the
  // ones every other entry is held to, and none of them had to bend. Both
  // declare one arrival, an opacity keyframe on the fade rung and the
  // state-change curve, which is what `animates only through tokens`, the raw
  // duration scan, the fill-mode rule and the caret rule have to say about a
  // surface that fades where it lands and moves nothing.
  '../features/chat/components/ChatTranscript.vue',
  // The agent panel's transcript, the sibling surface with the same control.
  // It is the chat transcript's twin down to the curve, which is the other
  // reason to hold them to the same list: the two arrive on one vocabulary or
  // they drift apart one file at a time.
  //
  // **The entry moved with the control.** The jump affordance — the one
  // animated thing this surface ever had — now lives in its own file beside the
  // copy, navigation and follow controls that were added around it
  // (`AgentTimelineControls.vue`), so `AgentTimeline.vue` declares no motion at
  // all and a list that went on naming it would be pointing at a file whose
  // every per-file guard passes by having nothing to hold. The surface is the
  // same one; the file that declares it changed, and this list follows the
  // declaration rather than the feature's name.
  '../features/agent/components/AgentTimelineControls.vue',
  // The palette's shell, likewise: its motion moved out of `ui/CommandPalette.vue`
  // into the feature's stylesheet, and the mount point that is left keeps none
  // of its own. The chat split made the same move when the panel was split.
  '../features/palette/styles/commandPalette.css',
  // The settings model spinner: the app's last bare duration, now on the rate.
  '../features/settings/components/AiSettings.vue',
  '../ui/ContextMenu.vue',
  // The two surfaces whose hover feedback the unification pass never reached:
  // they declared no motion at all, so a hover snapped there while it eased
  // everywhere else. Listed now that they run on the shared rung.
  '../ui/ImagePanel.vue',
  '../ui/TableMenu.vue',
  '../ui/InfoRail.vue',
  '../ui/StatusBar.vue',
  '../ui/TabBar.vue',
  '../ui/TitleBar.vue',
  // Panels and chrome that mount a region whole: the note-list body, the
  // settings section, the sidebar's two groups, the history diff and the
  // recovery toast wear the shared `arrives` nudge rather than declaring one of
  // their own. The rest are their neighbours — the diff's own component, the
  // template dialog, and the vault tree, which already carried a caret rotate
  // the guard should have been watching.
  '../ui/HistoryPanel.vue',
  '../ui/DiffView.vue',
  '../ui/TemplatePicker.vue',
  '../features/notes/components/NoteListPanel.vue',
  '../features/settings/components/SettingsPanel.vue',
  // `../features/sidebar/components/SidebarGroup.vue` was listed a second time
  // here and is not any more. A path that appears twice is the milder end of the
  // same failure this list keeps producing: the entry buys nothing the first one
  // did not, and it hides the fact that the group is accounted for under the
  // sidebar's own heading, where the guard's error message points.
  '../features/vault/components/FileTree.vue',
  '../features/vault/components/FileTreeRow.vue',
]

/**
 * What a listed file has to be, or the list is a claim nobody is checking.
 *
 * There are two honest ways to render motion here, and a listed file must do
 * one of them:
 *
 *   - declare it — a `transition`, an `animation` or a `will-change`, or the
 *     motion tokens themselves, which are declared in `tokens.css` and nowhere
 *     else;
 *   - or wear the arrival — every dialog under `components/` declares no
 *     transition at all, because `.dialog` and `.dialog-overlay` carry the
 *     shared one out of `motion.css` to whatever wears them. Their own CSS is
 *     still theirs to spoil: a hand-written duration on the surface the shared
 *     arrival already animates is exactly the defect this list exists to catch,
 *     so they stay listed.
 *
 * A file that does neither is a path every guard reads as nothing and
 * passes. `../style.css` was the one entry in that state — no motion of any
 * kind, shared or declared — and was dropped rather than left as a second
 * silent pass.
 */
export const MOTION_DECLARATION =
  /(?:^|[;{\s])(?:transition|animation)(?:-[\w-]+)?\s*:|(?:^|[;{\s])will-change\s*:|(?:^|[;{\s])--app-(?:motion|ease)[\w-]*\s*:/

/**
 * The classes motion.css animates on behalf of whoever wears them, one per
 * surface it is declared for.
 *
 * The first two are the shared surface arrival: a dialog declares no transition
 * of its own and is animated anyway. `arrives` is the same mechanism one level
 * down — the nudge a region *inside* a surface takes as it mounts whole — and it
 * is a worn class rather than a per-component rule on purpose: a renamed
 * internal class must not be able to drop a region out of the vocabulary in
 * silence, and motion.css has no business holding five components' private names
 * to keep them animated. Wearing it counts as rendering motion.
 */
export const SHARED_ARRIVAL: readonly string[] = ['dialog', 'dialog-overlay', 'arrives']

/** The two that are *scaled* on arrival, which is what the centring rule is
 *  about — a fade cannot move anything. */
export const SCALED_ARRIVAL: readonly string[] = ['dialog', 'dialog-overlay']

/** True when the component's markup puts one of the shared classes on an element. */
export const wearsArrival = (source: string, classes: readonly string[] = SHARED_ARRIVAL): boolean =>
  [...source.matchAll(/class="([^"]*)"/g)].some(([, found]) =>
    found.split(/\s+/).some((name) => classes.includes(name)),
  )
