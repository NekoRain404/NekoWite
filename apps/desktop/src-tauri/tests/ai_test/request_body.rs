//! What the request carries: the prompt and its images in each provider's own
//! shape, the system prompt, temperature and token cap, and the thinking budget
//! (`reasoning_effort`) each provider is handed.

use nekowite_lib::providers::ai::client::{
    ai_id_for, next_ai_id, normalize_reasoning_effort, AIConfig,
};

use super::support::{endpoint, tuned_cfg};

#[test]
fn ai_ids_distinct_in_same_instant() {
    // same micros, different sequence -> distinct ids (no collision)
    assert_ne!(
        ai_id_for(1_700_000_000_000_000, 1),
        ai_id_for(1_700_000_000_000_000, 2)
    );
}

#[test]
fn ai_ids_unique_across_calls() {
    assert_ne!(next_ai_id(), next_ai_id());
}

#[test]
fn endpoint_openai_images_build_array() {
    let cfg = AIConfig {
        provider: "openai".into(),
        model: "gpt-5-mini".into(),
        base_url: None,
        api_key: None,
        ..Default::default()
    };
    let images = vec![serde_json::json!("data:image/png;base64,AAA")];
    let (_url, body) = endpoint(&cfg, "look", &images);
    let content = &body["messages"][0]["content"];
    assert!(content.is_array(), "images must switch content to an array");
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[0]["text"], "look");
    assert_eq!(content[1]["type"], "image_url");
    assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAA");
}

#[test]
fn endpoint_openai_without_images_keeps_string() {
    let cfg = AIConfig {
        provider: "openai".into(),
        model: "gpt-5-mini".into(),
        base_url: None,
        api_key: None,
        ..Default::default()
    };
    let (_url, body) = endpoint(&cfg, "hello", &[]);
    assert!(
        body["messages"][0]["content"].is_string(),
        "empty images keeps string content"
    );
    assert_eq!(body["messages"][0]["content"], "hello");
}

#[test]
fn endpoint_anthropic_images_build_base64_source() {
    let cfg = AIConfig {
        provider: "anthropic".into(),
        model: "claude-sonnet-4-5".into(),
        base_url: None,
        api_key: None,
        ..Default::default()
    };
    let images = vec![serde_json::json!("data:image/png;base64,AAA")];
    let (_url, body) = endpoint(&cfg, "look", &images);
    let content = &body["messages"][0]["content"];
    assert!(content.is_array(), "images must switch content to an array");
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "image");
    assert_eq!(content[1]["source"]["type"], "base64");
    assert_eq!(content[1]["source"]["media_type"], "image/png");
    assert_eq!(content[1]["source"]["data"], "AAA");
}

#[test]
fn endpoint_gemini_images_build_inline_data() {
    let cfg = AIConfig {
        provider: "gemini".into(),
        model: "gemini-2.5-pro".into(),
        base_url: None,
        api_key: None,
        ..Default::default()
    };
    let images = vec![serde_json::json!("data:image/png;base64,AAA")];
    let (_url, body) = endpoint(&cfg, "look", &images);
    let parts = &body["contents"][0]["parts"];
    assert_eq!(parts[0]["text"], "look");
    assert_eq!(parts[1]["inline_data"]["mime_type"], "image/png");
    assert_eq!(parts[1]["inline_data"]["data"], "AAA");
}

#[test]
fn openai_body_puts_system_first_and_writes_tuning() {
    let (_url, body) = endpoint(&tuned_cfg("openai"), "hello", &[]);
    assert_eq!(
        body["temperature"],
        serde_json::json!(0.7_f32),
        "temperature as written by the f32 config"
    );
    assert_eq!(body["max_tokens"], 512);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(
        body["messages"][0]["content"],
        "You are a helpful editor assistant."
    );
    assert_eq!(body["messages"][1]["role"], "user");
    assert_eq!(
        body["messages"][2],
        serde_json::json!(null),
        "no third message"
    );
}

#[test]
fn openai_images_keep_message_after_system() {
    let cfg = tuned_cfg("openai");
    let images = vec![serde_json::json!("data:image/png;base64,AAA")];
    let (_url, body) = endpoint(&cfg, "look", &images);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][1]["role"], "user");
    assert!(
        body["messages"][1]["content"][1]["type"] == "image_url",
        "image block must ride the user message, not the system one"
    );
}

#[test]
fn anthropic_body_uses_top_level_system() {
    let (_url, body) = endpoint(&tuned_cfg("anthropic"), "hello", &[]);
    assert_eq!(body["temperature"], serde_json::json!(0.7_f32));
    assert_eq!(body["max_tokens"], 512);
    assert_eq!(body["system"], "You are a helpful editor assistant.");
    assert_eq!(body["messages"][0]["role"], "user");
}

