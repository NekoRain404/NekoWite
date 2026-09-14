//! Request-side construction: the shared body/URL helpers every provider
//! builds from, the endpoint the model list is fetched from, and the input
//! ceilings that are checked before anything is sent.
//!
//! The completion configuration and its derivations live in [`super::config`];
//! the names the old layout exposed from here are re-exported below.
//!
//! Dependencies: [`super::limits`] for the ceilings. Nothing here builds a
//! transport or parses a response, so this module never imports `client`,
//! `response`, `sse` or `url_policy`; the arrow points one way only
//! (`client`/`url_policy`/the provider modules depend on this file).
//!
//! The continuation instruction is NOT built here. `build_prompt` used to sit in
//! this file with no caller — the ghost writer assembles the prompt in
//! `features/ai/services/ai-prompt.ts`, where the cursor prefix lives — and the
//! byte-identical second copy was deleted rather than left to drift. Do not
//! re-add it: a prompt built here would need the prefix over IPC first.

use super::limits::{
    MAX_IMAGES_PER_REQUEST, MAX_IMAGE_DATA_URL_BYTES, MAX_PROMPT_BYTES, MAX_REQUEST_BODY_BYTES,
};

// The config DTO, its `for_models_fetch` derivation and the credential
// hydration moved to `super::config`, which is also where the split's
// compatibility surface is kept: `client`, `url_policy`, `model_list`, the
// provider modules and the integration tests import these names from here
// exactly as before, and no consumer file had to be edited. The direction of
// USE is `request` → `config`, never the reverse.
pub use super::config::{hydrate_stored_key, models_url_override, AIConfig};

/// Check one completion's raw inputs against [`MAX_PROMPT_BYTES`],
/// [`MAX_IMAGES_PER_REQUEST`] and [`MAX_IMAGE_DATA_URL_BYTES`].
///
/// Called at the IPC boundary (`ai_complete`) before anything is claimed or
/// sent, so an impossible request costs nothing and the user gets a specific
/// error instead of a provider-side rejection (or a 413) much later. The
/// provider-agnostic request builder is covered separately by
/// [`encode_request_body`], which bounds the assembled body whatever it holds.
pub fn validate_request_inputs(prompt: &str, images: &[serde_json::Value]) -> Result<(), String> {
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(format!(
            "提示词过长（{} 字节，上限 {} 字节）。请缩小选区或减少附加上下文后重试。",
            prompt.len(),
            MAX_PROMPT_BYTES
        ));
    }
    if images.len() > MAX_IMAGES_PER_REQUEST {
        return Err(format!(
            "一次请求最多发送 {} 张图片（本次 {} 张）。",
            MAX_IMAGES_PER_REQUEST,
            images.len()
        ));
    }
    for (index, image) in images.iter().enumerate() {
        let size = serialized_len(image);
        if size > MAX_IMAGE_DATA_URL_BYTES {
            return Err(format!(
                "第 {} 张图片过大（{} 字节，上限 {} 字节）。请压缩后再发送。",
                index + 1,
                size,
                MAX_IMAGE_DATA_URL_BYTES
            ));
        }
    }
    Ok(())
}

/// The size of a value as it will go on the wire. An image arrives as a `data:`
/// URL string; anything else is measured after serialising, so the number is
/// the JSON the request will actually carry rather than an approximation.
fn serialized_len(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::String(s) => s.len(),
        other => other.to_string().len(),
    }
}

/// Serialise a request body under [`MAX_REQUEST_BODY_BYTES`].
///
/// Serialising here, rather than letting `RequestBuilder::json` do it, is what
/// makes the ceiling enforceable: the bytes that will go on the wire are
/// measured before a connection is opened, and the very same bytes are then
/// handed to the request — nothing is serialised twice, and nothing can be
/// added between the measurement and the send.
pub fn encode_request_body(body: &serde_json::Value) -> Result<Vec<u8>, String> {
    let payload = serde_json::to_vec(body).map_err(|e| format!("AI 请求体序列化失败：{e}"))?;
    if payload.len() > MAX_REQUEST_BODY_BYTES {
        return Err(format!(
            "AI 请求体过大（{} 字节，上限 {} 字节）。请减少图片或缩短上下文后重试。",
            payload.len(),
            MAX_REQUEST_BODY_BYTES
        ));
    }
    Ok(payload)
}

