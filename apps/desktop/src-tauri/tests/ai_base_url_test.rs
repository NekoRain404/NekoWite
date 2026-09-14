//! Which host a request is dialled at when the user configured no Base URL.
//!
//! `local` is the app's default provider, its Base URL field is empty on an
//! install whose settings were cleared, and the request used to be sent to
//! `https://api.openai.com/v1` — the note text and the stored credential to a
//! host the user never named, with OpenAI's 401 read as "my key is invalid".
//! The SSRF policy could not catch it: `validate_base_url` returns early when
//! `base_url` is `None`, so a DERIVED endpoint never passes a check at all.
//!
//! What these tests pin is that the missing setting SURFACES instead: a
//! provider whose own host this crate knows keeps a default, and one it does
//! not (a local model server, a custom gateway, an id it has never heard of) is
//! refused with a message naming the field to fill in. Both entry points are
//! covered, because both derived the endpoint this way.

use nekowite_lib::providers::ai::client::{list_models, resolve_endpoint, AIConfig};
use nekowite_lib::providers::ai::request::{default_base_url, models_endpoint};

fn cfg(provider: &str, base_url: Option<&str>) -> AIConfig {
    AIConfig {
        provider: provider.into(),
        model: "m".into(),
        base_url: base_url.map(str::to_string),
        ..Default::default()
    }
}

/// Both entry points of one config, as the refusal (or the URL) they produce.
fn completion(cfg: &AIConfig) -> Result<String, String> {
    resolve_endpoint(cfg, "写一段话", &[]).map(|(url, _body)| url)
}

fn models(cfg: &AIConfig) -> Result<String, String> {
    models_endpoint(cfg).map(|(url, _headers)| url)
}

/// The hosts this crate knows, and the ones it refuses to invent.
#[test]
fn only_a_provider_with_its_own_host_has_a_default_base_url() {
    for (provider, host) in [
        ("openai", "https://api.openai.com/v1"),
        ("grok", "https://api.x.ai/v1"),
        ("deepseek", "https://api.deepseek.com/v1"),
    ] {
        assert_eq!(default_base_url(provider), Some(host), "{provider}");
    }
    // `local` was the one the doc comment called "intentionally absent" while
    // the `_` arm handed it api.openai.com.
    for provider in ["local", "custom", "something-new"] {
        assert_eq!(
            default_base_url(provider),
            None,
            "a host may not be guessed for {provider}"
        );
    }
}

/// The refusal has to name the setting the user must fill in — that is the
/// whole point of refusing instead of guessing — and it must never be a host
/// they did not name.
fn assert_refusal_naming_the_setting(provider: &str, err: &str) {
    assert!(
        err.contains("Base URL"),
        "{provider}: the refusal must name the setting: {err}"
    );
    assert!(
        err.contains(provider),
        "{provider}: the refusal must name the provider: {err}"
    );
    assert!(
        !err.contains("api.openai.com") && !err.contains("http"),
        "{provider}: no host may appear in the refusal: {err}"
    );
}

#[test]
fn a_local_provider_without_a_base_url_is_refused_by_both_entry_points() {
    let cfg = cfg("local", None);

    let from_completion = completion(&cfg).expect_err("local has no host of its own");
    let from_models = models(&cfg).expect_err("local has no host of its own");

    assert_refusal_naming_the_setting("local", &from_completion);
    assert_refusal_naming_the_setting("local", &from_models);
}

#[test]
fn a_custom_provider_without_a_base_url_is_refused_by_both_entry_points() {
    let cfg = cfg("custom", None);

    let from_completion = completion(&cfg).expect_err("custom has no host of its own");
    let from_models = models(&cfg).expect_err("custom has no host of its own");

    assert_refusal_naming_the_setting("custom", &from_completion);
    assert_refusal_naming_the_setting("custom", &from_models);
}

