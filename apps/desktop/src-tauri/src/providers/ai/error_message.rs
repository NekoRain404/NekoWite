//! What a failed request says to the user: the status hint, the provider's own
//! explanation read out of the response body, the one condition where the status
//! hint is actively misleading, and what a 2xx the app could not use says — with
//! the two primitives those diagnoses are built from.
//!
//! Split out of [`super::response`] because it is a different job from reading a
//! response: `response` turns bytes into values the app can use (the token
//! counts, the answer), and this module turns a reply the app could not use into
//! the sentence a human reads. The two share nothing but that, and this half grew
//! on its own — a context overflow reported as a *format* problem is a
//! user-visible defect that lives entirely in the text below.
//!
//! **The unfaithful 2xx.** A provider that answers a path it does not recognise
//! with HTTP 200 and its single-page-app fallback is ONE provider behaviour with
//! two victims here: `list_models`, whose report `ai_model_fetch_test.rs`
//! records, and the completion path, whose report `ai_unreadable_response_test.rs`
//! records. Both failures have to name the address that was asked, show a bounded
//! preview of what came back, and call a web page a page — so [`body_preview`]
//! and [`reads_as_a_web_page`] live here, where the two wording functions share
//! them instead of each spelling the bound and the recognition rule a second
//! time. They moved in from `model_list::diagnosis`, which re-exports them at its
//! own visibility so that its callers were not edited for the move.
//!
//! A leaf: nothing here reaches the network, the filesystem or the app handle,
//! so every wording is testable against a recorded body with no endpoint.
//! [`super::response`] re-exports these names, which is what keeps `client` and
//! the integration tests importing them from where they always have.

/// Build a readable, provider-agnostic failure message for a non-2xx HTTP
/// status returned by an AI provider.
///
/// `Response::error_for_status` only flags 4xx/5xx (client/server errors), so
/// in practice `status` is one of those ranges; the mapping stays total so an
/// unknown code still yields a generic line, making the function safe to call
/// directly and unit-testable without a live endpoint. Extracting it keeps
/// `list_models` and `stream_complete` from each re-deriving a one-off message,
/// and surfaces a friendly hint (e.g. a bad API key hides a 401 as "无效") instead
/// of a bare reqwest status string.
pub fn http_error_message(status: u16) -> String {
    http_error_message_with_detail(status, None)
}

/// The status hint, with the provider's own explanation appended when there is
/// one.
///
/// The status alone routinely points at the wrong thing. Measured against a
/// real gateway: an unknown MODEL NAME is answered with HTTP 403 and a body
/// saying `The current group does not support the requested model …; available
/// models: deepseek-flash` — so the user was told "your API key is invalid" and
/// spent their time re-entering a key that worked perfectly, while the message
/// that named the usable model sat in a response body nobody read. An image
/// sent to a text-only model is a 400 ("unsupported image"), which read as
/// "malformed request". A 402 is a billing problem, not a network one.
///
/// The detail is taken from the provider's JSON (`error.message`) when it
/// parses, otherwise the raw text is used verbatim; it is capped so a provider
/// cannot fill the toast with a wall of text.
pub fn http_error_message_with_detail(status: u16, detail: Option<&str>) -> String {
    http_error_message_at(None, status, detail)
}

