use nekowite_lib::ai::{
    ai_id_for, build_prompt, http_error_message, next_ai_id, parse_model_ids, parse_sse_line,
    resolve_endpoint, AIConfig, SseBuffer,
};

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
        ..Default::default()
    };
    let (url, body) = resolve_endpoint(&cfg, "hello", &[]);
    assert!(url.ends_with("/chat/completions"));
    assert_eq!(body["stream"], true);
    assert!(body["messages"][0]["content"].is_string(), "no images keeps string content");
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
    let (url, body) = resolve_endpoint(&cfg, "hello", &[]);
    assert!(url.ends_with("/v1/messages"));
    assert_eq!(body["stream"], true);
    assert!(body["messages"][0]["content"].is_string(), "no images keeps string content");
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
    let (url, body) = resolve_endpoint(&cfg, "hello", &[]);
    assert!(url.contains(":streamGenerateContent"));
    assert!(url.contains("alt=sse"));
    assert_eq!(body["contents"][0]["parts"][0]["text"], "hello");
    assert_eq!(body["contents"][0]["parts"].as_array().unwrap().len(), 1);
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
    assert_eq!(acc, "Hello", "delta must be aggregated into acc");
}

#[test]
fn sse_aggregates_across_deltas() {
    let mut acc = String::new();
    let a = parse_sse_line(
        r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#,
        "openai",
        &mut acc,
    );
    let b = parse_sse_line(
        r#"data: {"choices":[{"delta":{"content":"lo"}}]}"#,
        "openai",
        &mut acc,
    );
    assert_eq!(a.as_deref(), Some("Hel"));
    assert_eq!(b.as_deref(), Some("lo"));
    assert_eq!(acc, "Hello");
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
fn sse_parses_anthropic_content_block_start() {
    // Anthropic sends the FIRST text block inside content_block_start, not as a
    // delta — it must not be dropped.
    let mut acc = String::new();
    let delta = parse_sse_line(
        r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Hello"}}"#,
        "anthropic",
        &mut acc,
    );
    assert_eq!(delta.as_deref(), Some("Hello"));
    assert_eq!(acc, "Hello", "content_block text must be aggregated into acc");

    // A subsequent delta continues the same block.
    let delta = parse_sse_line(
        r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}"#,
        "anthropic",
        &mut acc,
    );
    assert_eq!(delta.as_deref(), Some(" world"));
    assert_eq!(acc, "Hello world");
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
    let (url, _body) = resolve_endpoint(&cfg, "hello", &[]);
    assert!(
        !url.contains("sk-gem-key") && !url.contains("key="),
        "gemini key must NOT ride in the URL query (it goes in the x-goog-api-key header), got: {url}"
    );
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

#[test]
fn sse_reassembles_fragmented_chunk() {
    let mut buf = SseBuffer::new();
    let mut acc = String::new();

    // network chunk 1 splits the data: line mid-JSON
    let lines = buf.feed(r#"data: {"choices":[{"delta":{"content":"Hel"#.as_bytes());
    assert!(lines.is_empty(), "partial line must stay buffered");

    // chunk 2 completes the JSON but not the newline
    let lines = buf.feed(r#"lo"}}]}"#.as_bytes());
    assert!(lines.is_empty(), "line incomplete until newline arrives");

    // chunk 3 terminates the line
    let lines = buf.feed(b"\n");
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0], r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#);

    let delta = parse_sse_line(&lines[0], "openai", &mut acc);
    assert_eq!(delta.as_deref(), Some("Hello"));
    assert_eq!(acc, "Hello");
}

#[test]
fn sse_buffer_returns_multiple_complete_lines() {
    let mut buf = SseBuffer::new();
    let mut acc = String::new();
    let lines = buf.feed(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\
         data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n"
            .as_bytes(),
    );
    assert_eq!(lines.len(), 2);
    let mut out = String::new();
    for line in &lines {
        if let Some(d) = parse_sse_line(line, "openai", &mut acc) {
            out.push_str(&d);
        }
    }
    assert_eq!(out, "Hello");
    assert_eq!(acc, "Hello");
}

#[test]
fn sse_buffer_preserves_cjk_split_across_chunks() {
    // "こんにちは" is 3 UTF-8 bytes per character. Cut the SSE line inside the
    // FIRST character's byte sequence: with per-chunk `String::from_utf8_lossy`
    // decoding, those orphaned bytes came back as U+FFFD and the JSON parse
    // failed, dropping the text entirely. Byte-level buffering must carry the
    // partial sequence across feed() calls instead.
    let line = r#"data: {"choices":[{"delta":{"content":"こんにちは"}}]}"#;
    // The newline rides in the second chunk, completing the line there.
    let bytes = format!("{line}\n").into_bytes();
    // `data: ` is 6 bytes and the JSON prefix
    // `{"choices":[{"delta":{"content":"` is 33, so the content starts at byte
    // 39; byte 41 falls in the middle of こ (E3 81 93).
    let (head, tail) = bytes.split_at(41);
    assert!(
        std::str::from_utf8(head).is_err(),
        "split point must fall inside a multi-byte UTF-8 sequence"
    );

    let mut buf = SseBuffer::new();
    let mut acc = String::new();

    let lines = buf.feed(head);
    assert!(lines.is_empty(), "partial bytes must stay buffered");

    let lines = buf.feed(tail);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0], line, "reassembled line must be byte-identical");

    let delta = parse_sse_line(&lines[0], "openai", &mut acc);
    assert_eq!(delta.as_deref(), Some("こんにちは"));
    assert_eq!(acc, "こんにちは");
}

