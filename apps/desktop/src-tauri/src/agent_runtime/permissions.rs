//! The permission boundary: the engine asks when it is configured to, the user decides, and this
//! module is the only place an answer may come from. P0 §7's preamble measured the default
//! configuration asking nothing — a write landed with `reverse requests seen: 0` — and §7.1 saw the
//! frame only after `permission: {edit:"ask"}` was set, so this is the flow once a request arrives,
//! not a gate every tool call passes. `session/request_permission` is the one reverse request where
//! the engine *blocks* instead of degrading, so a lost or invented answer stops work; §6.3's rules
//! are enforced here, and three of them are deliberately **stricter than Zed** (porting spec
//! §3.4/§3.5):
//!
//! - **The option ids are the engine's**, and a response naming an id it did not offer is refused.
//!   Zed forwards whatever id it is handed — its conversion keeps only the id and trusts the caller
//!   (§3.4) — so the offered set has to be kept here: the request is the only place it exists.
//! - **A second answer is a no-op where the decision is taken**: the first answer removes the
//!   request. Zed's duplicate never reaches the wire but still repaints the tool call (§3.5).
//! - **Cancel and process exit end every pending request** — Zed implements neither (§3.5, §6 item
//!   6), and §6.2 requires both.
//!
//! Each request is also bound to a composite identity — runtime, vault, session, run — because the
//! renderer is not a trusted source of it (§6.1), and the payloads below are the contract's own
//! shapes (`agent-contracts/payloads.ts`), whose validator drops a prompt whose fields this host
//! renamed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1::{
    PermissionOptionId, PermissionOptionKind, RequestPermissionOutcome, RequestPermissionResponse,
    SelectedPermissionOutcome, ToolCallUpdate,
};
use agent_client_protocol::{Error as AcpError, RequestCancellation, Responder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use super::acp_transport::PermissionRequest;
use super::events::{AgentEventKind, AgentIdentity};
use super::session::{AgentRuntime, AgentRuntimeEvents, Emitter, SessionError, SessionSlot};

/// How long a request may wait for the session it names to appear. The same window, for the same
/// measured reason, as `runs::dispatch_fs`: the engine may use a session the instant it receives
/// `session/new`'s answer, while this host registers it on another task — so for a moment "not
/// known yet" and "never ours" look identical.
const REGISTRATION_WINDOW: Duration = Duration::from_millis(250);

/// How many answered request ids are remembered. It only sharpens a refusal — "answered already"
/// instead of "no such request" — so a bound is safe: an id that falls out of it is still refused,
/// with the less precise reason, and nothing reaches the wire either way.
const ANSWERED_MEMORY: usize = 32;

/// Who an answer is for: the contract's `AgentIdentity`, field for field — the same object the
/// gateway passes as `session` when it answers (`answerPermission(session, requestId, optionId)`).
/// Each field defends against a different way for an answer to be about something other than the
/// prompt the user saw.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionIdentity {
    /// Which engine: two can run at once and hand out the same session id, since the ids are the
    /// engine's and nothing makes them globally unique.
    pub agent_id: String,
    /// Which configured profile of that engine.
    pub profile_id: String,
    /// Which incarnation of this host: a restarted app has a new one, so an answer from a window
    /// that outlived the restart cannot be applied to whatever session holds that id now.
    pub runtime_epoch: String,
    /// Which vault: the engine session outlives a vault switch, and consent given in one vault
    /// must not authorize work in another.
    pub vault_id: String,
    /// The engine's session id, as the engine named it.
    pub session_id: String,
}

impl PermissionIdentity {
    /// The first field the two do not share, named as the wire names it.
    fn first_mismatch(&self, other: &PermissionIdentity) -> Option<&'static str> {
        let checked: [(&'static str, bool); 5] = [
            ("agentId", self.agent_id == other.agent_id),
            ("profileId", self.profile_id == other.profile_id),
            ("runtimeEpoch", self.runtime_epoch == other.runtime_epoch),
            ("vaultId", self.vault_id == other.vault_id),
            ("sessionId", self.session_id == other.session_id),
        ];
        checked.into_iter().find(|(_, matches)| !matches).map(|(field, _)| field)
    }
}

