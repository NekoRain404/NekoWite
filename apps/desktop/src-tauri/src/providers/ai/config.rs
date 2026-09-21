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

use crate::storage::key_store::{load_ai_key_endpoint, load_ai_key_internal, AI_KEY_MASKED};

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

/// Whether a caller-supplied `api_key` is a credential at all.
///
/// The window sends [`AI_KEY_MASKED`] — the placeholder that says "a key is
/// configured" — when it is not handing the key itself over, and a blank value
/// when the field is empty. Neither is a credential, and treating either as one
/// puts a non-key in the provider's auth header (`request::with_completion_auth`)
/// while the vault's real key stays behind.
///
/// The test is deliberately not `== AI_KEY_MASKED`: the literal only matches the
/// mask spelled exactly as this crate writes it, so the same placeholder padded,
/// wrapped or spaced out read as a real key and was sent as a bearer token. What
/// the value SAYS is what counts — trim everything the mask itself is made of,
/// and whitespace, and every spelling of the placeholder has nothing left. A
/// real key is ASCII, so the mask's characters are never part of one, let alone
/// all of one; the empty string is the same statement at its extreme.
fn is_real_api_key(value: &str) -> bool {
    !value
        .trim_matches(|c: char| c.is_whitespace() || AI_KEY_MASKED.contains(c))
        .is_empty()
}

/// Whether the credential the vault holds for this provider may be attached to *this* request.
///
/// **The rule, and the hole it closes.** The endpoint in an AI request is chosen entirely by the
/// caller — `AIConfig.base_url` (and `models_url`) arrive over IPC — while the credential is looked up
/// by `provider` alone. So a window that asked for provider `openai` with
/// `base_url: "https://somewhere.else/v1"` and no key of its own got the user's stored OpenAI key
/// backfilled into it and sent to `somewhere.else` as `Authorization: Bearer …`
/// (`request::with_completion_auth`). The value never crossed IPC, which is what `keys.rs` means by
/// 「never exposed over IPC」, but it left through the socket — and this repository's own threat model
/// treats the main-window renderer as untrusted (`state/vault_confinement.rs`).
///
/// So a stored key belongs to the endpoint it was **saved for**, and `store_ai_key` records that
/// endpoint beside it. Three answers, and the asymmetry between the last two is deliberate:
///
///  * **An endpoint was recorded.** The request may name it (either field, ignoring a trailing
///    slash) and nothing else. A different endpoint is refused rather than sent without the key:
///    a request that quietly loses its credential fails later as a 401 from a host the user did not
///    choose, which is the diagnosis nobody can act on.
///  * **No endpoint was recorded, and the request names none.** A key saved by a build that did not
///    record one, used against the provider's own default endpoint — the ordinary case, and it keeps
///    working. This is the same concession `AiPermissionState.enabled` makes for a state written
///    before the field existed.
///  * **No endpoint was recorded, and the request names one.** Refused. A caller-chosen endpoint and
///    a key with no recorded home is exactly the shape of the exploit, and the honest migration is
///    one click: the user saves the key again, which records the endpoint they actually use.
pub fn credential_scope(config: &AIConfig, recorded: Option<&str>) -> Result<(), String> {
    let named: Vec<&str> = [config.base_url.as_deref(), config.models_url.as_deref()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|endpoint| !endpoint.is_empty())
        .collect();
    match recorded {
        Some(endpoint) => {
            if named.iter().any(|url| same_endpoint(url, endpoint)) {
                Ok(())
            } else {
                Err(format!(
                    "the stored key for {} was saved for {endpoint}, and this request names {}. \
                     Save the key again in 设置 → AI to move it to the address you are using.",
                    config.provider,
                    if named.is_empty() {
                        "no address (the provider's own default)".to_string()
                    } else {
                        named.join(", ")
                    }
                ))
            }
        }
        None if named.is_empty() => Ok(()),
        None => Err(format!(
            "the stored key for {} has no address recorded (it predates this check), and this \
             request names {}. Save the key again in 设置 → AI while that address is set, so the \
             credential is bound to it.",
            config.provider,
            named.join(", ")
        )),
    }
}

/// Whether two endpoint spellings are the same address.
///
/// Only a trailing slash is forgiven, and that is the whole of the normalisation on purpose: a
/// looser comparison (case, default ports, `www.`, a path prefix) is where a binding rule starts
/// accepting addresses that are not the one it recorded — which is the bug, not the fix.
fn same_endpoint(named: &str, recorded: &str) -> bool {
    named.trim_end_matches('/') == recorded.trim_end_matches('/')
}

/// Resolve the API key for an AI request: the decision, with the credential
/// store injected.
///
/// The key is never disclosed to the window (see `keys::load_ai_key`, which
/// returns only a masked indicator), so the backend injects the *stored* key
/// for the provider here when the caller did not supply a real one. A real key
/// supplied by the app's own settings page (a freshly typed, not-yet-saved key)
/// is kept as-is and the store is not read at all; only a missing or masked
/// value is backfilled from `load_stored`, which is asked for *this* config's
/// provider.
///
/// The store is a parameter rather than an `AppHandle` because this is the rule
/// that [`AI_KEY_MASKED`] is never what a request authenticates with, and a
/// rule nobody can execute is a rule nobody can check: with the store injected
/// the decision is a pure function a test can drive from any store it likes
/// (roadmap §13.10). [`hydrate_stored_key`] is the wrapper that supplies the
/// real vault; nothing below this line knows there is a vault at all.
///
/// **It does not decide *which* requests may be backfilled** — that is
/// [`credential_scope`], asked by the wrapper before this runs, because the
/// answer depends on a fact (the endpoint the key was saved for) that the vault
/// holds and this function deliberately cannot see.
pub fn hydrate_stored_key_with(
    config: &mut AIConfig,
    load_stored: impl Fn(&str) -> Result<Option<String>, String>,
) -> Result<(), String> {
    if let Some(k) = config.api_key.as_deref() {
        if is_real_api_key(k) {
            return Ok(());
        }
    }
    // Absent or masked, only the store may fill this in — and the placeholder is
    // dropped BEFORE the read, so no exit from here can leave it in the config.
    // What the config holds at the end is what the request authenticates with
    // (`request::with_completion_auth`, `request::models_headers`), so a mask
    // left behind is a mask sent to the provider; dropping it first also covers
    // the read failing, where the error propagates but a caller that ignored it
    // would otherwise still be holding the placeholder.
    config.api_key = None;
    if let Some(stored) = load_stored(&config.provider)? {
        config.api_key = Some(stored);
    }
    Ok(())
}

/// [`hydrate_stored_key_with`] against the real stronghold vault.
///
/// Vault access stays HERE, in the wrapper, and only here: the testable part
/// never sees an `AppHandle`, and `load_ai_key_internal` is still called on the
/// one path that has one.
pub fn hydrate_stored_key(app: &tauri::AppHandle, config: &mut AIConfig) -> Result<(), String> {
    // **Asked before the key is read, and only here.** `credential_scope` needs the endpoint the
    // credential was saved for, which lives in the vault beside the key — so the rule is stated in
    // the pure function above (where a test can drive it with any endpoint it likes) and the *fact*
    // is fetched here, on the one path that has an `AppHandle`. A request that fails this returns
    // before the key is loaded, so nothing is attached and nothing is sent.
    let recorded = load_ai_key_endpoint(app, &config.provider)?;
    credential_scope(config, recorded.as_deref())?;
    hydrate_stored_key_with(config, |provider| load_ai_key_internal(app, provider))
}
