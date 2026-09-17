//! The desktop pet's backend, as Tauri holds it — split out of `app_state.rs` by §13.1, and for the
//! reason that file's own header gives: it holds four unrelated subsystems, and this is the one whose
//! assembly is a *startup* concern of its own (a data directory, a stored switch, a window system).
//!
//! **Why it is built in `setup` and not by `Default`.** The host's window system is the running app
//! — [`TauriSurfaces`] holds an `AppHandle` — and there is no `AppHandle` until `setup` runs.
//! `with_surfaces` is the same state with the window system injected, which is how the IPC tests
//! drive the host's rules *and the commands' identity checks* without a compositor (§10.2's injection
//! rule, applied to the one dependency this state has).
//!
//! **And it is the moment the stored switch is applied.** Everything a launch needs is here at once —
//! the app's data directory, the settings store that lives in it, and a host with no window on screen
//! yet — which is why [`DesktopPetState::new`] ends by asking for the windows the user's own settings
//! say should be there. Without that, the switch reached a window only when a settings write carried
//! it (`desktop_pet::feature_switch`), and a declared default that no write had ever carried opened
//! nothing: a fresh install showed 「显示桌宠」 checked and drew no pet.

use std::sync::Mutex;

use tauri::Manager;

use crate::desktop_pet::{
    feature_switch, system_clock, CareLedger, HostAppearanceRelay, Observations, PetSettingsStore,
    PetSurfaces, PetTaskFeed, PetWindowHost, TauriSurfaces,
};
use crate::storage::key_store::data_dir;

/// The desktop pet's backend, as a handle Tauri holds (§7.1, §10.1).
///
/// The five fields are the whole of what a pet window can reach on this side: which character
/// windows are open and the rules about them, what this machine has been *observed* to do
/// (§7.2), what the care ledger has settled (§8), what the agent runtime is doing, projected
/// down to what a window may be told (§6), and the appearance the app last published (§1). Nothing
/// else lives here — no vault, no session owned by this struct, no provider, no document — so a pet
/// command has nothing to reach even if one were written carelessly. That absence is the module's
/// own claim (`desktop_pet/mod.rs`) held at the managed-state level: the pet's whole world is five
/// fields wide, and the fifth is one value the app hands over rather than a thing the pet owns.
///
/// **The task feed is here for the reason the ledger is.** §6.1 makes the host the single source
/// of truth for a task, and a projection is host state: the frames arrive on the driver's task,
/// which is not a window, and a window that held its own copy of them would be a second answer.
/// `PetTaskFeed` is the one place a frame is applied (`desktop_pet/task_feed.rs`), so this field
/// is what makes the pet's 任务提醒 reachable at all — without it the window's subscription died
/// on its first read and a pet that could not see work looked exactly like one with none.
///
/// **The ledger is the pet's own progress and not a fourth kind of thing.** It is not a
/// document, it has no path, and it belongs to no vault: it is the totals the pet earned, which
/// §4 keeps when the feature is switched off. What it deliberately is not is *persisted* —
/// `care_ledger` may not name a file at all (its own test asserts that), so where its record
/// lives between runs is a decision for whoever gives it a store, and the read command reports
/// the process's ledger in the meantime rather than inventing one.
///
/// **Why each field has its own lock.** They are read and written by different callers for
/// different reasons: the observations by whoever measured this machine (D13's matrix) and a
/// settings page, the ledger by whatever settles a run and by the settings page's care read, the
/// host by every window operation, and the appearance by the app window's publish. One lock would
/// make a capability report, or a care read, wait behind a window operation that is talking to a
/// compositor — or behind a colour.
pub struct DesktopPetState {
    /// The pet windows, and the policy about them. The rules are [`PetWindowHost`]'s; this is
    /// only where the process keeps them.
    pub host: Mutex<PetWindowHost>,
    /// §7.2's evidence. Empty on a fresh install, which is why every capability reads
    /// `unverified` there rather than "supported" or "unsupported".
    pub observations: Mutex<Observations>,
    /// §8's local progress. One for the process (§6.3's 「一份后端提醒账本」, read at this layer
    /// as: not one per window), and empty at every start until something settles into it.
    pub ledger: Mutex<CareLedger>,
    /// §6's tasks, as the runtime's own frames left them. One for the process, and the only
    /// place a frame is applied (`desktop_pet/task_feed.rs`), so a window that reads it and a
    /// command that answers from it cannot disagree.
    pub tasks: PetTaskFeed,
    /// §1's 「保留现有主题、强调色」, as the app published it: the theme, colour scheme, accent,
    /// contrast and body size the main window is drawing with.
    ///
    /// One for the process, for the reason the ledger is: there is one main window and therefore
    /// one answer. It is a *relay* and not a store — the app owns the value
    /// (`app/pet-host-appearance-link.ts`), this holds what it last said
    /// (`desktop_pet/host_appearance.rs`), and a pet window may not read the store it comes from
    /// (§7.1). Nothing here is written to a file: an appearance is republished at every start, and
    /// a remembered one would be a second answer the next time the app changed its mind.
    pub appearance: Mutex<HostAppearanceRelay>,
}

