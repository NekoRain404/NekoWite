//! The wire's shape into the host's vocabulary — the mapping, with no process in the way.
//!
//! Split out of `agent_runtime_test.rs`, which had grown past its line budget with two
//! responsibilities in it: the runtime end to end (a fixture process, a session, a run, a
//! cancellation race — everything that needs the harness) and these. What lives here is the
//! half that needs neither: `normalize_update` is a pure function from one `session/update` to
//! the host's kind and payload, so every case below is a frame in and an assertion out.
//!
//! The frames are deserialized from JSON rather than built from Rust structs on purpose — the
//! shape that has to survive is the *wire's* (`agent-client-protocol-schema` 1.7.0, v1), and a
//! struct literal would agree with this crate's reading of that shape by construction. What the
//! window does with the result is `tauri-agent.test.ts`, which reads the same JSON.

use nekowite_lib::agent_runtime;

use agent_client_protocol::schema::v1::SessionUpdate;
use serde_json::{Value, json};

use agent_runtime::events::normalize_update;
use agent_runtime::usage::counters;
use agent_runtime::AgentEventKind;

// ---------------------------------------------------------------------------
// The engine's own options
// ---------------------------------------------------------------------------

/// One `session/update` as the pinned schema sends it.
///
/// Deserialized from JSON rather than built from Rust structs on purpose: what the mapping
/// below has to survive is the *wire's* shape (`agent-client-protocol-schema` 1.7.0, v1), and
/// a struct literal would agree with this crate's reading of that shape by construction.
fn wire_update(frame: serde_json::Value) -> SessionUpdate {
    serde_json::from_value(frame).expect("the pinned schema reads its own frame")
}

/// The engine's option list, as the contract's reader takes it (`readers/session.ts`,
/// `readConfigChanged`): the discriminator on the *value* (`kind`), the current value under
/// `current`, and a select's choices a flat list.
#[test]
fn a_config_option_update_is_mapped_into_the_contracts_payload() {
    let update = wire_update(json!({
        "sessionUpdate": "config_option_update",
        "configOptions": [
            {
                "id": "model",
                "name": "Model",
                "description": "Which model answers",
                "type": "select",
                "currentValue": "fake/model-b",
                "options": [
                    { "value": "fake/model-a", "name": "Model A" },
                    { "value": "fake/model-b", "name": "Model B", "description": "the fast one" }
                ]
            },
            {
                "id": "fast",
                "name": "Fast mode",
                "type": "boolean",
                "currentValue": true
            }
        ]
    }));

    let (kind, payload) = normalize_update(&update).expect("an option list must be forwarded");

    assert_eq!(kind, AgentEventKind::ConfigChanged);
    assert_eq!(
        payload,
        json!({
            "options": [
                {
                    "id": "model",
                    "name": "Model",
                    "description": "Which model answers",
                    "value": {
                        "kind": "select",
                        "current": "fake/model-b",
                        "choices": [
                            { "value": "fake/model-a", "name": "Model A" },
                            { "value": "fake/model-b", "name": "Model B", "description": "the fast one" }
                        ]
                    }
                },
                {
                    "id": "fast",
                    "name": "Fast mode",
                    "value": { "kind": "toggle", "current": true }
                }
            ]
        }),
        "the window's reader accepts this shape and no other"
    );
}

#[test]
fn grouped_config_choices_are_flattened_in_the_engines_order() {
    // The wire's choices are an untagged union — a flat list, or a list of groups of them —
    // and the contract's `AgentConfigChoice` is one flat list. Flattening keeps the values and
    // their order; the group's *name* has nowhere to go, which is the residual T4b §7 reported
    // rather than something this mapping can decide.
    let update = wire_update(json!({
        "sessionUpdate": "config_option_update",
        "configOptions": [{
            "id": "model",
            "name": "Model",
            "type": "select",
            "currentValue": "a",
            "options": [
                { "group": "anthropic", "name": "Anthropic", "options": [
                    { "value": "a", "name": "A" },
                    { "value": "b", "name": "B" }
                ]},
                { "group": "local", "name": "Runs here", "options": [
                    { "value": "c", "name": "C" }
                ]}
            ]
        }]
    }));

    let (kind, payload) = normalize_update(&update).expect("an option list must be forwarded");

    assert_eq!(kind, AgentEventKind::ConfigChanged);
    let choices = payload["options"][0]["value"]["choices"]
        .as_array()
        .expect("a select's choices are a list");
    let values: Vec<&str> = choices
        .iter()
        .filter_map(|choice| choice["value"].as_str())
        .collect();
    assert_eq!(values, vec!["a", "b", "c"], "in the engine's own order");
    assert!(
        choices.iter().all(|choice| choice.get("group").is_none()),
        "the group's name has nowhere to go in the contract's choice: {choices:?}"
    );
}