#[test]
fn sse_buffer_flush_drains_trailing_line_without_newline() {
    let mut buf = SseBuffer::new();
    let mut acc = String::new();

    // A final event the server never terminates with a newline.
    let lines = buf.feed(r#"data: {"choices":[{"delta":{"content":"end"}}]}"#.as_bytes());
    assert!(lines.is_empty(), "no newline yet, nothing complete");

    let lines = buf.flush();
    assert_eq!(lines.len(), 1);
    let delta = parse_sse_line(&lines[0], "openai", &mut acc);
    assert_eq!(delta.as_deref(), Some("end"));
    assert_eq!(acc, "end");

    // Flushing an empty buffer is a no-op.
    assert!(buf.flush().is_empty());
}

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
    let (_url, body) = resolve_endpoint(&cfg, "look", &images);
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
    let (_url, body) = resolve_endpoint(&cfg, "hello", &[]);
    assert!(body["messages"][0]["content"].is_string(), "empty images keeps string content");
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
    let (_url, body) = resolve_endpoint(&cfg, "look", &images);
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
    let (_url, body) = resolve_endpoint(&cfg, "look", &images);
    let parts = &body["contents"][0]["parts"];
    assert_eq!(parts[0]["text"], "look");
    assert_eq!(parts[1]["inline_data"]["mime_type"], "image/png");
    assert_eq!(parts[1]["inline_data"]["data"], "AAA");
}

