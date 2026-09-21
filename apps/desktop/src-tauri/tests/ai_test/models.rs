//! The model list: what a provider's response parses to, and the size ceiling a loopback
//! server's bytes are read against - a response past it is refused rather than buffered,
//! whether its length is declared or chunked.

use nekowite_lib::providers::ai::client::{
    list_models, parse_model_ids, MAX_MODELS_RESPONSE_BYTES,
};

use super::support::base_cfg;

#[test]
fn parse_models_openai_data_ids() {
    let ids = parse_model_ids(r#"{"data":[{"id":"a"},{"id":"b"}]}"#, "openai");
    assert_eq!(ids, vec!["a", "b"]);
}

#[test]
fn parse_models_gemini_name_to_id() {
    let ids = parse_model_ids(r#"{"models":[{"name":"models/gemini-2.5-pro"}]}"#, "gemini");
    assert_eq!(ids, vec!["gemini-2.5-pro"]);
}

#[test]
fn parse_models_anthropic_data_ids() {
    let ids = parse_model_ids(r#"{"data":[{"id":"claude-sonnet-4-5"}]}"#, "anthropic");
    assert_eq!(ids, vec!["claude-sonnet-4-5"]);
}

#[test]
fn parse_models_empty_body_returns_empty() {
    assert_eq!(parse_model_ids("", "openai"), Vec::<String>::new());
    assert_eq!(parse_model_ids("   ", "openai"), Vec::<String>::new());
    assert_eq!(parse_model_ids("not json", "openai"), Vec::<String>::new());
}

#[test]
fn parse_models_sorts_and_dedups() {
    let ids = parse_model_ids(r#"{"data":[{"id":"b"},{"id":"a"},{"id":"b"}]}"#, "openai");
    assert_eq!(ids, vec!["a", "b"]);
}

#[test]
fn parse_models_skips_entries_without_id_or_name() {
    let ids = parse_model_ids(
        r#"{"data":[{"id":"ok"},{"description":"no id"},{"id":""}]}"#,
        "openai",
    );
    assert_eq!(ids, vec!["ok"]);
}

// --- P1 AI 输入输出限制：模型列表响应 ---------------------------------------
//
// One loopback server, one request: the response is the attacker's bytes, and
// the read must stop at a ceiling instead of trusting `Content-Length` or
// buffering whatever arrives.

/// Serve `body` once on a loopback port and hand back the Base URL and the
/// server task.
///
/// `content_length: Some(n)` sends an honest `Content-Length: n`; `None` sends
/// the body with chunked transfer-encoding, so the client sees NO length up
/// front and has to bound the read as it goes - the two paths the reader has to
/// defend separately.
async fn serve_once(
    body: &str,
    content_length: Option<usize>,
) -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind a loopback port");
    let addr = listener.local_addr().expect("local addr");
    let response = match content_length {
        Some(len) => {
            let mut out = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
            );
            out.push_str(body);
            out.into_bytes()
        }
        None => {
            let mut out = String::from(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            );
            for part in body.as_bytes().chunks(64 * 1024) {
                out.push_str(&format!("{:x}\r\n", part.len()));
                out.push_str(&String::from_utf8_lossy(part));
                out.push_str("\r\n");
            }
            out.push_str("0\r\n\r\n");
            out.into_bytes()
        }
    };
    let server = tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let response = response.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(&response).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    (format!("http://127.0.0.1:{}", addr.port()), server)
}

/// A models payload that exceeds `MAX_MODELS_RESPONSE_BYTES` while staying
/// VALID JSON - so a reader without a ceiling parses it happily and hands the
/// list back, and only a reader that bounds the read refuses it.
fn oversized_models_body() -> String {
    let filler = "x".repeat(MAX_MODELS_RESPONSE_BYTES + 1);
    format!(r#"{{"data":[{{"id":"a"}}],"filler":"{filler}"}}"#)
}

#[tokio::test]
async fn an_oversized_model_list_response_is_refused() {
    let (base, server) = serve_once(&oversized_models_body(), None).await;
    let cfg = base_cfg(&base, true);
    let result = list_models(&cfg).await;
    let err = result.err().unwrap_or_else(|| {
        panic!("a response past the ceiling must be refused, not parsed");
    });
    assert!(
        err.contains("过大"),
        "the error must name the size limit, got: {err}"
    );
    server.abort();
}

#[tokio::test]
async fn a_declared_oversized_model_list_response_is_refused_without_reading_it() {
    // A chunked response carries no length, but an honest one does: the reader
    // must refuse it before buffering a byte rather than reading the body and
    // checking afterwards.
    let body = r#"{"data":[{"id":"a"}]}"#;
    let (base, server) = serve_once(body, Some(MAX_MODELS_RESPONSE_BYTES + 1)).await;
    let cfg = base_cfg(&base, true);
    let err = list_models(&cfg).await.expect_err("oversized body");
    assert!(err.contains("过大"), "got: {err}");
    server.abort();
}

#[tokio::test]
async fn a_normal_model_list_response_still_works() {
    // The ceiling must not break the happy path it is drawn around.
    let (base, server) = serve_once(r#"{"data":[{"id":"b"},{"id":"a"}]}"#, None).await;
    let cfg = base_cfg(&base, true);
    let ids = list_models(&cfg).await.expect("a small list parses");
    assert_eq!(ids, vec!["a", "b"]);
    server.abort();
}