#[test]
fn an_option_list_with_no_options_is_still_a_list() {
    // An engine may withdraw every option it offered, and the contract replaces the previous
    // set wholesale: an empty list is a fact (`readConfigChanged` accepts it), while a missing
    // one is a payload the window cannot read.
    let update = wire_update(json!({
        "sessionUpdate": "config_option_update",
        "configOptions": []
    }));

    let (_, payload) = normalize_update(&update).expect("an empty list is still forwarded");

    assert_eq!(payload, json!({ "options": [] }));
}

#[test]
fn every_kind_is_spelled_the_way_the_contract_spells_it() {
    // The envelope's `kind` is a *string* on the wire: serde renders it from the variant name
    // (`#[serde(rename_all = "kebab-case")]`) while the contract's union is written out by hand
    // in `agent-contracts/payloads.ts`, so the two can drift apart with both suites green — which
    // is the failure this task's own predecessor found for `stopReason` (`runs.rs`,
    // `wire_stop_reason`), one field over. This is the whole enum in one place, against the
    // contract's own spellings; a kind added without its string fails here.
    for (kind, spelling) in [
        (AgentEventKind::TextDelta, "text-delta"),
        (AgentEventKind::ThoughtDelta, "thought-delta"),
        (AgentEventKind::ToolUpdate, "tool-update"),
        (AgentEventKind::PermissionRequest, "permission-request"),
        (AgentEventKind::CommandsChanged, "commands-changed"),
        (AgentEventKind::ConfigChanged, "config-changed"),
        (AgentEventKind::FilesChanged, "files-changed"),
        (AgentEventKind::RunFinished, "run-finished"),
        (AgentEventKind::RunFailed, "run-failed"),
    ] {
        assert_eq!(
            serde_json::to_value(kind).expect("a kind is a name"),
            json!(spelling),
            "{kind:?} must cross the wire under the contract's own name"
        );
    }
}

#[test]
fn a_thought_chunk_is_mapped_into_the_contracts_payload() {
    // `readText` (`agent-contracts/readers/stream.ts`) reads `{ text }` and nothing else, and the
    // reducer writes a `thought` row from it — so this is the exact payload the window needs, and
    // the one shape that keeps reasoning off the answer's side of the timeline.
    let update = wire_update(json!({
        "sessionUpdate": "agent_thought_chunk",
        "content": { "type": "text", "text": "weighing the options" }
    }));

    let (kind, payload) = normalize_update(&update).expect("a thought chunk must be forwarded");

    assert_eq!(kind, AgentEventKind::ThoughtDelta);
    assert_eq!(payload, json!({ "text": "weighing the options" }));
}

#[test]
fn a_chunk_with_no_text_is_not_an_empty_thought() {
    // A chunk is a content block and only a text block has text: an image in the thought stream
    // is a part this host has no kind for, and an empty string would draw as a thought the engine
    // never had.
    let update = wire_update(json!({
        "sessionUpdate": "agent_thought_chunk",
        "content": { "type": "image", "data": "aGk=", "mimeType": "image/png" }
    }));

    assert!(normalize_update(&update).is_none());
}

// ---------------------------------------------------------------------------
// A turn's usage
// ---------------------------------------------------------------------------

/// The counters as the window receives them: exactly what `runs.rs` serializes into a
/// `run-finished` payload's `"usage"` field, with the fields the engine did not send left off.
fn published(usage: Value) -> Value {
    serde_json::to_value(counters(Some(&usage))).expect("counters are an object or null")
}

