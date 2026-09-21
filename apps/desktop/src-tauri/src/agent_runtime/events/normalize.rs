//! One `session/update`, in the host's vocabulary: the kind, and the payload the contract reads.
//!
//! Its own module because this is the only place the wire's shapes are translated, and the shapes
//! move without the vocabularies beside them moving: a new `SessionUpdate`, a field the schema
//! respells, or a payload the frozen contract reads differently are all edits here. The readers
//! below (`context_cost`, `config_options`, `config_option`, `config_choices`, `text_of`) exist for
//! the same reason and change with it — each one is a difference between the schema's shape and the
//! contract's, mapped rather than passed through.

use agent_client_protocol::schema::v1::{
    ContentBlock, ContentChunk, Cost, SessionConfigKind, SessionConfigOption,
    SessionConfigSelectOption, SessionConfigSelectOptions, SessionUpdate,
};
use serde_json::{json, Value};

use super::kinds::AgentEventKind;

/// A `session/update` turned into the host's vocabulary.
///
/// `None` means "deliberately not forwarded", and the reasons are different
/// enough to name:
///
/// - **`AgentThoughtChunk`** was in this list and is no longer. P0 §2.3 measured
///   it on the wire; the contract was asked to decide and decided to keep it
///   (`payloads.ts`'s `'thought-delta'`, with a reducer arm, a collapsed timeline
///   row and its own copy), carrying the mapping forward to this layer in as many
///   words: 「the gap is in the mapping」 (T1 §2). A drop here would leave a kind
///   the whole window is built to render with no producer, which is the defect
///   §6.2's rule exists to prevent — reversed.
/// - **`UserMessageChunk`** was in this list too, for the same reason and with the
///   same outcome: the contract had a kind for it and this layer had no arm. See the
///   arm below.
/// - **everything else the schema can name** — plan frames, mode
///   updates, session metadata and usage, compaction, and the `Other` escape hatch.
///   §6.2 requires that `unknown` never reaches a component, so an update this host
///   has no kind for is not forwarded as a mystery blob to be guessed at.
pub fn normalize_update(update: &SessionUpdate) -> Option<(AgentEventKind, Value)> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            let text = text_of(chunk)?;
            Some((AgentEventKind::TextDelta, json!({ "text": text })))
        }
        // The engine's copy of the user's half. It is what `session/load` replays beside the
        // answers — the conversation's other half — and `user-delta` is the contract's own kind
        // for it (`payloads.ts`, `readText`, the reducer's `user` row and `AgentTimeline.vue`).
        //
        // **This arm is the producer that kind was missing.** It was declared at T1 with a
        // reducer arm, a timeline row and a renderer, and nothing on this side ever emitted it:
        // the frame fell to `_ => None` below, so a restored session drew only the agent's half
        // and drew it silently. Zed reads the same frame the same way (`acp_thread.rs` pushes a
        // `UserMessage` entry rather than appending to the answer), which is where this decision
        // comes from; its echo suppression is not copied, because this host keeps the engine's
        // copy in a row of its own (`origin: 'engine'`) rather than folding it into the message
        // it sent optimistically.
        //
        // Forwarded in the contract's shape for `user-delta` (`{ text }`), the same shape and the
        // same `text_of` reason as the two chunk kinds around it: a chunk carrying an image is
        // not an empty message.
        SessionUpdate::UserMessageChunk(chunk) => {
            let text = text_of(chunk)?;
            Some((AgentEventKind::UserDelta, json!({ "text": text })))
        }
        // The engine's reasoning channel, forwarded in the contract's shape for `thought-delta`
        // (`{ text }`) — the same shape as the answer's, and the same `text_of` reason for
        // refusing a chunk that carries no text: an image or a resource link is not an empty
        // thought.
        SessionUpdate::AgentThoughtChunk(chunk) => {
            let text = text_of(chunk)?;
            Some((AgentEventKind::ThoughtDelta, json!({ "text": text })))
        }
        // P0 §6.1: a tool call is a `ToolCall` followed by `ToolCallUpdate`
        // frames whose `status` runs pending → in_progress → completed, with
        // `toolCallId` as the key that ties the three together. Both are
        // forwarded verbatim: the shape is the schema's, and re-packaging it
        // here would only lose the fields T5 needs to correlate them.
        SessionUpdate::ToolCall(call) => {
            Some((AgentEventKind::ToolUpdate, json!({ "update": call })))
        }
        SessionUpdate::ToolCallUpdate(update) => {
            Some((AgentEventKind::ToolUpdate, json!({ "update": update })))
        }
        // Measured in P0 §2.2: the command list arrives as a notification after
        // `session/new`, replaces the previous list whole, and carries the
        // engine's own command names.
        SessionUpdate::AvailableCommandsUpdate(commands) => Some((
            AgentEventKind::CommandsChanged,
            json!({ "commands": commands.available_commands }),
        )),
        // The engine's own option list — the model selector among its entries, plus
        // whatever else the engine offers — as the full set with its current values.
        // The same kind of fact as the command list above (the engine telling the
        // session what it now offers), and forwarded for the same reason: the
        // contract declares the kind, the window's reducer keeps `view.config` from
        // it, and a frame dropped here is the one thing that keeps the panel from
        // ever showing an engine's own options.
        //
        // **The payload is mapped, not passed through.** The schema and the contract
        // do not share a shape for this one (see `config_options` below), and the
        // contract is the frozen side: `readConfigChanged` reads `{ options: [{ id,
        // name, description?, value }] }` and nothing else.
        SessionUpdate::ConfigOptionUpdate(update) => Some((
            AgentEventKind::ConfigChanged,
            json!({ "options": config_options(&update.config_options) }),
        )),
        // The session's context window and its cumulative cost. The kind, the reader
        // (`readers/session.ts`'s `readContextUsage`), the reducer's arm and the view's `usage`
        // were all placed at T1; this arm is the producer they were missing, and the reason it was
        // missing is that nothing in this tree had seen the frame on the wire.
        //
        // **The engine was measured sending it, in the pinned artifact itself.** The binary P0 §1
        // pins (`binaries/opencode-x86_64-unknown-linux-gnu`) builds and sends this frame in two
        // places, both named `usage.*sendUpdate` in its own source strings: one on the ACP
        // session path (`ACPUsage.sendUpdate`) and one after a prompt (`ACP.promptUsage.sendUpdate`).
        // Both take the same three facts — the last assistant message's context tokens as `used`,
        // the model's own context limit as `size`, and the session's cumulative cost — and both are
        // guarded: no message, no provider or model id, or no known context limit for that model
        // means *no frame at all*. So this arm is correct and may be invisible on a provider whose
        // model the engine has no limit for; that is a fact about the engine's guard rather than
        // about this mapping, and it is why the window must treat `usage === null` as "nothing has
        // been reported" (§5.1) rather than as a zero.
        //
        // **The payload is mapped, not passed through**, for the reason `config_options` below
        // gives: the contract is the frozen side, and it reads `{ usedTokens, contextTokens, cost }`
        // — `cost` present as numbers or as an explicit null, so a consumer is never left guessing
        // between "no cost" and "the field was forgotten".
        SessionUpdate::UsageUpdate(update) => Some((
            AgentEventKind::UsageChanged,
            json!({
                "usedTokens": update.used,
                "contextTokens": update.size,
                "cost": context_cost(update.cost.as_ref()),
            }),
        )),
        _ => None,
    }
}

