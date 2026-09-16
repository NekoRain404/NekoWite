//! §8's transfer rules for a download, and this build's answer to all of them.
//!
//! Nothing here makes a request. [`LIBRARY_ENDPOINT`] is `None`, so [`remote_fetch_plan`] answers
//! [`RemoteRefusal::NotConfigured`] before any other rule is consulted, and §8's
//! 「网络身份、服务条款、素材许可和数据流未确认前，只交付本地模式」 is a value in the source rather
//! than a promise in a plan. The rules below it are the specification §8 states — HTTPS, no
//! private or loopback address, bounded size, bounded time, a stated content type — kept here
//! because a rule that lives only in a plan is one the task that configures an endpoint would
//! have to derive again, and because the one place a URL may be spelled is easier to review than
//! a search for where one was.
//!
//! The endpoint is the only networking fact in this module and it is a constant rather than a
//! settings value: §10.1 makes a new endpoint a reviewed change to the repository, not a switch
//! a window may flip.

use serde::Serialize;

use super::MAX_PACKAGE_BYTES;

/// §8's row for a download: an endpoint, and nothing about the upstream project's domain.
///
/// `None` is the whole of this build's online behaviour, and it is a value rather than an absent
/// feature so that the day an endpoint is reviewed the change is one line here and not a search
/// for where a URL was spelled. §8 puts the online catalogue behind its own sub-plan with
/// 「明确端点与配置权限」, and until that is signed off 「只交付本地模式」.
pub const LIBRARY_ENDPOINT: Option<&str> = None;
/// §8's transfer budgets, in the same spirit: the numbers are here, and no request uses them yet.
pub const REMOTE_MAX_BYTES: u64 = MAX_PACKAGE_BYTES;
pub const REMOTE_TIMEOUT_MS: u64 = 20_000;
/// §8's content-type rule for the catalogue and one pack over it.
pub const REMOTE_CONTENT_TYPES: [&str; 3] = ["application/json", "image/png", "image/webp"];

pub fn remote_fetch_plan(endpoint: Option<&str>, url: &str) -> Result<FetchPlan, RemoteRefusal> {
    let Some(endpoint) = endpoint else {
        return Err(RemoteRefusal::NotConfigured);
    };
    // The endpoint is checked first and by the same rules, so a catalogue configured at an
    // `http://` origin or at an address inside the user's own network is refused as a
    // configuration rather than discovered on the first request.
    let base = reqwest::Url::parse(endpoint).map_err(|_| RemoteRefusal::Malformed)?;
    if base.scheme() != "https" {
        return Err(RemoteRefusal::NotHttps);
    }
    if !base.host_str().is_some_and(host_is_public) {
        return Err(RemoteRefusal::HostRefused);
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| RemoteRefusal::Malformed)?;
    if parsed.scheme() != "https" {
        return Err(RemoteRefusal::NotHttps);
    }
    let Some(host) = parsed.host_str() else {
        return Err(RemoteRefusal::Malformed);
    };
    if !host_is_public(host) {
        return Err(RemoteRefusal::HostRefused);
    }
    Ok(FetchPlan {
        url: parsed,
        max_bytes: REMOTE_MAX_BYTES,
        timeout_ms: REMOTE_TIMEOUT_MS,
        content_types: &REMOTE_CONTENT_TYPES,
    })
}

/// What a permitted fetch would be allowed to do.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FetchPlan {
    pub url: reqwest::Url,
    pub max_bytes: u64,
    pub timeout_ms: u64,
    /// The response types a client may accept. Part of the plan rather than a constant the client
    /// consults, so a caller cannot follow a plan and then decide for itself what a pack is.
    pub content_types: &'static [&'static str],
}

/// Why a fetch is refused before it starts.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteRefusal {
    /// No endpoint is configured, which is this build's only arm tonight.
    NotConfigured,
    /// Not `https`, so the transfer could be read or rewritten by anything on the path.
    NotHttps,
    /// A loopback, private or link-local address: §8's 「拒绝内网/回环地址跳转」, which is the
    /// rule that stops a catalogue entry pointing the client at the machine it runs on.
    HostRefused,
    /// Not a URL, or a URL with no host.
    Malformed,
}

/// Whether a host name is one a catalogue may point at.
///
/// IP literals are checked against the standard library's own ranges rather than against string
/// prefixes: `127.0.0.1`, `[::1]`, `10.0.0.1` and `169.254.169.254` are four spellings of the same
/// refusal, and a prefix check is how one of them gets through.
fn host_is_public(host: &str) -> bool {
    use std::net::IpAddr;
    // `Url::host_str` keeps the brackets around an IPv6 literal, so `[::1]` reaches here spelled
    // that way. Without this the literal fails to parse as an address and falls through to the
    // domain branch, where it is a name that merely looks unusual — which is how a loopback
    // address gets past a check that was written to refuse it. Found by
    // `a_download_never_becomes_an_address_inside_the_users_own_machine`.
    let host = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host);
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            !address.is_loopback()
                && !address.is_private()
                && !address.is_link_local()
                && !address.is_unspecified()
                && !address.is_broadcast()
        }
        Ok(IpAddr::V6(address)) => {
            !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_unicast_link_local()
                // IPv4-mapped addresses reach the same hosts by another spelling.
                && address
                    .to_ipv4_mapped()
                    .is_none_or(|mapped| host_is_public(&mapped.to_string()))
        }
        Err(_) => {
            let lower = host.to_ascii_lowercase();
            lower != "localhost" && !lower.ends_with(".localhost") && !lower.ends_with(".local")
        }
    }
}
