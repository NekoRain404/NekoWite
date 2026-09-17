//! The catalogue: what it offers, and what installing one of its offers does.
//!
//! Split from [`super::remote`] by responsibility — that file decides what may be fetched, this one
//! decides what a fetched document *means* — and from [`super::fetch`] for the same reason one step
//! further down. Nothing here is reachable without a plan, and no plan here is built by a caller:
//! [`read_catalogue`] and [`install_from_catalogue`] are the whole surface, and the second one
//! takes a **slug**. A renderer cannot name a URL, a host or a path, so the only thing an
//! interested front end can ask for is an offer the catalogue itself listed — the same shape
//! `desktop_pet_open` has for windows ("a caller names a character, never a window") and for the
//! same reason: there is no argument to forge.
//!
//! **The catalogue is untrusted input, and it is treated as one at three points.**
//!
//! - **Its document is bounded twice**: the byte budget stops the read (`fetch.rs`), and a count
//!   budget stops the parse, so a document that is small only because it repeats a short entry
//!   still cannot cost unbounded memory.
//! - **Its entries are read leniently, one at a time.** An entry whose slug is not a path
//!   component, or whose sheet address is not one this build may fetch, is *counted and dropped* —
//!   dropped because a page cannot offer what it cannot install, and counted because a catalogue
//!   that silently lost a third of its entries is the defect §3.1 records against the upstream
//!   client's `[]`-on-every-failure. The count travels with the reading and the page states it.
//! - **Its slug becomes a directory name.** That is the one place a value from the network reaches
//!   the filesystem, so it goes through [`name_problem`] — the library's own rule for a string
//!   about to become one path component — before anything else, and a slug that fails it is not
//!   an entry this build offers.
//!
//! **The sheet's name is this build's, not the catalogue's.** The pack format has `spritesheetPath`
//! inside `pet.json`, and the upstream client writes a downloaded sheet to that name
//! (`PetInstaller.swift:53-58`). This build never fetches `pet.json` at all, and it derives the
//! stored file name from the *verified* format, so no name from the network is ever joined onto a
//! path. Measured rather than assumed: none of the packs sampled from the live catalogue declares a
//! grid, and every sheet sampled from it is 1536×1872 — the format's own 8×9 grid at 192×208 cells,
//! which is what [`DEFAULT_SHEET_COLUMNS`] and [`DEFAULT_SHEET_ROWS`] already are, so the grid the
//! library slices on is the grid the format defines rather than a guess.
//!
//! **Integrity, stated exactly.** There is no per-entry hash to verify against: 0 of the 4,044
//! entries in the committed manifests and in the live one carry one, and §3.3's
//! 「不能从同一不可信响应同时获取二进制和摘要便声称可信」 forbids promoting the response's own `ETag`
//! into one. So this file claims what it can show. In transit, the bytes are pinned by TLS to a
//! validated host. At rest, [`CharacterLibrary::create`] hashes every file it publishes and writes
//! the digest into the manifest the library owns, so the installed sheet has a recorded identity
//! from the moment it lands and any later change to it is a state a page reports. What is *absent*
//! is an upstream attestation — a signature, a published digest, anything that would let this
//! build say the bytes are the ones the creator uploaded — and its absence is a finding rather
//! than a gap that a nearby header was made to fill.

use serde::Serialize;

use super::fetch::fetch;
use super::library::CharacterLibrary;
use super::media::image_format;
use super::pack::name_problem;
use super::remote::{remote_fetch_plan, FetchKind, RemoteRefusal, LIBRARY_ENDPOINT};
use super::{
    CharacterKind, CreateRequest, InstalledCharacter, ResourceRefusal, DEFAULT_SHEET_COLUMNS,
    DEFAULT_SHEET_ROWS,
};

/// How many offers one catalogue document may contribute.
///
/// Five times what the live catalogue holds (4,044 entries, measured), so the bound is a bound and
/// not a quota. It is separate from the byte budget because a document can be small and still
/// repeat: 8 MiB of `{"slug":"a"}` is millions of entries.
pub const MAX_CATALOGUE_ENTRIES: usize = 20_000;

