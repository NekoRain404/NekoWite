//! The window side of the live-buffer seam: how this process asks a window what a note holds.
//!
//! `agent_runtime::live_notes` declares the port and owns the questions; this is the end that
//! reaches a window, and it is here rather than in `agent_runtime` for the module's own stated
//! reason — the runtime "must not know about Tauri or the IPC surface", which is what lets it
//! be tested against a fake engine with no window in sight. The split is the same one
//! `storage::agent_files::AgentVaultFiles` makes for the write direction: the runtime declares
//! [`crate::agent_runtime::VaultFiles`], the module that owns the IPC implements it.
//!
//! ## What travels, and in which direction
//!
//! A question is published on `agent-live-note-request` with `Emitter::emit`, which reaches
//! every window; the answer comes back on `agent-live-note-answer` from the frontend's own
//! `emit`, and a window's registration travels on `agent-live-note-attach`. The permission
//! pair (`permissions.rs` + `agent_permission_answer`) is the same skeleton in the opposite
//! direction — an id minted by the host, a payload published as an event, a completion that
//! arrives from a window, and a refusal vocabulary for everything that arrives against a
//! question that is over.
//!
//! ## Why events rather than commands, and what that costs
//!
//! A command would need `lib.rs`'s handler list, `build.rs`'s app manifest and an entry in
//! `capabilities/default.json` — registering a command is three files, and the acceptance test
//! for the pair asserts both halves. Events need none of them: `core:default` already grants
//! `core:event:allow-emit` to the main window, so a window that can answer can already speak,
//! and **a window that must not answer cannot**: `capabilities/desktop-pet.json` grants the
//! pet windows `core:event:allow-listen`/`allow-unlisten` and deliberately *not* `emit`, so a
//! pet window cannot forge a live-note answer even if its page were made to try. That is a
//! structural answer to §2.2's "which window owns a path" question, and it is stronger than a
//! label check would be — but it is a property of today's capability files rather than of this
//! module, so the rule below is enforced here too.
//!
//! The cost is one thing the command pair would have given for free: Tauri reports the calling
//! window to a command and cannot report it for an event. So a window names itself, and the
//! label it names is used for exactly one thing — to *withhold* competence (it is pruned
//! against the webviews that actually exist, and it is a set key, so a registration is
//! idempotent, which is what makes a page reload the same window rather than a second one).
//! Nothing is granted by it, and a forged one can only make a read fail.
//!
//! The three channel names below are half of a wire whose other half is
//! `src/features/agent/services/live-note-responder.ts`; the adapter in that file declares the
//! same three strings, and they are one decision rather than two.
//!
//! ## What a registration is, and what it is not
//!
//! It says **which vault a window can be asked about**, and nothing about what is in it: the
//! payload carries a vault id and a window label, and never a document. That is the whole of
//! the defence against a second source of truth about "which version of this note is current"
//! — the registration cannot hold one, because it has no field to hold one in.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::{Emitter, Listener, Manager};

use crate::agent_runtime::live_notes::{
    LIVE_NOTE_ANSWER_CHANNEL, LIVE_NOTE_ATTACH_CHANNEL, LIVE_NOTE_REQUEST_CHANNEL,
    LiveNoteAnswerPayload, LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use crate::state::AgentRuntimeState;

/// What a window says about itself.
///
/// `windowId` is the window's own label, and `attached` is the whole vocabulary: a window
/// either can be asked about this vault or it cannot. There is deliberately no field a
/// document could travel in.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachPayload {
    vault_id: String,
    window_id: String,
    attached: bool,
}

/// Which windows can be asked about which vaults.
type Attached = Mutex<HashMap<String, BTreeSet<String>>>;

/// The port's implementation over Tauri: publish a question, count who can answer it.
struct NoteWindows {
    app: tauri::AppHandle,
    attached: Arc<Attached>,
    /// Kept so the listeners live exactly as long as the state that installed them. Nothing
    /// calls them: the host is built once per process and the app's own teardown is the only
    /// thing that ends it.
    #[allow(dead_code)]
    listeners: Mutex<Vec<tauri::EventId>>,
}

