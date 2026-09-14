//! The completion configuration: the DTO the frontend sends over IPC, the
//! credential hydration that decides which key an AI request runs under, and
//! the derivation that decides which address the model list is judged against.
//!
//! Dependencies: `serde` for the DTO and [`crate::storage::key_store`] for the
//! credential. Nothing here builds a URL, a body or a request -
//! [`super::request`] reads this config for that - so the arrow points one way
//! only: `request` and everything above it depend on this file, never the
//! reverse.

use serde::Deserialize;

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
    /// Normalised by
    /// [`normalize_reasoning_effort`](super::request::normalize_reasoning_effort)
    /// before a provider ever sees it. A value outside that ladder is dropped
    /// rather than forwarded: the server answers an invalid rung with HTTP 400
    /// (measured against tokenflux's `deepseek-flash`: "ultra", "bogus-level"
    /// and even the uppercase "HIGH" were all rejected), so an unrecognised
    /// value must degrade to "send nothing" instead of failing the whole
    /// request.
    pub reasoning_effort: Option<String>,
    /// Opt-in to allow private/loopback Base URLs (e.g. Ollama / LM Studio).
    /// Default `false`: a Base URL whose host is a literal private, loopback,
    /// link-local, CGNAT or unspecified IP (or `localhost`) is rejected. The
    /// frontend must send this to reach a local model endpoint.
    #[serde(default)]
    pub allow_private: bool,
    /// The address the model list comes from, when the user names one.
    ///
    /// The list is otherwise DERIVED from the Base URL (`{base}/v1/models` for
    /// Anthropic, `{base}/models` for everything else), which is a guess about
    /// a provider's layout. A provider whose layout differs cannot be reached
    /// by guessing harder, and one that answers unknown paths with a 200 HTML
    /// page cannot even be told apart from a broken response — this override is
    /// the way out: the complete endpoint, used verbatim, nothing appended.
    /// Blank means unset, so clearing the field restores the derived path.
    ///
    /// It is vetted by the same URL policy as `base_url` (see
    /// [`for_models_fetch`](AIConfig::for_models_fetch)): a second address,
    /// never a second set of rules.
    pub models_url: Option<String>,
}

impl AIConfig {
    /// A copy of this config whose `base_url` is the address `GET /models` will
    /// actually be sent to.
    ///
    /// The URL policy judges one address per request, and on the model-list
    /// path that address is the `models_url` override whenever there is one —
    /// so the override is what `validate_base_url` has to see. Substituting it
    /// here is what keeps the override INSIDE that policy rather than beside
    /// it: it is a second address, never a second set of rules, and the Base
    /// URL still governs the completion path unchanged.
    pub fn for_models_fetch(&self) -> AIConfig {
        match models_url_override(self) {
            Some(url) => AIConfig {
                base_url: Some(url.to_string()),
                ..self.clone()
            },
            None => self.clone(),
        }
    }
}

/// The endpoint the user named for the model list, when they named one.
///
/// Blank is treated as unset so clearing the settings field restores the
/// derived path instead of asking for an empty URL.
pub fn models_url_override(config: &AIConfig) -> Option<&str> {
    config
        .models_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
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