/// ACP's cumulative cost in the contract's shape, or an explicit `null`.
///
/// `null` rather than an absent member, and the difference is load-bearing: ACP makes `cost`
/// optional, the contract's `AgentContextUsage.cost` is `AgentCost | null`, and
/// `readContextUsage` refuses a payload where the member is missing — because "the engine
/// reported no cost" and "this producer forgot to say" are different statements, and §5.1 lets a
/// surface show only the first (§5.1: an unknown cost is not zero).
fn context_cost(cost: Option<&Cost>) -> Value {
    match cost {
        Some(cost) => json!({ "amount": cost.amount, "currency": cost.currency }),
        None => Value::Null,
    }
}

/// The schema's option list, in the contract's shape.
///
/// Three differences, and each one is a reason this is a mapping rather than a
/// pass-through:
///
///  - the discriminator. The contract tags the *value* (`value.kind`), the wire
///    flattens a `type` onto the option itself (`select` / `boolean`) — the two do
///    not even agree on how to spell "kind" (`toggle` and `boolean`);
///  - the current value: `value.current` against the wire's `currentValue`;
///  - a select's choices: an untagged union on the wire (a flat list, or a list of
///    *groups* of them) and a flat list in the contract. The grouped case is
///    flattened here, which loses the group's name — `AgentConfigChoice` has nowhere
///    to put it. That is the residual T4b §7 reported (the same flattening
///    `tauri-agent/session.ts` does for the catalog), not a decision taken here.
///
/// An option whose type this host cannot express is left out rather than sent as
/// something it is not: the contract's reader refuses a whole payload containing one
/// entry it cannot read, so a single unreadable option would cost the engine's entire
/// list. Nothing reaches that arm from the wire today — the schema skips an option it
/// cannot deserialize — which is why leaving it out is a floor rather than a policy.
fn config_options(options: &[SessionConfigOption]) -> Vec<Value> {
    options.iter().filter_map(config_option).collect()
}

/// One option, or `None` for a kind the contract has no arm for.
fn config_option(option: &SessionConfigOption) -> Option<Value> {
    let value = match &option.kind {
        SessionConfigKind::Select(select) => json!({
            "kind": "select",
            "current": select.current_value.to_string(),
            "choices": config_choices(&select.options),
        }),
        SessionConfigKind::Boolean(toggle) => json!({
            "kind": "toggle",
            "current": toggle.current_value,
        }),
        // `SessionConfigKind` is `#[non_exhaustive]`: a type the pinned schema does not
        // name yet is a shape this host cannot put in the contract's two arms.
        _ => return None,
    };
    let mut mapped = json!({
        "id": option.id.to_string(),
        "name": option.name,
        "value": value,
    });
    // Absent and empty differ: the contract's `description` is optional, and an engine
    // that sent none did not send an empty one.
    if let Some(description) = &option.description {
        mapped["description"] = json!(description);
    }
    Some(mapped)
}

/// A select's choices, in one flat list, in the engine's order.
fn config_choices(options: &SessionConfigSelectOptions) -> Vec<Value> {
    fn choice(option: &SessionConfigSelectOption) -> Value {
        let mut mapped = json!({
            "value": option.value.to_string(),
            "name": option.name,
        });
        if let Some(description) = &option.description {
            mapped["description"] = json!(description);
        }
        mapped
    }

    match options {
        SessionConfigSelectOptions::Ungrouped(values) => values.iter().map(choice).collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter().map(choice))
            .collect(),
        // `#[non_exhaustive]`, as above: a grouping this host has never seen is not a
        // set of choices it may invent.
        _ => Vec::new(),
    }
}

/// The text of a chunk, when it carries any.
///
/// A chunk is a content block, and only a text block has text: an image or a
/// resource link in the same stream is not a hole in the message, it is a part
/// this host has no kind for, and returning `None` keeps it from being rendered
/// as an empty string.
fn text_of(chunk: &ContentChunk) -> Option<String> {
    match &chunk.content {
        ContentBlock::Text(text) => Some(text.text.clone()),
        _ => None,
    }
}
