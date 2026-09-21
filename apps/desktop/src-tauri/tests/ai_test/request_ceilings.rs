//! The input ceilings: prompt bytes, image count and size, and the encoded request
//! body. They are enforced here because `ai_complete` is an IPC command, so the
//! renderer's own checks are only a courtesy.

use nekowite_lib::providers::ai::client::{
    encode_request_body, validate_request_inputs, MAX_IMAGES_PER_REQUEST, MAX_IMAGE_DATA_URL_BYTES,
    MAX_PROMPT_BYTES, MAX_REQUEST_BODY_BYTES,
};

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