/// Phrases that name the model's own context window, i.e. "the request did not
/// fit" — the one 400 whose cause the status hint below gets backwards.
///
/// The first is **observed**, not recalled: sent to the gateway this app is
/// configured against (`https://tokenflux.dev/v1`, model `deepseek-flash`), a
/// request past the window came back HTTP 400 with
/// `This model's maximum context length is 1048576 tokens. However, you
/// requested 1420272 tokens (1027056 in the messages, 393216 in the
/// completion). Please reduce the length of the messages or completion.` — the
/// provider naming the length while the app told the user their *format* was
/// wrong, which sends them looking for a broken image.
///
/// The rest are the wordings the providers this app speaks to are documented to
/// answer the same condition with — kept as a list of data so the next person
/// can correct one against a real body without touching the logic that reads
/// them.
///
/// Every entry is a phrase rather than a word on purpose: `max_tokens`,
/// `token` or `length` alone also appears in 400s that have nothing to do with
/// the window (measured on the same gateway: `Invalid max_tokens value, the
/// valid range of max_tokens is [1, 393216]`, and a rejected `reasoning_effort`
/// naming its six valid values), and a classifier that fires on those would be
/// lying in the other direction.
const CONTEXT_OVERFLOW_MARKERS: [&str; 9] = [
    "maximum context length",
    "context length exceeded",
    "context_length_exceeded",
    "context window",
    "reduce the length of the messages",
    "prompt is too long",
    "exceeds the maximum number of tokens",
    "too many tokens",
    "input is too long",
];

/// The hint for a request the model's own window refused.
///
/// Direction, and why it is the opposite of the truncation notice's: the app's
/// budget decides how much of the note is attached, so a note cut down to the
/// budget is answered by RAISING it (`contextTruncatedNotice`, Settings → AI)
/// and a request that still did not fit is answered by LOWERING it. Both name
/// the same setting because both are settled in the same place — the budget has
/// to sit between what the model accepts and what the note needs — and a reader
/// who meets only one of the two would take it for a contradiction.
///
/// It says "length, not format" because the hint it replaces said the opposite,
/// and a user who has seen that message once will look for the malformed part
/// until something tells them there is not one.
const CONTEXT_OVERFLOW_HINT: &str =
    "本次请求超出了模型能接收的上下文长度——内容太长，不是请求格式的问题。\
请缩短当前笔记，或在“设置 → AI”里把“笔记上下文长度”调小后重试；换用上下文窗口更大的模型也可以";

/// Whether the provider's own explanation says the request did not fit the
/// model's context window (see [`CONTEXT_OVERFLOW_MARKERS`]).
fn names_context_overflow(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    CONTEXT_OVERFLOW_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

/// The status hint, with the address that answered and the provider's own
/// explanation appended when there are any.
///
/// Naming the endpoint is not decoration: the user typed a Base URL, the app
/// derived a path from it, and only the derived URL shows which of the two the
/// provider disagreed with. Both extras are omitted rather than faked when the
/// caller has neither, so the message stays total — and identical to the
/// URL-less form it has always produced.
///
/// The status is checked *against* the detail rather than on its own: a 400 is
/// the status a context overflow arrives under, and the format hint that status
/// produces is the one message in this function that is worse than saying
/// nothing, because the user who overflows is the user this app's context
/// budget exists for. Only the statuses that family of rejections uses are
/// overridden (400, 413, 422); an auth or rate-limit hint is never rewritten
/// from a provider's prose.
pub fn http_error_message_at(url: Option<&str>, status: u16, detail: Option<&str>) -> String {
    let overflowed = matches!(status, 400 | 413 | 422)
        && detail.map(str::trim).is_some_and(names_context_overflow);
    let hint = if overflowed {
        CONTEXT_OVERFLOW_HINT
    } else {
        match status {
            400 => "请求格式不正确（模型可能不支持本次内容，例如图片）",
            401 => "API Key 无效，请检查设置",
            402 => "账户余额不足，请检查服务商账单",
            403 => "没有权限：可能是 API Key 或模型名不被该服务商支持",
            404 => "接口或模型不存在，请检查 Base URL 与模型名",
            413 => "请求体过大（图片或附件太多）",
            422 => "服务商无法处理本次请求",
            429 => "请求过于频繁，请稍后重试",
            500 | 502 | 503 | 504 => "服务端暂时不可用，请稍后重试",
            _ => "请求失败",
        }
    };
    let mut parts = vec![format!("AI 请求失败：HTTP {status}，{hint}")];
    if let Some(url) = url {
        parts.push(format!("请求地址：{url}"));
    }
    if let Some(detail) = detail.map(str::trim).filter(|d| !d.is_empty()) {
        let mut shown = detail.to_string();
        if shown.chars().count() > 300 {
            shown = shown.chars().take(300).collect::<String>() + "…";
        }
        parts.push(format!("服务商说明：{shown}"));
    }
    parts.join("。")
}

/// A human-readable message from a non-2xx response body, for the two JSON
/// shapes the supported providers use. Falls back to the trimmed body text.
pub fn error_detail_from_body(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(message) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .or_else(|| v.get("error").and_then(|e| e.as_str().map(|_| e)))
            .or_else(|| v.get("message"))
            .and_then(|m| m.as_str())
        {
            return Some(message.to_string());
        }
    }
    Some(trimmed.to_string())
}

