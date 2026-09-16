//! A turn's usage: the counters the engine sent, and the ending they arrived with.
//!
//! The one place this host decides what a usage object means. P0 §6.3 measured the field set
//! changing between two identical turns of the same engine — `thoughtTokens` in one,
//! `cachedReadTokens` in the other, and a `totalTokens` that is not the sum of input and output —
//! so what is published is six independent counters, each the engine's own number or absent.
//!
//! That measurement is also why [`PromptEnding`] exists rather than `PromptResponse` being passed
//! along as the SDK typed it: the schema's `usage` field is `Option<Usage>`, and `Usage` requires
//! `totalTokens`, `inputTokens` and `outputTokens` as non-optional `u64`s. It can therefore hold
//! an object the engine sent *whole* and nothing else — while §6.3 measured an engine that sends
//! the counters it has and omits the rest.
//!
//! The ending it arrives with is decided here too, for the same measurement read the other way.
//! `StopReason` is the protocol's list *at this pinned version*, not a fence around it, so a
//! response ending in a word the schema does not enumerate is a frame to read rather than one to
//! refuse — refusing it reports a turn the engine finished as a failure. [`PromptStopReason`] is
//! the shape that keeps such a word, and [`ending`] is where the line between it and a corrupt
//! frame is drawn.

use agent_client_protocol::schema::v1::{PromptResponse, StopReason, Usage};
use agent_client_protocol::JsonRpcResponse;
use serde::Serialize;
use serde_json::{Value, json};

/// The counters a usage object can carry, as this host publishes them.
///
/// The field set is the schema's own (`agent-client-protocol-schema` 1.7.0, `Usage`), including
/// the three counters it marks optional — which are the three §6.3 measured appearing and
/// disappearing. Every field stands alone: nothing here is derived from anything else.
/// `totalTokens` in particular is the engine's own count and never `input + output` (§6.3's
/// second turn reported 8895 for a 1721 + 6 turn), which is why it is read and not computed.
///
/// An absent field is `None` and is left off the wire. It is never a `0` — §5.1's rule is that an
/// unknown cost is not zero — while a `0` the engine *did* send is kept, because a reported zero
/// and a missing count are different facts a surface has to be able to tell apart.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCounters {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_read_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_write_tokens: Option<u64>,
}

impl UsageCounters {
    /// Whether the object this was read from carried no counter this type can hold.
    fn is_empty(&self) -> bool {
        *self == UsageCounters::default()
    }
}

/// The usage to publish for a turn, read from the engine's own `usage` value.
///
/// The schema is tried first, so an object it accepts is read by it: which numbers reach the
/// window stays the schema's decision on the normal case. What comes out is what
/// `PromptResponse.usage` published before this function existed, with one exception worth naming
/// — `_meta`, which the schema allows inside a usage object and which is not a counter: the
/// contract has no field for it (`payloads.ts`, `AgentUsage`) and its reader drops an unknown key
/// on the way in, so carrying it here would be this side publishing a shape no reader takes.
/// The routes cannot disagree on an object both can read: `Usage`'s counters, optional ones
/// included, are `DefaultOnError` there, which drops a malformed counter exactly as the
/// field-by-field read below drops it.
///
/// When the schema refuses the object — one of the three counts it requires is missing or is not
/// a count — the object is read one field at a time instead. It arrived, and the counters it did
/// carry are the engine's numbers; discarding them whole is 「no usage provided」 said about usage
/// that *was* provided, in part, which is §5.1's rule broken in the other direction.
///
/// `None` means nothing readable arrived: no object at all, a `null`, a value that is not an
/// object, or an object with no usable counter. The contract reads an object with no usable count
/// the same way (`readers/session.ts`), and `null` already means "reported nothing this window can
/// show" — which is a different statement from an empty object, and the only one of the two the
/// window is asked to render.
pub fn counters(usage: Option<&Value>) -> Option<UsageCounters> {
    let usage = usage?;
    if let Ok(typed) = serde_json::from_value::<Usage>(usage.clone()) {
        return Some(UsageCounters {
            total_tokens: Some(typed.total_tokens),
            input_tokens: Some(typed.input_tokens),
            output_tokens: Some(typed.output_tokens),
            thought_tokens: typed.thought_tokens,
            cached_read_tokens: typed.cached_read_tokens,
            cached_write_tokens: typed.cached_write_tokens,
        });
    }

    let fields = usage.as_object()?;
    let counters = UsageCounters {
        total_tokens: count(fields.get("totalTokens")),
        input_tokens: count(fields.get("inputTokens")),
        output_tokens: count(fields.get("outputTokens")),
        thought_tokens: count(fields.get("thoughtTokens")),
        cached_read_tokens: count(fields.get("cachedReadTokens")),
        cached_write_tokens: count(fields.get("cachedWriteTokens")),
    };
    (!counters.is_empty()).then_some(counters)
}