/// What a request is bound to: the identity, plus the run it was raised in.
///
/// The run is part of this record and travels on the event envelope, but it is not something an
/// answer echoes back — the gateway's answer carries no run — so the request id, this host's own
/// and unique per request, is what binds an answer to the request it names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionBinding {
    pub identity: PermissionIdentity,
    pub run_id: Option<String>,
}

/// One answer from the renderer. The identity is part of it rather than looked up from the request
/// id, so an answer naming a different vault or session is *evidence* of a stale or forged window
/// instead of a value the host would have supplied for it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionAnswer {
    /// The session the answer is for, as the gateway holds it.
    pub session: PermissionIdentity,
    /// The host's id for the request, from the prompt the renderer received.
    pub request_id: String,
    /// One of the engine's own option ids, exactly as the engine spelled it.
    pub option_id: String,
}

/// Why an answer — or a request — was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionRefusal {
    /// The request is not pending and never was one of ours. No timer is behind this: "expired"
    /// means the request has *ended* — cancelled, ended with the process, or abandoned by the
    /// engine. A host-side deadline would be a policy nothing measured, and would refuse a prompt
    /// the engine is still blocking on.
    Expired { request_id: String },
    /// The request was answered already: the second click of a double click.
    AlreadyAnswered { request_id: String },
    /// The answer's identity is not the identity the request was raised under.
    IdentityMismatch { field: &'static str },
    /// The answer names an option the engine never offered.
    OptionNotOffered { option_id: String },
    /// The engine asked about a session this host never opened.
    UnknownSession { session_id: String },
}

/// One of the engine's options, as the UI offers it — the contract's `AgentPermissionOption`. The
/// kind is the engine's own, all four of them rather than a collapsed allow/reject pair:
/// `allow_always` remembers the choice where `allow_once` does not, and that is what the user is
/// weighing (§6.3).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOptionView {
    pub option_id: String,
    pub name: String,
    pub kind: PermissionOptionKind,
}

/// The arguments, in the states the contract's `AgentToolInput` keeps apart.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ToolInput {
    /// Nothing to show. The schema drops a `rawInput` it cannot deserialize, so "the engine sent
    /// none" and "it sent one that did not parse" are one state by the time a typed request exists
    /// (open spec issue #1979): the contract's third state, `unreadable`, is one this host cannot
    /// honestly claim, and the prompt must read as "what you are approving has not arrived".
    Absent,
    /// The arguments as the engine sent them, serialized rather than parsed: their shape is the
    /// engine's, and pretty-printing is the UI's business.
    Text { json: String },
}

/// One permission request, as the UI receives it — the contract's `AgentPermissionRequest`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPrompt {
    /// The host's id for this request — what an answer must name, and what the UI keys its state
    /// on. Not the engine's JSON-RPC id, which is per connection and never leaves the transport.
    pub request_id: String,
    /// The engine's tool call id, which ties this prompt to the `tool_call_update` frames about the
    /// same call. §2.0b's re-render rule hangs on it: the arguments may be filled in *after* the
    /// request, and a prompt rendered from the request alone is consent given blind.
    pub tool_call_id: String,
    /// What the user is being asked to allow, in the engine's own wording ([`label_of`] says what a
    /// frame without one shows).
    pub title: String,
    pub input: ToolInput,
    /// Exactly the options the engine offered, in its order: §6.3 forbids the host inventing one.
    pub options: Vec<PermissionOptionView>,
}

/// Every request the engine has asked and this host has not answered. Bound to one runtime: its
/// event stream (a prompt is an ordinary event, sharing the runtime's one sequence counter rather
/// than starting a second stream the UI would have to interleave) and its session table (the run a
/// request belongs to comes from there, never from the renderer).
pub struct PermissionTable {
    identity: AgentIdentity,
    emitter: Emitter,
    sessions: Arc<Mutex<HashMap<String, SessionSlot>>>,
    pending: Mutex<Pending>,
    next_request_id: AtomicU64,
}

#[derive(Default)]
struct Pending {
    requests: HashMap<String, PendingRequest>,
    /// Ids of requests that stopped being pending because the *user* answered them, newest last:
    /// used only to tell a double click from an answer to something already gone.
    answered: Vec<String>,
}

