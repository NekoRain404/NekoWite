//! What a 200 response that is not an event stream produces.
//!
//! `ai_completion_result_test.rs` pins the verdict on a completion that was
//! FOLDED: a stream whose frames arrived and whose answer is empty is a no-op,
//! because the provider sent an event saying the turn ended with nothing in it.
//! This file is the other half — a response from which no event was ever read.
//! There we cannot say the model was silent, only that we could not read what
//! came back, and the two must not be answered the same way.
//!
//! ## The report this file exists for
//!
//! A provider answers every path it does not recognise with HTTP 200 and its
//! single-page-app fallback — the behaviour `ai_model_fetch_test.rs`'s header
//! records, one endpoint over, and the bug `list_models` was fixed for. On the
//! COMPLETION path that body is fed to `CompletionStream`, which looks for
//! `data:` frames, finds none and produces no events; the loop then reaches
//! `completion_refusal`, which answers `None` for an empty answer with no
//! `finish_reason` and no reasoning; and the call ends in `ai-done` carrying
//! `full: ""`. The user asked the editor to complete a sentence and got no text,
//! no error and no reason.
//!
//! ## What is driven
//!
//! The SHIPPED `stream_complete` — the real loop, the real emits, the real
//! transport — against a loopback server, so that "reported" and "silent" are
//! observed rather than inferred. That is why the function is generic over the
//! runtime: `tauri::test` can only build an app whose runtime is `MockRuntime`,
//! and a signature naming `tauri::AppHandle` (= `AppHandle<Wry>`) could not be
//! called with it. The events below are read back through `AppHandle::listen`,
//! the same mechanism a window uses, so the assertions are about what the app
//! actually published and not about a helper's return value.
//!
//! The `ai-error` assertions are half the promise; the `ai-done` ones are the
//! other half, and they are the ones the defect violated. `a_normal_stream_…`
//! below is what keeps those absences meaningful: it proves a listener here does
//! receive `ai-done`, so "no `ai-done` arrived" is a measurement rather than a
//! subscription that never worked.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::{Listener, Manager};
use tokio_util::sync::CancellationToken;

use nekowite_lib::providers::ai::client::{stream_complete, AIConfig};
use nekowite_lib::state::AiState;

/// The id every run in this file is registered under. `stream_complete` reads
/// the in-flight registry to decide whether it still owns the run, so a test
/// that never claims its id would have the loop exit on its first check.
const ID: &str = "ai-unreadable-1";

/// The single-page-app fallback, shrunk but faithful — the same document
/// `ai_model_fetch_test.rs` serves for the models endpoint, because it is one
/// provider answering the same wrong way to two paths. The `</body>` at the very
/// end is the marker the tests look for to prove the message carries a preview
/// of the page and not the page.
fn spa_fallback() -> String {
    format!(
        "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
         <title>TokenFlux</title><script>window.__NUXT__={{}}</script></head>\
         <body><div id=\"app\"></div>{}</body></html>",
        "<!-- filler -->".repeat(400)
    )
}

/// Serve one canned HTTP 200 on a loopback port, to every connection.
///
/// `content_type` is `None` for a response that declares no type at all, which
/// is a real shape (a proxy that forwards a bare body) and the one a
/// content-type gate would have to read as innocent. `hold_open` writes the
/// body and then keeps the connection alive without ever completing it — the
/// declared length is deliberately longer than what was sent — which is the
/// state a request is in while it is still being read.
async fn serve(
    content_type: Option<&str>,
    body: &str,
    hold_open: bool,
) -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind a loopback port");
    let addr = listener.local_addr().expect("local addr");
    let declared = match content_type {
        Some(value) => format!("Content-Type: {value}\r\n"),
        None => String::new(),
    };
    // A held-open response must never satisfy its own Content-Length: a complete
    // body ends the stream at its last byte, which would make this a finished
    // request rather than one still in flight.
    let promised = body.len() + if hold_open { 4096 } else { 0 };
    let response = format!(
        "HTTP/1.1 200 OK\r\n{declared}Content-Length: {promised}\r\nConnection: close\r\n\r\n{body}"
    );
    let server = tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let response = response.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.flush().await;
                if hold_open {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
                let _ = sock.shutdown().await;
            });
        }
    });
    (format!("http://127.0.0.1:{}", addr.port()), server)
}