impl DesktopPetState {
    /// The state the app runs with: the real window system, the stored notification switches, and
    /// the one thing the task feed cannot give itself — a way back to a gathering burst.
    ///
    /// The two additions are here rather than in `with_surfaces` because both need something that
    /// only a running app has. The **waker** needs an `AppHandle` to reach the async runtime and,
    /// three seconds later, the managed state again; the **switches** need the data directory the
    /// settings store lives in. A feed built without either is a feed whose bursts never close,
    /// which is what the tests that are not about notices run with.
    ///
    /// **The stored switch is the third of those**, applied at the end for the same reason: it needs
    /// the data directory and a host that no window has been built on yet. See
    /// [`DesktopPetState::restore_switch`].
    pub fn new(app: &tauri::AppHandle) -> Self {
        // §6.3's 「一份后端提醒账本」 is the policy's, and it starts from three things this moment
        // is the only one that has all of: the switches the notification page writes, the rows the
        // last run left in the file, and the channel this build runs with. Read once, at the one
        // moment an app data directory exists and no window does, because the alternative is a file
        // read on the driver's task for every frame. What that costs is stated rather than hidden:
        // a switch flipped in the settings page is applied by
        // `commands::desktop_pet::apply_notification_switch`, on the write path — which is where a
        // *saved* setting becomes a running behaviour, and the only other moment the answer is known
        // to this process.
        // The feed's own assembly (`PetTaskFeed::for_app`) is the pet module's, not this file's: it
        // reads the settings store, the ledger's file and the session's notification channel, and
        // all three are the pet's. What is here is the one thing it cannot have of its own — the
        // directory the app keeps its files in.
        let data = data_dir(app);
        let tasks = match &data {
            Ok(directory) => PetTaskFeed::for_app(directory, system_clock()() as i64),
            Err(detail) => {
                eprintln!("nekowite: the pet's reminders have no data directory: {detail}");
                PetTaskFeed::new()
            }
        };
        let state = Self::with_tasks(Box::new(TauriSurfaces::new(app.clone())), tasks);
        state.tasks.set_notice_waker(notice_waker(app));
        // The switch the user last saved, or the default a store with no record reads as. Last,
        // because it is the only step that can put a window on screen — and a window built before
        // the feed and the waker existed would mount against a pet that could not yet answer it.
        if let Ok(directory) = &data {
            state.restore_switch(directory);
        }
        state
    }

