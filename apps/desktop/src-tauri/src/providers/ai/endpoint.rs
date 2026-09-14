//! Which address a completion is sent to, and with which body: the provider
//! dispatch that turns a configured request into the `(url, body)` pair the
//! client posts.
//!
//! Extracted from [`super::client`] as one vertical slice - the addressing half
//! of a request - so `client` keeps the request lifecycle that sends it. The
//! split's compatibility re-exports in `client` mean `commands/ai.rs` and the
//! integration tests still import [`resolve_endpoint`] from where they always
//! did.
//!
//! Provider-specific request construction lives in [`super::gemini`] and
//! [`super::openai_compatible`], which this module dispatches to by provider
//! name.
//!
//! Dependencies: [`super::request`] for the configuration being addressed, and
//! the two provider modules. Nothing here imports `client`, so the graph keeps
//! its one-way direction.

use super::request::AIConfig;
use super::{gemini, openai_compatible};

/// Resolve a completion's request endpoint + body for the configured provider.
/// Provider-specific construction is delegated to [`super::gemini`] and
/// [`super::openai_compatible`].
///
/// `Err` when the provider has neither a Base URL nor a host of its own (see
/// [`super::request::resolve_base_url`]): the caller reports it instead of
/// sending anything.
pub fn resolve_endpoint(
    cfg: &AIConfig,
    prompt: &str,
    images: &[serde_json::Value],
) -> Result<(String, serde_json::Value), String> {
    match cfg.provider.as_str() {
        "anthropic" => Ok(openai_compatible::endpoint_anthropic(cfg, prompt, images)),
        "gemini" => Ok(gemini::endpoint(cfg, prompt, images)),
        _ => openai_compatible::endpoint_default(cfg, prompt, images),
    }
}
