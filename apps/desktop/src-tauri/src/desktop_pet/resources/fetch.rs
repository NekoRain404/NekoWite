//! The one place in this module that opens a socket.
//!
//! It does exactly what a [`FetchPlan`] says and nothing it does not: one request, to the URL the
//! plan resolved, with no redirect followed, reading at most the plan's byte budget from the body
//! and accepting only the content types the plan allows. Everything that *decides* is in
//! [`super::remote`]; this file is where a decision becomes a connection, which is why it is also
//! the only file the source-level test `only_one_file_in_this_module_opens_a_socket` permits to
//! name a client.
//!
//! **The body is read in chunks and measured as it arrives.** `Response::bytes()` would read
//! whatever the host sends into memory and only then compare it with a limit, which turns a size
//! cap into a report about a download that already happened. Here the cap stops the read: the
//! first chunk that would cross it ends the transfer with [`RemoteRefusal::TooLarge`], so a host
//! that streams without end costs the bound and not the machine. The `Content-Length` header is
//! consulted first as well, and that is an *early* refusal rather than the check — a header is the
//! server's claim about its own body, and the only claim this module trusts is the one it can
//! measure.
//!
//! **TLS is on and is not configurable from here.** `rustls-tls` is the only TLS feature this
//! crate enables, no builder in this file calls `danger_accept_invalid_certs`, and the source test
//! forbids the name — a certificate check that a future edit can switch off is a certificate check
//! that will be switched off once, when a test host is inconvenient.

use std::time::Duration;

use super::remote::{FetchPlan, RemoteRefusal};

/// What a permitted fetch produced.
pub struct Fetched {
    /// The declared type, normalised to its essence (`image/webp` from `image/webp; charset=…`).
    /// Carried onward because [`super::catalogue`] checks the *bytes* against it: the two halves of
    /// §8's content-type rule are one comparison, and a header that never reaches the comparison
    /// would make the second half impossible to state.
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// Perform one planned fetch.
pub async fn fetch(plan: &FetchPlan) -> Result<Fetched, RemoteRefusal> {
    // A redirect is refused rather than followed, so §8's 「拒绝内网/回环地址跳转」 has no hop to
    // apply to. See `remote.rs`'s header for why following nothing is the stronger of the two ways
    // to keep that rule.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(plan.timeout_ms))
        .user_agent(concat!("nekowite/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| RemoteRefusal::Transport {
            detail: format!("the HTTP client could not be built: {error}"),
        })?;

    let mut response = client
        .get(plan.url.clone())
        .send()
        .await
        .map_err(|error| transport_refusal(&error))?;

    let status = response.status();
    if status.is_redirection() {
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());
        return Err(RemoteRefusal::Redirect {
            status: status.as_u16(),
            location,
        });
    }
    if !status.is_success() {
        return Err(RemoteRefusal::Status {
            code: status.as_u16(),
        });
    }

    let declared = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(essence)
        // A response with no type at all is a response that did not state one, and §8's rule is
        // that the type is *stated*: an empty string is not one of the plan's types and is refused
        // by the comparison below with `""` as what was found.
        .unwrap_or_default();
    if !plan
        .content_types
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(&declared))
    {
        return Err(RemoteRefusal::ContentType {
            found: if declared.is_empty() {
                "no content type".to_string()
            } else {
                declared
            },
            allowed: plan.content_types.join(", "),
        });
    }

    // An early refusal, never a substitute for the running total below: a body whose header says
    // it is small can still be longer, and this branch only ever refuses sooner.
    if let Some(declared_length) = response.content_length() {
        if declared_length > plan.max_bytes {
            return Err(RemoteRefusal::TooLarge {
                limit: plan.max_bytes,
                found: declared_length,
            });
        }
    }

    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| transport_refusal(&error))?
    {
        let found = bytes.len() as u64 + chunk.len() as u64;
        if found > plan.max_bytes {
            return Err(RemoteRefusal::TooLarge {
                limit: plan.max_bytes,
                found,
            });
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(Fetched {
        content_type: declared,
        bytes,
    })
}

/// `image/webp; charset=utf-8` as `image/webp`.
///
/// The parameters are dropped rather than compared: they say how to read a body, not what it is,
/// and a catalogue that appends a charset to a PNG is not a catalogue serving a different format.
fn essence(header: &str) -> String {
    header
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// What went wrong, in the vocabulary a caller can branch on.
///
/// A timeout is separated from every other transport failure because it is the one the user can do
/// something about that the app cannot: a slow link is not a broken one, and the plan's own
/// timeout is the number to report.
fn transport_refusal(error: &reqwest::Error) -> RemoteRefusal {
    if error.is_timeout() {
        return RemoteRefusal::Transport {
            detail: "the catalogue took too long to answer".to_string(),
        };
    }
    let detail = if error.is_connect() {
        format!("the host could not be reached: {error}")
    } else {
        format!("the download did not complete: {error}")
    };
    RemoteRefusal::Transport { detail }
}
