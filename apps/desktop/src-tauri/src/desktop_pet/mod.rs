//! The desktop pet's backend: the windows it runs in, and what this machine can do with them.
//!
//! §7.1 draws this module's boundary by what is *absent* from it. A pet window is a second
//! window that must not become a second application, so nothing here starts an engine, opens a
//! vault, indexes a note or talks to a model. The module owns two jobs and reports the rest
//! upward:
//!
//! - [`window_host`] — which character windows exist, what they are labelled, how they are
//!   created on demand and torn down, and which window is allowed to ask for any of it (§7.1).
//! - [`linux_capabilities`] — what this machine has been *observed* to do, with what happens
//!   where it has not, so a missing capability is stated rather than substituted (§7.2).
//! - [`task_feed`] — the one place a runtime frame becomes a task a window can read, and the one
//!   place a window is told the list moved (§6). Without it `desktop_pet_tasks` had no state to
//!   answer from, which is the whole of why the pet could not remind anybody about anything.
//!
//! Three rules are structural here rather than documented, because a rule that lives only in
//! prose is a rule the next component can forget:
//!
//! - **A teardown cannot be mistaken for an erasure.** [`window_host::TeardownReport`]'s fields
//!   all describe windows; there is nowhere in this module to record a deleted character, a
//!   cancelled run or a reset ledger, and no way to reach one (§4). Switching the pet off
//!   returns the app to the state before it was switched on — it does not return the user's data
//!   to a default, because a teardown that clears state because it looks tidy is unrecoverable
//!   for the user who switches the pet back on.
//! - **A window label is not an argument.** [`window_host::PetWindowLabel`] cannot be built
//!   outside the host and no public operation accepts one, so §7.1's 「前端不能自选任意 label 去
//!   关闭主窗口」 is a type rather than a validation somebody has to remember to write.
//! - **A capability cannot be reported without what is done instead.** Every non-available arm of
//!   [`linux_capabilities::Finding`] carries a fallback, which is D1's `PetCapabilityFinding`
//!   shape (`pet-contracts/platform.ts:72-79`) reused rather than re-invented: an unavailable
//!   capability that omitted its alternative would leave the user to guess.
//!
//! Wiring is deliberately not here, and it is no longer missing either: `lib.rs` declares this
//! module and registers its commands, `commands/desktop_pet.rs` is the only place a caller's
//! identity is read, and `state/app_state.rs` holds [`PetWindowHost`], [`Observations`] and the
//! care ledger as managed state — with [`PetTaskFeed`] beside them, which is what gives
//! `desktop_pet_tasks` a state to answer from. This file stays a list of modules and a re-export, so the
//! isolation the header above describes is a property of the tree rather than of a paragraph.
//!
//! **The list grew as the pieces above landed.** Each one is declared here rather than inside
//! another module because this is the pet's tree, and each was compiled through its own test
//! target's `#[path]` include until this line existed — a module a test compiles and a library
//! build has never seen is a module nobody has type-checked. The list is the pet's whole backend;
//! a name added to it is a name every build carries.

pub mod care_ledger;
pub mod character_view;
pub mod history;
pub mod linux_capabilities;
pub mod notification_delivery;
pub mod notification_policy;
pub mod resources;
pub mod settings;
pub mod task_feed;
pub mod task_projection;
pub mod window_host;

pub use care_ledger::{CareLedger, CareOutcome, CareSummary, DAY_WINDOW, MEAL_XP};
pub use character_view::{
    appearance, entries, free_character_id, refusal_sentence, PetAppearance, PetCharacterEntry,
    PetCharacterFiles,
};
pub use history::{
    Decoded, DeliveryState, HistoryStore, Loaded, SaveOutcome, TaskHistory, TaskRecord,
    HISTORY_SCHEMA_VERSION, LEDGER_FILE, UNREAD_MAX_AGE_MS,
};
pub use linux_capabilities::{
    CapabilityReport, Desktop, DisplaySession, Finding, LinuxEnvironment, Observations, Observed,
};
pub use notification_delivery::{NotificationDelivery, PetNotice};
pub use notification_policy::{
    channel_for, NotificationChannel, NotificationOutcome, NotificationPolicy,
    NotificationPreferences, TaskFact,
};
pub use resources::{
    is_path_component, CharacterKind, CharacterLibrary, EntryState, InstallRequest, LibraryEntry,
};
pub use settings::{
    decide_write, read_domain, PetSettingsDomain, PetSettingsLoad, PetSettingsRecord,
    PetSettingsStore, PetSettingsUpdate, PetSettingsWrite, PET_SETTINGS_INITIAL_REVISION,
    PET_SETTINGS_SCHEMA_VERSION,
};
pub use task_feed::{publish_tasks, PetTaskFeed, PET_TASKS_CHANNEL};
pub use task_projection::{system_clock, PetClock, PetTaskKey, PetTaskProjection, TaskProjection};
pub use window_host::{
    CallerWindow, Closed, HostRefusal, PetInstance, PetSurfaces, PetWindowHost, PetWindowLabel,
    Placement, TauriSurfaces, TeardownReport, WindowAction, WindowStyle, WorkArea,
    CHARACTER_WINDOW_SIZE, DEFAULT_CHARACTER_CAP, DESKTOP_PET_PAGE, HARD_CHARACTER_CAP,
    PET_WINDOW_STYLE,
};