#[test]
fn parse_models_openai_data_ids() {
    let ids = parse_model_ids(r#"{"data":[{"id":"a"},{"id":"b"}]}"#, "openai");
    assert_eq!(ids, vec!["a", "b"]);
}

#[test]
fn parse_models_gemini_name_to_id() {
    let ids = parse_model_ids(r#"{"models":[{"name":"models/gemini-2.5-pro"}]}"#, "gemini");
    assert_eq!(ids, vec!["gemini-2.5-pro"]);
}

#[test]
fn parse_models_anthropic_data_ids() {
    let ids = parse_model_ids(r#"{"data":[{"id":"claude-sonnet-4-5"}]}"#, "anthropic");
    assert_eq!(ids, vec!["claude-sonnet-4-5"]);
}

#[test]
fn parse_models_empty_body_returns_empty() {
    assert_eq!(parse_model_ids("", "openai"), Vec::<String>::new());
    assert_eq!(parse_model_ids("   ", "openai"), Vec::<String>::new());
    assert_eq!(parse_model_ids("not json", "openai"), Vec::<String>::new());
}

#[test]
fn parse_models_sorts_and_dedups() {
    let ids = parse_model_ids(r#"{"data":[{"id":"b"},{"id":"a"},{"id":"b"}]}"#, "openai");
    assert_eq!(ids, vec!["a", "b"]);
}

#[test]
fn parse_models_skips_entries_without_id_or_name() {
    let ids = parse_model_ids(
        r#"{"data":[{"id":"ok"},{"description":"no id"},{"id":""}]}"#,
        "openai",
    );
    assert_eq!(ids, vec!["ok"]);
}

// `stream_complete` calls `Response::error_for_status()` after `send()` so a
// 4xx/5xx is surfaced as an `ai-error` event + `Err` instead of being read as an
// empty SSE stream. The status->message mapping is extracted into
// `http_error_message` so it can be tested without a live endpoint; each of
// these non-2xx codes would short-circuit `bytes_stream()` the same way a real
// provider error page would.

#[test]
fn http_error_401_hints_bad_key() {
    let msg = http_error_message(401);
    assert!(msg.starts_with("AI 请求失败："), "got: {msg}");
    assert!(msg.contains("API Key 无效"), "got: {msg}");
}

#[test]
fn http_error_429_hints_retry() {
    let msg = http_error_message(429);
    assert!(msg.contains("请稍后重试"), "got: {msg}");
}

#[test]
fn http_error_5xx_hints_unavailable() {
    for status in [500, 502, 503, 504] {
        let msg = http_error_message(status);
        assert!(msg.contains("服务端暂时不可用"), "status {status} got: {msg}");
    }
}

#[test]
fn http_error_unknown_status_stays_total() {
    // A hypothetical non-2xx code we did not explicitly map must still yield a
    // usable message (and never panic), so error_for_status never falls apart on
    // an unexpected provider page.
    let msg = http_error_message(599);
    assert!(msg.starts_with("AI 请求失败：HTTP 599，网络请求失败"), "got: {msg}");
}

fn tuned_cfg(provider: &str) -> AIConfig {
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

#[test]
fn openai_body_puts_system_first_and_writes_tuning() {
    let (_url, body) = resolve_endpoint(&tuned_cfg("openai"), "hello", &[]);
    assert_eq!(body["temperature"], serde_json::json!(0.7_f32), "temperature as written by the f32 config");
    assert_eq!(body["max_tokens"], 512);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(
        body["messages"][0]["content"],
        "You are a helpful editor assistant."
    );
    assert_eq!(body["messages"][1]["role"], "user");
    assert_eq!(body["messages"][2], serde_json::json!(null), "no third message");
}

#[test]
fn openai_images_keep_message_after_system() {
    let cfg = tuned_cfg("openai");
    let images = vec![serde_json::json!("data:image/png;base64,AAA")];
    let (_url, body) = resolve_endpoint(&cfg, "look", &images);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][1]["role"], "user");
    assert!(
        body["messages"][1]["content"][1]["type"] == "image_url",
        "image block must ride the user message, not the system one"
    );
}

#[test]
fn anthropic_body_uses_top_level_system() {
    let (_url, body) = resolve_endpoint(&tuned_cfg("anthropic"), "hello", &[]);
    assert_eq!(body["temperature"], serde_json::json!(0.7_f32));
    assert_eq!(body["max_tokens"], 512);
    assert_eq!(body["system"], "You are a helpful editor assistant.");
    assert_eq!(body["messages"][0]["role"], "user");
}

#[test]
fn gemini_body_uses_system_instruction_and_generation_config() {
    let (_url, body) = resolve_endpoint(&tuned_cfg("gemini"), "hello", &[]);
    assert_eq!(
        body["systemInstruction"]["parts"][0]["text"],
        "You are a helpful editor assistant."
    );
    assert_eq!(body["generationConfig"]["temperature"], serde_json::json!(0.7_f32));
    assert_eq!(body["generationConfig"]["maxOutputTokens"], 512);
    assert_eq!(body["contents"][0]["role"], "user");
}

#[test]
fn untuned_cfg_keeps_legacy_defaults() {
    let cfg = AIConfig {
        provider: "openai".into(),
        model: "m".into(),
        base_url: None,
        api_key: None,
        ..Default::default()
    };
    let (url, body) = resolve_endpoint(&cfg, "hello", &[]);
    assert!(url.ends_with("/chat/completions"));
    assert_eq!(body["max_tokens"], 256, "default max_tokens stays 256");
    assert!(body.get("temperature").is_none(), "no temperature by default");
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
    let (_url, body) = resolve_endpoint(&cfg, "hello", &[]);
    assert_eq!(
        body["messages"].as_array().unwrap().len(),
        1,
        "whitespace-only system prompt must be dropped"
    );
}
