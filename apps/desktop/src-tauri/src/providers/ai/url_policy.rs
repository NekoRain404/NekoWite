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
mod tests;
