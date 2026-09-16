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
//! Wiring is deliberately not here. `lib.rs`, `commands/mod.rs`, `state/app_state.rs` and
//! `commands/desktop_pet.rs` are the ACP plan's T4 files and the integrator's, so this tree is
//! declared by path in `tests/desktop_pet_ipc_test.rs` until those land — the convention T3's
//! tests established. The exact wiring points are listed in this task's report.

pub mod linux_capabilities;
pub mod window_host;

pub use linux_capabilities::{
    CapabilityReport, Desktop, DisplaySession, Finding, LinuxEnvironment, Observed, Observations,
};
pub use window_host::{
    CallerWindow, Closed, HostRefusal, PetInstance, PetSurfaces, PetWindowHost, PetWindowLabel,
    Placement, TauriSurfaces, TeardownReport, WindowAction, WindowStyle, WorkArea,
    CHARACTER_WINDOW_SIZE, DEFAULT_CHARACTER_CAP, DESKTOP_PET_PAGE, HARD_CHARACTER_CAP,
    PET_WINDOW_STYLE,
};