struct PendingRequest {
    /// What an answer must match, taken from the runtime's own session table when the request
    /// arrived — never from the request or the renderer.
    binding: PermissionBinding,
    /// The option ids the engine offered, in its order: the request is the only place they exist.
    offered: Vec<String>,
    /// The prompt as published, so a snapshot can be served without rebuilding it.
    prompt: PermissionPrompt,
    /// The engine's side of the request, consumed by the one answer it is entitled to.
    responder: Responder<RequestPermissionResponse>,
    /// Never read: the *drop* is the signal, and it is how the peer cancellation watcher learns
    /// it has nothing left to watch when this request stops being pending.
    _resolved: oneshot::Sender<()>,
}

impl PendingRequest {
    /// Sends the response this request is entitled to.
    fn answer(self, outcome: RequestPermissionOutcome) {
        report_failed_send(self.responder.respond(RequestPermissionResponse::new(outcome)));
    }

    /// Refuses on the engine's side: a request this host will not act on still has to end, because
    /// the engine is blocked on it.
    fn fail(self, error: AcpError) {
        report_failed_send(self.responder.respond_with_error(error));
    }
}

/// The prompt's label, from the engine's own data: its title, else its own kind as the wire spells
/// it, else the tool call id. Nothing is worded for the engine.
///
/// The fallback exists because the contract's reader refuses an empty title, and a prompt dropped
/// on the way to the UI leaves the engine blocked on a question the user never saw — the one
/// outcome §6.3 cannot allow.
fn label_of(tool_call: &ToolCallUpdate) -> String {
    if let Some(title) = tool_call.fields.title.clone() {
        return title;
    }
    if let Some(kind) = tool_call.fields.kind {
        let name = serde_json::to_value(kind).ok().and_then(|value| {
            value.as_str().map(String::from)
        });
        if let Some(name) = name {
            return name;
        }
    }
    tool_call.tool_call_id.to_string()
}

/// The arguments as the payload carries them. A value already in hand cannot fail to serialize; if
/// it somehow did, "nothing to show" is the honest state rather than an empty string that reads
/// like empty arguments.
fn input_of(tool_call: &ToolCallUpdate) -> ToolInput {
    let Some(json) = tool_call.fields.raw_input.as_ref().and_then(|raw| serde_json::to_string(raw).ok())
    else {
        return ToolInput::Absent;
    };
    ToolInput::Text { json }
}

/// A failed send means the connection is gone. The engine sees only an error code either way, so
/// the reason belongs here (spec §2.2's rule for every refusal) rather than being swallowed.
fn report_failed_send(sent: Result<(), AcpError>) {
    if let Err(error) = sent {
        eprintln!("nekowite: could not answer a permission request: {error}");
    }
}

impl Pending {
    /// Remembers that the *user* answered this request.
    ///
    /// Only an answer goes in here: a request ended by a cancel, by the process exiting or by the
    /// engine giving up was not answered, and recording it here would tell the next click that it
    /// was the one that already happened — the wrong fact to show them.
    fn remember_answered(&mut self, request_id: &str) {
        self.answered.push(request_id.to_string());
        if self.answered.len() > ANSWERED_MEMORY {
            self.answered.remove(0);
        }
    }

    /// Takes the request `answer` may be applied to, or says why it may not.
    fn take(&mut self, answer: &PermissionAnswer) -> Result<PendingRequest, PermissionRefusal> {
        let Some(entry) = self.requests.get(&answer.request_id) else {
            return Err(if self.answered.iter().any(|id| id == &answer.request_id) {
                PermissionRefusal::AlreadyAnswered { request_id: answer.request_id.clone() }
            } else {
                PermissionRefusal::Expired { request_id: answer.request_id.clone() }
            });
        };
        if let Some(field) = entry.binding.identity.first_mismatch(&answer.session) {
            return Err(PermissionRefusal::IdentityMismatch { field });
        }
        if !entry.offered.iter().any(|id| id == &answer.option_id) {
            return Err(PermissionRefusal::OptionNotOffered { option_id: answer.option_id.clone() });
        }
        // Removed only once every check has passed: a refused answer must leave the prompt
        // answerable, or one forged vault id would be enough to consume a live request.
        let entry = self.requests.remove(&answer.request_id).expect("checked a moment ago, under
             this same lock");
        self.remember_answered(&answer.request_id);
        Ok(entry)
    }
}

impl PermissionTable {
    /// Binds a table to one runtime. `identity` is the identity the runtime was built with: this
    /// copy is only ever *compared* with what an answer claims, so a composition that passed a
    /// different one fails closed — every answer refused — rather than authorizing the wrong vault.
    pub fn new(identity: AgentIdentity, runtime: &AgentRuntime) -> Arc<Self> {
        Arc::new(Self {
            identity,
            emitter: runtime.emitter.clone(),
            sessions: Arc::clone(&runtime.sessions),
            pending: Mutex::new(Pending::default()),
            next_request_id: AtomicU64::new(1),
        })
    }

