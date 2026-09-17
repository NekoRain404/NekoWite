//! The catalogue's IPC surface: what the public ACP registry publishes, as a window reads it.
//!
//! Its own command file for the reason `agent_registry.rs` and `agent_capabilities.rs` have theirs:
//! this is a *subject*, not another registry call. It is also the only place in this app that
//! reaches a third-party network endpoint, which is a boundary worth being able to point at.
//!
//! **What this file does not do is the whole design.** It does not download artifacts, it does not
//! extract them, it does not set an execute bit, and it cannot start anything. What it returns is a
//! description of what the registry *says* — and, for each check §3.3 requires of a download, which
//! of them a registry entry can support ([`catalogue::InstallGate`]). Two of the six do not
//! transfer and one does so only in part, so this build offers no install action at all rather than
//! a partial gate that would have to be mistaken for a whole one.
//!
//! That refusal is why the readout carries the gate list to the page: a page that drew an "Install"
//! control would be offering something the backend has no path for, and the honest rendering is the
//! reason instead. §3.4's 「安装声明仅用于启动提示」 is the same rule one level up — nothing here is
//! a claim about what an engine can do, because nothing here has run.
//!
//! **The one action the catalogue does enable** is registering a package-manager invocation. For a
//! `npx` or `uvx` distribution the artifact's provenance belongs to the package manager: it
//! resolves the platform, fetches the bytes and keeps its own integrity record, and NekoWite
//! records the resulting program as [`crate::agent_runtime::registry::InstallSource::External`] —
//! the user's own installation, which this app may report on and never replace (§3.4.6). NekoWite
//! is not part of that trust chain and makes no claim about it, which is exactly why the action is
//! allowed to exist.
//!
//! **The fetch is bounded and cached, and a failed fetch is not an error.** A catalogue is a
//! network dependency; the page must render with the network down, so a stale cache is served and
//! marked stale, and a first-run failure is a state the page says rather than an `Err` it cannot
//! explain. Nothing about an engine's registration depends on this call succeeding.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::AppHandle;

use crate::agent_runtime::catalogue::{self, EntryDefect, InstallGate, Standing};

/// The registry's aggregate. The schema files name this same host as their own `$id`
/// (`registry.schema.json`'s `$id` is `…/registry/v1/latest/registry.schema.json`), so this is the
/// published endpoint rather than one this app chose.
const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/// The whole request, body included. Zed bounds the same call at 30s
/// (`zed-main/crates/project/src/agent_registry_store.rs:24`) for the same reason: a settings page
/// waiting on a CDN must not be a settings page that hangs.
const FETCH_BOUND: Duration = Duration::from_secs(30);

/// How long a cached copy is served before the network is asked again. Zed's own throttle is an
/// hour (`agent_registry_store.rs:21`), and a catalogue that changed under a user mid-page would be
/// worse than one an hour old.
const CACHE_MAX_AGE: Duration = Duration::from_secs(60 * 60);

/// The directory the fetched document is kept in, under this app's own data directory (§3.2).
fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::storage::key_store::data_dir(app)?.join("agent-catalogue"))
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cache_dir(app)?.join("registry.json"))
}

/// How current the rows are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Freshness {
    /// Fetched within [`CACHE_MAX_AGE`] ago.
    Current,
    /// Served from the cache because the network did not answer. The rows are real and old, and
    /// the page says which.
    Stale,
    /// No document has been read at all, so there are no rows — only the reason.
    Unavailable,
}

/// Why there are no rows, or why the ones there are may be old.
///
/// A state and not an `Err`, deliberately. `Err` on this surface means the call did not complete
/// (`agent_registry.rs`'s two failure channels), and a machine with no network is a call that
/// completed with an answer: "the registry could not be reached". Collapsing the two would leave a
/// page unable to say which happened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueNote {
    /// A sentence for a log and for a page that wants to show it. Built here rather than on the
    /// page because reqwest's own error text is the useful half and the page cannot produce it.
    pub detail: String,
}

