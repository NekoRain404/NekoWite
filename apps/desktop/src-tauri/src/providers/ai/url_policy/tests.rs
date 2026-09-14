//! The URL-level guard's tests: which Base URLs are accepted, which are
//! refused, and which of the two rules does the refusing.
//!
//! Beside `url_policy.rs` rather than inside it, cut on the same seam as
//! `address_ranges`: the range table is exercised with an address alone, while
//! everything here needs a URL, a config and (where a name is involved) an
//! injected resolver. The file above passed the 400-line rung when the
//! IPv4-embedded forms were added, and the parts that grew were these.

use super::*;

#[test]
fn rejects_loopback_and_private_bases() {
    for base in [
        "http://localhost:11434",
        "http://localhost:11434/v1",
        "http://127.0.0.1:11434",
        "http://10.0.0.5",
        "http://172.16.0.1",
        "http://172.31.255.255",
        "http://192.168.1.1",
        "http://169.254.169.254",
        "http://100.64.0.1",
        "http://0.0.0.0:8080",
        "http://[::1]:8080",
        "http://[fc00::1]",
        "http://[fe80::1]",
        "http://[::ffff:127.0.0.1]",
    ] {
        assert!(validate_public_url(base).is_err(), "should reject {base}");
    }
}

/// Finding u2 at the URL level. Before the fix, `[::127.0.0.1]` reached the end
/// of the guard and came back as `VettedHost { host: "::7f00:1", addrs: [] }` —
/// accepted, and with nothing to resolve there was no second check behind the
/// first one to catch it either.
///
/// The other two forms ride in the same test because they are the same defect:
/// a literal whose embedded IPv4 address was never decoded.
#[test]
fn an_ipv4_embedded_literal_is_rejected_by_the_private_rule() {
    let resolve = |_host: &str| panic!("a literal IP must never be resolved");
    for base in [
        "https://[::127.0.0.1]:11434/v1",
        "https://[::7f00:1]:11434/v1", // what the parser canonicalises the line above to
        "http://[::127.0.0.1]:11434",
        "https://[::ffff:0:127.0.0.1]:11434/v1", // IPv4-translated
        "https://[64:ff9b::192.168.1.1]:11434/v1", // NAT64 well-known prefix
    ] {
        let err = validate_public_url_with(base, resolve)
            .expect_err("an embedded private address must be refused");
        assert!(err.contains("本机/内网地址"), "{base}: {err}");
    }
}

/// The other half of the same rule, and the half a cruder fix breaks: a literal
/// whose embedded IPv4 address is public is not a private host.
#[test]
fn a_literal_embedding_a_public_ipv4_is_still_accepted() {
    for base in [
        "https://[2606:4700:4700::1111]/v1", // reads as 0.0.17.17 if decoded blindly
        "https://[::ffff:8.8.8.8]/v1",
        "https://[64:ff9b::8.8.8.8]/v1", // a public address behind NAT64
    ] {
        assert!(validate_public_url(base).is_ok(), "should accept {base}");
    }
}

/// A name is not a way around the same check: the addresses it resolves to go
/// through the range table too, and one private answer among public ones is
/// enough to refuse.
#[test]
fn a_hostname_resolving_to_an_ipv4_embedded_form_is_rejected() {
    let resolve = |_host: &str| Ok(vec![sa("203.0.113.9"), sa("::127.0.0.1")]);
    assert!(validate_public_url_with("https://dual.example.com", resolve).is_err());
}

/// A vetted address for the injected resolvers below. Port is irrelevant to the
/// policy under test.
fn sa(ip: &str) -> SocketAddr {
    SocketAddr::new(ip.parse().unwrap(), 443)
}

#[test]
fn accepts_public_https_bases() {
    // The resolver is injected so this test asserts the scheme/host policy and
    // never touches the network or depends on real DNS.
    let public = |_host: &str| Ok(vec![sa("203.0.113.9")]);
    for base in [
        "https://api.openai.com/v1",
        "https://generativelanguage.googleapis.com",
        "https://api.anthropic.com",
        "https://llm.internal.example.com",
    ] {
        assert!(
            validate_public_url_with(base, public).is_ok(),
            "should accept {base}"
        );
    }
}

/// The roadmap's rule, at the unit level: a public Base URL must be HTTPS.
///
/// This USED to be accepted ("http://203.0.113.9:8000/v1" sat in the accepted
/// list above) — the request went out with the API key in an `Authorization`
/// header over plaintext, readable by every hop. The check here must decide
/// before resolution, so a name never causes a lookup it was going to fail
/// anyway.
#[test]
fn rejects_plaintext_http_to_a_public_host() {
    let resolve = |_host: &str| panic!("a plaintext public URL must be refused before any lookup");
    for base in [
        "http://203.0.113.9:8000/v1",
        "http://llm.example.com/v1",
        "http://8.8.8.8/v1",
    ] {
        let err = validate_public_url_with(base, resolve)
            .expect_err("plain HTTP to a public host must be refused");
        assert!(err.contains("https://"), "{base}: {err}");
        assert!(err.contains("明文"), "{base}: {err}");
    }
}

