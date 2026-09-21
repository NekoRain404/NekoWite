//! The fixtures the behaviour files share: the endpoint a config resolves to and the
//! tuned config the request-shape cases are built from.
//!
//! They are here rather than in one domain file because an endpoint assertion and a body
//! assertion are two readings of one `resolve_endpoint` call, and a second copy would
//! let the two files drift.

use nekowite_lib::providers::ai::client::{resolve_endpoint, AIConfig};

// `prompt_continues_cursor` used to live here, asserting that `build_prompt`
// carried the prefix and ended in a newline. `build_prompt` had no caller —
// the frontend builds the prompt (see `providers/ai/request.rs`'s header) — so
// both the function and its only test are gone. The instruction the model
// actually receives is pinned in `features/ai/index.test.ts`.

/// The endpoint of a provider that HAS one. These tests are about the body and
/// the path a provider produces, so every config here names a provider with a
/// host of its own; the refusal for the ones that do not is the subject of
/// `ai_base_url_test.rs`, and it is not reachable from here by construction.
pub fn endpoint(
    cfg: &AIConfig,
    prompt: &str,
    images: &[serde_json::Value],
) -> (String, serde_json::Value) {
    resolve_endpoint(cfg, prompt, images).expect("a provider with an address")
}

pub fn tuned_cfg(provider: &str) -> AIConfig {
    AIConfig {
        provider: provider.into(),
        model: "m".into(),
        base_url: None,
        api_key: None,
        temperature: Some(0.7),
        max_tokens: Some(512),
        system_prompt: Some("You are a helpful editor assistant.".into()),
        ..Default::default()
    }
}

pub fn base_cfg(base: &str, allow_private: bool) -> AIConfig {
    AIConfig {
        provider: "openai".into(),
        model: "m".into(),
        base_url: Some(base.into()),
        api_key: Some("SECRET-SESSION-KEY".into()),
        allow_private,
        ..Default::default()
    }
}