/// One counter, if the engine sent one: a non-negative whole number and nothing else.
///
/// A present-but-unusable value is left out rather than refused — the same statement an absent
/// field makes, and it keeps one bad decoration from discarding the counters beside it. The
/// window applies the same rule to the same field (`readers/session.ts`, `readUsage`), so an
/// object read on both sides gets the same answer, with one boundary worth naming: that reader
/// also refuses a count beyond JavaScript's safe-integer range, where this side publishes it. A
/// token count is nowhere near 2^53, and a bound here would be this side's invention rather than
/// the schema's — `Usage` itself takes a `u64`.
fn count(value: Option<&Value>) -> Option<u64> {
    value?.as_u64()
}

/// Why a turn ended, in the two shapes this host has for it.
///
/// The wire's `stopReason` is the protocol's own enum, and the pinned schema's `StopReason`
/// enumerates five variants under `#[serde(rename_all = "snake_case")]` with `#[non_exhaustive]`
/// and no `#[serde(other)]` arm (`agent-client-protocol-schema` 1.7.0, `v1/agent.rs`). A sixth
/// word therefore does not arrive as a value this host can hold politely: it fails the whole
/// typed read of the response, and `runs.rs` publishes that failure as `run-failed` with
/// `invalid-response` on the run it was the ending of — telling the user a turn the engine
/// finished had failed.
///
/// That is the outcome this type exists to remove, and the protocol says as much about itself:
/// `#[non_exhaustive]` is a promise that variants may be added, and P0 §6.3 measured this engine's
/// surface moving between two identical turns — there in the usage field set. So an unfamiliar
/// *word* is a forward-compatibility case: the ending is read, the engine's own word is kept in
/// [`Self::Unrecognised`], and nothing is invented in its place.
///
/// What it is deliberately not is a home for a malformed frame. A `stopReason` that is absent,
/// empty or not a string is a producer which did not answer the question, and [`ending`] refuses
/// it — the line is drawn at the *type* of the value rather than at membership of a list, which
/// is where the window's own reader draws it for the same field (`readers/session.ts`,
/// `readEnding`). Nor is it a repair: no unfamiliar word is mapped onto a variant it resembles,
/// so no surface can report an ending the engine never sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptStopReason {
    /// One of the reasons the pinned schema enumerates.
    Known(StopReason),
    /// The engine's own word for an ending this version has no arm for.
    ///
    /// Kept as the engine spelled it here, and published by `runs::wire_stop_reason` under the one
    /// spelling that crosses the wire — the contract's, `_` → `-`, the same mechanical replacement
    /// the five enumerated names get. The word is what the window's `unrecognisedReason` carries
    /// and what a future arm would be written from, so dropping it would leave "an ending we do
    /// not know" with no answer to "which one".
    Unrecognised(String),
}

/// What a prompt call answered: why the turn ended, and the usage that came with it.
///
/// The ending is the two facts P0 §2.3 measured arriving together. The stop reason is
/// [`PromptStopReason`] rather than the schema's enum, because that enum cannot hold a word the
/// protocol has not enumerated yet — the case [`ending`] exists for; the usage is this host's
/// shape, because the schema cannot carry the partial object §6.3 measured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptEnding {
    pub stop_reason: PromptStopReason,
    pub usage: Option<UsageCounters>,
}

/// The ending a `session/prompt` response carries, or the refusal that frame earned.
///
/// The schema is tried first, so a response it reads is read by it: which reason a normal frame
/// ends with stays the schema's decision. `Err` is the SDK's own error, returned as it arrived so
/// the transport classifies it exactly as its router would have (`acp_transport::prompt`).
///
/// The one tolerance is [`PromptStopReason::Unrecognised`], and it is deliberately narrow: it
/// applies to a frame carrying a *word* — a present, non-empty string the schema does not
/// enumerate — and only when the rest of the frame stands without it ([`unrecognised_reason`]).
/// Everything else the schema refuses is still refused: a missing, empty or non-string reason is
/// corruption rather than a protocol this host has not learned yet, and reading it as an ending
/// would be inventing one. §6.2 forbids both trades — an unfamiliar value must not become an
/// unreadable frame, and an unreadable frame must not become a fact.
pub fn ending(method: &str, raw: &Value) -> Result<PromptEnding, agent_client_protocol::Error> {
    let refusal = match PromptResponse::from_value(method, raw.clone()) {
        Ok(response) => {
            return Ok(PromptEnding {
                stop_reason: PromptStopReason::Known(response.stop_reason),
                usage: counters(raw.get("usage")),
            });
        }
        Err(refusal) => refusal,
    };
    match unrecognised_reason(method, raw) {
        Some(word) => Ok(PromptEnding {
            stop_reason: PromptStopReason::Unrecognised(word),
            usage: counters(raw.get("usage")),
        }),
        None => Err(refusal),
    }
}

