//! The model list: the endpoint it is fetched from, the round trip, and what to
//! say about an answer that is not a model list.
//!
//! Extracted from [`super::response`] as one vertical slice, because listing
//! models is the one thing this layer does that is not part of a completion: it
//! is read on demand, its failures are read by a human in the settings page, and
//! its answers come from endpoints that were never designed to be asked this
//! question. `response` keeps the primitives both paths share (the bounded read,
//! the status wording) and re-exports the two public items below as its
//! compatibility surface, so `client` and the integration tests import them from
//! where they always did.
//!
//! Dependencies: [`super::request`] for the endpoint and the configuration,
//! [`super::response`] for the bounded read and the status wording,
//! [`super::limits`] for the ceilings. The `pub use` in `response` points back
//! here only to satisfy the compatibility rule that split follows — the
//! direction of USE is this file → `response`, never the reverse.

use super::limits::{MAX_ERROR_BODY_BYTES, MAX_MODELS_RESPONSE_BYTES};
use super::request::{models_endpoint, AIConfig};
use super::response::{error_detail_from_body, http_error_message_at, read_body_bounded};

/// How much of an unexpected body a failure message shows.
///
/// Recognition, not fidelity: an HTML fallback is unmistakable from its
/// doctype, a gateway's sorry page from its first sentence. This is also the
/// bound that keeps a 124 KB single-page-app document out of a toast.
const BODY_PREVIEW_CHARS: usize = 120;

/// The opening of a body, whitespace collapsed, for showing the user what
/// actually came back.
///
/// Collapsing matters as much as truncating: the bodies worth showing are
/// pretty-printed documents and multi-line error pages, and their meaning lives
/// in the first line, not in the blank lines between them.
fn body_preview(body: &str) -> String {
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut shown: String = collapsed.chars().take(BODY_PREVIEW_CHARS).collect();
    if collapsed.chars().count() > BODY_PREVIEW_CHARS {
        shown.push('…');
    }
    shown
}

/// The failure to report when a 2xx body is not the provider's JSON.
///
/// Two shapes, because they mean different things to the user. A body that
/// reads as a web page is a wrong-URL symptom — the report this workstream
/// exists for: the provider answers every path it does not recognise with HTTP
/// 200 and the same 124 KB SPA document, so a typo'd Base URL does not fail, it
/// "succeeds" with a web page. Anything else is an upstream breaking its own
/// contract. Both name the URL, because neither is diagnosable without it, and
/// both show a bounded preview: the message this replaces was a bare serde
/// offset (`expected value at line 1 column 1`) describing a body the user had
/// never seen, which is what made the original report unanswerable.
fn unexpected_body_error(url: &str, content_type: &str, body: &str) -> String {
    let preview = body_preview(body);
    if reads_as_a_web_page(body, content_type) {
        return format!(
            "模型列表请求失败：{url} 返回的是网页（HTML）而不是模型列表，Base URL 很可能填错了。\
             请在设置里检查 Base URL，或直接填写「模型列表 URL」——\
             这里的地址会被原样请求。服务商返回内容开头：{preview}"
        );
    }
    let declared = if content_type.is_empty() {
        "未声明"
    } else {
        content_type
    };
    format!(
        "模型列表请求失败：{url} 返回的内容不是 JSON（Content-Type: {declared}）。\
         请检查 Base URL 是否正确。服务商返回内容开头：{preview}"
    )
}

/// True when a body reads as a web page rather than a provider response.
///
/// `<` as the first non-whitespace byte is markup — no JSON document starts
/// that way — and a declared `text/html` says the same for a page whose doctype
/// sits behind a BOM or whose head was rewritten in transit. Only ever asked
/// about a body that has ALREADY failed to parse as JSON, which is what keeps
/// an API that mislabels its own JSON (`text/html` on a real payload) readable.
fn reads_as_a_web_page(body: &str, content_type: &str) -> bool {
    body.trim_start().starts_with('<') || content_type.contains("html")
}

