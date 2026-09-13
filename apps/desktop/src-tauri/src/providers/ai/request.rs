//! Request-side construction: the completion configuration, the shared
//! body/URL helpers every provider builds from, and the input ceilings that are
//! checked before anything is sent.
//!
//! Dependencies: [`super::limits`] for the ceilings, `serde` for the config DTO
//! and [`crate::storage::key_store`] for credential hydration. Nothing here
//! builds a transport or parses a response, so this module never imports
//! `client`, `response`, `sse` or `url_policy`; the arrow points one way only
//! (`client`/`url_policy`/the provider modules depend on this file).

use serde::Deserialize;

use super::limits::{
    MAX_IMAGES_PER_REQUEST, MAX_IMAGE_DATA_URL_BYTES, MAX_PROMPT_BYTES, MAX_REQUEST_BODY_BYTES,
};
use crate::storage::key_store::{load_ai_key_internal, AI_KEY_MASKED};

#[derive(Deserialize, Clone, Default)]
pub struct AIConfig {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    /// Sampling temperature (0.0–2.0). `None` omits the field, letting the
    /// provider use its own default.
    pub temperature: Option<f32>,
    /// Completion token cap. `None` falls back to the legacy hardcoded 256.
    pub max_tokens: Option<u32>,
    /// Optional system prompt. `None`/empty adds no system message.
    pub system_prompt: Option<String>,
    /// The user's thinking-depth choice: one of the lowercase rungs
    /// `none|minimal|low|medium|high|xhigh`, case- and padding-insensitive.
    /// Normalised by [`normalize_reasoning_effort`] before a provider ever sees
    /// it. A value outside that ladder is dropped rather than forwarded: the
    /// server answers an invalid rung with HTTP 400 (measured against
    /// tokenflux's `deepseek-flash`: "ultra", "bogus-level" and even the
    /// uppercase "HIGH" were all rejected), so an unrecognised value must
    /// degrade to "send nothing" instead of failing the whole request.
    pub reasoning_effort: Option<String>,
    /// Opt-in to allow private/loopback Base URLs (e.g. Ollama / LM Studio).
    /// Default `false`: a Base URL whose host is a literal private, loopback,
    /// link-local, CGNAT or unspecified IP (or `localhost`) is rejected. The
    /// frontend must send this to reach a local model endpoint.
    #[serde(default)]
    pub allow_private: bool,
}

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
/// rejected there (with the user's key handed to the wrong origin). `local` is
/// intentionally absent — a local model server always needs an explicit URL,
/// and guessing one would be worse than surfacing the missing setting.
pub fn default_base_url(provider: &str) -> &'static str {
    match provider {
        "grok" => "https://api.x.ai/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        _ => "https://api.openai.com/v1",
    }
}

pub fn build_prompt(cursor_prefix: &str) -> String {
    format!(
        "Continue writing the following text. Only output the continuation, no preamble.\n\n{}\n",
        cursor_prefix.trim_end()
    )
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

/// Resolve the provider's `GET {endpoint}` for listing models, matching the
/// base/credential conventions of `resolve_endpoint` so the dropdown pulls from
/// the same origin a completion would use.
///
/// Returned rather than sent, so the caller keeps ownership of the transport
/// (the pinned client with its per-phase timeouts, see `client::list_models`):
/// the injection rule the roadmap sets for a split - build nothing inside the
/// module that cannot be handed in from outside.
pub fn models_endpoint(config: &AIConfig) -> (String, Vec<(String, String)>) {
    match config.provider.as_str() {
        "anthropic" => {
            let base = config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.anthropic.com".into());
            let url = format!("{}/v1/models", base.trim_end_matches('/'));
            let mut headers = vec![("anthropic-version".to_string(), "2023-06-01".to_string())];
            if let Some(key) = &config.api_key {
                headers.push(("x-api-key".to_string(), key.clone()));
            }
            (url, headers)
        }
        "gemini" => {
            let base = config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://generativelanguage.googleapis.com".into());
            // Keep the key out of the URL; it rides in the `x-goog-api-key`
            // header instead so it is never logged by a proxy/server.
            let url = format!("{}/v1beta/models", base.trim_end_matches('/'));
            let headers = if let Some(key) = &config.api_key {
                vec![("x-goog-api-key".to_string(), key.clone())]
            } else {
                Vec::new()
            };
            (url, headers)
        }
        _ => {
            let base = config
                .base_url
                .clone()
                .unwrap_or_else(|| default_base_url(&config.provider).to_string());
            let url = format!("{}/models", base.trim_end_matches('/'));
            let headers = if let Some(key) = &config.api_key {
                vec![("Authorization".to_string(), format!("Bearer {key}"))]
            } else {
                Vec::new()
            };
            (url, headers)
        }
    }
}

/// Resolve the API key for an AI request. The key is never disclosed to the
/// window (see `keys::load_ai_key`, which returns only a masked indicator), so
/// the backend injects the *stored* key for the provider here when the caller
/// did not supply a real one. A real key supplied by the app's own settings
/// page (a freshly typed, not-yet-saved key) is kept as-is; only a missing or
/// masked value is backfilled from the vault.
pub fn hydrate_stored_key(app: &tauri::AppHandle, config: &mut AIConfig) -> Result<(), String> {
    if let Some(k) = config.api_key.as_deref() {
        if k != AI_KEY_MASKED {
            return Ok(());
        }
    }
    if let Some(stored) = load_ai_key_internal(app, &config.provider)? {
        config.api_key = Some(stored);
    }
    Ok(())
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
