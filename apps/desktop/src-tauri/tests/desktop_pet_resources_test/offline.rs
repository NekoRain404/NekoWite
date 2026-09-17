//! §8's network half: what this build will fetch, from where, under which bounds, and why not.
//!
//! The catalogue is **on** now — `LIBRARY_ENDPOINT` names one — so this file is no longer about a
//! refusal that stands in for a feature. It is about the four checks that had to be true *before*
//! an endpoint could be named, and each of them has cases here:
//!
//! - **HTTPS and a host this build will talk to.** The scheme, the allow-list (the catalogue's own
//!   host and nothing else) and the address class (no loopback, private or link-local — the
//!   spelling a manifest entry would use to reach the machine it runs on). "Public host" and "the
//!   catalogue's host" are two different refusals and both have cases, because a check that only
//!   refused internal addresses would let a compromised manifest point this app's downloader at
//!   any host on the internet.
//! - **A size bound**, per kind of fetch, carried on the plan rather than remembered by a client.
//!   That the *read* stops at the bound is a property of `fetch.rs` and is asserted there, at the
//!   source level, because reaching it would mean a real socket and a hostile server.
//! - **A stated content type**, per kind of fetch, and checked against the bytes as well as the
//!   header. The byte half is `catalogue.rs`'s and has cases next door.
//! - **An integrity record**, which is what the library already does: every file it publishes is
//!   hashed into the manifest, so a sheet that changes after it was installed is reported. The
//!   case for that is `cache.rs`'s, and what this file asserts is the part that is *absent* —
//!   there is no upstream digest to check, and the module says so rather than checking the
//!   response's own `ETag` against itself.
//!
//! The last two cases are source-level and are the ones that keep the module honest: exactly one
//! file in this tree opens a socket, and that file follows no redirect and does not switch
//! certificate validation off. One thing is deliberately *not* asserted — that a request is never
//! made — because that is no longer true, and a test that pinned it would be a test that had to be
//! deleted rather than updated.

use std::path::Path;

use crate::desktop_pet::resources::{
    remote_fetch_plan, FetchKind, FetchPlan, RemoteRefusal, CATALOGUE_CONTENT_TYPES,
    CATALOGUE_MAX_BYTES, LIBRARY_ENDPOINT, REMOTE_MAX_BYTES, REMOTE_TIMEOUT_MS,
    SHEET_CONTENT_TYPES,
};
use crate::support::{install_request, library, pack_dir, png, write};

/// An endpoint that would be acceptable, so the cases below test the *target* rules rather than
/// tripping over a misconfigured origin first.
const ENDPOINT: &str = "https://pets.example.invalid/manifest.json";

#[test]
fn the_configured_endpoint_is_one_this_build_may_read() {
    // The endpoint is a reviewed constant (§10.1), so it is held to the rules every URL is held to
    // rather than trusted because it is ours. A build whose own address failed these would be
    // shipping a catalogue it cannot read, and this is where that is a red test rather than a
    // sentence in a report.
    let endpoint = LIBRARY_ENDPOINT.expect("this build reads a catalogue");
    let plan = remote_fetch_plan(LIBRARY_ENDPOINT, FetchKind::Catalogue, endpoint)
        .expect("the pinned endpoint is https, public and the catalogue's own host");
    assert_eq!(plan.url.as_str(), endpoint);
    assert_eq!(plan.kind, FetchKind::Catalogue);
    assert!(
        endpoint.starts_with("https://"),
        "a catalogue fetched over anything but https could be rewritten in flight"
    );
}

#[test]
fn a_download_never_becomes_an_address_inside_the_users_own_machine() {
    // §8's 「拒绝内网/回环地址跳转」, which is the rule that stops a catalogue entry pointing the
    // client at something on the machine it runs on. Each of these is a spelling of the same
    // refusal, and a prefix check rather than an address check is how one of them gets through.
    for url in [
        "https://127.0.0.1/pack.json",
        "https://127.1.2.3/pack.json",
        "https://[::1]/pack.json",
        "https://10.0.0.1/pack.json",
        "https://172.16.0.1/pack.json",
        "https://192.168.1.1/pack.json",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::ffff:127.0.0.1]/pack.json",
        "https://localhost/pack.json",
        "https://catalog.localhost/pack.json",
        "https://printer.local/pack.json",
    ] {
        assert_eq!(
            remote_fetch_plan(Some(ENDPOINT), FetchKind::Sheet, url),
            Err(RemoteRefusal::HostRefused),
            "{url}"
        );
    }
}