/// How much of an unexpected body a failure message shows.
///
/// Recognition, not fidelity: an HTML fallback is unmistakable from its
/// doctype, a gateway's sorry page from its first sentence. This is also the
/// bound that keeps a 124 KB single-page-app document out of a toast.
const BODY_PREVIEW_CHARS: usize = 120;

/// The opening of a body, whitespace collapsed, for showing the user what
/// actually came back.
///
/// Collapsing matters as much as truncating: the bodies worth showing are
/// pretty-printed documents and multi-line error pages, and their meaning lives
/// in the first line, not in the blank lines between them.
pub(crate) fn body_preview(body: &str) -> String {
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut shown: String = collapsed.chars().take(BODY_PREVIEW_CHARS).collect();
    if collapsed.chars().count() > BODY_PREVIEW_CHARS {
        shown.push('…');
    }
    shown
}

/// True when a body reads as a web page rather than a provider response.
///
/// `<` as the first non-whitespace byte is markup — no JSON document starts
/// that way — and a declared `text/html` says the same for a page whose doctype
/// sits behind a BOM or whose head was rewritten in transit. Only ever asked
/// about a body the app has ALREADY failed to read as what it asked for — not
/// JSON for a model list, no event for a completion — which is what keeps an API
/// that mislabels its own payload (`text/html` on a real one) readable.
pub(crate) fn reads_as_a_web_page(body: &str, content_type: &str) -> bool {
    body.trim_start().starts_with('<') || content_type.contains("html")
}

