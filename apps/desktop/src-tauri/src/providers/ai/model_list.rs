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
//! The slice is three files, and this one is the round trip: the ids a body
//! carries are read in `ids` and the sentences a failure produces are written in
//! `diagnosis`, with the names the old layout exposed re-exported below so that
//! no caller can tell where they moved.
//!
//! Dependencies: [`super::request`] for the endpoint and the configuration,
//! [`super::response`] for the bounded read and the status wording,
//! [`super::limits`] for the ceilings. The `pub use` in `response` points back
//! here only to satisfy the compatibility rule that split follows — the
//! direction of USE is this file → `response`, never the reverse.

mod diagnosis;
mod ids;

// The parser moved to `model_list::ids` and the failure wording to
// `model_list::diagnosis`; this path is the compatibility surface the split
// keeps, so `response` (and, through it, `client` and the integration tests)
// still import the name from where it always was.
pub use self::ids::parse_model_ids;

use self::diagnosis::{body_preview, transport_failure_note, unexpected_body_error};
use super::limits::{MAX_ERROR_BODY_BYTES, MAX_MODELS_RESPONSE_BYTES};
use super::request::{models_endpoint, AIConfig};
use super::response::{
    declared_content_type, error_detail_from_body, http_error_message_at, read_body_bounded,
};

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
    // A provider with no Base URL and no host of its own is refused here, before
    // the request is built — the model list used to be the second path that
    // reached api.openai.com in that state.
    let (url, headers) = models_endpoint(config)?;

    let mut request = client.get(&url);
    for (k, v) in &headers {
        request = request.header(k, v);
    }

    let response = request.send().await.map_err(|e| {
        format!(
            "请求模型列表失败（请求地址：{url}）：{}",
            transport_failure_note(&e)
        )
    })?;
    let status = response.status();
    // The declared type is read before the body consumes the response: it is
    // half of the diagnosis when the body turns out to be a web page rather
    // than a model list. The read is `response`'s, because the completion path
    // makes the same diagnosis of its own unfaithful 2xx and both must show the
    // same thing.
    let content_type = declared_content_type(&response);
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

    // Valid JSON that yields no models is the LAST silent case, and it is the
    // same failure the comment above describes one step later: the dropdown
    // comes up empty and nothing says why.
    //
    // Reported rather than returned as an empty list, because a `/models`
    // endpoint serving a well-formed document this parser cannot read is far
    // likelier than a provider genuinely offering zero models — the parser knows
    // `data[].id` and `models[].name`, and a bare top-level array or a renamed
    // key is not exotic. The document's opening is what identifies the shape it
    // actually sent, so a wrong guess costs one round trip instead of an
    // investigation.
    let ids = parse_model_ids(&body, &config.provider);
    if ids.is_empty() {
        return Err(format!(
            "模型列表请求成功，但没能从响应里读出任何模型（请求地址：{url}）。\
             服务商返回内容开头：{}",
            body_preview(&body)
        ));
    }
    Ok(ids)
}