#[test]
fn a_sheet_is_only_ever_fetched_from_the_catalogues_own_host() {
    // The allow-list, and the case that would have caught the version of this check that only
    // refused internal addresses: a public host that is not the catalogue's is a host a catalogue
    // entry named, and a named host is exactly what an untrusted entry may not choose.
    for url in [
        "https://cdn.pets.example.invalid/cat.webp",
        "https://pets.thenightwatcher.online.evil.example/cat.webp",
        // A prefix is not a match: this one starts with the catalogue's host as a string.
        "https://pets.example.invalid:8443/cat.webp",
        // Credentials are refused rather than compared, so the two spellings of one host cannot
        // become two entries on the allow-list.
        "https://cat@pets.example.invalid/cat.webp",
    ] {
        assert!(
            matches!(
                remote_fetch_plan(Some(ENDPOINT), FetchKind::Sheet, url),
                Err(RemoteRefusal::ForeignHost { .. })
            ),
            "{url}"
        );
    }

    // And the catalogue's own host is accepted, on the default port, with no credentials.
    assert!(remote_fetch_plan(
        Some(ENDPOINT),
        FetchKind::Sheet,
        "https://pets.example.invalid/pets/boba/spritesheet.webp"
    )
    .is_ok());
}

#[test]
fn a_fetch_has_to_be_https_whatever_the_endpoint_is() {
    assert_eq!(
        remote_fetch_plan(
            Some(ENDPOINT),
            FetchKind::Sheet,
            "http://pets.example.invalid/cat.png"
        ),
        Err(RemoteRefusal::NotHttps)
    );
    assert_eq!(
        remote_fetch_plan(Some(ENDPOINT), FetchKind::Sheet, "file:///etc/passwd"),
        Err(RemoteRefusal::NotHttps)
    );
    assert_eq!(
        remote_fetch_plan(
            Some(ENDPOINT),
            FetchKind::Sheet,
            "data:image/png;base64,AAAA"
        ),
        Err(RemoteRefusal::NotHttps)
    );
    // The endpoint itself is checked by the same rules, so a catalogue configured at an insecure
    // origin is refused as a configuration rather than discovered on the first request.
    assert_eq!(
        remote_fetch_plan(
            Some("http://pets.example.invalid/manifest.json"),
            FetchKind::Catalogue,
            "https://pets.example.invalid/cat.png"
        ),
        Err(RemoteRefusal::NotHttps)
    );
    assert_eq!(
        remote_fetch_plan(
            Some("https://localhost/manifest.json"),
            FetchKind::Catalogue,
            "https://pets.example.invalid/cat.png"
        ),
        Err(RemoteRefusal::HostRefused)
    );
}

#[test]
fn a_plan_carries_every_bound_a_fetch_would_have_to_honour() {
    let endpoint = LIBRARY_ENDPOINT.expect("this build reads a catalogue");
    let catalogue = remote_fetch_plan(LIBRARY_ENDPOINT, FetchKind::Catalogue, endpoint)
        .expect("the pinned endpoint");
    let sheet = remote_fetch_plan(
        LIBRARY_ENDPOINT,
        FetchKind::Sheet,
        "https://pets.thenightwatcher.online/pets/boba/spritesheet.webp",
    )
    .expect("the catalogue's own host");

    assert_fetch_bounds(
        &catalogue,
        CATALOGUE_MAX_BYTES,
        &CATALOGUE_CONTENT_TYPES,
        "application/json",
    );
    assert_fetch_bounds(&sheet, REMOTE_MAX_BYTES, &SHEET_CONTENT_TYPES, "image/webp");
    // The two budgets are different numbers because they are different documents, and a plan that
    // carried the wrong one would be a bound nobody could state.
    assert_ne!(catalogue.max_bytes, sheet.max_bytes);
    for plan in [&catalogue, &sheet] {
        assert!(
            !plan.content_types.iter().any(|kind| kind.contains("html")),
            "§8: a catalogue and its assets are data, never a document"
        );
    }
}

fn assert_fetch_bounds(plan: &FetchPlan, max_bytes: u64, types: &[&str], expected: &str) {
    assert_eq!(plan.max_bytes, max_bytes);
    assert_eq!(plan.timeout_ms, REMOTE_TIMEOUT_MS);
    assert_eq!(plan.content_types, types);
    assert!(plan.content_types.contains(&expected));
}

#[test]
fn a_sheets_content_types_are_the_formats_this_build_can_measure() {
    // Not taste: `media::image_size` reads these four headers and no others, and a format nobody
    // here can measure is a format nobody here can bound (§8's 「不能校验的就拒绝，不凭信任接受」).
    // It is the same rule that keeps `svg` out — an image by extension, a document by behaviour.
    assert_eq!(
        SHEET_CONTENT_TYPES,
        ["image/png", "image/webp", "image/jpeg", "image/gif"]
    );
    assert!(!SHEET_CONTENT_TYPES.contains(&"image/svg+xml"));
    assert!(!SHEET_CONTENT_TYPES.contains(&"application/octet-stream"));
}