#[test]
fn gemini_body_uses_system_instruction_and_generation_config() {
    let (_url, body) = endpoint(&tuned_cfg("gemini"), "hello", &[]);
    assert_eq!(
        body["systemInstruction"]["parts"][0]["text"],
        "You are a helpful editor assistant."
    );
    assert_eq!(
        body["generationConfig"]["temperature"],
        serde_json::json!(0.7_f32)
    );
    assert_eq!(body["generationConfig"]["maxOutputTokens"], 512);
    assert_eq!(body["contents"][0]["role"], "user");
}

#[test]
fn untuned_cfg_uses_the_raised_defaults() {
    let cfg = AIConfig {
        provider: "openai".into(),
        model: "m".into(),
        base_url: None,
        api_key: None,
        ..Default::default()
    };
    let (url, body) = endpoint(&cfg, "hello", &[]);
    assert!(url.ends_with("/chat/completions"));
    // Raised from 256: a reasoning model can spend the entire budget on its
    // thinking and return no answer at all (measured against deepseek-flash),
    // so the default has to leave room for the actual text.
    assert_eq!(body["max_tokens"], 1024, "default max_tokens is 1024");
    assert!(
        body.get("temperature").is_none(),
        "no temperature by default"
    );
    assert_eq!(
        body["messages"].as_array().unwrap().len(),
        1,
        "no system message by default"
    );
    assert_eq!(body["messages"][0]["role"], "user");
}

#[test]
fn blank_system_prompt_behaves_as_absent() {
    let cfg = AIConfig {
        provider: "openai".into(),
        model: "m".into(),
        base_url: None,
        api_key: None,
        system_prompt: Some("   ".into()),
        ..Default::default()
    };
    let (_url, body) = endpoint(&cfg, "hello", &[]);
    assert_eq!(
        body["messages"].as_array().unwrap().len(),
        1,
        "whitespace-only system prompt must be dropped"
    );
}

#[test]
fn a_tuned_config_still_wins_over_the_raised_default() {
    // The default rose from 256 to 1024 so a fresh install works with a
    // reasoning model (which can spend the whole budget thinking). An explicit
    // setting must still be honoured.
    let cfg = tuned_cfg("deepseek");
    let (_url, body) = endpoint(&cfg, "hi", &[]);
    assert_eq!(body["max_tokens"], 512);
}

// --- Thinking depth (`reasoning_effort`) ------------------------------------
//
// The server honours exactly the lowercase ladder `none|minimal|low|medium|
// high|xhigh` and rejects anything else with HTTP 400 (measured against
// tokenflux's `deepseek-flash`: "ultra", "bogus-level" and even the uppercase
// "HIGH" were all 400). Normalisation therefore happens once, at the config
// boundary, and every provider below pins the wire shape it produces.

#[test]
fn reasoning_effort_keeps_the_ladder_rungs() {
    for level in ["none", "minimal", "low", "medium", "high", "xhigh"] {
        assert_eq!(normalize_reasoning_effort(Some(level)), Some(level));
    }
}

#[test]
fn reasoning_effort_lowercases_and_trims_valid_values() {
    for level in ["none", "minimal", "low", "medium", "high", "xhigh"] {
        assert_eq!(
            normalize_reasoning_effort(Some(&level.to_uppercase())),
            Some(level),
            "uppercase {level} must normalise"
        );
        assert_eq!(
            normalize_reasoning_effort(Some(&format!("  {level}\t"))),
            Some(level),
            "padded {level} must normalise"
        );
    }
}

#[test]
fn reasoning_effort_drops_missing_blank_and_unknown_values() {
    for raw in [
        None,
        Some(""),
        Some("   "),
        Some("ultra"),
        Some("bogus-level"),
        Some("  bogus-level  "),
        Some("highish"),
    ] {
        assert_eq!(
            normalize_reasoning_effort(raw),
            None,
            "{raw:?} must be dropped"
        );
    }
}

/// A tuned config with room for the largest thinking budget, so the Anthropic
/// clamp is never what an unrelated assertion trips over.
fn thinking_cfg(provider: &str, effort: Option<&str>) -> AIConfig {
    AIConfig {
        max_tokens: Some(32_768),
        reasoning_effort: effort.map(str::to_string),
        ..tuned_cfg(provider)
    }
}

#[test]
fn unknown_effort_never_reaches_any_provider() {
    // The whole point of dropping an invalid rung: no provider is handed a
    // value the server would reject.
    for provider in ["openai", "anthropic", "gemini"] {
        let (_url, body) = endpoint(&thinking_cfg(provider, Some("ultra")), "hi", &[]);
        assert!(body.get("reasoning_effort").is_none(), "{provider}");
        assert!(body.get("thinking").is_none(), "{provider}");
        assert!(
            body.pointer("/generationConfig/thinkingConfig").is_none(),
            "{provider}"
        );
    }
}