/// The engine's own word for an ending, when the *only* thing the schema could not read is that
/// word — `None` for every other frame it refuses, which is what keeps the tolerance above a
/// statement about the reason rather than about the frame.
///
/// Two conditions, and the second is the one that is easy to leave out:
///
/// 1. `stopReason` is a present, non-empty string. That is the window's own boundary on the same
///    field in the same terms (`readers/session.ts`, `readEnding`): drawn on the type of the value
///    rather than on membership of a list, so a `null`, a number, an array or an object is a
///    producer that did not answer, and an empty string answers nothing.
/// 2. The frame reads once the reason stands aside. `PromptResponse` has exactly one field the
///    schema will not default — `stopReason` itself; `usage` and `_meta` both carry
///    `DefaultOnError` — so today nothing else in this response can fail the read, and this probe
///    cannot fail with it. It is here so that the tolerance stays a statement about the *reason*
///    if a later schema version grows a field it requires: a frame also missing that field is
///    corrupt and has to be refused, and the probe makes that true by construction instead of by
///    inspection of today's field list.
fn unrecognised_reason(method: &str, raw: &Value) -> Option<String> {
    let word = raw.get("stopReason")?.as_str()?;
    if word.is_empty() {
        return None;
    }
    let mut probe = raw.as_object()?.clone();
    // One reason the schema enumerates, so the only thing standing aside is the word the frame
    // actually sent. Nothing is published from this value.
    probe.insert("stopReason".to_string(), json!("end_turn"));
    PromptResponse::from_value(method, Value::Object(probe)).ok()?;
    Some(word.to_string())
}

#[cfg(test)]
mod tests {
    //! The ending's two boundaries, on frames rather than on structs: what has to survive is the
    //! *wire's* shape, and a struct literal would agree with this crate's reading of it by
    //! construction — the reason `tests/agent_event_contract_test.rs` deserializes its frames too.

    use super::super::events::{AgentFailureCode, classify};
    use super::*;

    /// One `session/prompt` response, through the reader the transport calls.
    fn ending_of(frame: Value) -> Result<PromptEnding, agent_client_protocol::Error> {
        ending("session/prompt", &frame)
    }

    #[test]
    fn the_five_reasons_the_schema_enumerates_are_read_by_the_schema() {
        // The normal case is unchanged and stays the schema's: this is the list the pinned
        // dependency owns, and a host that read these itself would be a second copy of it.
        for (spelling, reason) in [
            ("end_turn", StopReason::EndTurn),
            ("max_tokens", StopReason::MaxTokens),
            ("max_turn_requests", StopReason::MaxTurnRequests),
            ("refusal", StopReason::Refusal),
            ("cancelled", StopReason::Cancelled),
        ] {
            let ending = ending_of(json!({ "stopReason": spelling })).unwrap_or_else(|error| {
                panic!("the schema reads its own reason {spelling}: {error}")
            });
            assert_eq!(ending.stop_reason, PromptStopReason::Known(reason), "{spelling}");
        }
    }

    #[test]
    fn a_word_the_schema_does_not_enumerate_is_read_rather_than_refused() {
        // The defect this exists for. This frame is a *completed turn's* ending, so a refusal here
        // is published by `runs.rs` as `run-failed`/`invalid-response` on the run the engine just
        // finished — the user is told their finished turn failed. The word is kept and the
        // counters it arrived with are not lost with it.
        let ending = ending_of(json!({
            "stopReason": "budget_exceeded",
            "usage": { "inputTokens": 1721, "outputTokens": 6 }
        }))
        .expect("an unfamiliar word is a frame to read, not one to refuse");

        assert_eq!(
            ending.stop_reason,
            PromptStopReason::Unrecognised("budget_exceeded".to_string())
        );
        assert_eq!(
            ending.usage,
            Some(UsageCounters {
                input_tokens: Some(1721),
                output_tokens: Some(6),
                ..UsageCounters::default()
            })
        );
    }

