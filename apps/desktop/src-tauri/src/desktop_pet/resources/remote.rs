//! §8's transfer rules: what may be fetched, from where, under which bounds, and why not.
//!
//! This file decides and makes no request. [`super::fetch`] is the only code in this module that
//! opens a socket, and it opens one only for a [`FetchPlan`] built here — so a URL that fails a
//! check is refused with no packet sent, and the refusal is a value a page can render rather than
//! an empty list. The four checks §8 names are all in this file:
//!
//! - **HTTPS, and a host this build will talk to.** The scheme must be `https`, the host must be
//!   the *catalogue's own* host, and its address must be a public one. The last two are different
//!   refusals and are kept apart: [`RemoteRefusal::HostRefused`] is an address inside the user's
//!   own machine or network (the one a manifest entry would use to reach the machine it runs on),
//!   and [`RemoteRefusal::ForeignHost`] is a public host that is simply not the catalogue's. The
//!   allow-list is the catalogue's own host because that is what the catalogue actually serves:
//!   all 4,044 entries of the live manifest point at `pets.thenightwatcher.online`, measured
//!   rather than assumed, so a URL naming anything else is a URL the catalogue does not serve and
//!   this build will not follow. The cost is stated rather than hidden: a catalogue that moves its
//!   assets to a second hostname is refused loudly, with the name in the sentence, until this
//!   endpoint is reviewed again.
//! - **A size bound**, per kind of fetch, enforced while the body is read rather than after it.
//! - **A stated content type**, per kind of fetch, checked twice: the response header must be one
//!   of these, and the *bytes* must be what the header said. A header alone is a claim by the
//!   server, and this is the module whose whole subject is not taking those on trust.
//! - **An integrity record**, which is [`super::catalogue`]'s to make: the downloaded bytes are
//!   hashed and the digest is written into the manifest the library owns, so a sheet that changes
//!   after it was installed is a state the library reports rather than a file it keeps drawing.
//!
//! **What is *not* here, and cannot be.** §3.3's 「不能从同一不可信响应同时获取二进制和摘要便声称
//! 可信」 rules out the one thing that would look like a stronger integrity check: neither the
//! committed manifest nor the live one carries a hash for any of its 4,044 entries, and the
//! `ETag` a host does send is a digest *in the same untrusted response*, so comparing against it
//! would be verification in appearance only. There is therefore no upstream attestation for a
//! sheet, and this module does not claim one. What it has instead is stated in
//! [`super::catalogue::install_from_catalogue`].
//!
//! **A redirect is not followed at all.** The plan carries the rule and [`super::fetch`] obeys it
//! by refusing to follow one, so §8's 「拒绝内网/回环地址跳转」 is answered by there being no hop:
//! a 3xx is a refusal that names the status and the location. Re-validating each hop would be the
//! other way to satisfy the rule, and it is the weaker one — it makes the check a loop that a
//! future edit can get wrong once, while following nothing cannot be got wrong.

use super::MAX_PACKAGE_BYTES;

/// The catalogue this build reads, and — through [`remote_fetch_plan`] — the only host it will
/// read anything from.
///
/// The live address of the catalogue the reference browses (`references/desktop-pet`), which is
/// the only catalogue that exists: the reference's second source (`agentpet.thenightwatcher.online
/// /api/pets`) answers 404, and every one of the 4,044 entries the live manifest lists is served
/// from this host. §10.1 makes a new endpoint a reviewed change to the repository rather than a
/// switch a window may flip, which is why this is a constant and why the test
/// `the_configured_endpoint_is_one_this_build_may_read` holds it to the rules it would be judged
/// by.
pub const LIBRARY_ENDPOINT: Option<&str> =
    Some("https://pets.thenightwatcher.online/manifest.json");

/// §8's transfer budgets. The catalogue's is measured rather than guessed: the live manifest is
/// 1,098,128 bytes, so 8 MiB is seven times what it costs today and still a bound.
pub const CATALOGUE_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// A sheet's budget is the package budget, because a downloaded character *is* a package and the
/// library will apply the same number again when it installs one.
pub const REMOTE_MAX_BYTES: u64 = MAX_PACKAGE_BYTES;
/// How long one request may take, end to end.
///
/// Raised from the plan's initial 20 s against a measured fixture, which is what its own note asks
/// for: the largest sheet in the live catalogue is 1,931,458 bytes, so 20 s would be a hard floor
/// of about 0.8 Mbit/s and would fail a slow-but-real connection rather than a broken one.
pub const REMOTE_TIMEOUT_MS: u64 = 30_000;

/// §8's content-type rule for the catalogue document.
pub const CATALOGUE_CONTENT_TYPES: [&str; 1] = ["application/json"];
/// §8's content-type rule for a sheet, derived from what this build can *measure* rather than
/// chosen beside it: [`super::media::image_size`] reads PNG, GIF, WebP and JPEG headers, and a
/// format nobody here can bound is a format nobody here should accept (§8's 「不能校验的就拒绝，不凭
/// 信任接受」). `svg` is absent for the reason `media.rs` gives — it is an image by extension and a
/// document by behaviour.
pub const SHEET_CONTENT_TYPES: [&str; 4] = ["image/png", "image/webp", "image/jpeg", "image/gif"];

/// Which of the two documents a plan is for.
///
/// It exists so that the bounds travel with the plan instead of being looked up by the caller: a
/// client that followed a plan and then decided for itself which content types were acceptable
/// would be a second place where this decision is made.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FetchKind {
    /// The catalogue document itself.
    Catalogue,
    /// One spritesheet named by it.
    Sheet,
}

