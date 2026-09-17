//! The AI completion path against a real gateway: the app's own request, its own transport, its own
//! parser, and the usage the provider actually reports.
//!
//! Every other `ai_*` test in this repository drives these functions against a loopback server the
//! tests write themselves — bytes we chose, in frames we assembled, in chunk sizes we picked. That
//! is worth having and it is not evidence about a provider: a real gateway's frame shapes, its
//! chunking, its usage field set and the TLS chain it presents are exactly what a self-written
//! fixture cannot contain. The agent half of this app has a live run (`agent_live_test.rs`, and
//! `scripts/verify-acp-live.sh`, which refuses to skip); the AI half had none, which is what this
//! file is.
//!
//! Cost: **one prompt**, in [`one_paid_turn_streams_through_the_apps_own_path`]. The listing test
//! above it spends nothing. Do not put this on a loop.
//!
//! ## What is driven, and the layer this stops at
//!
//! `ai_complete` takes a `&tauri::AppHandle`, which is `AppHandle<Wry>`, and an integration test
//! cannot produce one: the only app it can build is `tauri::test`'s, whose runtime is `MockRuntime`
//! (`ai_config_test.rs` says the same thing about why the credential rule needed its store
//! injected). So this file drives the functions `stream_complete` itself calls, in its order, with
//! its types:
//!
//! ```text
//! validate_base_url      the policy call `ai_complete` makes before anything is dialled
//!   -> resolve_endpoint      the (url, body) the provider is asked for
//!   -> encode_request_body   the bytes exactly as they go on the wire
//!   -> the transport         redirect refusal, per-phase timeouts, the resolved-address pin
//!   -> with_completion_auth  the credential header for this provider
//!   -> CompletionStream      feed / finish / answer / usage — the app's own SSE path
//!   -> completion_refusal    the verdict that decides `ai-done` from `ai-error`
//! ```
//!
//! **`stream_complete` itself is callable from a test now**, and this file should move onto it:
//! it is generic over the runtime (the reason is on `events::emit_ai_error`), so a `MockRuntime`
//! app reaches its whole body, emits included —
//! `ai_unreadable_response_test.rs` drives it against a loopback server on every run. What is left
//! here is the paid turn, which is not re-pointed at it in the same change as that fix because
//! nothing in that change could be verified against the gateway without spending a prompt. Until
//! someone does, the one claim this file cannot make is that the body between the headers and the
//! verdict behaves the same against a real provider as the per-line drive below does.
//!
//! The transport is the one seam that is REBUILT rather than called ([`app_transport`]): the app's
//! own constructor, `transport::ai_http_client`, is `pub(super)` inside `providers::ai`, so an
//! integration test has no path to it, and widening its visibility is a production edit this change
//! is not entitled to make. What that costs is one narrow claim the live run cannot make — that
//! `ai_http_client` passes those same three settings to the builder. What it does NOT cost is the
//! TLS question: [`the_gateway_lists_the_model_the_paid_turn_asks_for`] goes through
//! `client::list_models`, i.e. through the shipped client, its shipped auth headers, its shipped
//! pin and the trust anchors this crate's `reqwest` was built with, against this exact host.
//!
//! Not reproduced: the emissions. Every decision the loop makes — stop on `Done`, flush the tail at
//! EOF, what the answer is, what the usage was, whether the completion has to be reported as a
//! failure — is the app's own code here, but the loop that moves socket chunks into
//! `CompletionStream` and its `StreamEvent`s into Tauri emits (`events::deliver_events`) is the
//! app's own code only in the test above's file, where the responses are one this repository
//! writes rather than one a gateway sent.
//!
//! ## The credential
//!
//! `NWK_TEST_KEY`, and nothing else: never `argv` (`/proc/<pid>/cmdline` is world readable), never a
//! file, never a log line. `scripts/verify-ai-live.sh` exports it from `/tmp/nkw-test-key`; this
//! file never reads that path, so a machine with no runner has no key by accident. A failure here
//! reports the status code and the provider's own message and never a request header — headers are
//! where the key would be.

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;