/// A config pointed at the loopback server the test just started. `allow_private`
/// is the opt-in the address policy requires for a loopback literal.
fn cfg(base: &str) -> AIConfig {
    AIConfig {
        provider: "openai".into(),
        model: "m".into(),
        base_url: Some(base.into()),
        api_key: Some("SECRET-SESSION-KEY".into()),
        allow_private: true,
        ..Default::default()
    }
}

/// What one run published, by event name.
#[derive(Default)]
struct Published {
    errors: Mutex<Vec<Value>>,
    dones: Mutex<Vec<Value>>,
    chunks: Mutex<Vec<String>>,
}

impl Published {
    fn errors(&self) -> Vec<Value> {
        self.errors.lock().expect("the listener's lock").clone()
    }

    fn dones(&self) -> Vec<Value> {
        self.dones.lock().expect("the listener's lock").clone()
    }

    fn chunks(&self) -> Vec<String> {
        self.chunks.lock().expect("the listener's lock").clone()
    }

    /// The one message the run reported, for the tests whose promise is that
    /// there is exactly one and that it is the `Err` the caller got back.
    fn only_error(&self) -> String {
        let errors = self.errors();
        assert_eq!(errors.len(), 1, "expected one ai-error, got {errors:?}");
        errors[0]["message"]
            .as_str()
            .expect("the payload carries a message")
            .to_string()
    }

    fn assert_silent_about_failure(&self) {
        assert!(
            self.errors().is_empty(),
            "no failure may be reported here: {:?}",
            self.errors()
        );
    }
}

/// The app a run emits into: an in-flight registry holding [`ID`], and a
/// listener on each of the three events, reading the payload exactly as a
/// window's `listen` would.
fn app(
    id: &str,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    Arc<Published>,
    CancellationToken,
) {
    let app = tauri::test::mock_app();
    app.manage(AiState::default());
    let cancel = CancellationToken::new();
    assert!(
        app.state::<AiState>()
            .claim(id, cancel.clone())
            .expect("the registry is readable"),
        "the id must be free; otherwise every run below exits as cancelled"
    );

    let published = Arc::new(Published::default());

    let sink = Arc::clone(&published);
    app.listen("ai-error", move |event| {
        sink.errors
            .lock()
            .expect("the listener's lock")
            .push(parse(event.payload()));
    });
    let sink = Arc::clone(&published);
    app.listen("ai-done", move |event| {
        sink.dones
            .lock()
            .expect("the listener's lock")
            .push(parse(event.payload()));
    });
    let sink = Arc::clone(&published);
    app.listen("ai-chunk", move |event| {
        let payload = parse(event.payload());
        sink.chunks
            .lock()
            .expect("the listener's lock")
            .push(payload["text"].as_str().unwrap_or_default().to_string());
    });

    (app, published, cancel)
}

fn parse(payload: &str) -> Value {
    serde_json::from_str(payload).unwrap_or_else(|e| panic!("an event payload is JSON: {e}"))
}

/// Drive the shipped completion path against `base`, as the app runs it: the
/// prompt and caps of a ghost-writer call, the id registered above, no images
/// and no pin (a loopback literal is not a name to pin).
async fn complete(
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    base: &str,
    id: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    stream_complete(
        app,
        &cfg(base),
        "complete this sentence",
        &[],
        id,
        cancel,
        None,
    )
    .await
}

/// The defect, as a test. A provider that answers a path it does not know with
/// its SPA fallback must be reported: the app parsed no event, so it cannot say
/// the model was silent — and `ai-done` with `full: ""` said nothing at all.
#[tokio::test]
async fn an_html_fallback_answered_with_200_is_reported_instead_of_ending_silently() {
    let (base, server) = serve(Some("text/html; charset=utf-8"), &spa_fallback(), false).await;
    let (app, published, cancel) = app(ID);

    let outcome = complete(app.handle(), &base, ID, &cancel).await;
    server.abort();

    let message = outcome.expect_err(
        "a 200 whose body is a web page must be reported: no event was ever read, so the app \
         cannot tell the user the model was silent",
    );
    // Which address answered — the answer to "why did nothing appear".
    assert!(
        message.contains(&format!("{base}/chat/completions")),
        "the failure must name the URL it asked: {message}"
    );
    // What came back, so a web page is recognisable at a glance.
    assert!(
        message.contains("HTML"),
        "the failure must say the answer was a web page: {message}"
    );
    assert!(
        message.contains("text/html"),
        "the failure must name the declared content type: {message}"
    );
    assert!(
        message.contains("<!DOCTYPE html>"),
        "the failure must show the start of the body: {message}"
    );
    assert!(
        message.contains("Base URL"),
        "the failure must point at the setting to fix: {message}"
    );
    // A preview, never the page: the same bound the models path holds itself to.
    assert!(
        !message.contains("</body>"),
        "the failure must show a bounded preview, not the whole body: {message}"
    );

    // The window is told the same thing the caller got back, under the same id.
    assert_eq!(published.only_error(), message);
    assert_eq!(published.errors()[0]["id"], ID);
    assert!(
        published.dones().is_empty(),
        "this is the defect: the call ended in `ai-done` with `full: \"\"`, and the user was told \
         nothing either way"
    );
}