#[test]
fn openai_body_pins_the_normalised_reasoning_effort() {
    let (url, body) = endpoint(&thinking_cfg("openai", Some("  HIGH ")), "hello", &[]);
    assert_eq!(url, "https://api.openai.com/v1/chat/completions");
    assert_eq!(
        body,
        serde_json::json!({
            "model": "m",
            "max_tokens": 32_768,
            "stream": true,
            "messages": [
                { "role": "system", "content": "You are a helpful editor assistant." },
                { "role": "user", "content": "hello" }
            ],
            "temperature": 0.7_f32,
            "reasoning_effort": "high",
            // The request asks the endpoint for its final usage chunk, which is
            // what the frontend shows as the request's token cost.
            "stream_options": { "include_usage": true }
        }),
        "padded uppercase input must go out trimmed and lowercased"
    );
}

#[test]
fn openai_body_omits_reasoning_effort_when_unset_or_unknown() {
    for raw in [None, Some("ultra")] {
        let (_url, body) = endpoint(&thinking_cfg("openai", raw), "hi", &[]);
        assert!(
            body.get("reasoning_effort").is_none(),
            "{raw:?} must not be forwarded"
        );
    }
}

#[test]
fn anthropic_maps_effort_to_extended_thinking_budgets() {
    for (effort, budget) in [
        ("minimal", 1024_u32),
        ("low", 2048),
        ("medium", 4096),
        ("high", 8192),
        ("xhigh", 16384),
    ] {
        let (_url, body) = endpoint(&thinking_cfg("anthropic", Some(effort)), "hi", &[]);
        assert_eq!(
            body["thinking"],
            serde_json::json!({ "type": "enabled", "budget_tokens": budget }),
            "effort {effort}"
        );
        assert!(
            body.get("reasoning_effort").is_none(),
            "Anthropic has no reasoning_effort field"
        );
    }
}

#[test]
fn anthropic_none_omits_thinking_entirely() {
    for raw in [None, Some("none")] {
        let (_url, body) = endpoint(&thinking_cfg("anthropic", raw), "hi", &[]);
        assert!(
            body.get("thinking").is_none(),
            "{raw:?} must not enable extended thinking"
        );
    }
}

#[test]
fn anthropic_clamps_the_budget_below_max_tokens() {
    // Anthropic rejects `budget_tokens >= max_tokens`, so a 2000-token cap
    // cannot host the 16384 of `xhigh`: the budget comes down to 1999.
    let cfg = AIConfig {
        max_tokens: Some(2000),
        reasoning_effort: Some("xhigh".into()),
        ..tuned_cfg("anthropic")
    };
    let (_url, body) = endpoint(&cfg, "hi", &[]);
    assert_eq!(
        body["thinking"],
        serde_json::json!({ "type": "enabled", "budget_tokens": 1999 })
    );
}

#[test]
fn anthropic_omits_thinking_when_max_tokens_is_too_small() {
    // 1024 is both the default cap and the smallest budget, and the budget must
    // stay strictly under the cap: no room means no extended thinking, rather
    // than a request Anthropic would reject outright.
    for max_tokens in [Some(1_u32), Some(512), Some(1024), None] {
        let cfg = AIConfig {
            max_tokens,
            reasoning_effort: Some("high".into()),
            ..tuned_cfg("anthropic")
        };
        let (_url, body) = endpoint(&cfg, "hi", &[]);
        assert!(
            body.get("thinking").is_none(),
            "max_tokens {max_tokens:?} must omit thinking"
        );
    }

    // One token above the smallest budget is the first cap that fits it.
    let cfg = AIConfig {
        max_tokens: Some(1025),
        reasoning_effort: Some("minimal".into()),
        ..tuned_cfg("anthropic")
    };
    let (_url, body) = endpoint(&cfg, "hi", &[]);
    assert_eq!(
        body["thinking"],
        serde_json::json!({ "type": "enabled", "budget_tokens": 1024 })
    );
}

#[test]
fn gemini_maps_effort_to_a_thinking_budget() {
    for (effort, budget) in [
        ("none", 0_u32),
        ("minimal", 512),
        ("low", 1024),
        ("medium", 4096),
        ("high", 8192),
        ("xhigh", 16384),
    ] {
        let (_url, body) = endpoint(&thinking_cfg("gemini", Some(effort)), "hi", &[]);
        assert_eq!(
            body["generationConfig"]["thinkingConfig"],
            serde_json::json!({ "thinkingBudget": budget }),
            "effort {effort}"
        );
    }
}