use nekowite_lib::providers::ai::client::{
    completion_refusal, encode_request_body, error_detail_from_body,
    http_error_message_with_detail, list_models, resolve_endpoint, validate_base_url, AIConfig,
    CompletionStream, SseBuffer, StreamEvent, VettedHost,
};
use nekowite_lib::providers::ai::limits::{COMPLETION_CONNECT_TIMEOUT, COMPLETION_READ_TIMEOUT};
use nekowite_lib::providers::ai::request::with_completion_auth;

/// The gateway every id and every request in this file is about.
const GATEWAY: &str = "https://ai.iapp.dpdns.org/v1";

/// The model the paid turn asks for. By value, like the agent live tests, and the listing test
/// asserts it is really offered before the turn that costs money asks for it.
const TEST_MODEL: &str = "deepseek-v4.1-flash";

/// P0 §2.3's prompt, the one the agent live run also uses. Anything longer buys nothing: what is
/// being measured is that the path works end to end, not what the model says.
const TEST_PROMPT: &str = "Reply with exactly: PONG";

/// How long the gateway may take. The app's own read ceiling is
/// [`COMPLETION_READ_TIMEOUT`](nekowite_lib::providers::ai::limits::COMPLETION_READ_TIMEOUT) per
/// read; this is the bound on the whole turn, and it is the sibling file's, so a run that needs
/// longer than this is a run nobody would have waited for either.
const RUN_PATIENCE: Duration = Duration::from_secs(150);

/// The credential for this run, or the reason there will not be one.
///
/// A skip rather than a failure, for the reason `agent_live_test.rs` gives: the key lives outside
/// the repository by design, so a checkout that does not own it is legitimately unable to run this.
/// `scripts/verify-ai-live.sh` is the caller that refuses to skip — it checks the key file before it
/// starts cargo — and a `SKIP:` line in this target is a failed run there.
fn live_run_key() -> Option<String> {
    match std::env::var("NWK_TEST_KEY") {
        Ok(key) if !key.trim().is_empty() => Some(key),
        _ => {
            eprintln!(
                "SKIP: NWK_TEST_KEY is not set; scripts/verify-ai-live.sh is what exports it from \
                 /tmp/nkw-test-key"
            );
            None
        }
    }
}

/// The configuration a completion in this app carries: a host the user named, its credential, and
/// the model and caps the ghost writer would send.
///
/// `"custom"` is deliberate. It is the id the settings page offers for exactly this situation — an
/// OpenAI-compatible gateway this crate has never heard of — so the request is built by the arm a
/// user of such a gateway reaches: `resolve_base_url` finds no default host for it and uses the
/// configured address, and the credential rides in `Authorization: Bearer`
/// ([`with_completion_auth`]). `max_tokens` is left unset so the body carries the app's own default
/// rather than a number this test invented.
fn live_config(key: String) -> AIConfig {
    AIConfig {
        provider: "custom".into(),
        model: TEST_MODEL.into(),
        base_url: Some(GATEWAY.into()),
        api_key: Some(key),
        ..Default::default()
    }
}

/// The transport the app dials through, rebuilt from the app's own settings.
///
/// Line for line this is `transport::ai_http_client`: the redirect refusal, the two per-phase
/// timeouts from `limits`, and the pin `validate_base_url` returned. It is rebuilt because that
/// function is `pub(super)` inside `providers::ai` — see this file's header for what the rebuild
/// costs and what it does not. The one thing NOT softened here is the address: the client dials the
/// addresses the app's own policy vetted, not whatever the name resolves to a second time.
fn app_transport(pin: Option<&VettedHost>) -> Result<reqwest::Client, reqwest::Error> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(COMPLETION_CONNECT_TIMEOUT)
        .read_timeout(COMPLETION_READ_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(pin) = pin {
        if !pin.addrs.is_empty() {
            builder = builder.resolve_to_addrs(&pin.host, &pin.addrs);
        }
    }
    builder.build()
}