/// An id this crate does not know is not a licence to pick a host for it.
#[test]
fn an_unknown_provider_without_a_base_url_is_refused_by_both_entry_points() {
    let cfg = cfg("acme-gateway", None);

    let from_completion = completion(&cfg).expect_err("an unknown provider has no host");
    let from_models = models(&cfg).expect_err("an unknown provider has no host");

    assert_refusal_naming_the_setting("acme-gateway", &from_completion);
    assert_refusal_naming_the_setting("acme-gateway", &from_models);
}

/// The refusal is what the model-list command returns to the window: it must
/// come out of `list_models` unchanged, before any connection is opened.
#[tokio::test]
async fn the_model_list_entry_point_refuses_instead_of_dialling_a_guessed_host() {
    let err = list_models(&cfg("local", None))
        .await
        .expect_err("a model list must not be fetched from a host nobody named");

    assert_refusal_naming_the_setting("local", &err);
}

/// The provider the `_` arm actually served keeps working: `openai` has no arm
/// of its own before this change and was served by the fallback.
#[test]
fn openai_without_a_base_url_keeps_its_own_host() {
    let cfg = cfg("openai", None);

    assert_eq!(
        completion(&cfg).expect("openai has a host of its own"),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        models(&cfg).expect("openai has a host of its own"),
        "https://api.openai.com/v1/models"
    );
}

#[test]
fn grok_and_deepseek_without_a_base_url_keep_their_own_hosts() {
    for (provider, host) in [
        ("grok", "https://api.x.ai/v1"),
        ("deepseek", "https://api.deepseek.com/v1"),
    ] {
        let cfg = cfg(provider, None);
        assert_eq!(
            completion(&cfg).expect("a known host"),
            format!("{host}/chat/completions"),
            "{provider} completion"
        );
        assert_eq!(
            models(&cfg).expect("a known host"),
            format!("{host}/models"),
            "{provider} model list"
        );
    }
}

/// An explicit Base URL is the address, for every provider id — including the
/// ones with no default, which need no refusal once the user has named a host.
#[test]
fn an_explicit_base_url_is_used_and_no_default_is_consulted() {
    for provider in ["local", "custom", "openai", "grok", "unknown-id"] {
        let cfg = cfg(provider, Some("https://gateway.example.com/v1"));

        assert_eq!(
            completion(&cfg).expect("the user named a host"),
            "https://gateway.example.com/v1/chat/completions",
            "{provider} completion"
        );
        assert_eq!(
            models(&cfg).expect("the user named a host"),
            "https://gateway.example.com/v1/models",
            "{provider} model list"
        );
    }
}

/// The models-URL override IS an address the user named, so it stands on its
/// own: `local` can list its models with one and no Base URL, and nothing is
/// appended to it.
#[test]
fn a_models_url_override_needs_no_base_url_behind_it() {
    let cfg = AIConfig {
        models_url: Some("https://gateway.example.com/custom/models".into()),
        ..cfg("local", None)
    };

    assert_eq!(
        models(&cfg).expect("the override is the endpoint"),
        "https://gateway.example.com/custom/models"
    );
    // The completion has no address at all and still refuses.
    completion(&cfg).expect_err("an override is not a completion address");
}

/// Adding the refusal must not have reached the providers that carry their own
/// default: Anthropic and Gemini do not go through the OpenAI-compatible table.
#[test]
fn anthropic_and_gemini_keep_their_own_defaults() {
    assert_eq!(
        completion(&cfg("anthropic", None)).expect("anthropic has a default"),
        "https://api.anthropic.com/v1/messages"
    );
    assert_eq!(
        models(&cfg("anthropic", None)).expect("anthropic has a default"),
        "https://api.anthropic.com/v1/models"
    );
    assert!(completion(&cfg("gemini", None))
        .expect("gemini has a default")
        .starts_with("https://generativelanguage.googleapis.com/"));
    assert_eq!(
        models(&cfg("gemini", None)).expect("gemini has a default"),
        "https://generativelanguage.googleapis.com/v1beta/models"
    );
}