impl FetchKind {
    pub fn max_bytes(self) -> u64 {
        match self {
            Self::Catalogue => CATALOGUE_MAX_BYTES,
            Self::Sheet => REMOTE_MAX_BYTES,
        }
    }

    pub fn content_types(self) -> &'static [&'static str] {
        match self {
            Self::Catalogue => &CATALOGUE_CONTENT_TYPES,
            Self::Sheet => &SHEET_CONTENT_TYPES,
        }
    }
}

/// What a permitted fetch is allowed to do.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FetchPlan {
    pub url: reqwest::Url,
    pub kind: FetchKind,
    pub max_bytes: u64,
    pub timeout_ms: u64,
    /// The response types a client may accept. Part of the plan rather than a constant the client
    /// consults, so a caller cannot follow a plan and then decide for itself what a pack is.
    pub content_types: &'static [&'static str],
}

/// Why a fetch is refused before it starts, or what a refusal means once one has.
///
/// Data, not a wire shape: no command returns one of these. What a window sees is
/// [`super::catalogue::CatalogueReading`]'s arm and the sentence built from [`Self::detail`], so a
/// refusal is free to name a host, a status and a limit without those becoming part of a contract.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum RemoteRefusal {
    /// No endpoint is configured. Unreachable for the endpoint above, and kept because a build
    /// without one is a state this vocabulary can still describe.
    NotConfigured,
    /// Not `https`, so the transfer could be read or rewritten by anything on the path.
    NotHttps,
    /// A loopback, private or link-local address: §8's 「拒绝内网/回环地址跳转」, which is the
    /// rule that stops a catalogue entry pointing the client at the machine it runs on.
    HostRefused,
    /// A public host that is not the catalogue's own. See [`LIBRARY_ENDPOINT`].
    ForeignHost { host: String, allowed: String },
    /// Not a URL, or a URL with no host.
    Malformed,
    /// The host answered with a redirect, which this build does not follow.
    Redirect {
        status: u16,
        location: Option<String>,
    },
    /// The body was larger than the plan allowed. Reported by the reader that stopped, so a
    /// response that never ends is refused at the bound rather than buffered.
    TooLarge { limit: u64, found: u64 },
    /// A response whose declared type is not one the plan accepts.
    ContentType { found: String, allowed: String },
    /// A response whose *bytes* are not the type it declared, or not the document it should be.
    Corrupt { detail: String },
    /// The host answered, and not with the document.
    Status { code: u16 },
    /// The request did not complete: no route, no name, a refused connection or a timeout.
    Transport { detail: String },
}

impl RemoteRefusal {
    /// The diagnostic that travels with this refusal: what actually happened, in one line.
    ///
    /// Not the sentence a user reads. That one is the page's, out of the i18n catalogue, keyed by
    /// the *state* this refusal produced — [`super::catalogue::CatalogueReading`]'s arm or the
    /// sentence `commands/desktop_pet.rs` assembles. This string is the part a translator cannot
    /// supply: a host name, an HTTP status, a byte count, the location a redirect pointed at.
    pub fn detail(&self) -> String {
        match self {
            Self::NotConfigured => "no catalogue endpoint is configured".to_string(),
            Self::NotHttps => {
                "the address is not https, so the transfer could be read or changed on the way"
                    .to_string()
            }
            Self::HostRefused => {
                "the address is inside this machine's own network, which is never where a \
                 catalogue's files are"
                    .to_string()
            }
            Self::ForeignHost { host, allowed } => format!(
                "{host} is not the catalogue's own host; this build downloads only from {allowed}"
            ),
            Self::Malformed => "the address is not a URL with a host in it".to_string(),
            Self::Redirect { status, location } => match location {
                Some(location) => format!(
                    "the host answered {status} and pointed at {location}, and this build follows \
                     no redirect"
                ),
                None => format!("the host answered {status}, and this build follows no redirect"),
            },
            Self::TooLarge { limit, found } => {
                format!("the download is {found} bytes and the limit is {limit}")
            }
            Self::ContentType { found, allowed } => {
                format!("the response is {found}, and this build accepts {allowed}")
            }
            Self::Corrupt { detail } => detail.clone(),
            Self::Status { code } => format!("the host answered {code}"),
            Self::Transport { detail } => detail.clone(),
        }
    }
}

pub fn remote_fetch_plan(
    endpoint: Option<&str>,
    kind: FetchKind,
    url: &str,
) -> Result<FetchPlan, RemoteRefusal> {
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
    let Some(base_host) = base.host_str() else {
        return Err(RemoteRefusal::Malformed);
    };
    if !host_is_public(base_host) {
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
    // The allow-list, compared case-insensitively because DNS names are. A URL that carries
    // credentials is refused outright rather than compared: `https://cat@pets.…` and
    // `https://pets.…` are the same host to a parser and different strings to a reader, and
    // nothing this catalogue serves needs a user name.
    if !host.eq_ignore_ascii_case(base_host) || !parsed.username().is_empty() {
        return Err(RemoteRefusal::ForeignHost {
            host: host.to_string(),
            allowed: base_host.to_string(),
        });
    }
    // The port is part of the host for this purpose: `https://pets.…:8443` is a different
    // service on the same name, and a catalogue is served on the default port or not at all.
    if parsed.port().is_some_and(|port| port != 443) {
        return Err(RemoteRefusal::ForeignHost {
            host: format!("{host}:{}", parsed.port().unwrap_or_default()),
            allowed: base_host.to_string(),
        });
    }
    Ok(FetchPlan {
        url: parsed,
        kind,
        max_bytes: kind.max_bytes(),
        timeout_ms: REMOTE_TIMEOUT_MS,
        content_types: kind.content_types(),
    })
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