/// One registry entry, as a page reads it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueRowView {
    pub id: String,
    pub name: String,
    /// The version the *entry* declares for its stable channel. Never the version of anything on
    /// this machine — nothing has been installed, so there is nothing local to have a version.
    pub version: String,
    pub description: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub authors: Vec<String>,
    /// The SPDX identifier, or `proprietary`. Free text on the wire: the schema allows any string.
    pub license: Option<String>,
    /// Required by the schema for every entry but one, and reported as absent rather than filled
    /// with a guess when it is missing.
    pub license_url: Option<String>,
    /// Resolved to an absolute URL, or `None` when the entry publishes no icon.
    pub icon_url: Option<String>,
    /// What this host could do about the entry's distribution — about the *process*, never about
    /// what the engine can do. The arm is the page's decision point.
    pub standing: StandingView,
    /// Why the entry cannot be offered, when it cannot. Separate from the standing because they
    /// are different questions: a malformed entry is a document defect, an inactionable one is a
    /// decision this build has not taken.
    pub defects: Vec<String>,
    /// Whether a control may be drawn for this row. Computed here so no page has to re-derive the
    /// rule 「不能让按钮看起来可用、点击后才发现不支持」 from the two fields above.
    pub offerable: bool,
}

/// The standing, flattened for the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StandingView {
    /// A package-manager invocation this host could register. `program` and `args` are what an add
    /// form would be prefilled with — kept apart, because §3.4.3 forbids a command line.
    ViaPackageManager {
        manager: &'static str,
        package: String,
        program: &'static str,
        args: Vec<String>,
        /// The version the package string pins, or `None` when it pins none — `@latest` and a bare
        /// name both pin nothing, and a page must not repeat the entry's version as though the
        /// artifact had promised it.
        pinned_version: Option<String>,
    },
    /// An archive for this machine and no package distribution: using it would make this app the
    /// downloader, which is the §3.3 decision this build does not take.
    ArchiveOnly { platform: &'static str, cmd: String },
    /// Archives for other machines only.
    Unsupported { published: Vec<&'static str> },
    /// Distribution kinds this build does not understand, named so a row can say which.
    Unrecognised { kinds: Vec<String> },
}

/// One §3.3 check, and whether a registry entry can support it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallGateView {
    pub check: &'static str,
    pub transfers: bool,
}

/// The catalogue, as the page reads it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueReadout {
    /// The registry schema version the document declared, so a page can show what it read.
    pub registry_version: String,
    pub freshness: Freshness,
    /// Why the rows are stale or absent, when they are.
    pub note: Option<CatalogueNote>,
    pub rows: Vec<CatalogueRowView>,
    /// How many rows a control may be drawn for, so a page can say it without counting.
    pub offerable: usize,
    /// Every check §3.3 requires of a download, with whether a registry entry can support it.
    /// Carried to the page because it is the *reason* there is no install action, and a page that
    /// stated a refusal without its reason would be asking a user to take it on trust.
    pub install_gates: Vec<InstallGateView>,
}

fn gates() -> Vec<InstallGateView> {
    InstallGate::ALL
        .into_iter()
        .map(|check| InstallGateView {
            check: check.as_str(),
            transfers: check.transfers(),
        })
        .collect()
}

fn standing_view(entry: &catalogue::Entry, standing: &Standing) -> StandingView {
    match standing {
        Standing::ViaPackageManager {
            manager,
            package,
            args,
        } => StandingView::ViaPackageManager {
            manager: manager.id(),
            package: package.clone(),
            program: manager.program(),
            args: args.clone(),
            pinned_version: entry
                .package_distribution()
                .and_then(|(_, package)| package.pinned_version())
                .map(str::to_string),
        },
        Standing::ArchiveOnly { platform, cmd } => StandingView::ArchiveOnly {
            platform: platform.key(),
            cmd: cmd.clone(),
        },
        Standing::Unsupported { published } => StandingView::Unsupported {
            published: published.iter().map(|platform| platform.key()).collect(),
        },
        Standing::Unrecognised { kinds } => StandingView::Unrecognised {
            kinds: kinds.clone(),
        },
    }
}

