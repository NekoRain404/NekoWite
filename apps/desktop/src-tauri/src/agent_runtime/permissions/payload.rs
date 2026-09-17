//! The permission payloads, and the three projections that build them out of the engine's frame.
//!
//! These are the contract's own shapes (`agent-contracts/payloads.ts`), whose validator drops a
//! prompt whose fields this host renamed — so every name below is the contract's, and the wire's
//! is only ever the *input* to a projection.
//!
//! Split out of `permissions.rs` when carrying the request's own content blocks took that file past
//! the budget (AGENTS.md: business files stay under 600 lines), which is the same reason
//! `commands/agent.rs`'s catalogue lives beside it. What is split is the *shape* half: the types a
//! renderer consumes and the functions that read one engine frame into them. The decision half —
//! what a request is bound to, which answers are refused, when a prompt ends — stays in
//! `permissions.rs`, where the lock that decides it lives.

use agent_client_protocol::schema::v1::{PermissionOptionKind, ToolCallContent, ToolCallUpdate};
use serde::Serialize;

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

/// One content block, in the two states the contract's `AgentToolContent` keeps apart.
///
/// The wire's `ToolCallContent` is a union of three (`agent-client-protocol-schema` 1.7.0,
/// `src/v1/tool_call.rs:572-583`): a standard content block, a `Diff`, and a `Terminal`. Exactly
/// one of them is *carried*, and it is the diff — the block a person acts on, since §6.3 requires
/// the user to see the target of the action they authorize and a proposed edit's target is its
/// text. The other two, and any arm a later schema adds, become `unrecognised` rather than being
/// dropped: a request that carried only those would otherwise read as one that carried nothing,
/// which is the difference the contract's kind list exists to keep (`payloads.ts`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolContentBlock {
    /// The change the engine proposes to a file, field for field the wire's `Diff`: the path as
    /// the engine named it, the original text as far as it stated one, and the text it proposes to
    /// leave. `old_text` is `None` when the engine stated none — which is **not** proof of a new
    /// file (the field deserializes default-on-error, so unreadable text arrives as `None` too),
    /// and the render's own rule about that is `AgentToolContent`'s.
    ///
    /// The path is carried only when this host can state it exactly: a `PathBuf` that is not valid
    /// UTF-8 becomes [`ToolContentBlock::Unrecognised`] rather than a replacement-character path
    /// the user cannot check against the file it names.
    #[serde(rename_all = "camelCase")]
    Diff {
        path: String,
        old_text: Option<String>,
        new_text: String,
    },
    /// A block this version does not draw.
    Unrecognised,
}

/// One permission request, as the UI receives it — the contract's `AgentPermissionRequest`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPrompt {
    /// The host's id for this request — what an answer must name, and what the UI keys its state
    /// on. Not the engine's JSON-RPC id, which is per connection and never leaves the transport.
    pub request_id: String,
    /// The engine's tool call id, which ties this prompt to the `tool_call_update` frames about the
    /// same call, and which the panel joins to the transcript's row for the call's *status*.
    /// §2.0b's re-render rule hangs on it: the arguments may be filled in *after* the request, and
    /// a prompt rendered from the request alone is consent given blind.
    pub tool_call_id: String,
    /// What the user is being asked to allow, in the engine's own wording ([`label_of`] says what a
    /// frame without one shows).
    pub title: String,
    pub input: ToolInput,
    /// The content blocks **this request's own `tool_call`** carried, in the contract's shapes —
    /// the proposed change among them.
    ///
    /// This is the surface where the decision is taken (§6.3 「等待授权时不锁死整个编辑器」), so it
    /// may not be a *join* to something else: P0 §7.1 measured the engine putting the diff in the
    /// request itself, and a prompt that read the transcript's row instead could show less than the
    /// engine asked with — on a host where the request is the first frame to carry the block,
    /// nothing at all. An empty list is what a request that carried no block says: the prompt then
    /// draws none, rather than falling back to the same call's row, which would make "this request
    /// stated no diff" and "its diff happens to equal the row's" one picture.
    pub content: Vec<ToolContentBlock>,
    /// Exactly the options the engine offered, in its order: §6.3 forbids the host inventing one.
    pub options: Vec<PermissionOptionView>,
}

/// The prompt's label, from the engine's own data: its title, else its own kind as the wire spells
/// it, else the tool call id. Nothing is worded for the engine.
///
/// The fallback exists because the contract's reader refuses an empty title, and a prompt dropped
/// on the way to the UI leaves the engine blocked on a question the user never saw — the one
/// outcome §6.3 cannot allow.
pub(super) fn label_of(tool_call: &ToolCallUpdate) -> String {
    if let Some(title) = tool_call.fields.title.clone() {
        return title;
    }
    if let Some(kind) = tool_call.fields.kind {
        let name = serde_json::to_value(kind)
            .ok()
            .and_then(|value| value.as_str().map(String::from));
        if let Some(name) = name {
            return name;
        }
    }
    tool_call.tool_call_id.to_string()
}

