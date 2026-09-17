//! What a failed model-list request says to the user: the whole cause chain
//! behind a transport failure, the proxy it went through, and a bounded view of
//! the body that came back when it was not a model list.
//!
//! Extracted from [`super`] as one vertical slice, because explaining a failure
//! and getting the answer are two concerns: this one is wording, driven only by
//! the error or the bytes it is handed, so the sentences a user reads can be
//! changed, and the diagnosis they describe can be tested, without a socket or
//! a round trip.
//!
//! Dependencies: [`super::super::error_message`] for the two primitives the
//! other unfaithful-2xx diagnosis shares with this one — the preview and the
//! web-page recognition — which live there because both callers must hold the
//! same bound and the same rule. They are re-exported at this module's own
//! visibility so that `super`'s callers kept their imports through the move.

// `pub(super)` rather than a plain `use`: `super` imported both names from this
// module before they moved to the wording leaf, and a split moves code rather
// than the paths its callers use.
pub(super) use super::super::error_message::{body_preview, reads_as_a_web_page};

/// A transport failure with its **whole** cause chain appended.
///
/// `reqwest::Error`'s own `Display` prints the top-level kind and the URL —
/// `error sending request for url (…)` — and then its source *only when it has
/// one*. A connect failure that arrives with no appended source therefore reaches
/// the user as a sentence naming neither the cause nor any way to find it.
///
/// That is not hypothetical: this exact message was reported twice, and one
/// build later the same request succeeded **ten times out of ten** from a test
/// process using the app's own `list_models` on the same machine — so the
/// difference had to be in the app process's own environment (a proxy, a
/// resolver, a trust store) and the message said nothing about which. Walking
/// `source()` by hand is what makes the next report name the cause instead of
/// restating the symptom.
///
/// Takes `&dyn Error` rather than `&reqwest::Error` so the walk itself is
/// testable: a `reqwest::Error` cannot be constructed by hand, and an untestable
/// error formatter is how this one came to be written in the first place.
pub(super) fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    let mut depth = 0;
    while let Some(s) = source {
        depth += 1;
        // A reqwest error's source is frequently another reqwest error repeating
        // the parent's text verbatim; only a line that adds something is worth
        // printing, and the cap stops a misbehaving chain becoming the toast.
        let text = s.to_string();
        if !out.contains(&text) {
            out.push_str(" → ");
            out.push_str(&text);
        }
        if depth >= 8 {
            break;
        }
        source = s.source();
    }
    out
}

/// The proxy this request will go through, if the environment names one.
///
/// reqwest reads the conventional variables itself and exposes nothing about the
/// result, so the only way to tell a user "this failed through a proxy you may
/// have forgotten about" is to read the same variables. It is worth saying out
/// loud: a `127.0.0.1:7890` left over from a proxy client that is no longer
/// running produces exactly the failure this function is called for, and it is
/// invisible from inside the app otherwise.
fn proxy_in_use() -> Option<String> {
    const VARS: [&str; 6] = [
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ];
    VARS.iter().find_map(|k| match std::env::var(k) {
        Ok(v) if !v.trim().is_empty() => Some(format!("{k}={}", v.trim())),
        _ => None,
    })
}

/// What to append to a send failure: the cause chain, and the proxy if one is in
/// play. Kept together because a proxy failure and a socket failure read the
/// same at the top of the chain and are told apart by this line.
pub(super) fn transport_failure_note(e: &reqwest::Error) -> String {
    match proxy_in_use() {
        Some(p) => format!("{}；本次请求经由代理 {p}", error_chain(e)),
        None => error_chain(e),
    }
}