/// The wire shape of a parsed catalogue.
///
/// Total over the rows: every entry the document carried reaches the page, including the ones that
/// cannot be offered. Dropping a defective entry would make a malformed listing look like an agent
/// that does not exist, which is the same failure as a button that offers nothing.
fn readout(
    catalogue: catalogue::Catalogue,
    freshness: Freshness,
    note: Option<String>,
) -> CatalogueReadout {
    let rows: Vec<CatalogueRowView> = catalogue
        .rows
        .iter()
        .map(|row| CatalogueRowView {
            id: row.entry.id.clone(),
            name: row.entry.name.clone(),
            version: row.entry.version.clone(),
            description: row.entry.description.clone(),
            repository: row.entry.repository.clone(),
            website: row.entry.website.clone(),
            authors: row.entry.authors.clone(),
            license: row.entry.license.clone(),
            license_url: row.entry.license_url.clone(),
            icon_url: row.entry.icon_url(),
            standing: standing_view(&row.entry, &row.standing),
            defects: row.defects.iter().map(defect_text).collect(),
            offerable: row.is_offerable(),
        })
        .collect();
    CatalogueReadout {
        registry_version: catalogue.version,
        freshness,
        note: note.map(|detail| CatalogueNote { detail }),
        offerable: rows.iter().filter(|row| row.offerable).count(),
        rows,
        install_gates: gates(),
    }
}

/// One entry defect as a sentence a page can print.
///
/// The facts are kept as facts and the wording is built here, because these are *document* defects
/// — a bug in a third party's listing — rather than conditions of the user's machine, and no
/// translation key can enumerate a schema's failure modes.
fn defect_text(defect: &EntryDefect) -> String {
    defect.to_string()
}

/// The catalogue: the cache when it is fresh, a fetch when it is not, and the cache again when the
/// fetch fails.
///
/// Every arm returns `Ok`. A page has to draw something, and "the registry could not be reached" is
/// a thing to draw — the alternative is an error the page can only render as a blank section.
#[tauri::command]
pub async fn agent_catalogue_read(app: AppHandle) -> Result<CatalogueReadout, String> {
    let path = cache_path(&app)?;
    let cached = read_cache(&path);

    if let Some((bytes, age)) = cached.as_ref() {
        if *age < CACHE_MAX_AGE {
            // Fresh enough. Parsed rather than trusted: the file is on disk and could have been
            // truncated by a crash between the write and the flush.
            match catalogue::parse(bytes) {
                Ok(parsed) => return Ok(readout(parsed, Freshness::Current, None)),
                Err(error) => {
                    // A cached document this build cannot read is worth replacing rather than
                    // serving, so the fetch below runs instead of returning this.
                    let _ = fs::remove_file(&path);
                    return match fetch().await {
                        Ok(bytes) => cached_readout(&app, bytes).await,
                        Err(detail) => Ok(unavailable(detail, Some(error.to_string()))),
                    };
                }
            }
        }
    }

    match fetch().await {
        Ok(bytes) => cached_readout(&app, bytes).await,
        Err(detail) => {
            // The fetch failed. An old cache is still an answer, and a marked-stale one is more
            // useful than none: the entries it lists were real an hour ago.
            match cached {
                Some((bytes, age)) => match catalogue::parse(&bytes) {
                    // The age is reported rather than only felt: a listing whose rows are hours
                    // old is a fact about what the page is showing, and the page has no way to
                    // know it otherwise.
                    Ok(parsed) => Ok(readout(
                        parsed,
                        Freshness::Stale,
                        Some(format!(
                            "{detail} (showing a copy fetched {})",
                            humanize(age)
                        )),
                    )),
                    Err(error) => Ok(unavailable(detail, Some(error.to_string()))),
                },
                None => Ok(unavailable(detail, None)),
            }
        }
    }
}

/// Parse what was just fetched and write it to the cache, so the next read is a disk read.
async fn cached_readout(app: &AppHandle, bytes: Vec<u8>) -> Result<CatalogueReadout, String> {
    let parsed = match catalogue::parse(&bytes) {
        Ok(parsed) => parsed,
        Err(error) => return Ok(unavailable(error.to_string(), None)),
    };
    // Written only after it parsed, so a document this build cannot read never becomes the cache a
    // later read serves instead of asking again.
    if let Ok(dir) = cache_dir(app) {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join("registry.json"), &bytes);
    }
    Ok(readout(parsed, Freshness::Current, None))
}