/// The `usage` object one SSE line carries, when it carries one at all.
///
/// This is the EVIDENCE reader, not a second parser for the assertions: `CompletionStream` keeps the
/// three counts `TokenUsage` models and deliberately drops everything else, and this file has to
/// print what the provider actually sent. It reads `data:` lines only, so the blank lines and
/// comments of the SSE framing cannot be mistaken for frames.
fn usage_of(line: &str) -> Option<Value> {
    let raw = line.trim().strip_prefix("data:")?.trim();
    if raw == "[DONE]" {
        return None;
    }
    let frame: Value = serde_json::from_str(raw).ok()?;
    frame
        .get("usage")
        .filter(|usage| usage.is_object())
        .cloned()
}

/// What the app makes of the real `/models` answer.
///
/// The assertion is on the IDS, never on `Ok`. `ai_model_fetch_test.rs`'s header records what this
/// kind of endpoint does with a path it does not recognise — an SPA fallback answered as HTTP 200 —
/// which is exactly why "it returned successfully" is not a measurement, and why the model the paid
/// turn below asks for is checked against the listing first: a turn against a model the gateway does
/// not offer would be paid for and answered with an error.
///
/// This is also the test that answers the TLS question for this crate's own transport: it is
/// `client::list_models`, so the shipped client (its redirect refusal, its per-phase timeouts, its
/// resolved-address pin) and the trust anchors this crate's `reqwest` was compiled with are what
/// either accept `ai.iapp.dpdns.org` or do not. Nothing here can disable verification, and nothing
/// here would: a chain the app cannot trust is a finding about the app.
#[tokio::test]
async fn the_gateway_lists_the_model_the_paid_turn_asks_for() {
    let Some(key) = live_run_key() else {
        return;
    };
    let config = live_config(key);

    let ids = list_models(&config)
        .await
        .unwrap_or_else(|error| panic!("GET {GATEWAY}/models failed: {error}"));

    assert!(
        !ids.is_empty(),
        "the gateway's /models answered with no ids at all"
    );
    assert!(
        ids.iter().any(|id| id == TEST_MODEL),
        "the gateway does not list {TEST_MODEL}, which the paid turn below asks for; it lists {ids:?}"
    );
    eprintln!(
        "--- model ids from the gateway ({}): {}",
        ids.len(),
        ids.join(", ")
    );
    eprintln!("--- {TEST_MODEL} is among them, so the turn below asks for a model that exists");
}