impl LiveNoteWindows for NoteWindows {
    fn ask(&self, question: &LiveNoteQuestion) -> usize {
        let reached = {
            let mut attached = self.attached.lock().unwrap();
            // A window that is gone can no longer answer, and a registration that outlives it
            // would make this host wait ten seconds for a listener that does not exist — the
            // one stall the count is here to prevent. `webview_windows` is the authority on
            // which labels exist, so the set is pruned against it rather than trusted.
            let live: BTreeSet<String> = self
                .app
                .webview_windows()
                .keys()
                .cloned()
                .collect();
            if let Some(windows) = attached.get_mut(&question.vault_id) {
                windows.retain(|label| live.contains(label));
            }
            attached
                .get(&question.vault_id)
                .map(|windows| windows.len())
                .unwrap_or(0)
        };
        if reached == 0 {
            return 0;
        }
        // Published to every window rather than to the registered labels one at a time: the
        // registration is a *count* of who can answer, and a window that cannot answer is not
        // listening. A window that received a question it cannot answer does nothing with it —
        // and if one ever did answer a vault it does not hold, the answer would be refused by
        // the table's own vault check before it decided anything.
        match self.app.emit(LIVE_NOTE_REQUEST_CHANNEL, question) {
            Ok(()) => reached,
            Err(error) => {
                // Nobody can receive it, so nobody can answer: answering `0` is what makes the
                // read fail at once and loudly instead of parking the serialized fs loop for
                // the whole bound.
                eprintln!("nekowite: the live-note question could not be published: {error}");
                0
            }
        }
    }
}

/// The seam, built on the first start and kept for the life of the process.
///
/// `None` until a start has happened, because the port holds an `AppHandle` and there is none
/// before `setup` — the same reason `DesktopPetState` is built in `setup` and not by
/// `Default`. It is **kept across starts and across vault switches**, and that is deliberate:
/// a registration is a fact about a window, not about an engine, so a table that went with the
/// runtime would make every vault switch a window that can no longer be asked — a read that
/// fails loudly for a note the user is looking at.
pub fn live_notes(
    state: &AgentRuntimeState,
    app: &tauri::AppHandle,
) -> Result<LiveNotes, String> {
    let mut slot = state
        .live_notes
        .lock()
        .map_err(|_| "the agent runtime state was poisoned by a panic".to_string())?;
    if let Some(notes) = slot.as_ref() {
        return Ok(notes.clone());
    }

    let table = Arc::new(LiveNoteTable::new());
    let attached: Arc<Attached> = Arc::new(Mutex::new(HashMap::new()));

    let answers = Arc::clone(&table);
    let answer_id = app.listen(LIVE_NOTE_ANSWER_CHANNEL, move |event| {
        match serde_json::from_str::<LiveNoteAnswerPayload>(event.payload()) {
            // A refusal is reported and not retried: the question it names is either over or
            // was never this host's, and neither is something a second attempt would change.
            // stderr is the only channel this callback has — it is a host-side inconsistency
            // (a window answering a question that is not open), not an event of the session a
            // window is following.
            Ok(payload) => {
                if let Err(refusal) = answers.answer(payload) {
                    eprintln!(
                        "nekowite: a live-note answer was refused: {}",
                        refusal.sentence()
                    );
                }
            }
            Err(error) => eprintln!("nekowite: a live-note answer could not be read: {error}"),
        }
    });

    let registry = Arc::clone(&attached);
    let attach_id = app.listen(LIVE_NOTE_ATTACH_CHANNEL, move |event| {
        match serde_json::from_str::<AttachPayload>(event.payload()) {
            Ok(payload) => {
                let mut attached = registry.lock().unwrap();
                let windows = attached.entry(payload.vault_id).or_default();
                if payload.attached {
                    windows.insert(payload.window_id);
                } else {
                    windows.remove(&payload.window_id);
                }
            }
            Err(error) => eprintln!("nekowite: a window registration could not be read: {error}"),
        }
    });

    let notes = LiveNotes::new(
        table,
        Arc::new(NoteWindows {
            app: app.clone(),
            attached,
            listeners: Mutex::new(vec![answer_id, attach_id]),
        }),
    );
    *slot = Some(notes.clone());
    Ok(notes)
}