/// One offer as the catalogue states it.
///
/// Host-side only, and [`Self::sheet_url`] is the reason: the address a fetch is made to is resolved
/// here, from a catalogue this process just read, and is never sent to or accepted from a window.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CatalogueEntry {
    pub slug: String,
    pub name: String,
    /// The catalogue's own byline for the entry (`submittedBy`). Free text, shown and never
    /// parsed — it is what the catalogue states, and it is not a rights grant.
    pub author: Option<String>,
    /// The catalogue's own category word (`character`, `creature`, `object`, `asian`, `western`).
    /// Free text for the same reason: the vocabulary is the catalogue's, so a filter built from
    /// the values that are present cannot fall out of step with what arrives.
    pub kind: Option<String>,
    /// The terms the catalogue stated, if it stated any. `None` for every entry of every catalogue
    /// available today — see the report's outstanding list — and *read* rather than hard-coded, so
    /// that the day an entry carries terms the page shows them instead of dropping them.
    pub terms: Option<String>,
    pub(super) sheet_url: String,
}

/// One offer as a window is told about it.
///
/// Deliberately without the sheet address. A page renders a name and a byline; the address a
/// character is downloaded from is the host's, and `PetGateway` has no method that would take one.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueOffer {
    pub slug: String,
    pub name: String,
    pub author: Option<String>,
    pub kind: Option<String>,
    pub terms: Option<String>,
}

impl From<&CatalogueEntry> for CatalogueOffer {
    fn from(entry: &CatalogueEntry) -> Self {
        Self {
            slug: entry.slug.clone(),
            name: entry.name.clone(),
            author: entry.author.clone(),
            kind: entry.kind.clone(),
            terms: entry.terms.clone(),
        }
    }
}

/// What one catalogue document held.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Catalogue {
    pub entries: Vec<CatalogueEntry>,
    /// Entries dropped because this build could not offer them: no slug, a slug that is not a path
    /// component, or a sheet address that failed a transfer rule. Reported so that "the catalogue
    /// lists four thousand" and "four of them cannot be installed" are two facts and not one.
    pub skipped: usize,
}

/// Why the catalogue could not be read. Three arms, matching the three the page distinguishes.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CatalogueFailure {
    /// No endpoint is configured. Unreachable for the pinned one, and kept for a build without
    /// one.
    Unconfigured,
    /// No request completed, or none was made — a refusal to fetch is stated here and the detail
    /// says which, so "your network is down" and "this build will not fetch that address" are told
    /// apart by the sentence even though a page groups them.
    Unreachable(String),
    /// A response arrived and is not a catalogue.
    Unreadable(String),
}

/// What this build can say about the catalogue right now.
///
/// Five arms, and they are D9's `PetCatalogueState` exactly — the vocabulary `pet-catalogue.ts` was
/// written around before there was an endpoint, kept whole so that "unreachable", "empty" and
/// "unreadable" stay three answers rather than one.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum CatalogueReading {
    Unconfigured,
    Unreachable {
        detail: String,
    },
    Unreadable {
        detail: String,
    },
    /// A catalogue answered, and nothing in it can be installed.
    Empty {
        skipped: usize,
    },
    /// A catalogue answered with offers. `skipped` is how many entries it listed that this build
    /// could not offer.
    Listed {
        offers: Vec<CatalogueOffer>,
        skipped: usize,
    },
}

impl CatalogueFailure {
    fn into_reading(self) -> CatalogueReading {
        match self {
            Self::Unconfigured => CatalogueReading::Unconfigured,
            Self::Unreachable(detail) => CatalogueReading::Unreachable { detail },
            Self::Unreadable(detail) => CatalogueReading::Unreadable { detail },
        }
    }
}

/// Why one offer could not be installed.
///
/// Data rather than a sentence, for the reason `ResourceRefusal` gives: the wording a user reads is
/// assembled at the edge, where the function that knows the library's own vocabulary already
/// lives.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum AdoptionRefusal {
    /// The catalogue could not be read at all, so there is nothing to adopt from. The failure
    /// itself rather than a restatement of it: it has three arms and every one of them is a
    /// different thing to tell the user, so a caller that flattened them here would be losing the
    /// distinction one layer below the page that needs it.
    Catalogue(CatalogueFailure),
    /// The catalogue was read and does not offer that slug. Reachable without a race: the slug is
    /// resolved against the read this install just made, so an offer withdrawn since the page drew
    /// its list lands here rather than installing something nobody is offering.
    NoSuchOffer { slug: String },
    /// The sheet could not be fetched, or is not the image the response claimed.
    Transfer(RemoteRefusal),
    /// The library refused to publish it — already installed, over budget, not an image whose size
    /// this build can measure, or a filesystem that said no.
    Library(ResourceRefusal),
}