/// The readout for a document that could not be read at all.
fn unavailable(detail: String, parse_detail: Option<String>) -> CatalogueReadout {
    let detail = match parse_detail {
        Some(parse_detail) => {
            format!("{detail} (the document also could not be parsed: {parse_detail})")
        }
        None => detail,
    };
    CatalogueReadout {
        registry_version: String::new(),
        freshness: Freshness::Unavailable,
        note: Some(CatalogueNote { detail }),
        rows: Vec::new(),
        offerable: 0,
        install_gates: gates(),
    }
}

/// The cached document and how long ago it was written.
///
/// The age comes from the file's own modification time rather than a stamp written beside it: one
/// file cannot disagree with itself, and a stamp is a second thing to keep in step with the first.
fn read_cache(path: &PathBuf) -> Option<(Vec<u8>, Duration)> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default();
    Some((fs::read(path).ok()?, age))
}

/// How long ago the cached document was written, as a phrase a sentence can carry.
///
/// Coarse on purpose: the exact age of a registry listing is not a fact anyone acts on, and a page
/// that printed seconds would invite a user to read a precision into it that the cache does not
/// have. Only ever reached on the stale path, so the arms below a day are the ones that matter.
fn humanize(age: Duration) -> String {
    let minutes = age.as_secs() / 60;
    match minutes {
        0 => "less than a minute ago".to_string(),
        1 => "a minute ago".to_string(),
        m if m < 60 => format!("{m} minutes ago"),
        m if m < 120 => "an hour ago".to_string(),
        m if m < 60 * 48 => format!("{} hours ago", m / 60),
        m => format!("{} days ago", m / (60 * 24)),
    }
}

