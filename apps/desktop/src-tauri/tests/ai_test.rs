use nekowite_lib::providers::ai::client::{
    accumulate_usage, ai_done_payload, ai_id_for, build_prompt, default_base_url,
    encode_request_body, error_detail_from_body, http_error_message,
    http_error_message_with_detail, list_models, next_ai_id, normalize_reasoning_effort,
    parse_model_ids, parse_sse_event, parse_sse_line, resolve_endpoint, validate_base_url,
    validate_request_inputs, AIConfig, CompletionStream, SseBuffer, StreamEvent, TokenUsage,
    MAX_ANSWER_BYTES, MAX_IMAGES_PER_REQUEST, MAX_IMAGE_DATA_URL_BYTES, MAX_MODELS_RESPONSE_BYTES,
    MAX_PROMPT_BYTES, MAX_REQUEST_BODY_BYTES, MAX_SSE_LINE_BYTES,
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
    let (url, body) = resolve_endpoint(&cfg, "hello", &[]);
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
    assert_eq!(
        acc, "Hello",
        "content_block text must be aggregated into acc"
    );

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
    // `[DONE]` is a signal, not a line to ignore: it means the answer is
    // complete even if the server keeps the connection open. Treating it as
    // "nothing" left the caller waiting for EOF (or for a timeout) on a request
    // that had already finished.
    assert_eq!(parse_sse_line(r#"data: [DONE]"#, "openai", &mut acc), None);
    let done = parse_sse_event(r#"data: [DONE]"#, "openai", &mut acc).unwrap();
    assert!(done.done);
    assert!(done.text.is_none() && done.error.is_none());
}

#[test]
fn sse_reassembles_fragmented_chunk() {
    let mut buf = SseBuffer::new();
    let mut acc = String::new();

    // network chunk 1 splits the data: line mid-JSON
    let lines = buf
        .feed(r#"data: {"choices":[{"delta":{"content":"Hel"#.as_bytes())
        .expect("under the ceiling");
    assert!(lines.is_empty(), "partial line must stay buffered");

    // chunk 2 completes the JSON but not the newline
    let lines = buf
        .feed(r#"lo"}}]}"#.as_bytes())
        .expect("under the ceiling");
    assert!(lines.is_empty(), "line incomplete until newline arrives");

    // chunk 3 terminates the line
    let lines = buf.feed(b"\n").expect("under the ceiling");
    assert_eq!(lines.len(), 1);
    assert_eq!(
        lines[0],
        r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#
    );

    let delta = parse_sse_line(&lines[0], "openai", &mut acc);
    assert_eq!(delta.as_deref(), Some("Hello"));
    assert_eq!(acc, "Hello");
}

#[test]
fn sse_buffer_returns_multiple_complete_lines() {
    let mut buf = SseBuffer::new();
    let mut acc = String::new();
    let lines = buf
        .feed(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\
         data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n"
                .as_bytes(),
        )
        .expect("under the ceiling");
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

    let lines = buf.feed(head).expect("under the ceiling");
    assert!(lines.is_empty(), "partial bytes must stay buffered");

    let lines = buf.feed(tail).expect("under the ceiling");
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
    let lines = buf
        .feed(r#"data: {"choices":[{"delta":{"content":"end"}}]}"#.as_bytes())
        .expect("under the ceiling");
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
        assert!(
            msg.contains("服务端暂时不可用"),
            "status {status} got: {msg}"
        );
    }
}

#[test]
fn http_error_unknown_status_stays_total() {
    // A hypothetical non-2xx code we did not explicitly map must still yield a
    // usable message (and never panic), so error_for_status never falls apart on
    // an unexpected provider page.
    let msg = http_error_message(599);
    // The unmapped fallback says "request failed" rather than "network failed":
    // an unexpected status is still a RESPONSE, and calling it a network problem
    // sent users to check a connection that was working fine.
    assert!(
        msg.starts_with("AI 请求失败：HTTP 599，请求失败"),
        "got: {msg}"
    );
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
    let (url, body) = resolve_endpoint(&cfg, "hello", &[]);
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
    let (_url, body) = resolve_endpoint(&cfg, "hello", &[]);
    assert_eq!(
        body["messages"].as_array().unwrap().len(),
        1,
        "whitespace-only system prompt must be dropped"
    );
}

#[test]
fn default_base_url_is_per_provider() {
    // Without a per-provider default, every OpenAI-compatible provider without
    // an explicit Base URL was sent to api.openai.com — the wrong host, holding
    // the user's key for a different vendor.
    assert_eq!(default_base_url("grok"), "https://api.x.ai/v1");
    assert_eq!(default_base_url("deepseek"), "https://api.deepseek.com/v1");
    assert_eq!(default_base_url("openai"), "https://api.openai.com/v1");
    // An unknown/custom provider keeps the OpenAI default rather than an
    // invented host.
    assert_eq!(default_base_url("whatever"), "https://api.openai.com/v1");
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
        let (url, _) = resolve_endpoint(&cfg, "hi", &[]);
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
    let (url, body) = resolve_endpoint(&cfg, "hi", &[]);
    assert_eq!(url, "https://tokenflux.dev/v1/chat/completions");
    assert_eq!(body["model"], "deepseek-flash");
    assert_eq!(body["stream"], true);
}

#[test]
fn reasoning_deltas_are_reported_separately_from_the_answer() {
    // Measured against tokenflux's deepseek-flash: 27 `reasoning_content`
    // deltas arrive (with `content: null`) before the first answer delta.
    // Reasoning must never join the answer text — the ghost writer inserts
    // whatever it streams straight into the document.
    let mut acc = String::new();
    let reasoning =
        r#"data: {"choices":[{"index":0,"delta":{"content":null,"reasoning_content":"We need"}}]}"#;
    let delta = parse_sse_event(reasoning, "deepseek", &mut acc).expect("reasoning delta");
    assert_eq!(delta.reasoning.as_deref(), Some("We need"));
    assert_eq!(delta.text, None);
    assert_eq!(acc, "", "reasoning must not reach the answer accumulator");

    let answer =
        r#"data: {"choices":[{"index":0,"delta":{"content":"PONG","reasoning_content":null}}]}"#;
    let delta = parse_sse_event(answer, "deepseek", &mut acc).expect("answer delta");
    assert_eq!(delta.text.as_deref(), Some("PONG"));
    assert_eq!(delta.reasoning, None);
    assert_eq!(acc, "PONG");
}

#[test]
fn a_role_only_opening_delta_is_not_reported_as_content() {
    // The first SSE frame of a reasoning model carries
    // `{"role":"assistant","content":null,"reasoning_content":""}`. It must not
    // produce an empty chunk (nor an empty reasoning event).
    let mut acc = String::new();
    let opener = r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}"#;
    assert_eq!(parse_sse_event(opener, "deepseek", &mut acc), None);
    assert_eq!(acc, "");
}

#[test]
fn the_reasoning_field_spelling_is_tolerated() {
    // Some gateways name the field `reasoning` instead of `reasoning_content`.
    let mut acc = String::new();
    let line = r#"data: {"choices":[{"index":0,"delta":{"reasoning":"hmm"}}]}"#;
    let delta = parse_sse_event(line, "deepseek", &mut acc).expect("delta");
    assert_eq!(delta.reasoning.as_deref(), Some("hmm"));
}

#[test]
fn parse_sse_line_still_returns_answer_text_only() {
    // Back-compat wrapper: callers that only want document text keep working.
    let mut acc = String::new();
    let reasoning = r#"data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}"#;
    assert_eq!(parse_sse_line(reasoning, "deepseek", &mut acc), None);
    let answer = r#"data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}"#;
    assert_eq!(
        parse_sse_line(answer, "deepseek", &mut acc).as_deref(),
        Some("hi")
    );
    assert_eq!(acc, "hi");
}

#[test]
fn a_tuned_config_still_wins_over_the_raised_default() {
    // The default rose from 256 to 1024 so a fresh install works with a
    // reasoning model (which can spend the whole budget thinking). An explicit
    // setting must still be honoured.
    let cfg = tuned_cfg("deepseek");
    let (_url, body) = resolve_endpoint(&cfg, "hi", &[]);
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
        let (_url, body) = resolve_endpoint(&thinking_cfg(provider, Some("ultra")), "hi", &[]);
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
    let (url, body) = resolve_endpoint(&thinking_cfg("openai", Some("  HIGH ")), "hello", &[]);
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
        let (_url, body) = resolve_endpoint(&thinking_cfg("openai", raw), "hi", &[]);
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
        let (_url, body) = resolve_endpoint(&thinking_cfg("anthropic", Some(effort)), "hi", &[]);
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
        let (_url, body) = resolve_endpoint(&thinking_cfg("anthropic", raw), "hi", &[]);
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
    let (_url, body) = resolve_endpoint(&cfg, "hi", &[]);
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
        let (_url, body) = resolve_endpoint(&cfg, "hi", &[]);
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
    let (_url, body) = resolve_endpoint(&cfg, "hi", &[]);
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
        let (_url, body) = resolve_endpoint(&thinking_cfg("gemini", Some(effort)), "hi", &[]);
        assert_eq!(
            body["generationConfig"]["thinkingConfig"],
            serde_json::json!({ "thinkingBudget": budget }),
            "effort {effort}"
        );
    }
}

#[test]
fn gemini_keeps_generation_config_siblings_when_adding_thinking() {
    let (_url, body) = resolve_endpoint(&thinking_cfg("gemini", Some("high")), "hello", &[]);
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
    let (_url, body) = resolve_endpoint(&cfg, "hi", &[]);
    assert_eq!(
        body["generationConfig"],
        serde_json::json!({ "thinkingConfig": { "thinkingBudget": 4096 } })
    );
}

#[test]
fn gemini_omits_thinking_when_unset_or_unknown() {
    for raw in [None, Some("ultra")] {
        let (_url, body) = resolve_endpoint(&thinking_cfg("gemini", raw), "hi", &[]);
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
    let (_url, body) = resolve_endpoint(&cfg, "hi", &[]);
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
        let (_url, body) = resolve_endpoint(&cfg, "hi", &[]);
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
    let (_url, body) = resolve_endpoint(&cfg, "hi", &[]);
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
    let (_url, body) = resolve_endpoint(&cfg, "hi", &[]);
    assert_eq!(
        body.pointer("/generationConfig/thinkingConfig/thinkingBudget")
            .and_then(serde_json::Value::as_u64),
        Some(0)
    );
}

/// An error frame inside a 200 OK stream must surface as an error.
///
/// Providers send these when the request is rejected mid-generation (rate limit
/// hit on the first token, content policy, upstream failure). The parser used to
/// return `None` for them, so the partial answer flowed on as if complete and
/// `ai-done` fired — the user got a truncated reply with no indication anything
/// went wrong, and could insert it into a note believing it was the whole answer.
#[test]
fn sse_reports_in_band_errors() {
    let mut acc = String::new();
    let openai = parse_sse_event(
        r#"data: {"error":{"message":"rate limit exceeded","type":"rate_limit_error"}}"#,
        "openai",
        &mut acc,
    )
    .unwrap();
    let message = openai.error.expect("an error frame must be reported");
    assert!(message.contains("rate limit exceeded"));
    assert!(
        message.contains("rate_limit_error"),
        "the kind is kept: {message}"
    );
    assert!(openai.text.is_none());

    let anthropic = parse_sse_event(
        r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        "anthropic",
        &mut acc,
    )
    .unwrap();
    assert!(anthropic.error.unwrap().contains("Overloaded"));

    // A normal delta is untouched by the error branch.
    let ok = parse_sse_event(
        r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
        "openai",
        &mut acc,
    )
    .unwrap();
    assert_eq!(ok.text.as_deref(), Some("hi"));
    assert!(ok.error.is_none());
}

/// `finish_reason` is what tells a complete answer from a truncated one.
#[test]
fn sse_reports_finish_reason() {
    let mut acc = String::new();
    let cut = parse_sse_event(
        r#"data: {"choices":[{"delta":{},"finish_reason":"length"}]}"#,
        "openai",
        &mut acc,
    )
    .unwrap();
    assert_eq!(cut.finish_reason.as_deref(), Some("length"));
    assert!(
        cut.text.is_none(),
        "a final frame carries no text of its own"
    );

    let filtered = parse_sse_event(
        r#"data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}"#,
        "openai",
        &mut acc,
    )
    .unwrap();
    assert_eq!(filtered.finish_reason.as_deref(), Some("content_filter"));

    // Anthropic spells it `stop_reason`.
    let anthropic = parse_sse_event(
        r#"data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#,
        "anthropic",
        &mut acc,
    )
    .unwrap();
    assert_eq!(anthropic.finish_reason.as_deref(), Some("max_tokens"));

    // A plain delta reports no finish reason, so the loop does not think the
    // answer ended on every chunk.
    let plain = parse_sse_event(
        r#"data: {"choices":[{"delta":{"content":"x"}}]}"#,
        "openai",
        &mut acc,
    )
    .unwrap();
    assert!(plain.finish_reason.is_none());
    assert!(!plain.done);
}

/// The provider's own explanation is what tells the user what to fix.
#[test]
fn http_error_includes_the_provider_detail() {
    // Measured against a real gateway: an unknown model name is HTTP 403 with
    // a body naming the models that WOULD work. Reporting only the status told
    // the user their API key was invalid, so they re-entered a key that was
    // fine while the useful sentence sat unread in a response body.
    let body = r#"{"error":{"message":"The current group does not support the requested model. Available models: deepseek-flash"}}"#;
    let detail = error_detail_from_body(body).expect("a JSON error body yields its message");
    let message = http_error_message_with_detail(403, Some(&detail));
    assert!(message.contains("403"));
    assert!(message.contains("Available models: deepseek-flash"));
    assert!(
        message.contains("模型名"),
        "the hint names the model as a suspect: {message}"
    );

    // A non-JSON body is shown verbatim rather than dropped.
    assert_eq!(
        error_detail_from_body("  upstream exploded  ").unwrap(),
        "upstream exploded"
    );

    // An empty body adds nothing, and 402 is a billing problem rather than a
    // network one.
    assert!(error_detail_from_body("   ").is_none());
    let bare = http_error_message_with_detail(402, None);
    assert!(bare.contains("余额"), "402 reads as billing: {bare}");

    // A wall of text is capped so it cannot fill the toast.
    let capped = http_error_message_with_detail(500, Some(&"x".repeat(5000)));
    assert!(capped.chars().count() < 700);
}

// --- P1 网络安全：HTTPS / localhost URL 策略 --------------------------------
//
// Roadmap rule: a Base URL that is not local must be HTTPS, so an API key can
// never travel to a public endpoint in the clear. HTTP stays available for the
// local-development addresses the product explicitly supports (Ollama / LM
// Studio on localhost), and for a private/LAN endpoint the user deliberately
// opted into with `allow_private`.

fn base_cfg(base: &str, allow_private: bool) -> AIConfig {
    AIConfig {
        provider: "openai".into(),
        model: "m".into(),
        base_url: Some(base.into()),
        api_key: Some("SECRET-SESSION-KEY".into()),
        allow_private,
        ..Default::default()
    }
}

#[test]
fn a_plaintext_public_base_url_is_rejected() {
    // Both spellings of "public" are refused: a literal address and a name.
    // (The names here are never resolved - the scheme rule is decided first, so
    // this test needs no DNS.)
    for base in [
        "http://203.0.113.9:8000/v1",
        "http://api.openai.com/v1",
        "http://tokenflux.dev/v1",
        "http://8.8.8.8/v1",
    ] {
        let err = validate_base_url(&base_cfg(base, false))
            .err()
            .unwrap_or_else(|| panic!("{base} must be refused: plain HTTP to a public host"));
        assert!(
            err.contains("https://"),
            "{base} must say what to use instead: {err}"
        );
    }
}

#[test]
fn the_same_public_base_is_accepted_over_https() {
    // The fix must not become "refuse everything public": the rule is HTTPS,
    // not a ban. A literal address keeps this test off DNS.
    assert!(validate_base_url(&base_cfg("https://203.0.113.9:8000/v1", false)).is_ok());
}

#[test]
fn localhost_http_stays_usable_for_a_local_model() {
    for base in [
        "http://localhost:11434/v1",
        "http://127.0.0.1:11434/v1",
        "http://[::1]:8080/v1",
    ] {
        assert!(
            validate_base_url(&base_cfg(base, true)).is_ok(),
            "{base} must stay usable: that is what allow_private is for"
        );
    }
}

#[test]
fn allow_private_does_not_opt_out_of_https_for_public_hosts() {
    // `allow_private` exists to reach a local model server. It must not double
    // as "send my key to any host in the clear": the flag is about REACHING a
    // private address, not about dropping transport security on the public
    // internet.
    for base in ["http://example.com/v1", "http://api.openai.com/v1"] {
        assert!(
            validate_base_url(&base_cfg(base, true)).is_err(),
            "{base} must still be refused with allow_private"
        );
    }
    // HTTPS to a public host remains the user's own call under the opt-in.
    assert!(validate_base_url(&base_cfg("https://example.com/v1", true)).is_ok());
}

#[test]
fn a_lan_address_the_user_opted_into_may_still_use_http() {
    // Ollama on another box on the home network is the documented use case for
    // the setting, and that box speaks plain HTTP.
    for base in ["http://192.168.1.5:11434", "http://10.0.0.5:8000/v1"] {
        assert!(
            validate_base_url(&base_cfg(base, true)).is_ok(),
            "{base} is what 允许本地/内网地址 means"
        );
    }
}

#[test]
fn allow_private_does_not_accept_a_garbage_scheme() {
    // The opt-in skips the SSRF check, not the URL policy: a scheme the client
    // cannot even speak must still be refused up front.
    for base in ["file:///etc/passwd", "ftp://example.com", "not a url"] {
        assert!(
            validate_base_url(&base_cfg(base, true)).is_err(),
            "{base} must be refused"
        );
    }
}

// --- P1 AI 输入输出限制：模型列表响应 ---------------------------------------
//
// One loopback server, one request: the response is the attacker's bytes, and
// the read must stop at a ceiling instead of trusting `Content-Length` or
// buffering whatever arrives.

/// Serve `body` once on a loopback port and hand back the Base URL and the
/// server task.
///
/// `content_length: Some(n)` sends an honest `Content-Length: n`; `None` sends
/// the body with chunked transfer-encoding, so the client sees NO length up
/// front and has to bound the read as it goes - the two paths the reader has to
/// defend separately.
async fn serve_once(
    body: &str,
    content_length: Option<usize>,
) -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind a loopback port");
    let addr = listener.local_addr().expect("local addr");
    let response = match content_length {
        Some(len) => {
            let mut out = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
            );
            out.push_str(body);
            out.into_bytes()
        }
        None => {
            let mut out = String::from(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            );
            for part in body.as_bytes().chunks(64 * 1024) {
                out.push_str(&format!("{:x}\r\n", part.len()));
                out.push_str(&String::from_utf8_lossy(part));
                out.push_str("\r\n");
            }
            out.push_str("0\r\n\r\n");
            out.into_bytes()
        }
    };
    let server = tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let response = response.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(&response).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    (format!("http://127.0.0.1:{}", addr.port()), server)
}

/// A models payload that exceeds `MAX_MODELS_RESPONSE_BYTES` while staying
/// VALID JSON - so a reader without a ceiling parses it happily and hands the
/// list back, and only a reader that bounds the read refuses it.
fn oversized_models_body() -> String {
    let filler = "x".repeat(MAX_MODELS_RESPONSE_BYTES + 1);
    format!(r#"{{"data":[{{"id":"a"}}],"filler":"{filler}"}}"#)
}

#[tokio::test]
async fn an_oversized_model_list_response_is_refused() {
    let (base, server) = serve_once(&oversized_models_body(), None).await;
    let cfg = base_cfg(&base, true);
    let result = list_models(&cfg).await;
    let err = result.err().unwrap_or_else(|| {
        panic!("a response past the ceiling must be refused, not parsed");
    });
    assert!(
        err.contains("过大"),
        "the error must name the size limit, got: {err}"
    );
    server.abort();
}

#[tokio::test]
async fn a_declared_oversized_model_list_response_is_refused_without_reading_it() {
    // A chunked response carries no length, but an honest one does: the reader
    // must refuse it before buffering a byte rather than reading the body and
    // checking afterwards.
    let body = r#"{"data":[{"id":"a"}]}"#;
    let (base, server) = serve_once(body, Some(MAX_MODELS_RESPONSE_BYTES + 1)).await;
    let cfg = base_cfg(&base, true);
    let err = list_models(&cfg).await.expect_err("oversized body");
    assert!(err.contains("过大"), "got: {err}");
    server.abort();
}

#[tokio::test]
async fn a_normal_model_list_response_still_works() {
    // The ceiling must not break the happy path it is drawn around.
    let (base, server) = serve_once(r#"{"data":[{"id":"b"},{"id":"a"}]}"#, None).await;
    let cfg = base_cfg(&base, true);
    let ids = list_models(&cfg).await.expect("a small list parses");
    assert_eq!(ids, vec!["a", "b"]);
    server.abort();
}

// --- P1 AI 输入输出限制：请求侧 ---------------------------------------------
//
// The ceilings are enforced at the Rust boundary because the renderer's own
// checks are a courtesy: `ai_complete` is an IPC command, and anything that can
// invoke it can send any prompt, any number of images and any image size.

#[test]
fn an_oversized_prompt_is_refused() {
    // The limit itself is usable; one byte past it is not.
    assert!(validate_request_inputs(&"a".repeat(MAX_PROMPT_BYTES), &[]).is_ok());
    let err = validate_request_inputs(&"a".repeat(MAX_PROMPT_BYTES + 1), &[])
        .expect_err("a prompt past the ceiling must be refused");
    assert!(err.contains("过长"), "got: {err}");
    assert!(
        err.contains(&MAX_PROMPT_BYTES.to_string()),
        "the error must name the ceiling: {err}"
    );
}

#[test]
fn the_prompt_ceiling_counts_bytes_not_characters() {
    // A CJK prompt is 3 bytes per character, so a character count is not a size
    // count: the note context the renderer measures in characters has to be
    // measured in bytes where it arrives.
    let cjk = "字".repeat(MAX_PROMPT_BYTES / 3 + 1);
    assert!(cjk.chars().count() < MAX_PROMPT_BYTES, "chars would pass");
    assert!(validate_request_inputs(&cjk, &[]).is_err());
}

#[test]
fn too_many_images_are_refused() {
    let img = || serde_json::json!("data:image/png;base64,AAA");
    let at_limit: Vec<_> = (0..MAX_IMAGES_PER_REQUEST).map(|_| img()).collect();
    assert!(validate_request_inputs("hi", &at_limit).is_ok());
    let over: Vec<_> = (0..MAX_IMAGES_PER_REQUEST + 1).map(|_| img()).collect();
    let err =
        validate_request_inputs("hi", &over).expect_err("a count past the ceiling must be refused");
    assert!(err.contains(&MAX_IMAGES_PER_REQUEST.to_string()), "{err}");
}

#[test]
fn an_oversized_image_is_refused() {
    let payload = |bytes: usize| {
        serde_json::json!(format!(
            "data:image/png;base64,{}",
            "A".repeat(bytes.saturating_sub("data:image/png;base64,".len()))
        ))
    };
    assert!(validate_request_inputs("hi", &[payload(MAX_IMAGE_DATA_URL_BYTES)]).is_ok());
    let err = validate_request_inputs("hi", &[payload(MAX_IMAGE_DATA_URL_BYTES + 1)])
        .expect_err("an image past the ceiling must be refused");
    assert!(err.contains("图片"), "got: {err}");
    assert!(err.contains(&MAX_IMAGE_DATA_URL_BYTES.to_string()), "{err}");
}

#[test]
fn an_oversized_request_body_is_refused() {
    let body = serde_json::json!({ "data": "x".repeat(MAX_REQUEST_BODY_BYTES + 1) });
    let err = encode_request_body(&body).expect_err("a body past the ceiling must be refused");
    assert!(err.contains("过大"), "got: {err}");
    assert!(err.contains(&MAX_REQUEST_BODY_BYTES.to_string()), "{err}");

    // ...and the largest body the app can legitimately build still fits, so the
    // ceiling cannot be what refuses a real request.
    let fit = serde_json::json!({ "data": "x".repeat(MAX_REQUEST_BODY_BYTES - 64) });
    assert!(encode_request_body(&fit).is_ok());
}

// --- P1 AI 输入输出限制：流式响应侧 -----------------------------------------
//
// `CompletionStream` is the streaming loop without the socket and without the
// Tauri emit, so the size policy on the RESPONSE side (frame reassembly, the
// accumulated answer) is testable here instead of only being visible in code
// that needs a running app.

#[test]
fn a_frame_past_the_reassembly_ceiling_is_refused() {
    let mut stream = CompletionStream::new("openai");
    // A peer that never sends a newline used to grow the reassembly buffer
    // without bound: 1 MiB of unterminated "frame" is already far past any real
    // event, and the error has to say so instead of buffering it.
    let err = stream
        .feed(&vec![b'x'; MAX_SSE_LINE_BYTES + 1])
        .expect_err("an unterminated frame past the ceiling must be refused");
    assert!(err.contains("过大"), "got: {err}");
    assert!(err.contains(&MAX_SSE_LINE_BYTES.to_string()), "{err}");
}

#[test]
fn a_frame_at_the_reassembly_ceiling_is_still_accepted() {
    // The boundary: exactly the ceiling (newline included) is a legal frame, so
    // the check cannot be off by one in the direction that breaks a provider.
    let mut stream = CompletionStream::new("openai");
    let mut frame = vec![b'x'; MAX_SSE_LINE_BYTES - 1];
    frame.push(b'\n');
    // Not a valid event, but it must not be refused for its SIZE.
    assert!(stream.feed(&frame).is_ok());
}

#[test]
fn an_over_long_answer_is_refused_instead_of_accumulating() {
    let piece = "a".repeat(64 * 1024);
    let frame = format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{piece}\"}}}}]}}\n");
    let mut stream = CompletionStream::new("openai");
    let mut refusal = None;
    for _ in 0..(MAX_ANSWER_BYTES / piece.len() + 2) {
        if let Err(e) = stream.feed(frame.as_bytes()) {
            refusal = Some(e);
            break;
        }
    }
    let err = refusal.expect("an answer past the ceiling must be refused");
    assert!(err.contains("过长"), "got: {err}");
    // Bounded overshoot: the ceiling is checked per frame, so the answer can
    // only exceed it by the frame that crossed it - never without bound.
    assert!(stream.answer().len() <= MAX_ANSWER_BYTES + piece.len() + 1024);
}

#[test]
fn a_normal_stream_folds_text_reasoning_usage_and_done() {
    let mut stream = CompletionStream::new("deepseek");
    let events = stream.feed(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"}}]}\n",
            "\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n",
            "data: [DONE]\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"after done\"}}]}\n",
        )
        .as_bytes(),
    )
    .expect("no ceiling is crossed here");

    assert_eq!(
        events,
        vec![
            StreamEvent::Reasoning("thinking".into()),
            StreamEvent::Text("Hi".into()),
            StreamEvent::Done,
        ],
        "the frame after [DONE] must not be folded into the answer"
    );
    assert_eq!(
        stream.answer(),
        "Hi",
        "reasoning is never part of the answer"
    );
    assert_eq!(stream.finish_reason(), Some("stop"));
    assert!(stream.saw_reasoning());
    assert_eq!(
        stream.usage(),
        Some(TokenUsage {
            prompt_tokens: Some(3),
            completion_tokens: Some(1),
            total_tokens: Some(4),
        })
    );
}

#[test]
fn an_in_band_error_frame_is_reported_as_an_event() {
    // A 200 response that carries an error event: the caller has to see it and
    // stop, or a truncated answer is accepted as a complete one.
    let mut stream = CompletionStream::new("openai");
    let events = stream
        .feed(b"data: {\"error\":{\"message\":\"rate limit exceeded\"}}\n")
        .expect("an in-band error is not a size violation");
    assert_eq!(
        events,
        vec![StreamEvent::ProviderError(
            "rate limit exceeded".to_string()
        )]
    );
}

#[test]
fn a_trailing_frame_without_a_newline_is_flushed_at_the_end() {
    let mut stream = CompletionStream::new("openai");
    assert!(stream
        .feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"end\"}}]}")
        .expect("no newline yet")
        .is_empty());
    assert_eq!(
        stream.finish().expect("the tail is under the ceiling"),
        vec![StreamEvent::Text("end".into())]
    );
    assert_eq!(stream.answer(), "end");
}

// --- Usage accounting on the folded stream -----------------------------------
//
// These two came from the unit-test module inside `providers::ai::client` when
// that file was split: both drive only the public surface (`parse_sse_event`,
// `accumulate_usage`, `ai_done_payload`, `resolve_endpoint`), so they belong
// with the rest of the provider-facing behaviour tests. The private-policy
// tests (URL/SSRF rules, redirect refusal) stayed next to the code they cover.

#[test]
fn a_stream_that_reports_no_usage_ends_with_null_and_invents_nothing() {
    let mut acc = String::new();
    let mut usage: Option<TokenUsage> = None;
    for line in [
        r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
        "data: [DONE]",
    ] {
        if let Some(delta) = parse_sse_event(line, "openai", &mut acc) {
            accumulate_usage(&mut usage, &delta);
        }
    }
    assert_eq!(usage, None);
    let payload = ai_done_payload("ai-1", "hi", usage);
    assert_eq!(payload["id"], "ai-1");
    assert_eq!(payload["full"], "hi");
    assert_eq!(payload["usage"], serde_json::Value::Null);
    // An all-empty usage object is the same "not reported", not a 0-token
    // completion.
    let empty = ai_done_payload("ai-1", "hi", Some(TokenUsage::default()));
    assert_eq!(empty["usage"], serde_json::Value::Null);
}

#[test]
fn gemini_url_has_no_key_embedded() {
    let cfg = AIConfig {
        provider: "gemini".into(),
        model: "gemini-2.5-pro".into(),
        api_key: Some("SECRET-KEY".into()),
        ..Default::default()
    };
    let (url, _body) = resolve_endpoint(&cfg, "hi", &[]);
    assert!(
        !url.contains("SECRET-KEY"),
        "key must not appear in URL: {url}"
    );
    assert!(
        !url.contains("key="),
        "url must not carry a key query param: {url}"
    );
}
