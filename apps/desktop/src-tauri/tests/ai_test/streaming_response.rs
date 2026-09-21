//! The response side: the SSE framing - reassembly across network chunks and
//! multi-byte boundaries - and the per-provider delta parsing on top of it, up to the
//! `CompletionStream` that folds frames into text, reasoning and usage.

use nekowite_lib::providers::ai::client::{
    accumulate_usage, ai_done_payload, parse_sse_event, parse_sse_line, CompletionStream,
    SseBuffer, StreamEvent, TokenUsage, MAX_ANSWER_BYTES, MAX_SSE_LINE_BYTES,
};

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