/// The arguments as the payload carries them. A value already in hand cannot fail to serialize; if
/// it somehow did, "nothing to show" is the honest state rather than an empty string that reads
/// like empty arguments.
pub(super) fn input_of(tool_call: &ToolCallUpdate) -> ToolInput {
    let Some(json) = tool_call
        .fields
        .raw_input
        .as_ref()
        .and_then(|raw| serde_json::to_string(raw).ok())
    else {
        return ToolInput::Absent;
    };
    ToolInput::Text { json }
}

/// The content blocks the request's own `tool_call` carried, in the contract's shapes.
///
/// A `tool_call` that mentions no content is an empty list, not a missing field — the contract's
/// payload always states this one, and "this request carried no block" is a complete answer rather
/// than a gap to be filled from somewhere else. Nothing here reads the session's tool rows: the
/// request is the only source, which is what keeps the prompt's diff the request's own.
pub(super) fn content_of(tool_call: &ToolCallUpdate) -> Vec<ToolContentBlock> {
    let Some(blocks) = tool_call.fields.content.as_ref() else {
        return Vec::new();
    };
    blocks
        .iter()
        .map(|block| match block {
            ToolCallContent::Diff(diff) => match diff.path.to_str() {
                Some(path) => ToolContentBlock::Diff {
                    path: path.to_string(),
                    old_text: diff.old_text.clone(),
                    new_text: diff.new_text.clone(),
                },
                None => ToolContentBlock::Unrecognised,
            },
            // Including `Content` and `Terminal`: named here rather than left to the wildcard so
            // that a reader can see which arms of the schema's union this version knows about and
            // does not draw. The `_` covers the arm `#[non_exhaustive]` leaves room for.
            ToolCallContent::Content(_) | ToolCallContent::Terminal(_) => {
                ToolContentBlock::Unrecognised
            }
            _ => ToolContentBlock::Unrecognised,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A `tool_call` as the engine sends one, deserialized through the schema rather than built
    /// field by field: the input of every projection here is the wire's own frame, and a struct
    /// assembled by hand would be a shape this host never sees. The fields are merged onto the one
    /// member the schema requires.
    fn tool_call(fields: serde_json::Value) -> ToolCallUpdate {
        let mut call = json!({ "toolCallId": "call_1" });
        let members = call.as_object_mut().expect("the seed is an object");
        for (name, value) in fields.as_object().expect("the fields are an object") {
            members.insert(name.clone(), value.clone());
        }
        serde_json::from_value(call).expect("the tool call deserializes")
    }

    #[test]
    fn content_carries_the_requests_own_diff_in_the_contracts_shape() {
        // Field for field the wire's `Diff` — which is also the contract's `diff` block, so the
        // render can use it unchanged. This is what the prompt draws a proposed edit from.
        let call = tool_call(json!({
            "content": [{
                "type": "diff",
                "path": "/vault/a.md",
                "oldText": "alpha\n",
                "newText": "ALPHA\n",
            }],
        }));
        assert_eq!(
            serde_json::to_value(content_of(&call)).expect("a block serializes"),
            json!([{ "type": "diff", "path": "/vault/a.md", "oldText": "alpha\n", "newText": "ALPHA\n" }])
        );
    }

    #[test]
    fn a_block_this_version_does_not_draw_is_named_rather_than_dropped() {
        // The wire's other two arms. Naming them keeps "the request carried a block I cannot draw"
        // apart from "the request carried nothing", which is the difference the contract's kind
        // list exists for — and the second half of the case is the `oldText` the engine did not
        // state, which reaches the contract as an explicit `null` rather than as a missing field.
        let call = tool_call(json!({
            "content": [
                { "type": "terminal", "terminalId": "t1" },
                { "type": "diff", "path": "/vault/a.md", "newText": "written\n" },
            ],
        }));
        assert_eq!(
            serde_json::to_value(content_of(&call)).expect("a block serializes"),
            json!([
                { "type": "unrecognised" },
                { "type": "diff", "path": "/vault/a.md", "oldText": null, "newText": "written\n" },
            ])
        );
    }

    #[test]
    fn a_request_that_mentions_no_content_carries_an_empty_list() {
        // Absent and empty are one answer here, and it is the request's own: the prompt draws
        // nothing for it, rather than the same call's row. `PermissionPrompt`'s field is not an
        // `Option`, so the payload always states this — the other half of the rule, that a
        // producer cannot leave it out, is the contract's reader's.
        let call = tool_call(json!({ "title": "Read notes/a.md" }));
        assert!(content_of(&call).is_empty());
        assert_eq!(
            serde_json::to_value(content_of(&call)).expect("an empty list serializes"),
            json!([])
        );
    }
}