/// Read the catalogue, once, and say what it is.
pub async fn read_catalogue() -> CatalogueReading {
    match read().await {
        Ok(catalogue) if catalogue.entries.is_empty() => CatalogueReading::Empty {
            skipped: catalogue.skipped,
        },
        Ok(catalogue) => CatalogueReading::Listed {
            offers: catalogue.entries.iter().map(CatalogueOffer::from).collect(),
            skipped: catalogue.skipped,
        },
        Err(failure) => failure.into_reading(),
    }
}

/// One fetch and one parse, which is the whole of reading a catalogue.
async fn read() -> Result<Catalogue, CatalogueFailure> {
    let Some(endpoint) = LIBRARY_ENDPOINT else {
        return Err(CatalogueFailure::Unconfigured);
    };
    // The endpoint goes through the same function as every entry it lists, so a pinned address
    // that violates a rule is refused as a configuration instead of being requested anyway.
    let plan = remote_fetch_plan(LIBRARY_ENDPOINT, FetchKind::Catalogue, endpoint)
        .map_err(|refusal| CatalogueFailure::Unreachable(refusal.detail()))?;
    let fetched = fetch(&plan)
        .await
        .map_err(|refusal| CatalogueFailure::Unreachable(refusal.detail()))?;
    // The second half of §8's content-type rule: the header said `application/json`, and this is
    // where the bytes are held to it. A failure here is `Unreadable` and not `Unreachable` because
    // something *was* reached and was not a catalogue.
    parse_catalogue(&fetched.bytes).map_err(CatalogueFailure::Unreadable)
}

/// Read a catalogue document into offers, dropping and counting what cannot be offered.
///
/// `Err` is a document that is not a catalogue at all: not JSON, or JSON with no `pets` array. A
/// document that *is* a catalogue and holds entries this build cannot use is `Ok` with a `skipped`
/// count — the difference between "this is not the document" and "this is the document, and here
/// is what of it I can use" is the whole of §7.5's defect list.
pub fn parse_catalogue(bytes: &[u8]) -> Result<Catalogue, String> {
    let document: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("the catalogue is not JSON: {error}"))?;
    let pets = document
        .get("pets")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "the catalogue has no `pets` array in it".to_string())?;

    let mut entries: Vec<CatalogueEntry> = Vec::new();
    let mut skipped = 0usize;
    let mut seen = std::collections::HashSet::new();
    for (index, value) in pets.iter().enumerate() {
        if entries.len() >= MAX_CATALOGUE_ENTRIES {
            // Everything not yet looked at is counted, so the count is the whole of what this
            // build did not carry rather than the part of it that happened to be malformed.
            skipped += pets.len() - index;
            break;
        }
        match entry_of(value) {
            // Deduplicated by slug, first one wins. The library is keyed by directory and cannot
            // hold two characters under one id — `create` refuses the second with
            // `AlreadyInstalled` — so a catalogue that lists a slug twice would draw a row that
            // can only ever fail. The reference deduplicates the same way
            // (`PetBrowser.swift:121-124`).
            Some(entry) if seen.insert(entry.slug.clone()) => entries.push(entry),
            _ => skipped += 1,
        }
    }
    Ok(Catalogue { entries, skipped })
}