/// Extract stable, sorted model IDs from a provider's `/models` response.
///
/// Robust across providers: OpenAI-compatible and Anthropic place their
/// entries in a `data` array with an `id` field; Gemini uses a `models` array
/// holding a fully-qualified `name` (e.g. `models/gemini-2.5-pro`) that we
/// reduce to its final segment. An empty or unparseable body yields an empty
/// list so the caller can degrade gracefully.
pub fn parse_model_ids(body: &str, _provider: &str) -> Vec<String> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.get("models").and_then(|m| m.as_array()));
    let Some(arr) = arr else {
        return Vec::new();
    };
    let mut ids: Vec<String> = Vec::new();
    for item in arr {
        let id = item
            .get("id")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .or_else(|| {
                item.get("name")
                    .and_then(|x| x.as_str())
                    .map(|n| n.rsplit('/').next().unwrap_or(n).to_string())
            });
        if let Some(id) = id {
            if !id.trim().is_empty() {
                ids.push(id);
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

/// Run the `GET /models` round trip against an already-built, already-pinned
/// client and return the parsed model ids.
///
/// The client is injected rather than constructed here: the transport (timeouts
/// from `limits`, the SSRF pin and the redirect refusal from `url_policy`, both
/// applied by `client::ai_http_client`) belongs to the caller, so this function
/// owns only what the response side owns - the endpoint's status, its bounded
/// body read and the JSON it parses into.
///
/// Every failure names the URL that was requested. That is not a nicety: the
/// path is DERIVED from the Base URL, so a message without it leaves the user
/// unable to tell which of the two the provider rejected - the original report
/// ("输入api地址和key刷新无法获取到model") took a probe of four URLs to answer,
/// and one line naming the derived endpoint would have answered it outright.
pub async fn fetch_model_ids(
    client: &reqwest::Client,
    config: &AIConfig,
) -> Result<Vec<String>, String> {
    let (url, headers) = models_endpoint(config);

    let mut request = client.get(&url);
    for (k, v) in &headers {
        request = request.header(k, v);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("请求模型列表失败（请求地址：{url}）：{e}"))?;
    let status = response.status();
    // The declared type is read before the body consumes the response: it is
    // half of the diagnosis when the body turns out to be a web page rather
    // than a model list.
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !status.is_success() {
        // Same reasoning as the completion path: the body says WHY (wrong key,
        // wrong base URL, unknown model), and that is what the user needs. The
        // read is bounded even here - an error page is peer-controlled bytes
        // too - and a body past that ceiling simply yields no detail, because
        // the status hint is the part that has to survive.
        let detail = read_body_bounded(response, MAX_ERROR_BODY_BYTES)
            .await
            .ok()
            .and_then(|body| error_detail_from_body(&body));
        return Err(http_error_message_at(
            Some(&url),
            status.as_u16(),
            detail.as_deref(),
        ));
    }
    let body = read_body_bounded(response, MAX_MODELS_RESPONSE_BYTES)
        .await
        .map_err(|e| format!("{e}（请求地址：{url}）"))?;

    // A blank body is a legitimate "no models" signal; anything non-empty must
    // still parse as JSON, otherwise a 500 error page would silently surface as
    // an empty dropdown instead of a real error.
    if body.trim().is_empty() {
        return Ok(Vec::new());
    }
    // What the body IS comes before what it means. A 2xx carrying a web page is
    // the signature of a URL the provider did not recognise - it answered with
    // its frontend instead of its API - and reporting that as a parse failure
    // is what made the wrong-URL case indistinguishable from a broken provider.
    // The serde error is deliberately NOT part of the message: `expected value
    // at line 1 column 1` describes a body the user has never seen, and the
    // preview above says the same thing in a form they can act on.
    if serde_json::from_str::<serde_json::Value>(&body).is_err() {
        return Err(unexpected_body_error(&url, &content_type, &body));
    }
    Ok(parse_model_ids(&body, &config.provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_is_collapsed_and_bounded() {
        // A pretty-printed page must not put its blank lines into the toast,
        // and its tail must not come along at all.
        let page = format!("<!DOCTYPE html>\n\n<html>\n{}</html>", "x".repeat(4000));
        let preview = body_preview(&page);
        assert_eq!(preview.chars().count(), BODY_PREVIEW_CHARS + 1); // + the ellipsis
        assert!(preview.starts_with("<!DOCTYPE html> <html>"));
    }

    #[test]
    fn a_page_is_recognised_by_its_body_or_by_its_declared_type() {
        for (body, content_type) in [
            ("<!DOCTYPE html>", "application/json"),
            ("  \n\t<html>", ""),
            // A doctype behind a BOM is not a `<` at the first byte; the
            // declared type is what catches it.
            ("\u{feff}<html>", "text/html; charset=utf-8"),
        ] {
            assert!(
                reads_as_a_web_page(body, content_type),
                "{body:?} / {content_type:?} must read as a page"
            );
        }
        for (body, content_type) in [
            ("upstream connect error", "text/plain"),
            ("[1,2,3]", "application/json"),
        ] {
            assert!(!reads_as_a_web_page(body, content_type));
        }
    }
}
