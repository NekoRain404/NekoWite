//! What the pinned engine actually puts on the wire — measured, not inferred.
//!
//! Five rows of `agent-ui-gap-audit-remeasure.md` were left unsettled for one reason: nothing in
//! this tree had ever recorded the pinned engine sending the frames they are about. Row 5
//! (`usage_update`), row 11 (`session_info_update`) and row 21 (`plan`) had a producer added, or a
//! consumer chain waiting, on the strength of *code existing in the artifact* — a byte scan
//! establishes that a sender was compiled in, and nothing about whether it ever fires. Rows 26 and
//! 27 (`_meta.subagent_session_info` on a tool call, and `elicitation/create`) had no measurement
//! at all.
//!
//! **Why this instrument and not the runtime's own event stream.** `AgentRuntimeEvents` carries
//! `normalize_update`'s *output*, and `normalize_update` is exactly the filter three of the five
//! questions are about: a `plan` frame and a `session_info_update` frame fall to `_ => None`
//! (`events.rs:414`), which from up there is indistinguishable from a frame the engine never sent.
//! The replay target's own lesson is the same one one layer down — a drop inside the mapping is
//! invisible from any stream that has already been through it. So this file listens to the
//! **transport**, where the engine's frames are still the engine's:
//!
//! 1. the typed half: `EngineEvents.updates` is the SDK's own `SessionNotification`, before any
//!    host vocabulary is applied;
//! 2. the verbatim half: the launch is wrapped in a two-way `tee`, so every JSON-RPC line in both
//!    directions is on disk beside the run. That is the only place an engine→**client request**
//!    can be seen at all — this host registers no handler for `elicitation/create`, so the SDK
//!    answers such a request `-32601` inside its own dispatch loop and it never reaches a Rust
//!    caller. Without the transcript, row 27 would be unmeasurable through this transport.
//!
//! Everything below the wrapper is the product's own path: the same binary with the same `acp`
//! argument, `isolated_profile_env`'s roots, `NWK_TEST_KEY` through the same environment, the same
//! CA injection, the same `BoundedFrameReader`, the same request bounds, and `EngineConnection`'s
//! own calls. What is skipped is `AgentRuntime`'s bookkeeping, deliberately: that layer's job is
//! to decide which frames reach a window, so asking it whether a frame arrived would be asking the
//! filter to report on what it filtered. The mapping is still measured here — `mapped` below runs
//! the host's own `normalize_update` over each frame that actually arrived.
//!
//! **The prompts are ordinary usage, not probes.** A turn that reads a folder and writes a summary
//! of it is what the composer is for; a turn that searches a folder for a word is what people ask
//! for every day. Neither is shaped to make a frame appear — the point is the opposite, and a
//! negative here is the result worth having.

//! The cases are divided by behaviour domain rather than kept in one file, because this target
//! outgrew a page: `harness` for the engine behind the tee wrapper and the guards that decide when
//! there is nothing to measure, `frames` for the frame vocabulary and the bounded read, `turn` for
//! one measured turn, `transcript` for the verbatim wire log, `measured_absences` for the four
//! frames the engine was measured not to send, `metadata_member` for row 26's member check, and one
//! file per paying case (`tool_turn`, `search_turn`) plus the wrapper's own control
//! (`wrapper_control`). They are one target and one command:
//! `cargo test --test agent_wire_frames_live_test` runs every one of them, because a test in a file
//! nobody runs is not evidence.
//!
//! `#[path]` rather than a bare `mod`, because this target's root is
//! `tests/agent_wire_frames_live_test.rs` and a plain `mod harness;` would resolve to
//! `tests/harness.rs` — a file cargo would then discover as a target of its own. The directory
//! holds behaviour, not targets, and there is deliberately no `main.rs` in it.

// The frame vocabulary and the bounded read that fills it.
#[path = "agent_wire_frames_live_test/frames.rs"]
mod frames;
// The engine behind the tee wrapper: the launch, the skip guards and the reverse-request servant.
#[path = "agent_wire_frames_live_test/harness.rs"]
mod harness;
// The four frames the pinned engine was measured not to send, and the assertion that reads them.
#[path = "agent_wire_frames_live_test/measured_absences.rs"]
mod measured_absences;
// Row 26: whether a frame carries its own `_meta`, and the detector's own unit case.
#[path = "agent_wire_frames_live_test/metadata_member.rs"]
mod metadata_member;
// The search turn: a tree worth searching, where a subagent key would be the ordinary instrument.
#[path = "agent_wire_frames_live_test/search_turn.rs"]
mod search_turn;
// The read-and-summarise turn: an ordinary composer request, measured frame by frame.
#[path = "agent_wire_frames_live_test/tool_turn.rs"]
mod tool_turn;
// The verbatim wire log, read for tool-call frames and engine->client requests.
#[path = "agent_wire_frames_live_test/transcript.rs"]
mod transcript;
// One turn end to end: the folder, the session, the prompt, and the frames it produced.
#[path = "agent_wire_frames_live_test/turn.rs"]
mod turn;
// The wrapper's control: both directions recorded, the handshake unchanged.
#[path = "agent_wire_frames_live_test/wrapper_control.rs"]
mod wrapper_control;