/// A 200 that is neither JSON nor HTML — a gateway's plain-text page, a proxy
/// error — still has to say where the bytes came from and what they were.
#[tokio::test]
async fn a_gateway_page_that_is_not_html_is_reported_with_what_came_back() {
    let (base, server) = serve(
        Some("text/plain"),
        "upstream connect error or disconnect",
        false,
    )
    .await;
    let (app, published, cancel) = app(ID);

    let outcome = complete(app.handle(), &base, ID, &cancel).await;
    server.abort();

    let message = outcome.expect_err("plain text is not an event stream");
    assert!(
        message.contains(&format!("{base}/chat/completions")),
        "the failure must name the URL it asked: {message}"
    );
    assert!(
        message.contains("text/plain"),
        "the failure must name the declared content type: {message}"
    );
    assert!(
        message.contains("upstream connect error"),
        "the failure must show what came back: {message}"
    );
    assert_eq!(published.only_error(), message);
    assert!(published.dones().is_empty(), "and it is not a done");
}

/// The case a content-type check could never have caught: a 200 declaring
/// `application/json`, which is what a stream is perfectly entitled to declare,
/// carrying a well-formed NON-streaming completion document. Nothing in it is a
/// `data:` frame, so no event is read, and the only honest answer is to report
/// it — with its own words, which name what actually happened.
#[tokio::test]
async fn a_json_body_that_carries_no_events_is_reported_too() {
    let body = r#"{"id":"chatcmpl-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}]}"#;
    let (base, server) = serve(Some("application/json"), body, false).await;
    let (app, published, cancel) = app(ID);

    let outcome = complete(app.handle(), &base, ID, &cancel).await;
    server.abort();

    let message = outcome.expect_err("a non-streaming document is not an event stream");
    assert!(
        message.contains("application/json"),
        "the failure must name the declared content type: {message}"
    );
    assert!(
        message.contains(r#""object":"chat.completion""#),
        "the failure must show the body, which is what says WHICH kind of wrong answer this is: \
         {message}"
    );
    assert!(published.dones().is_empty(), "and it is not a done");
}

/// A 200 with an empty body and no declared type: still nothing was read, so it
/// is still reported — and the message does not pretend to show a preview it
/// does not have.
#[tokio::test]
async fn an_empty_200_body_is_reported_rather_than_ending_silently() {
    let (base, server) = serve(None, "", false).await;
    let (app, published, cancel) = app(ID);

    let outcome = complete(app.handle(), &base, ID, &cancel).await;
    server.abort();

    let message = outcome.expect_err("an empty body declares no event either");
    assert!(
        message.contains(&format!("{base}/chat/completions")),
        "the failure must name the URL it asked: {message}"
    );
    assert!(
        message.contains("Content-Type"),
        "the failure must say a type was not read, rather than inventing one: {message}"
    );
    assert!(published.dones().is_empty(), "and it is not a done");
}

/// The rule must not be tightened into a refusal. OpenAI-compatible providers
/// are not consistent about the type they declare for a stream — this app asks
/// one for `stream: true` and reads whatever frames come back — so a real event
/// stream is still read whatever it declares, including a type that has nothing
/// to do with SSE and no type at all. A rejected stream would cost the user the
/// answer they paid for, which is worse than the silence this change removes.
#[tokio::test]
async fn an_event_stream_is_read_whatever_content_type_it_declares() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"PONG\"}}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":1,\"total_tokens\":10}}\n\n",
        "data: [DONE]\n\n",
    );
    for declared in [
        Some("text/event-stream"),
        Some("text/event-stream; charset=utf-8"),
        Some("text/plain"),
        Some("application/json"),
        Some("application/octet-stream"),
        // The type a GATE would have refused, on a response that is a perfectly
        // good stream: the web-page rule is asked about a body that yielded no
        // event, and this one yielded events.
        Some("text/html"),
        None,
    ] {
        let (base, server) = serve(declared, body, false).await;
        let (app, published, cancel) = app(ID);

        let outcome = complete(app.handle(), &base, ID, &cancel).await;
        server.abort();

        outcome.unwrap_or_else(|message| {
            panic!("a real event stream declaring {declared:?} must complete: {message}")
        });
        published.assert_silent_about_failure();
        assert_eq!(
            published.chunks(),
            vec!["PONG".to_string()],
            "the answer must reach the window: {declared:?}"
        );
        let dones = published.dones();
        assert_eq!(dones.len(), 1, "{declared:?} produced {dones:?}");
        assert_eq!(dones[0]["full"], "PONG", "{declared:?}");
        // And the accounting the provider sent survives the new arm untouched.
        assert_eq!(dones[0]["usage"]["total_tokens"], 10, "{declared:?}");
    }
}