#[test]
fn gemini_keeps_generation_config_siblings_when_adding_thinking() {
    let (_url, body) = endpoint(&thinking_cfg("gemini", Some("high")), "hello", &[]);
    assert_eq!(
        body["generationConfig"],
        serde_json::json!({
            "temperature": 0.7_f32,
            "maxOutputTokens": 32_768,
            "thinkingConfig": { "thinkingBudget": 8192 }
        }),
        "the thinking merge must not clobber temperature/maxOutputTokens"
    );
    assert_eq!(body["contents"][0]["parts"][0]["text"], "hello");
}

#[test]
fn gemini_creates_generation_config_when_nothing_else_is_tuned() {
    let cfg = AIConfig {
        provider: "gemini".into(),
        model: "gemini-2.5-pro".into(),
        reasoning_effort: Some("medium".into()),
        ..Default::default()
    };
    let (_url, body) = endpoint(&cfg, "hi", &[]);
    assert_eq!(
        body["generationConfig"],
        serde_json::json!({ "thinkingConfig": { "thinkingBudget": 4096 } })
    );
}

#[test]
fn gemini_omits_thinking_when_unset_or_unknown() {
    for raw in [None, Some("ultra")] {
        let (_url, body) = endpoint(&thinking_cfg("gemini", raw), "hi", &[]);
        assert!(
            body.pointer("/generationConfig/thinkingConfig").is_none(),
            "{raw:?} must not add a thinking config"
        );
    }
}

/// Anthropic rejects a request that carries BOTH extended thinking and a
/// non-default temperature, and the app's own temperature default (0.7) is not
/// the model's. Enabling thinking must therefore drop the field rather than
/// force a value — the provider default is exactly what extended thinking
/// requires.
#[test]
fn anthropic_drops_temperature_when_extended_thinking_is_enabled() {
    let cfg = thinking_cfg("anthropic", Some("high"));
    assert!(
        cfg.temperature.is_some(),
        "the fixture must set a temperature"
    );
    let (_url, body) = endpoint(&cfg, "hi", &[]);
    assert!(
        body.get("thinking").is_some(),
        "this rung must enable extended thinking or the test proves nothing"
    );
    assert!(
        body.get("temperature").is_none(),
        "temperature must be omitted while thinking is enabled: {body}"
    );
}

/// The flip side: with thinking OFF the user's temperature must still reach the
/// provider, or the setting would silently stop working.
#[test]
fn anthropic_keeps_temperature_when_thinking_is_off() {
    for raw in [None, Some("none")] {
        let cfg = thinking_cfg("anthropic", raw);
        let (_url, body) = endpoint(&cfg, "hi", &[]);
        assert!(body.get("thinking").is_none(), "{raw:?}");
        assert_eq!(
            body["temperature"].as_f64(),
            cfg.temperature.map(f64::from),
            "the configured temperature must survive when thinking is off ({raw:?})"
        );
    }
}

/// Gemini's thinking budget is carved out of the OUTPUT allowance, so a rung
/// that asks for more thinking than the request has room for is clamped instead
/// of being sent as an impossible pair. Anthropic documents the same rule; here
/// it costs nothing when the two already agree, which the sibling test covers.
#[test]
fn gemini_clamps_the_thinking_budget_to_the_output_cap() {
    let mut cfg = thinking_cfg("gemini", Some("xhigh"));
    cfg.max_tokens = Some(2048);
    let (_url, body) = endpoint(&cfg, "hi", &[]);
    let budget = body
        .pointer("/generationConfig/thinkingConfig/thinkingBudget")
        .and_then(serde_json::Value::as_u64)
        .expect("xhigh must still ask for thinking");
    assert!(
        budget < 2048,
        "the budget must stay under maxOutputTokens (got {budget})"
    );
    // ...and the cap it was clamped against must not have been overwritten.
    assert_eq!(
        body.pointer("/generationConfig/maxOutputTokens")
            .and_then(serde_json::Value::as_u64),
        Some(2048)
    );
}

/// `none` is an explicit `0` at Gemini, not an omission: the clamp must leave
/// it alone or thinking would look enabled for a rung that turns it off.
#[test]
fn gemini_keeps_an_explicit_zero_budget() {
    let mut cfg = thinking_cfg("gemini", Some("none"));
    cfg.max_tokens = Some(1024);
    let (_url, body) = endpoint(&cfg, "hi", &[]);
    assert_eq!(
        body.pointer("/generationConfig/thinkingConfig/thinkingBudget")
            .and_then(serde_json::Value::as_u64),
        Some(0)
    );
}