/// The failure to report when a 2xx body is not the provider's JSON.
///
/// Two shapes, because they mean different things to the user. A body that
/// reads as a web page is a wrong-URL symptom — the report this workstream
/// exists for: the provider answers every path it does not recognise with HTTP
/// 200 and the same 124 KB SPA document, so a typo'd Base URL does not fail, it
/// "succeeds" with a web page. Anything else is an upstream breaking its own
/// contract. Both name the URL, because neither is diagnosable without it, and
/// both show a bounded preview: the message this replaces was a bare serde
/// offset (`expected value at line 1 column 1`) describing a body the user had
/// never seen, which is what made the original report unanswerable.
pub(super) fn unexpected_body_error(url: &str, content_type: &str, body: &str) -> String {
    let preview = body_preview(body);
    if reads_as_a_web_page(body, content_type) {
        return format!(
            "模型列表请求失败：{url} 返回的是网页（HTML）而不是模型列表，Base URL 很可能填错了。\
             请在设置里检查 Base URL，或直接填写「模型列表 URL」——\
             这里的地址会被原样请求。服务商返回内容开头：{preview}"
        );
    }
    let declared = if content_type.is_empty() {
        "未声明"
    } else {
        content_type
    };
    format!(
        "模型列表请求失败：{url} 返回的内容不是 JSON（Content-Type: {declared}）。\
         请检查 Base URL 是否正确。服务商返回内容开头：{preview}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;

    /// An error that carries another, so a chain can be built by hand —
    /// `reqwest::Error` cannot be constructed in a test, which is why
    /// [`error_chain`] takes `&dyn Error` in the first place.
    #[derive(Debug)]
    struct Layer {
        message: String,
        source: Option<Box<Layer>>,
    }

    impl Layer {
        fn leaf(message: &str) -> Box<Layer> {
            Box::new(Layer {
                message: message.into(),
                source: None,
            })
        }

        fn over(message: &str, source: Box<Layer>) -> Box<Layer> {
            Box::new(Layer {
                message: message.into(),
                source: Some(source),
            })
        }
    }

    impl fmt::Display for Layer {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(&self.message)
        }
    }

    impl std::error::Error for Layer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.source
                .as_ref()
                .map(|b| b.as_ref() as &(dyn std::error::Error + 'static))
        }
    }

    #[test]
    fn a_bare_error_is_reported_as_itself() {
        // The reported symptom, verbatim: one sentence and no cause. It must not
        // gain padding — the fix is to add the cause when there IS one, not to
        // decorate the case where there is not.
        let e = Layer::leaf("error sending request for url (https://example.test/v1/models)");
        assert_eq!(error_chain(e.as_ref()), e.message);
    }

    #[test]
    fn the_whole_cause_chain_is_appended_in_order() {
        let e = Layer::over(
            "error sending request",
            Layer::over(
                "error trying to connect",
                Layer::leaf("tcp connect error: connection refused"),
            ),
        );
        assert_eq!(
            error_chain(e.as_ref()),
            concat!(
                "error sending request → ",
                "error trying to connect → ",
                "tcp connect error: connection refused",
            ),
        );
    }

    #[test]
    fn a_source_repeating_its_parent_is_not_printed_twice() {
        // reqwest wraps its own error several layers deep, so the same sentence
        // arrives repeatedly; printing it each time is what buries the one line
        // that would have answered the bug report.
        let e = Layer::over(
            "error sending request",
            Layer::leaf("error sending request"),
        );
        assert_eq!(error_chain(e.as_ref()), "error sending request");
    }

    #[test]
    fn a_chain_that_never_ends_is_capped() {
        // Nothing may turn a toast into an unbounded walk, so the cap is what
        // makes this safe to call on an error a peer ultimately influenced.
        let mut e = Layer::leaf("layer 0");
        for i in 1..20 {
            e = Layer::over(&format!("layer {i}"), e);
        }
        assert_eq!(error_chain(e.as_ref()).matches('\u{2192}').count(), 8);
    }

    // The preview's bound and the web-page rule moved with them to
    // `super::super::error_message`, which is where their tests are now: the
    // completion path's unfaithful-2xx diagnosis shares both, and a bound two
    // modules enforce is a bound one of them can drift from.
}
