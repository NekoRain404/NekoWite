//! Where a request goes: the address a provider resolves to, the per-provider
//! default behind it, and the key that must never ride in the URL. The body those calls
//! return is the subject of `request_body`.

use nekowite_lib::providers::ai::client::{default_base_url, AIConfig};

use super::support::endpoint;

#[test]
fn endpoint_maps_openai() {
    let cfg = AIConfig {
        provider: "openai".into(),
        model: "gpt-5-mini".into(),
        base_url: Some("https://api.openai.com/v1".into()),
        api_key: Some("k".into()),
        ..Default::default()
    };
    let (url, body) = endpoint(&cfg, "hello", &[]);
    assert!(url.ends_with("/chat/completions"));
    assert_eq!(body["stream"], true);
    assert!(
        body["messages"][0]["content"].is_string(),
        "no images keeps string content"
    );
}

#[test]
fn endpoint_maps_anthropic() {
    let cfg = AIConfig {
        provider: "anthropic".into(),
        model: "claude-sonnet-4-5".into(),
        base_url: None,
        api_key: None,
        ..Default::default()
    };
    let (url, body) = endpoint(&cfg, "hello", &[]);
    assert!(url.ends_with("/v1/messages"));
    assert_eq!(body["stream"], true);
    assert!(
        body["messages"][0]["content"].is_string(),
        "no images keeps string content"
    );
}

#[test]
fn endpoint_maps_gemini() {
    let cfg = AIConfig {
        provider: "gemini".into(),
        model: "gemini-2.5-pro".into(),
        base_url: None,
        api_key: None,
        ..Default::default()
    };
    let (url, body) = endpoint(&cfg, "hello", &[]);
    assert!(url.contains(":streamGenerateContent"));
    assert!(url.contains("alt=sse"));
    assert_eq!(body["contents"][0]["parts"][0]["text"], "hello");
    assert_eq!(body["contents"][0]["parts"].as_array().unwrap().len(), 1);
}

#[test]
fn endpoint_does_not_embed_gemini_key_in_url() {
    let cfg = AIConfig {
        provider: "gemini".into(),
        model: "gemini-2.5-pro".into(),
        base_url: None,
        api_key: Some("sk-gem-key".into()),
        ..Default::default()
    };
    let (url, _body) = endpoint(&cfg, "hello", &[]);
    assert!(
        !url.contains("sk-gem-key") && !url.contains("key="),
        "gemini key must NOT ride in the URL query (it goes in the x-goog-api-key header), got: {url}"
    );
}

#[test]
fn default_base_url_is_per_provider() {
    // Without a per-provider default, every OpenAI-compatible provider without
    // an explicit Base URL was sent to api.openai.com — the wrong host, holding
    // the user's key for a different vendor.
    assert_eq!(default_base_url("grok"), Some("https://api.x.ai/v1"));
    assert_eq!(
        default_base_url("deepseek"),
        Some("https://api.deepseek.com/v1")
    );
    assert_eq!(
        default_base_url("openai"),
        Some("https://api.openai.com/v1")
    );
    // A provider whose host this crate does not know has no default at all —
    // the fallback to api.openai.com it used to get sent the note text and the
    // key to a host the user never named (see `ai_base_url_test.rs`).
    assert_eq!(default_base_url("local"), None);
    assert_eq!(default_base_url("whatever"), None);
}

#[test]
fn deepseek_and_grok_use_their_own_host_when_no_base_url_is_set() {
    for (provider, expected) in [
        ("deepseek", "https://api.deepseek.com/v1/chat/completions"),
        ("grok", "https://api.x.ai/v1/chat/completions"),
    ] {
        let cfg = AIConfig {
            provider: provider.into(),
            model: "m".into(),
            ..Default::default()
        };
        let (url, _) = endpoint(&cfg, "hi", &[]);
        assert_eq!(url, expected, "{provider} endpoint");
    }
}

#[test]
fn an_explicit_base_url_still_wins() {
    let cfg = AIConfig {
        provider: "deepseek".into(),
        model: "deepseek-flash".into(),
        base_url: Some("https://tokenflux.dev/v1".into()),
        ..Default::default()
    };
    let (url, body) = endpoint(&cfg, "hi", &[]);
    assert_eq!(url, "https://tokenflux.dev/v1/chat/completions");
    assert_eq!(body["model"], "deepseek-flash");
    assert_eq!(body["stream"], true);
}