#[test]
fn a_local_http_base_is_kept_for_the_opt_in_path() {
    // `localhost` and loopback are the one HTTP exemption, so the plaintext
    // rule must not be what refuses them (the private-host rule is, on the
    // default path — that is what `allow_private` exists to lift). The embedded
    // spelling is the same concession: it is loopback, and it is only now
    // recognised as such.
    for base in [
        "http://localhost:11434",
        "http://127.0.0.1:11434",
        "http://[::127.0.0.1]:11434",
    ] {
        let cfg = AIConfig {
            base_url: Some(base.into()),
            allow_private: true,
            ..Default::default()
        };
        assert!(validate_base_url(&cfg).is_ok(), "{base} must stay usable");
    }
}

#[test]
fn rejects_non_http_schemes_and_missing_host() {
    assert!(validate_public_url("ftp://example.com").is_err());
    assert!(validate_public_url("file:///etc/passwd").is_err());
    assert!(validate_public_url("http://").is_err());
    assert!(validate_public_url("not a url").is_err());
}

#[test]
fn hostname_resolving_to_loopback_is_rejected() {
    let resolve = |host: &str| {
        if host == "evil.example.com" {
            Ok(vec![sa("127.0.0.1")])
        } else {
            Ok(vec![sa("203.0.113.9")])
        }
    };
    assert!(
        validate_public_url_with("https://evil.example.com/v1", resolve).is_err(),
        "DNS to loopback must be rejected"
    );
    assert!(
        validate_public_url_with("https://ok.example.com/v1", resolve).is_ok(),
        "public resolution must still pass"
    );
}

#[test]
fn mixed_public_and_private_resolved_ips_are_rejected() {
    let resolve = |_host: &str| Ok(vec![sa("203.0.113.9"), sa("10.0.0.1")]);
    assert!(validate_public_url_with("https://dual.example.com", resolve).is_err());
}

#[test]
fn unresolved_hostname_is_rejected() {
    // A name that does not resolve cannot be shown to be public. Treating this
    // as "public" let the request through with no check at all.
    let resolve = |_host: &str| Err("resolution failed".to_string());
    assert!(validate_public_url_with("https://no-such.example.invalid", resolve).is_err());
}

#[test]
fn a_hostname_resolving_to_nothing_is_rejected() {
    let resolve = |_host: &str| Ok(Vec::new());
    assert!(validate_public_url_with("https://empty.example.com", resolve).is_err());
}

#[test]
fn a_vetted_hostname_hands_back_the_addresses_to_pin() {
    // The pin is what closes the DNS-rebinding window: the client may only
    // connect to the addresses this check saw.
    let resolve = |_host: &str| Ok(vec![sa("203.0.113.9"), sa("203.0.113.10")]);
    let vetted =
        validate_public_url_with("https://ok.example.com/v1", resolve).expect("public host");
    assert_eq!(vetted.host, "ok.example.com");
    assert_eq!(vetted.addrs.len(), 2);
}

#[test]
fn a_literal_ip_base_has_nothing_to_pin_and_is_not_resolved() {
    let resolve = |_host: &str| panic!("a literal IP must never be resolved");
    let vetted = validate_public_url_with("https://203.0.113.9:8000/v1", resolve)
        .expect("public literal ip");
    assert!(vetted.addrs.is_empty());
}

#[test]
fn an_ipv6_literal_is_stripped_of_its_brackets_for_the_vetted_host() {
    let vetted = validate_public_url("https://[2606:4700:4700::1111]/v1").expect("public ipv6");
    assert_eq!(vetted.host, "2606:4700:4700::1111");
    assert!(vetted.addrs.is_empty());
}

#[test]
fn allow_private_opts_out() {
    let cfg = AIConfig {
        provider: "openai".into(),
        model: "gpt-4o".into(),
        base_url: Some("http://localhost:11434/v1".into()),
        allow_private: true,
        ..Default::default()
    };
    assert!(validate_base_url(&cfg).is_ok());
}

#[test]
fn default_bases_are_not_rejected() {
    let cfg = AIConfig {
        provider: "openai".into(),
        model: "gpt-4o".into(),
        ..Default::default()
    };
    assert!(validate_base_url(&cfg).is_ok());
}
