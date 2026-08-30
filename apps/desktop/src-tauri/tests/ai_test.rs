use nekowite_lib::ai::{build_prompt, parse_sse_line, resolve_endpoint, AIConfig};

#[test]
fn prompt_continues_cursor() {
    let p = build_prompt("The quick brown");
    assert!(p.contains("The quick brown"));
    assert!(p.ends_with('\n'));
}

#[test]
fn endpoint_maps_openai() {
    let cfg = AIConfig {
        provider: "openai".into(),
        model: "gpt-5-mini".into(),
        base_url: Some("https://api.openai.com/v1".into()),
        api_key: Some("k".into()),
    };
    let (url, body) = resolve_endpoint(&cfg);
    assert!(url.ends_with("/chat/completions"));
    assert_eq!(body["stream"], true);
}

#[test]
fn endpoint_maps_anthropic() {
    let cfg = AIConfig {
        provider: "anthropic".into(),
        model: "claude-sonnet-4-5".into(),
        base_url: None,
        api_key: None,
    };
    let (url, body) = resolve_endpoint(&cfg);
    assert!(url.ends_with("/v1/messages"));
    assert_eq!(body["stream"], true);
}

#[test]
fn endpoint_maps_gemini() {
    let cfg = AIConfig {
        provider: "gemini".into(),
        model: "gemini-2.5-pro".into(),
        base_url: None,
        api_key: None,
    };
    let (url, _body) = resolve_endpoint(&cfg);
    assert!(url.contains(":streamGenerateContent"));
    assert!(url.contains("alt=sse"));
}

#[test]
fn sse_parses_openai_delta() {
    let mut acc = String::new();
    let delta = parse_sse_line(
        r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#,
        "openai",
        &mut acc,
    );
    assert_eq!(delta.as_deref(), Some("Hello"));
}

#[test]
fn sse_parses_anthropic_delta() {
    let mut acc = String::new();
    let delta = parse_sse_line(
        r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}"#,
        "anthropic",
        &mut acc,
    );
    assert_eq!(delta.as_deref(), Some("Hi"));
}

#[test]
fn sse_parses_gemini_delta() {
    let mut acc = String::new();
    let delta = parse_sse_line(
        r#"data: {"candidates":[{"content":{"parts":[{"text":"Yo"}]}}]}"#,
        "gemini",
        &mut acc,
    );
    assert_eq!(delta.as_deref(), Some("Yo"));
}

#[test]
fn sse_ignores_other_lines() {
    let mut acc = String::new();
    assert_eq!(parse_sse_line(": keep-alive", "openai", &mut acc), None);
    assert_eq!(parse_sse_line("", "openai", &mut acc), None);
    assert_eq!(parse_sse_line(r#"data: [DONE]"#, "openai", &mut acc), None);
}