/// The one network call this app makes to a third-party catalogue endpoint.
///
/// Bounded as a whole — connect, body and all — rather than per-read, because a CDN that dribbles
/// bytes satisfies any per-read timeout forever.
async fn fetch() -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|error| format!("could not build an HTTP client: {error}"))?;
    let response = client
        .get(REGISTRY_URL)
        .timeout(FETCH_BOUND)
        .send()
        .await
        .map_err(|error| format!("requesting {REGISTRY_URL}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{REGISTRY_URL} answered {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("reading the response from {REGISTRY_URL}: {error}"))?;
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::catalogue::PackageManager;

    /// The schema's own example, so the wire shape is exercised against a real document.
    const EXAMPLE: &str = r#"{"version":"1.0.0","agents":[
        {"id":"someagent","name":"SomeAgent","version":"1.0.0","description":"d",
         "license":"MIT","license_url":"https://e.com/l","icon":"icon.svg",
         "distribution":{"npx":{"package":"@acme/ai-agent","args":["--acp"]}}},
        {"id":"maconly","name":"MacOnly","version":"1.0.0","description":"d",
         "license_url":"https://e.com/l",
         "distribution":{"binary":{"darwin-aarch64":{"archive":"https://e.com/a.zip","cmd":"./a"}}}},
        {"id":"debs","name":"Debs","version":"1.0.0","description":"d",
         "license_url":"https://e.com/l",
         "distribution":{"binary":{"linux-x86_64":{"archive":"https://e.com/a.deb","cmd":"./a"}}}}
    ]}"#;

    fn parsed() -> CatalogueReadout {
        let catalogue = catalogue::parse(EXAMPLE.as_bytes()).expect("valid");
        readout(catalogue, Freshness::Current, None)
    }

    #[test]
    fn every_entry_reaches_the_page_including_the_ones_it_cannot_offer() {
        // The totality rule: a dropped row would make a listing this build cannot use look like an
        // agent that does not exist.
        let readout = parsed();
        assert_eq!(readout.rows.len(), 3);
        assert_eq!(readout.offerable, 1);
        assert_eq!(readout.registry_version, "1.0.0");
        assert_eq!(readout.freshness, Freshness::Current);
        // The defective row is present *and* marked, rather than absent.
        let debs = readout
            .rows
            .iter()
            .find(|row| row.id == "debs")
            .expect("kept");
        assert!(!debs.offerable);
        assert_eq!(debs.defects.len(), 1, "{:?}", debs.defects);
    }

    #[test]
    fn the_actionable_row_carries_what_a_form_would_need() {
        // `program` and `args` apart, never joined: §3.4.3's rule has to survive the wire.
        let readout = parsed();
        let row = readout
            .rows
            .iter()
            .find(|row| row.id == "someagent")
            .expect("present");
        match &row.standing {
            StandingView::ViaPackageManager {
                manager,
                package,
                program,
                args,
                pinned_version,
            } => {
                assert_eq!(*manager, "npx");
                assert_eq!(program, &PackageManager::Npx.program());
                assert_eq!(package, "@acme/ai-agent");
                assert_eq!(args, &vec!["--acp".to_string()]);
                // Nothing is pinned, so no version is claimed — the entry's `1.0.0` is not the
                // artifact's promise and must not be repeated as one.
                assert_eq!(*pinned_version, None);
            }
            other => panic!("expected the package arm, got {other:?}"),
        }
        // And the icon resolved to the registry repository rather than the CDN, which serves the
        // aggregate and not the per-entry files.
        assert_eq!(
            row.icon_url.as_deref(),
            Some("https://raw.githubusercontent.com/agentclientprotocol/registry/main/someagent/icon.svg")
        );
    }

    #[test]
    fn the_gates_the_page_shows_are_the_ones_the_module_decides() {
        // The refusal and its reason travel together: a page that stated "not available" without
        // the why would be asking a user to take it on trust.
        let readout = parsed();
        assert_eq!(readout.install_gates.len(), InstallGate::ALL.len());
        let digest = readout
            .install_gates
            .iter()
            .find(|gate| gate.check == "digest")
            .expect("the deciding check is named");
        assert!(!digest.transfers);
        let architecture = readout
            .install_gates
            .iter()
            .find(|gate| gate.check == "architecture")
            .expect("present");
        assert!(architecture.transfers);
    }

    #[test]
    fn an_unreadable_registry_is_a_state_and_not_an_error() {
        // A machine with no network must still render. `unavailable` has no rows and a reason, and
        // the page draws that rather than a blank section.
        let readout = unavailable(
            "requesting the registry: no route to host".to_string(),
            None,
        );
        assert_eq!(readout.freshness, Freshness::Unavailable);
        assert!(readout.rows.is_empty());
        assert_eq!(readout.offerable, 0);
        assert!(readout
            .note
            .expect("a reason")
            .detail
            .contains("no route to host"));
        // The gate list is still reported: it is a property of this build, not of the network.
        assert_eq!(readout.install_gates.len(), InstallGate::ALL.len());
    }

    #[test]
    fn a_stale_listing_says_how_old_it_is() {
        // The stale arm is the one a page cannot otherwise explain: the rows are real, and they are
        // not current. Coarse phrasing on purpose — see `humanize`.
        assert_eq!(humanize(Duration::from_secs(30)), "less than a minute ago");
        assert_eq!(humanize(Duration::from_secs(60)), "a minute ago");
        assert_eq!(humanize(Duration::from_secs(60 * 7)), "7 minutes ago");
        assert_eq!(humanize(Duration::from_secs(60 * 90)), "an hour ago");
        assert_eq!(humanize(Duration::from_secs(60 * 60 * 5)), "5 hours ago");
        assert_eq!(
            humanize(Duration::from_secs(60 * 60 * 24 * 3)),
            "3 days ago"
        );
    }

    #[test]
    fn a_parse_failure_keeps_both_reasons() {
        // The network answered and the document was still unusable. The two facts are different
        // and a page showing only one would send a user to the wrong place.
        let readout = unavailable(
            "the registry is not readable".to_string(),
            Some("expected value at line 1".to_string()),
        );
        let detail = readout.note.expect("a reason").detail;
        assert!(detail.contains("not readable"), "{detail}");
        assert!(detail.contains("expected value"), "{detail}");
    }
}
