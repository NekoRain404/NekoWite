//! The URL policy the AI layer holds: HTTPS for anything not local, the deliberate
//! `allow_private` opt-in for a LAN address, and a key that never rides in a URL.

use nekowite_lib::providers::ai::client::{validate_base_url, AIConfig};

use super::support::{base_cfg, endpoint};

// --- P1 网络安全：HTTPS / localhost URL 策略 --------------------------------
//
// Roadmap rule: a Base URL that is not local must be HTTPS, so an API key can
// never travel to a public endpoint in the clear. HTTP stays available for the
// local-development addresses the product explicitly supports (Ollama / LM
// Studio on localhost), and for a private/LAN endpoint the user deliberately
// opted into with `allow_private`.

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

#[test]
fn gemini_url_has_no_key_embedded() {
    let cfg = AIConfig {
        provider: "gemini".into(),
        model: "gemini-2.5-pro".into(),
        api_key: Some("SECRET-KEY".into()),
        ..Default::default()
    };
    let (url, _body) = endpoint(&cfg, "hi", &[]);
    assert!(
        !url.contains("SECRET-KEY"),
        "key must not appear in URL: {url}"
    );
    assert!(
        !url.contains("key="),
        "url must not carry a key query param: {url}"
    );
}