    /// Records one engine request, publishes it, and starts watching for the engine abandoning it.
    pub fn adopt(
        self: &Arc<Self>,
        request: PermissionRequest,
    ) -> Result<PermissionPrompt, PermissionRefusal> {
        let session_id = request.request.session_id.to_string();
        // One read of the session table, used for the binding *and* the envelope: the two must not
        // be able to disagree about which run the prompt belongs to.
        let run_id = {
            match self.sessions.lock().unwrap().get(&session_id) {
                Some(slot) => slot.run.as_ref().map(|run| run.run_id.clone()),
                None => {
                    // Not a session this host opened: nothing to bind to and no prompt to show.
                    // The engine is blocked on this request, so silence is not an option — it gets
                    // an error naming the id, the answer Zed's choke point gives the same case
                    // (spec §2.5).
                    let error = AcpError::internal_error()
                        .data(format!("unknown session: {session_id}"));
                    report_failed_send(request.responder.respond_with_error(error));
                    return Err(PermissionRefusal::UnknownSession { session_id });
                }
            }
        };
        let binding = PermissionBinding {
            identity: PermissionIdentity {
                agent_id: self.identity.agent_id.clone(),
                profile_id: self.identity.profile_id.clone(),
                runtime_epoch: self.identity.runtime_epoch.clone(),
                vault_id: self.identity.vault_id.clone(),
                session_id: session_id.clone(),
            },
            run_id,
        };
        let request_id = format!("perm-{}", self.next_request_id.fetch_add(1, Ordering::Relaxed));
        let tool_call = &request.request.tool_call;
        let prompt = PermissionPrompt {
            request_id: request_id.clone(),
            tool_call_id: tool_call.tool_call_id.to_string(),
            title: label_of(tool_call),
            input: input_of(tool_call),
            options: request
                .request
                .options
                .iter()
                .map(|option| PermissionOptionView {
                    option_id: option.option_id.to_string(),
                    name: option.name.clone(),
                    kind: option.kind,
                })
                .collect(),
        };
        let offered = request.request.options.iter().map(|option| option.option_id.to_string());
        let cancellation = request.responder.cancellation();
        let (resolved, resolved_rx) = oneshot::channel();

        let entry = PendingRequest {
            binding: binding.clone(),
            offered: offered.collect(),
            prompt: prompt.clone(),
            responder: request.responder,
            _resolved: resolved,
        };
        self.pending.lock().unwrap().requests.insert(request_id.clone(), entry);

        // Into the runtime's own stream, stamped with the same run id the binding holds.
        self.emitter.emit(
            &session_id,
            binding.run_id.clone(),
            AgentEventKind::PermissionRequest,
            serde_json::to_value(&prompt).unwrap_or(Value::Null),
        );
        let watched = watch_peer_cancellation(Arc::clone(self), request_id, cancellation, resolved_rx);
        tokio::spawn(watched);
        Ok(prompt)
    }

    /// Records one request the driver has already read off the runtime.
    ///
    /// The wait is the reason this is not simply [`PermissionTable::adopt`]: the engine may use a
    /// session the instant it receives `session/new`'s answer, while this host registers it on the
    /// task that issued the call — so for a moment "not known yet" and "never ours" look the same,
    /// and waiting briefly is what separates them (`runs::dispatch_fs` waits for the same measured
    /// reason).
    pub async fn adopt_known(
        self: &Arc<Self>,
        request: PermissionRequest,
    ) -> Result<PermissionPrompt, PermissionRefusal> {
        let session_id = request.request.session_id.to_string();
        let deadline = Instant::now() + REGISTRATION_WINDOW;
        while !self.sessions.lock().unwrap().contains_key(&session_id) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.adopt(request)
    }