/// The system prompt to send, normalised so blanks become `None`.
pub(crate) fn system_prompt_of(cfg: &AIConfig) -> Option<String> {
    cfg.system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The thinking-depth ladder every provider understands, lowest first. The
/// server accepts this exact lowercase set and 400s on anything else, so
/// normalisation may only ever return one of these six words or `None`.
const REASONING_EFFORT_LADDER: [&str; 6] = ["none", "minimal", "low", "medium", "high", "xhigh"];

/// Normalise the user's thinking-depth choice to its wire spelling: trimmed,
/// lowercased, then matched against [`REASONING_EFFORT_LADDER`]. A blank or
/// unknown value — or no choice at all — returns `None`, meaning "do not send
/// the field", never a guessed rung: an invalid value is a hard 400 from the
/// server, so dropping it is the only safe degradation.
pub fn normalize_reasoning_effort(raw: Option<&str>) -> Option<&'static str> {
    let value = raw?.trim().to_lowercase();
    REASONING_EFFORT_LADDER
        .into_iter()
        .find(|level| *level == value.as_str())
}

/// Default API base for a provider that speaks the OpenAI wire format, used
/// when the caller supplies no explicit Base URL.
///
/// Without this the `_` arm of `endpoint_default` sent every such provider to
/// api.openai.com: a Grok or DeepSeek request would reach OpenAI's host and be
/// rejected there (with the user's key handed to the wrong origin).
///
/// Only a provider whose own host this crate knows has an arm. `local`,
/// `custom` and an unknown id get `None` — not api.openai.com, which is what
/// "absent from the match" used to mean — because there is no host to guess:
/// a local model server's address is the user's to name, and an id this crate
/// has never heard of is not a licence to pick one. [`resolve_base_url`] turns
/// that `None` into a refusal. (Anthropic and Gemini carry their own default
/// inside their own request builders; they do not speak this wire format and
/// are not reachable from here.)
pub fn default_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com/v1"),
        "grok" => Some("https://api.x.ai/v1"),
        "deepseek" => Some("https://api.deepseek.com/v1"),
        _ => None,
    }
}

/// The Base URL a request will actually be dialled at: the one the user
/// configured, otherwise the provider's own default. `Err` when neither
/// exists.
///
/// The refusal is the whole point of this function. A request with no address
/// of its own was sent to api.openai.com by the `_` arm, and the SSRF policy
/// could not catch it: `validate_base_url` returns early when `base_url` is
/// `None`, so a DERIVED endpoint never passes the check that exists to stop a
/// request reaching a host the user did not name. `local` is the app's default
/// provider and a local server has no default address, so that path sent the
/// note text and the stored credential to a vendor the user had not chosen.
///
/// What is NOT done here: inventing `http://localhost:1234/v1` for `local`.
/// The frontend seeds that address into a fresh install's settings field,
/// which is a decision made where the user can see and change it; guessing it
/// here would put the request on a host nobody confirmed.
pub fn resolve_base_url(cfg: &AIConfig) -> Result<String, String> {
    if let Some(base) = cfg.base_url.as_deref() {
        return Ok(base.to_string());
    }
    default_base_url(&cfg.provider).map(str::to_string).ok_or_else(|| {
        format!(
            "未填写接口地址（Base URL）：服务商“{}”没有自带的默认地址，无法确定请求该发往哪台服务器。\
             请在“设置 → AI”中填写该服务商的接口地址后重试。",
            cfg.provider
        )
    })
}

/// Split a data URL (`data:<mime>[;base64],<data>`) into its media type and
/// payload. Anthropic/Gemini require the mime and base64 separately, while the
/// OpenAI-compatible path sends the whole data URL verbatim as `image_url.url`.
/// A malformed value falls back to `image/png` so the request body stays valid.
pub(crate) fn split_data_url(data_url: &str) -> (String, String) {
    let s = data_url.strip_prefix("data:").unwrap_or(data_url);
    let (meta, data) = match s.split_once(',') {
        Some((m, d)) => (m, d),
        None => ("", s),
    };
    let mime = meta.split(';').next().unwrap_or("").trim();
    let mime = if mime.is_empty() {
        "image/png".to_string()
    } else {
        mime.to_string()
    };
    (mime, data.to_string())
}

