//! §8's offline half: what this build does about the network, which is nothing, and says so.
//!
//! The rule this file is about is the one this codebase applies most consistently: an unavailable
//! network capability is *stated as unavailable*, never drawn as a control that silently does
//! nothing. §8 goes further for this feature — 「网络身份、服务条款、素材许可和数据流未确认前，只交付
//! 本地模式」 — so the online catalogue is not merely switched off, it has no endpoint, and the
//! operation that would fetch from it refuses before any other rule is consulted.
//!
//! Two things are therefore tested that would normally be tested apart:
//!
//! - the *refusal*, which is a value a page can render, and which names the reason rather than
//!   returning an empty list — the exact defect §3.1 lists against `catalog.ts`, whose failed
//!   fetch returns `[]` and so makes "the network is down", "the library is empty" and "the
//!   catalogue is broken" one indistinguishable state;
//! - the *rules*, which are checked even though nothing consults them today, because they are the
//!   specification the task that configures an endpoint would otherwise have to derive: HTTPS
//!   only, no private or loopback address — including on a redirect — and bounded size and time.
//!
//! The last case is the one that keeps the module honest: it reads the module's own sources and
//! asserts that the only thing they name is a URL *parse*, never a request.

use std::path::Path;

use crate::desktop_pet::resources::{
    remote_fetch_plan, RemoteRefusal, LIBRARY_ENDPOINT, REMOTE_CONTENT_TYPES, REMOTE_MAX_BYTES,
    REMOTE_TIMEOUT_MS,
};
use crate::support::{install_request, library, pack_dir, png, write};

/// An endpoint that would be acceptable, so the cases below test the *target* rules rather than
/// tripping over a misconfigured origin first.
const ENDPOINT: &str = "https://pets.example.invalid/manifest.json";

#[test]
fn this_build_has_no_catalogue_endpoint_and_says_so_rather_than_returning_an_empty_list() {
    assert_eq!(
        LIBRARY_ENDPOINT, None,
        "§8 defers the online catalogue to its own sub-plan with 明确端点与配置权限"
    );

    // Every URL is refused, and refused as *not configured* rather than as malformed, insecure or
    // private: the reason a page shows has to be the reason that is true.
    for url in [
        "https://pets.example.invalid/cat.png",
        "https://pets.example.invalid/",
        "http://pets.example.invalid/cat.png",
        "https://127.0.0.1/cat.png",
        "not a url",
    ] {
        assert_eq!(
            remote_fetch_plan(LIBRARY_ENDPOINT, url),
            Err(RemoteRefusal::NotConfigured),
            "{url}"
        );
    }
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
            remote_fetch_plan(Some(ENDPOINT), url),
            Err(RemoteRefusal::HostRefused),
            "{url}"
        );
    }
}

#[test]
fn a_fetch_has_to_be_https_whatever_the_endpoint_is() {
    assert_eq!(
        remote_fetch_plan(Some(ENDPOINT), "http://pets.example.com/cat.png"),
        Err(RemoteRefusal::NotHttps)
    );
    assert_eq!(
        remote_fetch_plan(Some(ENDPOINT), "file:///etc/passwd"),
        Err(RemoteRefusal::NotHttps)
    );
    assert_eq!(
        remote_fetch_plan(Some(ENDPOINT), "data:image/png;base64,AAAA"),
        Err(RemoteRefusal::NotHttps)
    );
    // The endpoint itself is checked by the same rules, so a catalogue configured at an insecure
    // origin is refused as a configuration rather than discovered on the first request.
    assert_eq!(
        remote_fetch_plan(
            Some("http://pets.example.invalid/manifest.json"),
            "https://pets.example.invalid/cat.png"
        ),
        Err(RemoteRefusal::NotHttps)
    );
    assert_eq!(
        remote_fetch_plan(
            Some("https://localhost/manifest.json"),
            "https://pets.example.invalid/cat.png"
        ),
        Err(RemoteRefusal::HostRefused)
    );
}