#[test]
fn a_usage_object_the_schema_refuses_keeps_the_counters_it_sent() {
    // The pinned schema's `Usage` requires `totalTokens`, `inputTokens` and `outputTokens` as
    // non-optional `u64`s, so an object missing one is refused whole and its counters go with it
    // — which is the shape P0 §6.3 measured the engine sending. Both routes are asserted here,
    // because what the window has to be able to tell apart is a partial object it *can* render
    // (the counters that arrived) from a turn that reported nothing.
    //
    // P0 §6.3's probe 3, every core count present: the schema reads it, and its own numbers and
    // absences are published unchanged.
    assert_eq!(
        published(json!({
            "inputTokens": 8717, "outputTokens": 3, "totalTokens": 8732, "thoughtTokens": 12
        })),
        json!({
            "inputTokens": 8717, "outputTokens": 3, "totalTokens": 8732, "thoughtTokens": 12
        }),
        "the window's reader takes these camelCase counters and no other spelling"
    );

    // Probe 4's shape with `totalTokens` removed — the object the schema refuses. The counters
    // that arrived are kept, `cachedReadTokens` included; the absent total stays absent, and in
    // particular is not filled in with the sum of the other two (1721 + 6 is 1727, and the
    // engine's own total, 8895, is not in this frame to publish).
    assert_eq!(
        published(json!({
            "inputTokens": 1721, "outputTokens": 6, "cachedReadTokens": 7168
        })),
        json!({
            "inputTokens": 1721, "outputTokens": 6, "cachedReadTokens": 7168
        }),
        "a refused object's counters are the engine's numbers, and its total is no sum"
    );
}

#[test]
fn a_counter_the_engine_did_not_send_is_absent_rather_than_zero() {
    // §5.1's rule, on both of the routes above: an unknown count is not a zero. A field the
    // engine did not send must be missing from the published object (so the window renders "not
    // provided"), while a `0` it *did* send survives as the number it is — the two are different
    // facts about a turn and a default would collapse them into one.
    for frame in [
        json!({ "inputTokens": 1, "outputTokens": 2, "totalTokens": 3 }),
        json!({ "inputTokens": 1, "outputTokens": 2 }),
    ] {
        let usage = published(frame.clone());
        for absent in ["thoughtTokens", "cachedReadTokens", "cachedWriteTokens"] {
            assert!(
                usage.get(absent).is_none(),
                "{absent} came back as {} for a frame that never sent it: {frame}",
                usage[absent]
            );
        }
    }

    assert_eq!(
        published(json!({ "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 })),
        json!({ "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 }),
        "a reported zero is a count, not an absence"
    );
}

#[test]
fn a_usage_with_nothing_readable_is_no_usage_rather_than_an_empty_object() {
    // `null` and `{}` are not the same statement, and the contract only accepts the first: an
    // object with no usable count means "reported no usage this window can show"
    // (`readers/session.ts`), so publishing the empty object would be a shape no reader of the
    // payload is prepared to read. A field that arrived unusable is left out for the same reason
    // a missing one is — and this is the rule that keeps the whole object from being refused over
    // one bad decoration.
    assert_eq!(counters(None), None, "no usage key in the response at all");
    assert_eq!(counters(Some(&Value::Null)), None, "usage: null");
    assert_eq!(counters(Some(&json!({}))), None, "an empty object");
    assert_eq!(counters(Some(&json!([1, 2]))), None, "not an object");
    assert_eq!(
        counters(Some(&json!({ "inputTokens": "1721", "totalTokens": -1 }))),
        None,
        "a string and a negative are not counts"
    );
    assert_eq!(
        published(json!({ "inputTokens": "1721", "cachedWriteTokens": 0 })),
        json!({ "cachedWriteTokens": 0 }),
        "one usable counter beside an unusable one is kept"
    );
    // And the wire spelling of that `None` is the contract's `null`: this is the serialization
    // `runs.rs` performs on the read (`json!({ "usage": response.usage })`), pinned here because
    // the whole point of the recovery is that `null` keeps meaning "nothing arrived" — an empty
    // object would be the same statement in a shape the window's reader does not accept.
    assert_eq!(
        serde_json::to_value(counters(None)).expect("counters serialize"),
        Value::Null,
        "no usage is null, never an object with no counters in it"
    );
}