    #[test]
    fn the_schema_alone_refuses_the_frame_the_tolerance_reads() {
        // Why the tolerance is not decoration, measured rather than argued: the typed read below
        // *is* the path this replaces, and it fails the whole response over one word. That is the
        // defect — the response is the ending of a turn the engine completed, so the failure
        // reaches the user as a failed turn (`runs.rs`'s `Err` arm), with the counters that came
        // with it thrown away. Both halves of the claim in one test: the schema refuses, and the
        // door the transport uses does not.
        let frame = json!({ "stopReason": "budget_exceeded", "usage": null });

        let refusal = PromptResponse::from_value("session/prompt", frame.clone())
            .expect_err("the pinned schema enumerates five reasons and this is not one of them");
        assert!(
            refusal.to_string().contains("unknown variant"),
            "the refusal is the enum's, not the frame's shape: {refusal}"
        );

        assert_eq!(
            ending_of(frame).expect("the same frame is an ending here").stop_reason,
            PromptStopReason::Unrecognised("budget_exceeded".to_string())
        );
    }

    #[test]
    fn an_unfamiliar_word_is_never_repaired_into_a_reason_the_schema_knows() {
        // The protocol spells its reasons `snake_case` and the contract `kebab-case`, so a word in
        // the contract's own spelling is one the schema cannot parse. It is read as what it is —
        // the engine's word — and not translated into the variant it resembles: this host
        // answering `EndTurn` here would be reporting an ending the engine never sent, which is
        // the class of lie the tolerance exists to replace rather than to commit.
        let ending =
            ending_of(json!({ "stopReason": "end-turn" })).expect("a word is a word, either spelling");

        assert_eq!(
            ending.stop_reason,
            PromptStopReason::Unrecognised("end-turn".to_string())
        );
    }

    #[test]
    fn a_frame_that_states_no_usable_reason_is_still_a_protocol_fault() {
        // The other side of the line, and the reason it is drawn at the *type* of the value: a
        // reason that is missing, empty or not a string is a producer which did not answer the
        // question, so reading it as an ending would invent one. Each of these keeps exactly the
        // outcome the tolerance above removes for the other case — `invalid-response`, the class
        // the transport already produced for a response it could not read — and here that is the
        // correct one.
        for frame in [
            json!({}),
            json!({ "stopReason": null }),
            json!({ "stopReason": "" }),
            json!({ "stopReason": 7 }),
            json!({ "stopReason": ["end_turn"] }),
            json!({ "stopReason": { "reason": "end_turn" } }),
            json!([{ "stopReason": "end_turn" }]),
            json!(null),
        ] {
            let refusal = ending_of(frame.clone())
                .err()
                .unwrap_or_else(|| panic!("this frame states no usable reason: {frame}"));
            assert_eq!(
                classify(refusal).failure_code(),
                AgentFailureCode::InvalidResponse,
                "{frame} must reach the window as a protocol fault, not as an ending"
            );
        }
    }

    #[test]
    fn no_usage_shape_can_drop_the_response_it_came_with() {
        // §6.3's other half — the field set that moves between identical turns — checked at the
        // door rather than assumed. `usage` is the one field of `PromptResponse` the schema
        // defaults on error (`DefaultOnError`, with `#[serde(default)]`), and this host reads the
        // engine's own object through `counters` rather than the typed field, so no usage shape
        // can fail the response read. The worst an unreadable one does is arrive as `None`, which
        // is the statement "it reported nothing this window can show" and not a refusal.
        for usage in [
            json!("lots"),
            json!([1, 2]),
            json!(7),
            json!(null),
            json!({ "inputTokens": "1721", "totalTokens": -1 }),
        ] {
            let ending = ending_of(json!({ "stopReason": "end_turn", "usage": usage }))
                .unwrap_or_else(|error| panic!("usage {usage} dropped the response: {error}"));
            assert_eq!(ending.usage, None, "{usage} carries no counter this window can show");
        }

        // Nor is the reason's tolerance conditional on the usage shape, in either direction: the
        // frame is read, and it says nothing about usage.
        let ending = ending_of(json!({ "stopReason": "budget_exceeded", "usage": "lots" }))
            .expect("a bad container is not a bad reason");
        assert_eq!(
            ending.stop_reason,
            PromptStopReason::Unrecognised("budget_exceeded".to_string())
        );
        assert_eq!(ending.usage, None);
    }
}