/// One entry, or `None` for one this build will not offer.
///
/// Deliberately total: every field is read leniently, so one malformed element of a 4,044-element
/// array costs one row and not the list. That is the reference's `Lenient<T>` decision
/// (`PetBrowser.swift:26-31`) and it is the one worth keeping — the alternative, decoding the array
/// strictly, makes a single bad submission an app that cannot show the catalogue at all.
fn entry_of(value: &serde_json::Value) -> Option<CatalogueEntry> {
    let text = |key: &str| -> Option<String> {
        value
            .get(key)
            .and_then(|field| field.as_str())
            .map(str::trim)
            .filter(|field| !field.is_empty())
            .map(str::to_string)
    };
    let slug = text("slug")?;
    // The one value from the network that becomes a path. Refused before anything is fetched, and
    // by the library's own rule rather than by a second one written here.
    if name_problem(&slug).is_some() {
        return None;
    }
    let sheet_url = text("spritesheetUrl")?;
    // An entry whose sheet address this build may not fetch is not an offer: it is a row that could
    // only ever fail. The plan is built and discarded — `install_from_catalogue` builds it again —
    // so an address that is refused is refused while the list is read, not when the user clicks.
    remote_fetch_plan(LIBRARY_ENDPOINT, FetchKind::Sheet, &sheet_url).ok()?;
    Some(CatalogueEntry {
        name: text("displayName").unwrap_or_else(|| slug.clone()),
        author: text("submittedBy"),
        kind: text("kind"),
        terms: text("license").or_else(|| text("licence")),
        sheet_url,
        slug,
    })
}

/// Download one offer and install it, through the library's own transaction.
///
/// The slug is resolved against the read this call makes rather than against a list the caller
/// holds. That costs one catalogue fetch per install and buys two things: the address that is
/// fetched is one this build just read rather than one a window remembered, and an offer withdrawn
/// since the page drew its list is [`AdoptionRefusal::NoSuchOffer`] instead of an install of
/// something nobody is offering.
pub async fn install_from_catalogue(
    slug: &str,
    library: &CharacterLibrary,
    installed_at_ms: u64,
) -> Result<InstalledCharacter, AdoptionRefusal> {
    let catalogue = read().await.map_err(AdoptionRefusal::Catalogue)?;
    let entry = catalogue
        .entries
        .into_iter()
        .find(|entry| entry.slug == slug)
        .ok_or_else(|| AdoptionRefusal::NoSuchOffer {
            slug: slug.to_string(),
        })?;

    let plan = remote_fetch_plan(LIBRARY_ENDPOINT, FetchKind::Sheet, &entry.sheet_url)
        .map_err(AdoptionRefusal::Transfer)?;
    let sheet = fetch(&plan).await.map_err(AdoptionRefusal::Transfer)?;
    // §8's content-type rule, second half, and the one thing a header cannot say for itself: the
    // bytes have to be the format the response claimed. A PNG served as `image/webp` is refused
    // here rather than handed to a decoder that was told to expect the other one — and, because
    // this build measures a sheet's size before it can bound it, a format whose header it cannot
    // read is not a sheet at all.
    let format = image_format(&sheet.bytes).ok_or_else(|| {
        AdoptionRefusal::Transfer(RemoteRefusal::Corrupt {
            detail: format!(
                "the response declared {} and this build can read no image header in the bytes",
                sheet.content_type
            ),
        })
    })?;
    let declared = sheet
        .content_type
        .strip_prefix("image/")
        .unwrap_or(&sheet.content_type);
    // `image/jpeg` is the one content type whose name is not the format's own short name.
    let declared = if declared == "jpg" { "jpeg" } else { declared };
    if declared != format {
        return Err(AdoptionRefusal::Transfer(RemoteRefusal::Corrupt {
            detail: format!(
                "the response declared {} and the bytes are {format}",
                sheet.content_type
            ),
        }));
    }

    // The transaction every other character goes through, with `Remote` as the kind so that one
    // that came from the network is distinguishable from one the user made or imported — which is
    // the question the licence work will have to answer.
    library
        .create(&CreateRequest {
            character_id: entry.slug.clone(),
            name: entry.name.clone(),
            kind: CharacterKind::Remote,
            installed_at_ms,
            // This build's own name for the file, derived from what the bytes *are*. See the
            // module header: no name from the catalogue is ever joined onto a path.
            sheet_name: format!("spritesheet.{format}"),
            sheet: sheet.bytes,
            columns: DEFAULT_SHEET_COLUMNS,
            rows: DEFAULT_SHEET_ROWS,
        })
        .map_err(AdoptionRefusal::Library)
}