#[test]
fn the_library_reads_and_installs_with_nothing_reachable() {
    // §8's 「缓存与离线角色不依赖服务可用性」: an installed character is a local directory, and
    // every read works with no interface up. There is no call in this test that could reach a
    // network, which is the point — the assertion is that importing, listing and verifying are
    // complete operations on their own, whether or not a catalogue is configured.
    let (library, _data) = library("offline-local");
    let source = pack_dir("offline-local");
    write(&source, "sheet.png", &png(64, 64));
    library
        .install(&install_request("cat", &source))
        .expect("a local pack");

    assert_eq!(library.list().expect("readable").len(), 1);
    assert!(library.verify("cat").expect("readable").is_empty());
}

#[test]
fn only_the_fetch_module_opens_a_socket() {
    // A source-level assertion, in the spirit of D3's teardown case, and the updated form of the
    // rule this file used to state as "nothing in the module makes a request". That rule is no
    // longer true — the catalogue is wired — so what is asserted is the version that still means
    // something: exactly one file opens a socket, and every other file in the tree mentions the
    // HTTP crate only to *parse a URL*. Everything that decides is `remote.rs`; everything that
    // connects is `fetch.rs`; a third file reaching for a client would fail here.
    for (source, text) in module_sources() {
        let is_the_socket = source.file_name().is_some_and(|name| name == "fetch.rs");
        for (at, _) in text.match_indices("reqwest::") {
            assert!(
                is_the_socket || text[at..].starts_with("reqwest::Url"),
                "{} reaches for reqwest beyond a URL parse: {}",
                source.display(),
                &text[at..(at + 32).min(text.len())]
            );
        }
        for forbidden in [
            "danger_accept_invalid_certs",
            "danger_accept_invalid_hostnames",
            "reqwest::blocking",
            ".blocking()",
            "ureq::",
            "curl::",
        ] {
            assert!(
                !text.contains(forbidden),
                "{} contains {forbidden}",
                source.display()
            );
        }
    }
}

#[test]
fn the_one_socket_this_module_opens_follows_no_redirect_and_checks_certificates() {
    // §8's 「拒绝内网/回环地址跳转」, satisfied by there being no hop: the client refuses to
    // follow one, so a 3xx is a refusal that names the status and the location instead of a second
    // request the plan never validated. Both halves are read off the source because reaching them
    // at runtime needs a server that redirects.
    let (_, text) = module_sources()
        .into_iter()
        .find(|(path, _)| path.file_name().is_some_and(|name| name == "fetch.rs"))
        .expect("the fetch module is part of this tree");

    assert!(
        text.contains("redirect(reqwest::redirect::Policy::none())"),
        "the client has to decline redirects rather than validate each hop"
    );
    assert!(
        text.contains(".timeout(Duration::from_millis(plan.timeout_ms))"),
        "the plan's own timeout is the one the request gets"
    );
    assert!(
        !text.contains("policy(") || !text.contains("Policy::limited"),
        "a redirect budget is a redirect followed"
    );
}

/// Every source file of the module, as `(path, code)` — comments removed.
///
/// Comments are stripped because these cases are about what the code *does*. `fetch.rs` documents
/// the two verification flags it must never set, and a scan that read prose would fail the file for
/// explaining itself — which is the shape of test that gets weakened rather than fixed.
fn module_sources() -> Vec<(std::path::PathBuf, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/desktop_pet");
    let mut sources = vec![root.join("resources.rs")];
    sources.extend(
        std::fs::read_dir(root.join("resources"))
            .expect("the module's sibling files")
            .flatten()
            .map(|entry| entry.path()),
    );
    sources
        .into_iter()
        .map(|source| {
            let text = std::fs::read_to_string(&source).expect("a readable source file");
            (source, strip_comments(&text))
        })
        .collect()
}

/// Rust source with its comments removed, and string literals left alone.
///
/// Deliberately small: it tracks double-quoted strings (so a `//` inside a URL is not read as a
/// comment), `//` to end of line, and `/* … */`. Raw strings and character literals are not
/// handled, and the files it reads contain neither — a scanner that guessed at them would be a
/// place for a check to hide rather than a place for it to run.
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(character) = chars.next() {
        if in_string {
            out.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match (character, chars.peek().copied()) {
            ('"', _) => {
                in_string = true;
                out.push(character);
            }
            ('/', Some('/')) => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut previous = '\0';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            _ => out.push(character),
        }
    }
    out
}