#[test]
fn a_plan_carries_every_bound_a_fetch_would_have_to_honour() {
    let plan = remote_fetch_plan(Some(ENDPOINT), "https://cdn.pets.example.invalid/cat.webp")
        .expect("a public host over https");
    assert_eq!(
        plan.url.as_str(),
        "https://cdn.pets.example.invalid/cat.webp"
    );
    // §8's 超时、大小、内容类型, as values on the plan rather than as conventions a client is
    // trusted to remember.
    assert_eq!(plan.max_bytes, REMOTE_MAX_BYTES);
    assert_eq!(plan.timeout_ms, REMOTE_TIMEOUT_MS);
    assert_eq!(plan.content_types, &REMOTE_CONTENT_TYPES[..]);
    assert!(plan.content_types.contains(&"application/json"));
    assert!(
        !plan.content_types.iter().any(|kind| kind.contains("html")),
        "§8: a catalogue and its assets are data, never a document"
    );
}

#[test]
fn a_redirect_is_validated_by_the_same_rules_as_the_first_hop() {
    // A redirect is not a second kind of fetch: the rule that refuses a loopback address has to
    // apply to the hop that *becomes* one, which is why the target is put through the same
    // function the origin went through. Every one of these is redirect-to-self's shape.
    let plan = remote_fetch_plan(Some(ENDPOINT), "https://cdn.pets.example.invalid/cat.webp")
        .expect("the origin is fine");
    assert_eq!(plan.url.host_str(), Some("cdn.pets.example.invalid"));

    for target in [
        "https://127.0.0.1/cat.webp",
        "http://cdn.pets.example.invalid/cat.webp",
        "https://[::1]/cat.webp",
    ] {
        assert!(
            remote_fetch_plan(Some(ENDPOINT), target).is_err(),
            "a hop to {target} was allowed"
        );
    }
}

#[test]
fn the_library_reads_and_installs_with_nothing_configured_at_all() {
    // §8's 「缓存与离线角色不依赖服务可用性」: an installed character is a local directory, and
    // every read works with no interface up. There is no call in this test that could reach a
    // network, which is the point — the assertion is that importing, listing and verifying are
    // complete operations on their own.
    let (library, _data) = library("offline-local");
    let source = pack_dir("offline-local");
    write(&source, "sheet.png", &png(64, 64));
    library
        .install(&install_request("cat", &source))
        .expect("a local pack");

    assert_eq!(library.list().expect("readable").len(), 1);
    assert!(library.verify("cat").expect("readable").is_empty());
    assert_eq!(LIBRARY_ENDPOINT, None, "and it stayed that way");
}

#[test]
fn nothing_in_the_module_makes_a_request() {
    // A source-level assertion, in the spirit of D3's teardown case: the module names a URL only
    // to parse one, and a future edit that reached for a client would have to add a name this
    // test does not allow. `reqwest` is in the tree already, so this is not a dependency
    // statement — it is a statement about what this file does with it.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/desktop_pet");
    let mut sources = vec![root.join("resources.rs")];
    sources.extend(
        std::fs::read_dir(root.join("resources"))
            .expect("the module's sibling files")
            .flatten()
            .map(|entry| entry.path()),
    );

    for source in &sources {
        let text = std::fs::read_to_string(source).expect("a readable source file");
        // Every mention of the HTTP crate in this module is a URL parse. A name that is *not*
        // `reqwest::Url` is the beginning of a request, and that is the line this case draws.
        for (at, _) in text.match_indices("reqwest::") {
            assert!(
                text[at..].starts_with("reqwest::Url"),
                "{} reaches for reqwest beyond a URL parse: {}",
                source.display(),
                &text[at..(at + 32).min(text.len())]
            );
        }
        for forbidden in ["reqwest::Client", ".blocking().", "ureq::", "curl::"] {
            assert!(
                !text.contains(forbidden),
                "{} contains {forbidden}",
                source.display()
            );
        }
    }
}
