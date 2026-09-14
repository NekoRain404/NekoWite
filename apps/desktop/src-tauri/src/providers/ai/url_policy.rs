//! Which hosts an AI request may be sent to: the HTTPS rule for public
//! addresses and the SSRF guard for private, loopback, link-local and CGNAT
//! ones, together with the [`VettedHost`] answer that lets the client be pinned
//! to exactly the addresses that were checked.
//!
//! The ranges the guard reads live in `address_ranges`: whether a URL may be
//! dialled is one concern and which addresses are private is another, and only
//! the second one is a table of RFCs that takes an address and answers.
//!
//! Dependencies: [`super::request`] for the configuration whose `base_url` and
//! `allow_private` flag are being judged, and `address_ranges` for the
//! predicates. Nothing here imports `client`, `response` or `sse`, so the
//! module is a near-leaf and cannot join a cycle.

mod address_ranges;

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};

use self::address_ranges::{is_private_or_loopback_host, is_private_or_loopback_ip};
use super::request::AIConfig;

/// Guard against SSRF / internal-endpoint abuse via a user-supplied `base_url`,
/// and against handing the API key to a plaintext public endpoint.
///
/// Two rules, and the second one is NOT waived by the opt-in:
///
///   * **A public Base URL must be HTTPS.** HTTP is only for local development
///     addresses — `localhost`, a loopback IP, or (under the opt-in) a private
///     LAN host — so the key can never cross the public internet in the clear.
///   * **Without [`AIConfig::allow_private`]**, a host that is (or resolves to)
///     a literal private, loopback, link-local, CGNAT or unspecified address is
///     rejected, and the addresses that were vetted are returned so the client
///     can be pinned to exactly those.
///
/// [`AIConfig::allow_private`] waives the SSRF guard for a local model server
/// (Ollama / LM Studio). It does not waive the URL parse, the scheme rule or the
/// host requirement: the flag is about REACHING a private address, not about
/// dropping transport security on the public internet.
pub fn validate_base_url(cfg: &AIConfig) -> Result<Option<VettedHost>, String> {
    let Some(base) = cfg.base_url.as_deref() else {
        return Ok(None);
    };
    if cfg.allow_private {
        let url = parse_base_url(base)?;
        reject_plaintext_public_url(&url, base)?;
        return Ok(None);
    }
    validate_public_url(base).map(Some)
}

/// The addresses that were vetted for a user-supplied Base URL.
///
/// The HTTP client is pinned to exactly these, so the address reqwest dials is
/// the address this check approved. Without the pin the name is resolved
/// twice — once here, once inside reqwest — and a TTL-0 record can answer
/// `127.0.0.1` to the second lookup after answering a public address to the
/// first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VettedHost {
    /// The bare hostname (no IPv6 brackets) the addresses belong to.
    pub host: String,
    /// Empty for a literal-IP Base URL: there is no name to pin.
    pub addrs: Vec<SocketAddr>,
}

fn validate_public_url(base: &str) -> Result<VettedHost, String> {
    validate_public_url_with(base, resolve_host_addrs)
}

/// Resolve `host` to the socket addresses a connection could go to.
///
/// A resolution failure is surfaced, never swallowed: an unresolvable name
/// cannot be shown to be public, and treating that as "public" let the request
/// through completely unchecked.
fn resolve_host_addrs(host: &str) -> Result<Vec<SocketAddr>, String> {
    (host, 0u16)
        .to_socket_addrs()
        .map(|addrs| addrs.collect())
        .map_err(|_| {
            format!(
                "AI Base URL 的主机名无法解析：{host}。请检查网络连接、DNS 设置，或改用其他地址。"
            )
        })
}

fn private_url_error(host: &str) -> String {
    format!(
        "AI Base URL 指向了本机/内网地址（{host}）。为安全起见已默认拒绝连接内网。\
         如果你确实要连接本地模型（如 Ollama / LM Studio），请在设置中开启“允许本地/内网地址”后再试。"
    )
}

