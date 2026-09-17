//! What the app makes of the answers a real provider gives to `GET /models`.
//!
//! The report this file exists for was one line long and unreadable —
//! `expected value at line 1 column 1` — because the provider answers any path
//! it does not recognise with HTTP 200 and a single-page-app fallback: the same
//! 124 KB HTML document, a request that "succeeds" and a message that can only
//! describe a serde offset. The app could not tell "wrong URL" from "malformed
//! provider response", and said neither the URL nor the body.
//!
//! Every test here pins one of the promises that replaces it: the failure names
//! the address that was asked, shows what came back, and calls an HTML page a
//! page.

use std::sync::{Arc, Mutex};

use nekowite_lib::providers::ai::client::{list_models, AIConfig};

/// The single-page-app fallback, shrunk but faithful: a document head, then a
/// body far longer than the window a failure message is allowed to show. The
/// `</body>` at the very end is the marker the test looks for to prove the
/// message carries a preview of the page and not the page.
fn spa_fallback() -> String {
    format!(
        "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
         <title>TokenFlux</title><script>window.__NUXT__={{}}</script></head>\
         <body><div id=\"app\"></div>{}</body></html>",
        "<!-- filler -->".repeat(400)
    )
}

/// Serve one canned HTTP response on a loopback port, recording the request
/// line of every connection so a test can prove WHICH path was asked for.
async fn serve(
    status: &str,
    content_type: &str,
    body: &str,
) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind a loopback port");
    let addr = listener.local_addr().expect("local addr");
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let server = tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let record = record.clone();
            let response = response.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let read = sock.read(&mut buf).await.unwrap_or(0);
                let line = String::from_utf8_lossy(&buf[..read])
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_string();
                if let Ok(mut seen) = record.lock() {
                    seen.push(line);
                }
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    (format!("http://127.0.0.1:{}", addr.port()), seen, server)
}

/// A config pointed at the loopback server the test just started.
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

/// The bug report, as a test: the provider answers an unrecognised path with
/// its SPA fallback, so the request "succeeds" and the user is told nothing.
#[tokio::test]
async fn an_html_fallback_answered_with_200_is_reported_as_a_wrong_url() {
    let (base, seen, server) = serve("200 OK", "text/html; charset=utf-8", &spa_fallback()).await;
    let config = cfg(&base);

    let err = list_models(&config)
        .await
        .expect_err("an HTML page must not read as an empty model list");

    // Which address answered — the answer to "why did refreshing fail".
    assert!(
        err.contains(&format!("{base}/models")),
        "the failure must name the URL it tried: {err}"
    );
    // What came back, so 124 KB of Nuxt fallback is recognisable at a glance.
    assert!(
        err.contains("<!DOCTYPE html>"),
        "the failure must show the start of the body: {err}"
    );
    assert!(
        err.contains("HTML"),
        "the failure must say the answer was a web page: {err}"
    );
    assert!(
        err.contains("Base URL"),
        "the failure must point at the setting to fix: {err}"
    );
    // The message stays readable: a preview, never the page itself.
    assert!(
        !err.contains("</body>"),
        "the failure must show a bounded preview, not the whole body: {err}"
    );
    // The message that opened this workstream.
    assert!(
        !err.contains("line 1 column"),
        "a serde offset must never be the user-facing message: {err}"
    );

    // And the page really was the answer: the request went to the derived path.
    assert_eq!(
        seen.lock().expect("request log").as_slice(),
        ["GET /models HTTP/1.1".to_string()],
        "the derived endpoint is what a config without an override asks for"
    );
    server.abort();
}