/// The policy `ai_completion_result_test.rs` pins, driven through the whole
/// loop: a response that DID yield an event, whose answer is empty, is the model
/// saying nothing — a no-op, not a failure. This is the case the new arm could
/// have taken away, so it is pinned end to end and not only on the folded state.
#[tokio::test]
async fn an_empty_turn_that_arrived_is_still_a_no_op() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    );
    let (base, server) = serve(Some("text/event-stream"), body, false).await;
    let (app, published, cancel) = app(ID);

    let outcome = complete(app.handle(), &base, ID, &cancel).await;
    server.abort();

    outcome.expect("an empty answer with no truncation and no reasoning is a no-op");
    published.assert_silent_about_failure();
    let dones = published.dones();
    assert_eq!(dones.len(), 1, "it ends in a done: {dones:?}");
    assert_eq!(dones[0]["full"], "", "carrying the empty answer it had");
}

/// The other side of that boundary, and the measurement that makes the absences
/// above mean something: an ordinary stream still reaches the window text by
/// text and ends in an `ai-done` carrying all of it. Without this, "no `ai-done`
/// arrived" could be a listener that never worked.
#[tokio::test]
async fn a_normal_stream_still_ends_in_a_done_carrying_its_text() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    );
    let (base, server) = serve(Some("text/event-stream"), body, false).await;
    let (app, published, cancel) = app(ID);

    let outcome = complete(app.handle(), &base, ID, &cancel).await;
    server.abort();

    outcome.expect("a normal completion is a success");
    published.assert_silent_about_failure();
    assert_eq!(
        published.chunks(),
        vec!["he".to_string(), "llo".to_string()]
    );
    let dones = published.dones();
    assert_eq!(dones.len(), 1, "exactly one done: {dones:?}");
    assert_eq!(dones[0]["full"], "hello");
}

/// A cancellation is not a failure and not a completion. The response here is
/// one the new arm WOULD report — a web page answered as 200 — and it is
/// stopped mid-read, which must stay silent: the user asked for the request to
/// stop, and turning their own Stop into an error message (or into a done) is
/// how a cancelled request gets adopted by whatever runs next. The connection is
/// held open so the request really is in flight when the stop arrives; either
/// way the outcome is the same, because a cancel that beats the headers returns
/// through the same silent path.
#[tokio::test]
async fn a_cancelled_unreadable_response_stays_silent() {
    let (base, server) = serve(Some("text/html; charset=utf-8"), &spa_fallback(), true).await;
    let (app, published, cancel) = app(ID);

    let handle = app.handle().clone();
    let stopping = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        handle
            .state::<AiState>()
            .cancel(ID)
            .expect("the registry is readable");
    });

    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        complete(app.handle(), &base, ID, &cancel),
    )
    .await
    .expect("a stop must not wait for the provider");
    server.abort();
    stopping.await.expect("the stop ran");

    outcome.expect("a cancellation is not a failure");
    published.assert_silent_about_failure();
    assert!(
        published.dones().is_empty(),
        "and it is not a completion either: {:?}",
        published.dones()
    );
    assert!(published.chunks().is_empty());
}