/// Parse a Base URL and require the shape every caller depends on: a scheme the
/// client can actually speak and a host to send to.
fn parse_base_url(base: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(base)
        .map_err(|_| format!("AI Base URL 无效：{base}（应为 http:// 或 https:// 格式）"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("AI Base URL 必须使用 http:// 或 https://：{base}"));
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err(format!("AI Base URL 缺少主机名：{base}"));
    }
    Ok(url)
}

/// Refuse a plaintext URL whose host is not local.
///
/// This is the rule that keeps the API key off the wire in the clear. The key
/// rides in `Authorization` / `x-api-key` / `x-goog-api-key`, and reqwest sends
/// those over `http://` without complaint, visible to every hop between here and
/// the provider. A local address is exempt because a local model server has no
/// certificate to offer and `http://localhost:11434` is the documented Ollama /
/// LM Studio setup — the credential never leaves the machine (or, for a host
/// the user explicitly opted into, the local network).
fn reject_plaintext_public_url(url: &reqwest::Url, base: &str) -> Result<(), String> {
    if url.scheme() != "http" {
        return Ok(());
    }
    let host = url.host_str().unwrap_or("");
    if is_private_or_loopback_host(host) {
        return Ok(());
    }
    Err(format!(
        "AI Base URL 使用了明文 HTTP，而主机（{host}）不是本机地址：{base}。\
         为避免 API Key 以明文发送到公网，公共地址必须使用 https://；\
         只有本机/内网开发地址（如 http://localhost:11434）可以使用 HTTP。"
    ))
}

fn validate_public_url_with(
    base: &str,
    resolve: impl Fn(&str) -> Result<Vec<SocketAddr>, String>,
) -> Result<VettedHost, String> {
    let url = parse_base_url(base)?;
    // The scheme rule is decided BEFORE resolution: it is the one rule that
    // cannot be waived, and a plaintext public URL must be refused on its own
    // terms rather than after a DNS lookup that a name-based bypass could steer.
    reject_plaintext_public_url(&url, base)?;
    let host = url.host_str().unwrap_or("");
    if is_private_or_loopback_host(host) {
        return Err(private_url_error(host));
    }
    // `host_str()` keeps the brackets around an IPv6 literal; they are neither
    // part of the address nor of the name reqwest resolves.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    // A literal IP was fully decided by the check above: there is no name to
    // pin, and "resolving" it would just hand back the same address.
    if bare.parse::<IpAddr>().is_ok() {
        return Ok(VettedHost {
            host: bare.to_string(),
            addrs: Vec::new(),
        });
    }
    // A hostname must not be allowed to bypass the check by resolving to a
    // loopback or RFC1918 address — and a name that does not resolve at all
    // must be refused rather than waved through.
    let addrs = resolve(bare)?;
    if addrs.is_empty() {
        return Err(format!(
            "AI Base URL 的主机名没有解析到任何地址：{bare}。请检查 DNS 设置或改用其他地址。"
        ));
    }
    if addrs.iter().any(|a| is_private_or_loopback_ip(a.ip())) {
        return Err(private_url_error(host));
    }
    Ok(VettedHost {
        host: bare.to_string(),
        addrs,
    })
}

#[cfg(test)]
mod tests {
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

    /// A vetted address for the injected resolvers below. Port is irrelevant
    /// to the policy under test.
    fn sa(ip: &str) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), 443)
    }

    #[test]
    fn accepts_public_https_bases() {
        // The resolver is injected so this test asserts the scheme/host policy
        // and never touches the network or depends on real DNS.
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
    /// This USED to be accepted ("http://203.0.113.9:8000/v1" sat in the
    /// accepted list above) — the request went out with the API key in an
    /// `Authorization` header over plaintext, readable by every hop. The check
    /// here must decide before resolution, so a name never causes a lookup it
    /// was going to fail anyway.
    #[test]
    fn rejects_plaintext_http_to_a_public_host() {
        let resolve =
            |_host: &str| panic!("a plaintext public URL must be refused before any lookup");
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
        // default path — that is what `allow_private` exists to lift).
        for base in ["http://localhost:11434", "http://127.0.0.1:11434"] {
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
        // A name that does not resolve cannot be shown to be public. Treating
        // this as "public" let the request through with no check at all.
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
}