    /// Takes the next request off the runtime and records it — the single-request form, which a
    /// caller that is not itself driving the event stream uses (the driver takes both streams at
    /// once, and calls [`PermissionTable::adopt_known`] with what it reads).
    pub async fn adopt_next(
        self: &Arc<Self>,
        events: &mut AgentRuntimeEvents,
    ) -> Option<Result<PermissionPrompt, PermissionRefusal>> {
        let request = events.next_permission().await?;
        Some(self.adopt_known(request).await)
    }

    /// Answers one pending request.
    pub fn respond(&self, answer: &PermissionAnswer) -> Result<(), PermissionRefusal> {
        let entry = self.pending.lock().unwrap().take(answer)?;
        // Outside the lock: an answer that cannot be sent must not hold up the next request's.
        entry.answer(RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            PermissionOptionId::new(answer.option_id.clone()),
        )));
        Ok(())
    }

    /// Ends every pending request raised on `session_id`, answering each one `cancelled`.
    ///
    /// §6.2's 「旧授权按钮失效」 for a stopped run: a prompt that outlived its turn cannot stay
    /// answerable, and the engine — still blocking on it — must be told the turn is over rather
    /// than denied, which is a different fact about the user (spec §2.0b).
    pub fn revoke_session(&self, session_id: &str) -> usize {
        self.revoke(|binding| binding.identity.session_id == session_id)
    }

    /// Ends every pending request: the process-exit route to the same rule.
    pub fn revoke_all(&self) -> usize {
        self.revoke(|_| true)
    }

    /// Ends every pending request `doomed` selects, under one lock. No tombstone is left behind:
    /// these ended without an answer, so a later click is refused as a prompt no longer open
    /// rather than as one already answered.
    fn revoke(&self, doomed: impl Fn(&PermissionBinding) -> bool) -> usize {
        let mut pending = self.pending.lock().unwrap();
        let ids: Vec<String> = pending
            .requests
            .iter()
            .filter(|(_, entry)| doomed(&entry.binding))
            .map(|(id, _)| id.clone())
            .collect();
        let mut ended = 0;
        for id in ids {
            if let Some(entry) = pending.requests.remove(&id) {
                ended += 1;
                // Answered under the lock: the send is a channel write, and keeping "revoked" and
                // "answered `cancelled`" one step is what makes a race with a click have exactly
                // one winner.
                entry.answer(RequestPermissionOutcome::Cancelled);
            }
        }
        ended
    }

    /// The prompts still waiting for an answer — the snapshot §6.2 requires a remounting UI to
    /// take before it subscribes, for the one part of the state that grants something.
    pub fn pending(&self) -> Vec<PermissionPrompt> {
        self.pending.lock().unwrap().requests.values().map(|entry| entry.prompt.clone()).collect()
    }

    /// Ends one request because the engine abandoned it (see the watcher).
    fn revoke_peer_cancelled(&self, request_id: &str) {
        if let Some(entry) = self.pending.lock().unwrap().requests.remove(request_id) {
            // An error, not `cancelled`: `cancelled` tells the engine the turn died, and here the
            // engine cancelled its own request. This is the answer Zed's handler gives the same
            // case (spec §2.3, half 1).
            entry.fail(AcpError::request_cancelled());
        }
    }
}

/// Watches one pending request for the engine's own cancellation of it: ACP lets the side that
/// raised a request cancel it, and Zed revokes the prompt and answers the peer when that happens
/// (spec §2.3, half 1). Ends either way, so it is one task per open prompt, not a leak.
async fn watch_peer_cancellation(
    table: Arc<PermissionTable>,
    request_id: String,
    cancellation: RequestCancellation,
    resolved: oneshot::Receiver<()>,
) {
    tokio::select! {
        () = cancellation.cancelled() => table.revoke_peer_cancelled(&request_id),
        // The sender is dropped when this host answers or revokes the request, so this arm is
        // also how the watcher ends normally.
        _ = resolved => {}
    }
}

/// Stops a run: every pending prompt is ended first, then the engine is told.
///
/// The order is the protocol's, not a preference (spec §2.0b): a `session/cancel` sent while a
/// permission request is open leaves the engine waiting on a request whose turn is already over.
pub async fn cancel_run(
    runtime: &AgentRuntime,
    table: &PermissionTable,
    session_id: &str,
) -> Result<(), SessionError> {
    table.revoke_session(session_id);
    runtime.cancel(session_id).await
}