/// One paid turn: the app's request, the app's transport settings, the app's parser, the app's
/// verdict — and the usage the provider reports, printed as it sent it.
///
/// Items 2 and 3 of what this file exists for are both here, and one prompt pays for both: the
/// answer proves the streaming path, and the same response carries the accounting.
#[tokio::test]
async fn one_paid_turn_streams_through_the_apps_own_path() {
    let Some(key) = live_run_key() else {
        return;
    };
    let config = live_config(key);

    // ---- 1. the address policy, before anything is dialled -------------------------------------
    // `ai_complete` makes this call first and hands what it returns to the client, so the request
    // can only reach an address this check approved.
    let pin = validate_base_url(&config).expect("a public HTTPS Base URL is accepted");
    match &pin {
        Some(vetted) => eprintln!(
            "--- address policy: {} pinned to {} vetted address(es)",
            vetted.host,
            vetted.addrs.len()
        ),
        None => eprintln!("--- address policy: nothing to pin (a literal address or the opt-in)"),
    }

    // ---- 2. the request the app would build ----------------------------------------------------
    let (url, body) = resolve_endpoint(&config, TEST_PROMPT, &[]).expect("the config names a host");
    assert_eq!(url, format!("{GATEWAY}/chat/completions"), "the endpoint");
    assert_eq!(body["model"], TEST_MODEL, "the model this run pays for");
    assert_eq!(
        body["stream"], true,
        "the app streams; a non-streaming body would never reach the parser under test"
    );
    assert_eq!(
        body["stream_options"]["include_usage"], true,
        "the app asks the provider for usage, which is what item 3 below is about"
    );
    assert_eq!(
        body["max_tokens"], 1024,
        "the app's own default output cap, with max_tokens left unset in the config"
    );
    // The credential is NOT in the body — it is a header `with_completion_auth` adds — which is why
    // printing the body is safe here, and why nothing prints a header.
    eprintln!("--- request: POST {url}");
    eprintln!("--- request body (no credential in it): {body}");
    let payload = encode_request_body(&body).expect("a one-line prompt is far under the ceiling");
    eprintln!("--- encoded body: {} bytes", payload.len());

    // ---- 3. the transport and the credential header --------------------------------------------
    let client = app_transport(pin.as_ref()).expect("the AI client builds");
    let request = with_completion_auth(
        client
            .post(&url)
            .header("content-type", "application/json")
            .body(payload),
        &config,
    );

    // ---- 4. one paid turn ----------------------------------------------------------------------
    let response = request
        .send()
        .await
        .unwrap_or_else(|error| panic!("the request to the gateway did not complete: {error}"));
    let status = response.status();
    if !status.is_success() {
        // The provider's own words, and never the request headers: a failure report that carried
        // them would put the credential in a terminal, in a CI log and in this run's transcript.
        let text = response.text().await.unwrap_or_default();
        let detail = error_detail_from_body(&text);
        panic!(
            "the gateway answered {}: {}",
            status.as_u16(),
            http_error_message_with_detail(status.as_u16(), detail.as_deref())
        );
    }
    eprintln!(
        "--- HTTP {} content-type {:?}",
        status.as_u16(),
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("(none)")
    );

    // ---- 5. the app's own SSE path, over the real socket ----------------------------------------
    let mut socket = response.bytes_stream();
    let mut completion = CompletionStream::new(&config.provider);
    // A second reader over the same bytes, for EVIDENCE only: it is the app's own reassembly
    // (`SseBuffer`), so even the printed usage frames are read by shipped code rather than by a
    // splitter written here.
    let mut frames = SseBuffer::new();
    let mut usage_frames: Vec<Value> = Vec::new();
    let mut terminal: Option<&str> = None;
    let mut chunks = 0usize;
    let mut reasoning_events = 0usize;
    let deadline = tokio::time::Instant::now() + RUN_PATIENCE;

    loop {
        let next = tokio::time::timeout_at(deadline, socket.next())
            .await
            .unwrap_or_else(|_| panic!("the gateway sent nothing for {RUN_PATIENCE:?}"));
        let Some(chunk) = next else {
            break; // EOF: the response ended without `data: [DONE]`
        };
        let chunk = chunk.expect("the response body stays readable");
        chunks += 1;

        // The raw frames first — the same bytes, in the same order, read for the record.
        for line in frames.feed(&chunk).expect("no frame is near the ceiling") {
            if let Some(usage) = usage_of(&line) {
                usage_frames.push(usage);
            }
        }

        let events = completion
            .feed(&chunk)
            .expect("a one-word answer is far under the answer ceiling");
        for event in &events {
            match event {
                StreamEvent::Reasoning(_) => reasoning_events += 1,
                // `stream_complete` emits this as `ai-error` and returns `Err`; with no window to
                // emit into, the failure has to be this test's.
                StreamEvent::ProviderError(message) => {
                    panic!("the provider reported an error inside an HTTP {status}: {message}")
                }
                _ => {}
            }
        }
        if events
            .iter()
            .any(|event| matches!(event, StreamEvent::Done))
        {
            terminal = Some("data: [DONE]");
            break;
        }
    }
    if terminal.is_none() {
        // What `stream_complete` does when the SOCKET ended the response rather than the provider:
        // flush the tail, so a server that stopped mid-line loses no text.
        for line in frames.flush() {
            if let Some(usage) = usage_of(&line) {
                usage_frames.push(usage);
            }
        }
        let _ = completion.finish().expect("no frame is near the ceiling");
        eprintln!("--- the response ended at EOF without `data: [DONE]`");
    }

    // ---- 6. it ended, and it ended the way a finished stream ends -------------------------------
    // This is the one assertion here that is STRICTER than the app: an OpenAI-compatible provider is
    // expected to end a stream with `data: [DONE]`, and that is the terminal event item 2 asks for,
    // but `stream_complete` treats EOF as an ending too. So a Base URL that answers a 200 with
    // something that is not an event stream at all — the SPA fallback `ai_model_fetch_test.rs`'s
    // header is about, one wrong address away — is a red run here and, in the app, an `ai-error`
    // naming the address, the declared type and the opening of the body (`stream_complete`'s
    // no-events verdict, pinned by `ai_unreadable_response_test.rs`). That used to be the app's
    // third answer — an `ai-done` carrying `full: ""`, because `completion_refusal` returns `None`
    // for an empty answer with no `finish_reason` and no reasoning — and that verdict is still what
    // an empty turn the provider DELIVERED gets, which `ai_completion_result_test.rs` pins as
    // deliberate ("a no-op, not an error"). Do not weaken this assertion to match either one: the
    // two now report the same thing in different words, and this file is the sentence's only
    // witness.
    assert!(
        terminal.is_some(),
        "the stream produced no terminal event: {chunks} chunk(s) and no `data: [DONE]`"
    );
    eprintln!("--- terminal event: {terminal:?} after {chunks} chunk(s)");

    // ---- 7. text arrived ------------------------------------------------------------------------
    let answer = completion.answer();
    eprintln!(
        "--- assistant text ({} chunk(s), {reasoning_events} reasoning event(s), {} bytes): \
         {answer:?}",
        chunks,
        answer.len()
    );
    assert!(
        !answer.trim().is_empty(),
        "the app's own SSE path produced no assistant text; {chunks} chunk(s) arrived and the \
         terminal event was {terminal:?}"
    );

    // ---- 8. the verdict the app would act on ----------------------------------------------------
    // `stream_complete` reports a refusal as `ai-error` instead of `ai-done`, so a stream that
    // produced text and still ends as a refusal is not a green run.
    if let Some(refusal) = completion_refusal(&completion) {
        panic!("the app would report this completion as a failure: {refusal}");
    }
    eprintln!(
        "--- finish_reason: {:?}, reasoning seen: {}",
        completion.finish_reason(),
        completion.saw_reasoning()
    );

    // ---- 9. the usage the provider reported, verbatim -------------------------------------------
    // P0 §6.3 measured that this gateway's usage field set is NOT fixed: on the agent path
    // `thoughtTokens` appeared in one turn and not in another, `cachedReadTokens` in the other, and
    // `totalTokens` was not `input + output`. Nothing here therefore asserts WHICH fields arrive —
    // the frames are printed as sent, and the one invariant asserted is the one that would make the
    // app's cost display lie: every count the app reports is a count the provider sent, unchanged,
    // with the newest value winning per field (the rule `TokenUsage::merge` documents) and a value
    // that is not a non-negative integer ignored on both sides (`response::token_count`).
    eprintln!("--- provider usage frames ({}):", usage_frames.len());
    for frame in &usage_frames {
        eprintln!("    {frame}");
    }
    let usage = completion.usage();
    eprintln!("--- app-side TokenUsage: {usage:?}");
    // Measured on this gateway on 2026-09-17: one usage frame per turn, carrying
    // `prompt_tokens` 17, `completion_tokens` 2 and `total_tokens` 19, plus a dozen fields
    // `TokenUsage` does not model (`cached_tokens`, `completion_thinking_tokens`,
    // `prompt_cache_miss_tokens`, two `*_details` objects, a `credit`). The count is NOT what is
    // asserted — a field set that is not fixed (P0 §6.3) may arrive with more or fewer of them —
    // but the presence of the object is: this request asks for it by name
    // (`stream_options.include_usage`) and the app's cost display has nothing to show without it,
    // so "the provider stopped answering that" is a finding rather than a quiet no-op.
    assert!(
        !usage_frames.is_empty(),
        "the gateway reported no usage at all for a request that asked for it; the app can only \
         display what the provider sends"
    );
    for (field, reported) in [
        ("prompt_tokens", usage.and_then(|found| found.prompt_tokens)),
        (
            "completion_tokens",
            usage.and_then(|found| found.completion_tokens),
        ),
        ("total_tokens", usage.and_then(|found| found.total_tokens)),
    ] {
        let sent = usage_frames
            .iter()
            .filter_map(|frame| frame.get(field))
            .filter_map(Value::as_u64)
            .next_back();
        assert_eq!(
            reported, sent,
            "the app reported {field} = {reported:?} but the provider sent {sent:?}; frames: \
             {usage_frames:?}"
        );
    }
    eprintln!("--- every count the app reports is one the provider sent, unchanged");
}
