//! The two reads of what this process's own frames settled: §8's care ledger and §6's task list, as
//! a window may ask for them.
//!
//! **Why this is a module and not commands on `desktop_pet.rs`.** The parent had reached 814 lines
//! against the 600-line budget `docs/dev.md:286` puts on a business file, and the split is by
//! *reason to change* — the criterion that same section states. What makes this file change is what
//! the runtime holds and how a window is told about it: a further fact of the ledger's summary, a new
//! arm for a record this build cannot read, a change to the projection a task list is drawn from. A
//! window operation or an install does not touch it.
//!
//! **They share a file because they share one property, and it is the one that matters here: neither
//! invents a first payload.** Both answer from state this process already holds — the ledger by
//! whatever settles a run, the projection by the runtime's own frames — and both are the first read a
//! listen-then-read subscription makes. That is why a host which cannot answer states a refusal
//! instead of answering emptily: a window handed an empty list for a failure cannot tell it from a
//! pet with no work, and a page handed zeroes cannot tell them from progress it has not recorded.
//! The care read goes one step further and asks the feed *before* the lock, because its read-only arm
//! is a fact the store owns rather than the ledger.
//!
//! **Nothing here names a window, a caller or a character.** The ledger is the process's own progress
//! (§6.3's one-ledger rule) and the task list is the process's own view of the runtime, so every
//! window that asks gets the same answer and there is nothing to address.

use serde::Serialize;

use crate::desktop_pet::CareSummary;
use crate::state::DesktopPetState;

/// What the care ledger settled, or the fact that it settled nothing (§8).
///
/// Three arms, and the second one is the whole design. A ledger nothing has settled into has totals
/// — `xp: 0`, `meals: 0`, no streak, no day — and handing those over would have the surface draw
/// level 0 and an empty bar for a user who has completed five hundred runs. That is §8's
/// 「token 未知不是 0」 one level up: `meals: 0` would read *the absence of a record* as *a record
/// of absence*, when the truth is that nothing has been recorded at all. So the totals are not
/// sent unless something settled, and the caller is told which of the two it is holding.
///
/// **The third arm arrived with the store**, which is what the previous revision of this comment
/// predicted it would: 「It arrives with whatever store gives the ledger a disk」. A record a newer
/// build wrote is loaded as an *empty* ledger — this build cannot make rows out of fields it does not
/// know — so without this arm the page would draw level 0 for a user whose progress is sitting on
/// disk. The ledger does not read it and must not replace it (§10.2), and the caller is told which of
/// the three facts it is holding rather than being handed the emptiest one.
///
/// `rename_all = "kebab-case"` rather than the `camelCase` this enum carried while it had two arms,
/// and it is the spelling `PetSettingsLoad` already uses for the same three facts one module over:
/// the two remaining arms serialise to the same words either way (`current`, `empty`), and kebab-case
/// is what makes the third one `read-only` rather than a second spelling of the name the contract and
/// this comment both give it.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PetCareRead {
    /// Something has settled: the totals, and nothing about how they got that way.
    Current { summary: CareSummary },
    /// Nothing has settled into the ledger, so there is nothing to draw.
    Empty,
    /// The record on disk belongs to a newer build. Nothing was read and nothing will be written, so
    /// there are no totals to send and no zeroes to send instead of them.
    ReadOnly,
}

/// What the ledger settled, for the care page that draws it (§8).
///
/// The read is the *only* way anything outside the ledger's own settlement path reaches these
/// totals: `CareLedger::summary` returns facts, never a level, a stage or a progress bar — those
/// are `pet-care-rules.ts`'s, computed where they are drawn, so there is one level curve in the
/// build and not two.
///
/// Nothing here names a window, a caller or a character. The ledger is the process's own progress
/// (§6.3's one-ledger rule), so every window that asks gets the same answer and there is nothing
/// to address: like the window list and the capability report, this command has no parameter
/// beyond the state, and unlike them it is the only *read* whose answer a page draws numbers
/// from.
#[tauri::command]
pub fn desktop_pet_care_read(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<PetCareRead, String> {
    // Asked **before** the lock and before the revision check, and the order is the whole of it. A
    // read-only ledger is empty by construction — this build cannot make rows out of a newer record —
    // so `revision() == 0` is true for it and the answer below would be `empty`: a level-0 page for a
    // user with months of progress on disk. The latch is the store's, reached through the feed that
    // owns it, so there is no second copy of the fact to keep in step.
    if state.tasks.care_read_only() {
        return Ok(PetCareRead::ReadOnly);
    }
    let ledger = state
        .ledger
        .lock()
        .map_err(|_| "the pet's care ledger was poisoned by a panic".to_string())?;
    // `revision` moves when anything is decided *or* when an import lands, so zero means no
    // decision and no import: the one state in which this ledger holds no record at all. The
    // check is here rather than in the ledger because what to draw from a summary is the
    // surface's question — the ledger's own answer (`summary()`) is what it settled, which for an
    // empty ledger is accurately nothing.
    if ledger.revision() == 0 {
        return Ok(PetCareRead::Empty);
    }
    Ok(PetCareRead::Current {
        summary: ledger.summary(),
    })
}

/// What the runtime is doing, as this window may be told (§6).
///
/// D1's `PetTaskProjection` list, read from the projection D4's state machine built and this
/// process now holds (`desktop_pet/task_feed.rs`). The window's subscription is listen-then-read,
/// so this is both the answer to its first read and what it re-reads on a push — and because the
/// list is complete every time, a push that never arrived costs freshness rather than the task.
///
/// **This command had no backend until the feed landed.** Its absence was not a missing first
/// payload: `tauri-pet.ts`'s `subscribe` releases the listener when the first read rejects, so a
/// window mounted against a host that could not answer this looked exactly like a pet with no
/// work — a quiet subscription rather than a stated failure. The read is now a real one, and the
/// refusal a poisoned lock produces is the caller's to state rather than a silence.
#[tauri::command]
pub fn desktop_pet_tasks(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Vec<crate::desktop_pet::PetTaskProjection>, String> {
    state.tasks.read()
}
