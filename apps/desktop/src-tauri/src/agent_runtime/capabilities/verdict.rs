//! What the negotiation said about one feature — the per-feature join, and the sentence each
//! refusal uses.
//!
//! **Why it is a file of its own.** It was the middle of `capabilities.rs`, which passed the
//! 600-line budget `docs/dev.md:286` puts on a business source file. The split is by *reason to
//! change*, which is the criterion that section states rather than the line count: this module moves
//! when a *feature* or the wire fact behind it moves — a `HostFeature` variant, the field an arm
//! reads, which of the two handshake groups answers it — while `super::finding` moves when the answer
//! vocabulary does, and `super` moves when the report row or this build's own offers do.
//!
//! **This is where a user is told a capability is not there**, so it is the file the brief's rule
//! about refusals is enforced in: every arm either reports the engine's own fact (naming the wire
//! field it read) or says nothing has established one, and the two are never merged. The two
//! sentences for the absent case sit beside the arms that use them rather than with `super`'s
//! no-negotiation sentence, because each one is written for its own arm and is only correct there.
//!
//! **It is the only place `Finding::Available` is built.** Nothing else may produce that arm, so a
//! reader looking for "what could make this available" has one file to read.

use crate::agent_runtime::adapters::HostFeature;

use super::finding::{answered, unavailable, unverified, Finding};
use super::negotiated::SessionCapabilities;

/// Why a feature the handshake would have answered is not available.
const NO_HANDSHAKE: &str =
    "this runtime has not read the engine's handshake, so nothing has said either way";

/// Why a feature the session response would have answered is not available.
const NO_SESSION: &str =
    "no session response has been read: the engine has not yet been asked what it offers here";

/// What the negotiation said about one feature — the only place [`Finding::Available`] is built.
///
/// A missing fact is `unverified` and a fact that says no is `unavailable`, at every arm: the two
/// are the difference between "this engine cannot" and "nobody has established that it can", which
/// is the distinction the whole module exists to keep.
pub(super) fn finding_for(
    feature: HostFeature,
    facts: &SessionCapabilities,
    model_option_id: Option<&str>,
) -> Finding {
    match feature {
        HostFeature::SessionResume => answered(
            facts.supports_session_resume(),
            "the engine's handshake does not advertise `loadSession`, so this engine cannot load a \
             session it still has",
            NO_HANDSHAKE,
        ),
        // The four `sessionCapabilities` sub-objects. Each names the wire field it read, because
        // the specific limitation is what §3.4.6 asks a page to be able to show — and because
        // "list" and "resume" name one method each while `SessionResume` above names a *different*
        // one, so a detail that said only "resume" would be ambiguous about which field said no.
        HostFeature::SessionList => answered(
            facts.session_capability_list(),
            "the engine's handshake carries no `sessionCapabilities.list`, so it has said it does \
             not answer `session/list` and there is no session history to show",
            NO_HANDSHAKE,
        ),
        HostFeature::SessionResumeWithoutHistory => answered(
            facts.session_capability_resume(),
            "the engine's handshake carries no `sessionCapabilities.resume`, so this engine cannot \
             reopen a session without its previous messages",
            NO_HANDSHAKE,
        ),
        HostFeature::SessionClose => answered(
            facts.session_capability_close(),
            "the engine's handshake carries no `sessionCapabilities.close`, so this engine cannot \
             be asked to free a session it holds",
            NO_HANDSHAKE,
        ),
        HostFeature::SessionFork => answered(
            facts.session_capability_fork(),
            "the engine's handshake carries no `sessionCapabilities.fork` — and the pinned schema \
             marks that capability unstable, so an engine may have removed it",
            NO_HANDSHAKE,
        ),
        HostFeature::ImageAttachments => answered(
            facts.supports_images(),
            "the engine's handshake does not advertise `promptCapabilities.image`, so an image \
             sent in a prompt is not something it has said it would read",
            NO_HANDSHAKE,
        ),
        HostFeature::AudioAttachments => answered(
            facts.supports_audio(),
            "the engine's handshake does not advertise `promptCapabilities.audio`, so an audio \
             attachment is not something it has said it would read",
            NO_HANDSHAKE,
        ),
        HostFeature::EmbeddedContext => answered(
            facts.supports_embedded_context(),
            "the engine's handshake does not advertise `promptCapabilities.embeddedContext`, so a \
             note or a selection cannot be sent inside the prompt as a resource block",
            NO_HANDSHAKE,
        ),
        HostFeature::SlashCommands => answered(
            facts.has_slash_completions(),
            // A published list with nothing in it is a measurement, not a gap: the engine answered
            // the question by publishing it (P0 §2.2 measured the list arriving after `session/new`,
            // always as a full replacement). What has *not* arrived is neither answer.
            "the engine published a command list and it was empty",
            "the engine has published no command list for this session, so there is no evidence \
             either way yet",
        ),
        HostFeature::SessionConfigOptions => match facts.session() {
            None => unverified(NO_SESSION),
            Some(session) if session.config_option_ids.is_empty() => unavailable(
                "`session/new` returned no configuration options, so this engine has nothing of \
                 its own here to set",
            ),
            Some(_) => Finding::Available,
        },
        HostFeature::ModelSelection => {
            // The adapter's answer for which option selects the model is the engine's-own-id
            // knowledge §3.4 forbids anyone else from guessing; without it there is nothing to look
            // for, and `unverified` is the honest state rather than a hunt through the options.
            let Some(option_id) = model_option_id else {
                return unverified(
                    "this engine's adapter names no configuration option as the model selector, so \
                     no session fact could confirm one",
                );
            };
            match facts.session() {
                None => unverified(NO_SESSION),
                Some(session) if session.config_option_ids.iter().any(|id| id == option_id) => {
                    Finding::Available
                }
                Some(_) => unavailable(&format!(
                    "`session/new` returned no option with the id `{option_id}` that this engine's \
                     adapter names as the model selector"
                )),
            }
        }
    }
}