    /// The state with a substitute window system, for tests and for nothing else.
    ///
    /// `PetSurfaces` is the same port the real adapter implements, so what a test substitutes
    /// is what the product uses — not a smaller shape written to make the test easy. Nothing is
    /// restored here: a test that wants the startup path drives
    /// [`DesktopPetState::restore_switch`] with its own directory.
    ///
    /// **The feed is the app's, channel and all.** A case that ends a run through this state
    /// therefore reaches the session's real notification daemon and puts a toast on the screen of
    /// whoever is running the suite — which is correct for the product and is not something a test
    /// usually wants. One that does not want it builds the feed itself and passes it to
    /// [`DesktopPetState::with_tasks`], pointing the channel at a bus the test started
    /// (`tests/desktop_pet_ipc_test/wiring.rs`, and `tests/desktop_pet_notification_channel_test.rs`
    /// for the channel on its own).
    pub fn with_surfaces(surfaces: Box<dyn PetSurfaces>) -> Self {
        Self::with_tasks(surfaces, PetTaskFeed::new())
    }

    /// The state with both substitutes: the port, and the feed a test built itself.
    ///
    /// Public for the reason above: what a test needs to keep out of a desktop is the *feed*, and
    /// the feed is a value the caller can assemble — `PetTaskFeed::with_notifications` takes the
    /// channel, the switches and the history (§10.2's injection, at the one seam a state has).
    pub fn with_tasks(surfaces: Box<dyn PetSurfaces>, tasks: PetTaskFeed) -> Self {
        Self {
            host: Mutex::new(PetWindowHost::new(surfaces)),
            observations: Mutex::new(Observations::new()),
            ledger: Mutex::new(CareLedger::new()),
            // Nothing has published yet: the relay answers the app's own defaults until the main
            // window publishes what it is drawing (`host_appearance.rs`).
            appearance: Mutex::new(HostAppearanceRelay::new()),
            // The feed builds its own clock (`system_clock`): the projection stamps `updated_at`
            // with it, and the display subtracts it from the same epoch milliseconds, which is the
            // one thing about the unit a test can get wrong (`task_projection/outcomes.rs`).
            tasks,
        }
    }

    /// Apply what the settings store says about the switch, now that a data directory is known.
    ///
    /// Two refusals, both logged and neither fatal: a store that cannot be built is a data directory
    /// this process cannot use, and a poisoned lock is a panic somewhere else. The app runs without a
    /// pet in either case, exactly as it does when the user has the switch off — which is the state
    /// this call exists to tell apart from the one it produces.
    pub fn restore_switch(&self, data: &std::path::Path) {
        let Ok(store) = PetSettingsStore::new(data) else {
            eprintln!("nekowite: the pet's stored switch has no store to be read from");
            return;
        };
        match self.host.lock() {
            Ok(mut host) => feature_switch::restore(&mut host, &store),
            Err(_) => {
                eprintln!("nekowite: the pet's windows did not follow the stored switch: the lock was poisoned")
            }
        }
    }
}

/// The way back to a completion burst whose window has closed (§6.3's 「3 秒内多个完成合并」).
///
/// The ledger merges a burst of completions into one notice and knows when that notice is due; what
/// it cannot do is *come back* then, because it has no timer and no runtime and a tick would be a
/// poll running all day for a notice that happens a few times an hour. This is the one shot: the
/// feed asks once per due time, the wait is the difference between that time and the clock, and the
/// flush is handed the due time rather than reading a clock of its own — the ledger takes a time as
/// a parameter (§10.2's injected clock), and a wake that ran late must not become a second opinion
/// about when the window closed.
///
/// The state is reached through `try_state` at the moment of the wake rather than held here, for the
/// reason `start_session`'s sink gives: this closure is built *while* that state is being assembled,
/// so it cannot capture what it belongs to — and a wake that fires after the app is gone finds
/// nothing to do instead of a dangling handle.
fn notice_waker(app: &tauri::AppHandle) -> impl Fn(i64) + Send + Sync + 'static {
    let app = app.clone();
    move |due_at_ms: i64| {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let now = crate::desktop_pet::system_clock()() as i64;
            let wait = due_at_ms.saturating_sub(now).max(0) as u64;
            tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            let Some(pet) = app.try_state::<DesktopPetState>() else {
                return;
            };
            if let Err(detail) = pet.tasks.flush_notices(due_at_ms) {
                eprintln!("nekowite: the pet's notice could not be delivered: {detail}");
            }
        });
    }
}