/// The failure to report when a 2xx from the completion endpoint yielded no
/// event at all.
///
/// The state this is written for is NOT "the model said nothing" — that is a
/// completion whose frames arrived, and it stays a no-op (see
/// [`super::refusal::completion_refusal`]). It is "we could not read the
/// response": the fold parsed no event, so the answer is empty for a reason that
/// has nothing to do with the model, and the user is watching a document that
/// nothing is being typed into. Measured against this app's providers, the
/// common cause is an address the provider did not recognise, answered with HTTP
/// 200 and its frontend; the rest is an upstream breaking its own contract —
/// which is why the message shows the body instead of guessing at one of them.
///
/// Both shapes name `url`, for the reason `model_list`'s diagnosis gives: it is
/// DERIVED from the Base URL, and a reader cannot tell a typo'd Base URL from a
/// broken provider without knowing which address answered. Both name the
/// declared content type and show the same bounded preview, and the web-page
/// shape says the setting to check, because "it answered with a page" is the one
/// cause with an obvious fix.
pub fn unreadable_response_error(url: &str, content_type: &str, head: &str) -> String {
    let declared = if content_type.trim().is_empty() {
        "未声明"
    } else {
        content_type.trim()
    };
    let diagnosis = if reads_as_a_web_page(head, content_type) {
        format!(
            "{url} 返回的是网页（HTML）而不是事件流（Content-Type: {declared}），\
             Base URL 很可能填错了，请在设置里检查"
        )
    } else {
        format!(
            "{url} 这次没有读到任何可解析的响应事件（Content-Type: {declared}），\
             因此没有生成任何内容；请检查设置里的 Base URL 是否正确"
        )
    };
    // A blank body has no preview to show and must not pretend to: the empty
    // clause says the same thing in one word.
    let preview = body_preview(head);
    if preview.is_empty() {
        format!("AI 生成失败：{diagnosis}。响应体为空。")
    } else {
        format!("AI 生成失败：{diagnosis}。服务商返回内容开头：{preview}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The provider's own words for a request past the model's window. Recorded
    /// verbatim from a live call to `https://tokenflux.dev/v1` (model
    /// `deepseek-flash`), which is what makes the classifier testable against a
    /// real rejection instead of a guess at one.
    const OBSERVED_OVERFLOW: &str = "This model's maximum context length is 1048576 tokens. \
However, you requested 1420272 tokens (1027056 in the messages, 393216 in the completion). \
Please reduce the length of the messages or completion.";

    /// Two 400s from the same gateway, recorded the same way, that are NOT about
    /// the window — the false positives this classifier must not produce.
    const OBSERVED_OTHER_400: [&str; 2] = [
        "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]",
        "Failed to deserialize the JSON body into the target type: reasoning_effort: unknown variant `bogus-level`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` at line 1 column 74",
    ];

    #[test]
    fn a_context_overflow_is_named_as_one_and_says_what_to_do() {
        let message = http_error_message_at(
            Some("https://tokenflux.dev/v1/chat/completions"),
            400,
            Some(OBSERVED_OVERFLOW),
        );
        // The cause, in the user's language...
        assert!(message.contains("上下文长度"), "{message}");
        // ...the instruction not to go looking for a malformed request...
        assert!(message.contains("不是请求格式的问题"), "{message}");
        // ...and both ways out: the setting (named as the truncation notice
        // names it) and the model.
        assert!(message.contains("设置 → AI"), "{message}");
        assert!(message.contains("笔记上下文长度"), "{message}");
        assert!(message.contains("上下文窗口更大的模型"), "{message}");
        // The provider's own numbers survive: they are the only measurement of
        // how far over the request was.
        assert!(message.contains("1048576 tokens"), "{message}");
        // And the format hint that had the cause backwards is gone.
        assert!(!message.contains("请求格式不正确"), "{message}");
    }

    #[test]
    fn a_400_that_is_not_about_the_window_keeps_the_hint_it_had() {
        for detail in OBSERVED_OTHER_400 {
            let message = http_error_message_with_detail(400, Some(detail));
            assert!(message.contains("请求格式不正确"), "{message}");
            assert!(!message.contains("上下文长度"), "{message}");
        }
        // No detail at all is not evidence of anything.
        assert!(http_error_message_with_detail(400, None).contains("请求格式不正确"));
    }

    #[test]
    fn a_window_rejection_is_named_whatever_status_carries_it() {
        // Providers disagree about the code (400/413/422); the body is what
        // says which condition it is. The same body under an auth status is not
        // touched: a 401 is about the key, not about length.
        for status in [400, 413, 422] {
            assert!(
                http_error_message_with_detail(
                    status,
                    Some("prompt is too long: 218500 tokens > 200000 maximum")
                )
                .contains("上下文长度"),
                "status {status}"
            );
        }
        let unauthorized = http_error_message_with_detail(401, Some("context window exceeded?"));
        assert!(unauthorized.contains("API Key 无效"), "{unauthorized}");
    }

    #[test]
    fn the_status_message_names_the_url_only_when_it_has_one() {
        // The URL-less form is what the completion path and the older public
        // API still produce, byte for byte.
        assert_eq!(
            http_error_message_at(None, 404, None),
            http_error_message_with_detail(404, None)
        );
        let named =
            http_error_message_at(Some("https://api.example.com/v1/models"), 404, Some("nope"));
        assert!(
            named.contains("https://api.example.com/v1/models"),
            "{named}"
        );
        assert!(named.contains("nope"), "{named}");
    }

    // --- the two primitives both unfaithful-2xx diagnoses are built from -------

    #[test]
    fn a_preview_is_collapsed_and_bounded() {
        // A pretty-printed page must not put its blank lines into the toast,
        // and its tail must not come along at all.
        let page = format!("<!DOCTYPE html>\n\n<html>\n{}</html>", "x".repeat(4000));
        let preview = body_preview(&page);
        assert_eq!(preview.chars().count(), BODY_PREVIEW_CHARS + 1); // + the ellipsis
        assert!(preview.starts_with("<!DOCTYPE html> <html>"));
    }

    #[test]
    fn a_page_is_recognised_by_its_body_or_by_its_declared_type() {
        for (body, content_type) in [
            ("<!DOCTYPE html>", "application/json"),
            ("  \n\t<html>", ""),
            // A doctype behind a BOM is not a `<` at the first byte; the
            // declared type is what catches it.
            ("\u{feff}<html>", "text/html; charset=utf-8"),
        ] {
            assert!(
                reads_as_a_web_page(body, content_type),
                "{body:?} / {content_type:?} must read as a page"
            );
        }
        for (body, content_type) in [
            ("upstream connect error", "text/plain"),
            ("[1,2,3]", "application/json"),
        ] {
            assert!(!reads_as_a_web_page(body, content_type));
        }
    }

    // --- the completion path's unfaithful 2xx ---------------------------------

    /// The report this wording exists for: a provider answers a path it does not
    /// recognise with HTTP 200 and its single-page-app fallback, so the
    /// completion "succeeded" with no answer and nothing was said about it. The
    /// message has to name the address, call the page a page, and point at the
    /// setting the user can actually change.
    #[test]
    fn a_web_page_answered_to_a_completion_names_the_url_and_the_setting() {
        let page = format!(
            "<!DOCTYPE html><html><body>{}</body></html>",
            "x".repeat(4000)
        );

        let message = unreadable_response_error(
            "https://gateway.test/v1/chat/completions",
            "text/html; charset=utf-8",
            &page,
        );

        assert!(
            message.contains("https://gateway.test/v1/chat/completions"),
            "the failure must name the address it asked: {message}"
        );
        assert!(
            message.contains("HTML"),
            "the failure must say the answer was a web page: {message}"
        );
        assert!(
            message.contains("text/html; charset=utf-8"),
            "the declared type is part of what came back: {message}"
        );
        assert!(
            message.contains("Base URL"),
            "the failure must point at the setting to fix: {message}"
        );
        assert!(
            message.contains("<!DOCTYPE html>"),
            "the failure must show the start of the body: {message}"
        );
        assert!(
            !message.contains("</body>"),
            "a bounded preview, never the page: {message}"
        );
    }

    /// Everything else that yielded no event: the declared type is named, the
    /// body is shown as it came, and nothing claims it was a page.
    #[test]
    fn anything_else_that_yielded_no_event_is_shown_as_it_came() {
        let message = unreadable_response_error(
            "https://gateway.test/v1/chat/completions",
            "text/plain",
            "upstream connect error or disconnect",
        );
        assert!(message.contains("text/plain"), "{message}");
        assert!(message.contains("upstream connect error"), "{message}");
        assert!(
            !message.contains("HTML"),
            "a text page is not a web page: {message}"
        );

        // A body the peer did not label is said rather than guessed, and a blank
        // one is not offered a preview it does not have.
        let unlabelled =
            unreadable_response_error("https://gateway.test/v1/chat/completions", "", "  ");
        assert!(unlabelled.contains("未声明"), "{unlabelled}");
        assert!(unlabelled.contains("响应体为空"), "{unlabelled}");
        assert!(
            !unlabelled.contains("服务商返回内容开头"),
            "an empty body must not be shown as a preview: {unlabelled}"
        );
    }
}