/// The derived endpoint is still per provider: the override is an addition, not
/// a rewrite of what a Base URL alone produces.
#[tokio::test]
async fn each_provider_keeps_its_own_derived_models_path() {
    for (provider, path) in [
        ("anthropic", "/v1/models"),
        ("gemini", "/v1beta/models"),
        ("openai", "/models"),
    ] {
        let (base, seen, server) =
            serve("200 OK", "application/json", r#"{"data":[{"id":"m"}]}"#).await;
        let config = AIConfig {
            provider: provider.into(),
            ..cfg(&base)
        };

        let ids = list_models(&config).await.expect("a model list");
        assert_eq!(ids, vec!["m"], "{provider}");
        assert_eq!(
            seen.lock().expect("request log").as_slice(),
            [format!("GET {path} HTTP/1.1")],
            "{provider} derives its own path from the Base URL"
        );
        server.abort();
    }
}

/// The fetch the agent settings page's provider form makes.
///
/// `agent-provider-authoring.ts` sends this command `provider: "custom"` and the address the user
/// typed in the form's Base URL field, because an engine provider block names
/// `@ai-sdk/openai-compatible` — whose own model list is `GET {baseURL}/models` with
/// `Authorization: Bearer <key>`, the request this app already makes for every provider it has no
/// special case for. So the claim "one command serves both" is a claim about *this* path, and it is
/// asserted here rather than in a comment: the derived endpoint from the address alone, with a
/// trailing slash the user may well have left on it.
#[tokio::test]
async fn the_provider_form_fetches_from_the_address_it_was_given() {
    let (base, seen, server) = serve(
        "200 OK",
        "application/json",
        r#"{"data":[{"id":"deepseek-v4.1-flash"}]}"#,
    )
    .await;
    let config = AIConfig {
        provider: "custom".into(),
        base_url: Some(format!("{base}/")),
        ..cfg(&base)
    };

    let ids = list_models(&config).await.expect("a model list");
    assert_eq!(ids, vec!["deepseek-v4.1-flash"]);
    assert_eq!(
        seen.lock().expect("request log").as_slice(),
        ["GET /models HTTP/1.1".to_string()],
        "the address the user typed, its own /models, trailing slash and all"
    );
    server.abort();
}

/// A 2xx that is not JSON and not HTML either — a proxy's plain-text page, a
/// truncated body — still has to say where the bytes came from and what they
/// were.
#[tokio::test]
async fn a_non_json_2xx_body_names_the_url_and_shows_what_came_back() {
    let (base, _seen, server) = serve(
        "200 OK",
        "text/plain",
        "upstream connect error or disconnect",
    )
    .await;

    let err = list_models(&cfg(&base))
        .await
        .expect_err("plain text is not a model list");

    assert!(
        err.contains(&format!("{base}/models")),
        "the failure must name the URL it tried: {err}"
    );
    assert!(
        err.contains("upstream connect error"),
        "the failure must show what came back: {err}"
    );
    assert!(
        !err.contains("line 1 column"),
        "a serde offset must never be the user-facing message: {err}"
    );
    server.abort();
}

/// A non-2xx already carried the provider's explanation; it must now also carry
/// the address that gave it.
#[tokio::test]
async fn a_non_2xx_names_the_url_as_well_as_the_provider_detail() {
    let (base, _seen, server) = serve(
        "403 Forbidden",
        "application/json",
        r#"{"error":{"message":"invalid api key"}}"#,
    )
    .await;

    let err = list_models(&cfg(&base))
        .await
        .expect_err("403 is a failure");

    assert!(
        err.contains(&format!("{base}/models")),
        "the failure must name the URL it tried: {err}"
    );
    assert!(
        err.contains("invalid api key"),
        "the provider's own explanation must survive: {err}"
    );
    server.abort();
}

// --- The models-URL override -------------------------------------------------
//
// A Base URL is a guess about a provider's layout. The override is the user
// saying exactly where the list lives — used verbatim, and judged by the same
// URL policy as everything else.

#[tokio::test]
async fn an_explicit_models_url_is_asked_for_verbatim() {
    let (base, seen, server) = serve(
        "200 OK",
        "application/json",
        r#"{"data":[{"id":"custom-model"}]}"#,
    )
    .await;
    let config = AIConfig {
        models_url: Some(format!("{base}/anthropic/v1/models")),
        ..cfg(&base)
    };

    let ids = list_models(&config)
        .await
        .expect("the override IS the endpoint");
    assert_eq!(ids, vec!["custom-model"]);

    // Nothing is appended to it: not `/models`, not `/v1`.
    assert_eq!(
        seen.lock().expect("request log").as_slice(),
        ["GET /anthropic/v1/models HTTP/1.1".to_string()],
        "the override is used verbatim"
    );
    server.abort();
}

#[tokio::test]
async fn a_blank_models_url_falls_back_to_the_derived_endpoint() {
    // Clearing the field must restore the derived path rather than ask for "".
    let (base, seen, server) =
        serve("200 OK", "application/json", r#"{"data":[{"id":"a"}]}"#).await;
    let config = AIConfig {
        models_url: Some("   ".into()),
        ..cfg(&base)
    };

    let ids = list_models(&config).await.expect("blank means unset");
    assert_eq!(ids, vec!["a"]);
    assert_eq!(
        seen.lock().expect("request log").as_slice(),
        ["GET /models HTTP/1.1".to_string()]
    );
    server.abort();
}

#[tokio::test]
async fn a_models_url_override_is_held_to_the_https_rule() {
    // The override is a second address, not a second set of rules. The Base URL
    // here is a perfectly good HTTPS one; it is the override that is judged.
    let config = AIConfig {
        base_url: Some("https://203.0.113.9/v1".into()),
        models_url: Some("http://203.0.113.9/v1/models".into()),
        api_key: Some("SECRET-SESSION-KEY".into()),
        ..Default::default()
    };

    let err = list_models(&config)
        .await
        .expect_err("plain HTTP to a public host must be refused");
    assert!(
        err.contains("https://"),
        "the refusal must say what to use instead: {err}"
    );
}

#[tokio::test]
async fn a_models_url_override_does_not_bypass_the_private_host_guard() {
    // Same rule for a loopback literal: an override must not become the hole in
    // the SSRF policy that `allow_private` exists to control.
    let config = AIConfig {
        base_url: Some("https://203.0.113.9/v1".into()),
        models_url: Some("http://127.0.0.1:1/v1/models".into()),
        api_key: Some("SECRET-SESSION-KEY".into()),
        ..Default::default()
    };

    let err = list_models(&config)
        .await
        .expect_err("loopback without the opt-in must be refused");
    assert!(
        err.contains("内网") || err.contains("本机"),
        "the refusal must name the private-address rule: {err}"
    );
}

// --- The wire shape ----------------------------------------------------------

#[test]
fn the_models_url_override_round_trips_from_json() {
    // The frontend hands this over IPC, so the field name and its optionality
    // are part of the contract.
    let with_override: AIConfig = serde_json::from_value(serde_json::json!({
        "provider": "anthropic",
        "model": "m",
        "models_url": "https://example.com/v1/models"
    }))
    .expect("a config without every field still deserializes");
    assert_eq!(
        with_override.models_url.as_deref(),
        Some("https://example.com/v1/models")
    );

    let without: AIConfig = serde_json::from_value(serde_json::json!({
        "provider": "openai",
        "model": "m"
    }))
    .expect("models_url is optional");
    assert!(without.models_url.is_none());
}
