use nekowite_lib::ai::{
    ai_id_for, build_prompt, next_ai_id, parse_sse_line, resolve_endpoint, AIConfig, SseBuffer,
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
fn endpoint_embeds_gemini_key_in_query() {
    let cfg = AIConfig {
        provider: "gemini".into(),
        model: "gemini-2.5-pro".into(),
        base_url: None,
        api_key: Some("sk-gem-key".into()),
    };
    let (url, _body) = resolve_endpoint(&cfg, "hello", &[]);
    assert!(
        url.contains("key=sk-gem-key"),
        "gemini key must ride in the URL query, got: {url}"
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
    };
    let images = vec![serde_json::json!("data:image/png;base64,AAA")];
    let (_url, body) = resolve_endpoint(&cfg, "look", &images);
    let parts = &body["contents"][0]["parts"];
    assert_eq!(parts[0]["text"], "look");
    assert_eq!(parts[1]["inline_data"]["mime_type"], "image/png");
    assert_eq!(parts[1]["inline_data"]["data"], "AAA");
}