/// The credential headers a model-list request carries.
///
/// The conventions of [`with_completion_auth`], kept in one place so an
/// explicit models URL gets the provider's own authentication instead of a
/// guessed one: the key rides in the header each provider actually
/// authenticates with — `x-api-key` + `anthropic-version`, `x-goog-api-key`,
/// `Authorization: Bearer` — never in the URL, where a proxy or a server log
/// would capture it.
fn models_headers(config: &AIConfig) -> Vec<(String, String)> {
    match config.provider.as_str() {
        "anthropic" => {
            let mut headers = vec![("anthropic-version".to_string(), "2023-06-01".to_string())];
            if let Some(key) = &config.api_key {
                headers.push(("x-api-key".to_string(), key.clone()));
            }
            headers
        }
        "gemini" => config
            .api_key
            .as_ref()
            .map(|key| vec![("x-goog-api-key".to_string(), key.clone())])
            .unwrap_or_default(),
        _ => config
            .api_key
            .as_ref()
            .map(|key| vec![("Authorization".to_string(), format!("Bearer {key}"))])
            .unwrap_or_default(),
    }
}

/// Resolve the provider's `GET {endpoint}` for listing models, matching the
/// base/credential conventions of `resolve_endpoint` so the dropdown pulls from
/// the same origin a completion would use.
///
/// An explicit [`AIConfig::models_url`] replaces the whole endpoint — nothing
/// is appended to it. That is the point of the override: it exists for the
/// provider whose `/v1/models` is somewhere else, and appending a guess to a
/// URL the user spelled out in full would recreate the failure it is there to
/// fix. An override is also an address the user DID name, so it needs no
/// default behind it and `local` can list its models with one and no Base URL.
///
/// Without an override the endpoint is DERIVED, and [`resolve_base_url`]
/// refuses when there is nothing to derive it from — the model list was the
/// second entry point that reached api.openai.com for `local`.
///
/// Returned rather than sent, so the caller keeps ownership of the transport
/// (the pinned client with its per-phase timeouts, see `client::list_models`):
/// the injection rule the roadmap sets for a split - build nothing inside the
/// module that cannot be handed in from outside.
pub fn models_endpoint(config: &AIConfig) -> Result<(String, Vec<(String, String)>), String> {
    if let Some(url) = models_url_override(config) {
        return Ok((url.to_string(), models_headers(config)));
    }
    let url = match config.provider.as_str() {
        "anthropic" => {
            let base = config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.anthropic.com".into());
            format!("{}/v1/models", base.trim_end_matches('/'))
        }
        "gemini" => {
            let base = config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://generativelanguage.googleapis.com".into());
            format!("{}/v1beta/models", base.trim_end_matches('/'))
        }
        _ => {
            let base = resolve_base_url(config)?;
            format!("{}/models", base.trim_end_matches('/'))
        }
    };
    Ok((url, models_headers(config)))
}

/// Attach the credential header the configured provider expects to a completion
/// request.
///
/// The key must ride in the header each provider actually authenticates with -
/// never in the URL, where a proxy or a server log would capture it:
///
/// * Anthropic: `x-api-key`, plus the required `anthropic-version`;
/// * Gemini: `x-goog-api-key` (Gemini rejects `Authorization: Bearer`, and the
///   key was removed from the URL for this reason);
/// * everything else (OpenAI-compatible): `Authorization: Bearer`.
///
/// The request is taken and handed back rather than mutated through a `&mut`
/// borrow, so the caller keeps ownership of the body bytes it already measured
/// (see [`encode_request_body`]).
pub fn with_completion_auth(
    mut request: reqwest::RequestBuilder,
    config: &AIConfig,
) -> reqwest::RequestBuilder {
    match config.provider.as_str() {
        "anthropic" => {
            if let Some(key) = &config.api_key {
                request = request.header("x-api-key", key);
            }
            request = request.header("anthropic-version", "2023-06-01");
        }
        "gemini" => {
            // Gemini keys ride in the `x-goog-api-key` header, NOT in the URL
            // (removed from `resolve_endpoint`) and NOT `Authorization: Bearer`
            // (Gemini rejects Bearer auth). Keeping it in a header stops the
            // secret from being logged by proxies/servers.
            if let Some(key) = &config.api_key {
                request = request.header("x-goog-api-key", key);
            }
        }
        _ => {
            if let Some(key) = &config.api_key {
                request = request.header("Authorization", format!("Bearer {key}"));
            }
        }
    }
    request
}
