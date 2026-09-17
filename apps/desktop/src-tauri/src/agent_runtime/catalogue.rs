//! The ACP agent catalogue: what the public registry publishes, read as data and never as an
//! instruction.
//!
//! The registry is how a client supports many engines without shipping a list of them. Its
//! aggregate is one JSON document (`registry.json`) of agent entries, and its shape is published
//! rather than guessed: `registry.schema.json` and `agent.schema.json` in
//! `github.com/agentclientprotocol/registry`, both of which name
//! `https://cdn.agentclientprotocol.com/registry/v1/latest/…` as their own `$id`. This module is
//! that schema, and nothing else.
//!
//! **A catalogue entry describes a process, never a capability.** Every field below is a fact the
//! publisher wrote about an artifact — an id, a version, a URL, an argument list. None of it is a
//! measurement of an engine, because nothing here has run. What an engine can do is established by
//! a handshake and a session negotiation, which is [`super::capabilities`]'s subject and the reason
//! no function in this file can answer [`super::adapters::HostFeature`]: the type that could answer
//! one deliberately does not exist here. A page that rendered a capability row from a catalogue
//! entry would be offering a button for something nothing has confirmed.
//!
//! **Nothing here downloads and nothing here runs.** [`parse`] reads bytes that are already in
//! hand. [`Standing`] says what a distribution *is*, not how to obtain it — and for the three kinds
//! the schema defines the answers differ in a way that matters, which is [`InstallGate`]'s subject.
//!
//! Files in this module's world: the schema's three distribution kinds are `binary`, `npx` and
//! `uvx` (`agent.schema.json`'s `distribution` object, `additionalProperties: false`). Zed reads
//! two of them — its `RegistryDistribution` has `binary` and `npx` only
//! (`zed-main/crates/project/src/agent_registry_store.rs:658-664`) and its builder drops an entry
//! that has neither (`:445-456`), so a `uvx`-only agent is invisible in Zed's registry page. This
//! module keeps all three, because the schema is the contract and a distribution kind this host
//! cannot use is a thing to *report* rather than a thing to make disappear.

use std::collections::BTreeMap;
use std::fmt;

use serde::Deserialize;

/// The document that lists the registry's entries, and the version of its own shape
/// (`registry.schema.json`: `required: ["version", "agents"]`).
#[derive(Debug, Clone, Deserialize)]
pub struct CatalogueDocument {
    /// The registry schema's version. Read and kept — a document whose major version this build
    /// does not know is refused rather than parsed on the assumption that the shape held.
    pub version: String,
    pub agents: Vec<Entry>,
}

/// One agent's manifest (`agent.schema.json`). A manifest is also published on its own, so this
/// is the same type whether it arrived inside the aggregate or as a single file.
#[derive(Debug, Clone, Deserialize)]
pub struct Entry {
    /// The registry's id. The schema pins it to `^[a-z][a-z0-9-]*$`, which is a strict subset of
    /// this app's `validate_id` charset — so every registry id is usable as a registration id,
    /// and [`Entry::registration_id`] is the one place that mapping is stated.
    pub id: String,
    pub name: String,
    /// Semantic version, `^[0-9]+\.[0-9]+\.[0-9]+$` on the stable channel — no pre-release suffix.
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    /// Author names. Zed's parser has no field for these (`agent_registry_store.rs:641-656`); the
    /// schema has, and a licence or an author is exactly the provenance a user needs in order to
    /// decide whether to trust an engine, so it is kept.
    #[serde(default)]
    pub authors: Vec<String>,
    /// An SPDX identifier or the literal `proprietary` (the schema allows both strings).
    #[serde(default)]
    pub license: Option<String>,
    /// A URL to the licence text or the terms of service.
    ///
    /// Required by the schema for every entry except one (`agent.schema.json:8-16` carries an
    /// `if`/`else` that excludes the single id `dimcode`), so a missing one is reported rather
    /// than treated as an absent optional: for every other entry its absence is a bug in the
    /// document, and the field is what tells a user what they are agreeing to.
    #[serde(default)]
    pub license_url: Option<String>,
    /// Where the icon is. The schema says the build sets this from the entry's own `icon.svg`, and
    /// a relative value resolves against the entry's directory in the registry repository rather
    /// than against the CDN — which is why [`Entry::icon_url`] exists as a function.
    #[serde(default)]
    pub icon: Option<String>,
    pub distribution: Distribution,
    /// The optional preview channel. Package-based only: the schema's `previewChannel` permits
    /// `npx` and `uvx` and no `binary`, so a preview can never be something this host would have
    /// to download itself.
    #[serde(default)]
    pub preview: Option<Preview>,
}

impl Entry {
    /// Whether this entry carries everything the schema requires of it.
    ///
    /// Checked here rather than trusted, because the document is fetched over a network and a
    /// malformed entry must be one row that says so rather than a parse failure for the whole
    /// catalogue. The schema's own rules that serde cannot express: the id charset, the version
    /// pattern, and the licence URL the `if`/`else` makes mandatory.
    pub fn validate(&self) -> Result<(), EntryDefect> {
        if !is_registry_id(&self.id) {
            return Err(EntryDefect::Id {
                value: self.id.clone(),
            });
        }
        if !is_semver(&self.version) {
            return Err(EntryDefect::Version {
                value: self.version.clone(),
            });
        }
        if self.distribution.is_empty() {
            return Err(EntryDefect::NoDistribution);
        }
        // The schema requires a licence URL of every entry but `dimcode`. Refused here for the
        // same reason the schema refuses it: the URL is what a user reads before agreeing to run
        // someone's agent, and an entry that omitted it is not one to offer.
        if self.id != EXEMPT_FROM_LICENSE_URL && self.license_url.is_none() {
            return Err(EntryDefect::NoLicenseUrl);
        }
        Ok(())
    }

    /// The id a registration would carry. Total, and deliberately its own function: the registry's
    /// charset is a subset of this app's, and a reviewer reading `Entry::registration_id` should
    /// find that claim rather than a `.clone()` whose safety has to be re-derived.
    pub fn registration_id(&self) -> &str {
        &self.id
    }

    /// An absolute URL for the entry's icon, when it has one.
    ///
    /// Two cases, and the schema's `icon` field is only ever the second: a value that is already a
    /// URL, and a path relative to the entry's directory in the registry repository. Zed resolves
    /// the relative case against `raw.githubusercontent.com/agentclientprotocol/registry/main/…`
    /// (`agent_registry_store.rs:574-585`) rather than against the CDN, and this is the same
    /// mapping for the same reason: the CDN serves the aggregate, not the per-entry files.
    pub fn icon_url(&self) -> Option<String> {
        let icon = self.icon.as_ref()?;
        if icon.starts_with("https://") || icon.starts_with("http://") {
            return Some(icon.clone());
        }
        Some(format!(
            "{REGISTRY_REPO_RAW}/{}/{relative}",
            self.id,
            relative = icon.trim_start_matches("./")
        ))
    }
}

/// The schema's one carve-out: the `id` for which `license_url` is not required
/// (`agent.schema.json:8-16`).
const EXEMPT_FROM_LICENSE_URL: &str = "dimcode";

/// Where the registry's per-entry files live. The CDN serves the aggregate; the entry's own
/// directory — icons included — is in the repository.
const REGISTRY_REPO_RAW: &str =
    "https://raw.githubusercontent.com/agentclientprotocol/registry/main";

/// The manifest's own schema version this build understands.
///
/// The registry's `version` is its *schema* version and the schema's pattern is only `^x.y.z`, so
/// the major number is the whole of what can be compared. A document from a newer major describes
/// a shape this build has not read, and guessing would be the one thing a catalogue must not do.
pub const SUPPORTED_REGISTRY_MAJOR: u64 = 1;

/// Why an entry cannot be offered, or why a whole document cannot be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryDefect {
    /// The id does not match the schema's `^[a-z][a-z0-9-]*$`.
    Id { value: String },
    /// The version is not `x.y.z`.
    Version { value: String },
    /// `distribution` had no properties, which the schema forbids (`minProperties: 1`).
    NoDistribution,
    /// No `license_url` on an entry the schema does not exempt.
    NoLicenseUrl,
    /// An archive URL the schema's `format: uri` would reject, or an archive suffix the schema
    /// names as unsupported (`.dmg`, `.pkg`, `.deb`, `.rpm` are installers, not archives).
    Archive { url: String, reason: &'static str },
}

impl fmt::Display for EntryDefect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EntryDefect::Id { value } => write!(f, "`{value}` is not a usable registry id"),
            EntryDefect::Version { value } => write!(f, "`{value}` is not a semantic version"),
            EntryDefect::NoDistribution => write!(f, "the entry publishes no distribution"),
            EntryDefect::NoLicenseUrl => write!(f, "the entry publishes no licence URL"),
            EntryDefect::Archive { url, reason } => write!(f, "{url}: {reason}"),
        }
    }
}

/// One agent's distributions (`agent.schema.json`'s `distribution`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Distribution {
    /// Platform-keyed archives. The schema's `propertyNames` pins the keys to the six in
    /// [`Platform::ALL`], so an unrecognised key is a document this build does not fully
    /// understand rather than a target to guess at.
    #[serde(default)]
    pub binary: BTreeMap<String, BinaryTarget>,
    #[serde(default)]
    pub npx: Option<Package>,
    #[serde(default)]
    pub uvx: Option<Package>,
    /// Distribution kinds the schema does not (yet) define.
    ///
    /// Captured rather than refused, and this is a deliberate reading of
    /// `additionalProperties: false`. Strictly, a document with a fourth kind is invalid; a
    /// client that *failed the whole catalogue* over one entry's new distribution would go dark
    /// the day the schema grew, and one that silently ignored it would offer a row with no
    /// distribution and no explanation. Keeping them makes the third option available: the row
    /// says which kinds it did not understand.
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}

impl Distribution {
    /// Whether anything at all is published. The schema's `minProperties: 1`.
    pub fn is_empty(&self) -> bool {
        self.binary.is_empty() && self.npx.is_none() && self.uvx.is_none() && self.other.is_empty()
    }
}

/// One platform's archive (`agent.schema.json`'s `binaryTarget`).
#[derive(Debug, Clone, Deserialize)]
pub struct BinaryTarget {
    /// `required`. The schema restricts the suffix to `.zip`, `.tar.gz`, `.tgz`, `.tar.bz2`,
    /// `.tbz2` or a raw binary, and refuses installer formats.
    pub archive: String,
    /// `required`. The command inside the extracted tree.
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// The archive's SHA-256, **optional in the schema** — and this is the field that decides
    /// whether a catalogue can become an installer on its own terms. See [`InstallGate::Digest`].
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// A package-manager distribution (`agent.schema.json`'s `packageDistribution`), shared by `npx`
/// and `uvx` because the schema gives them one shape.
#[derive(Debug, Clone, Deserialize)]
pub struct Package {
    /// The package name, with an optional version. The schema says "with optional version" and
    /// pins nothing further, so `@latest` is a legal value here even though the registry's
    /// submission guide asks contributors not to use it — which means a catalogue may not assume a
    /// version is stated. [`Package::pinned_version`] is the honest read of it.
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

impl Package {
    /// The version the package string pins, when it pins one.
    ///
    /// `@scope/name@1.2.3` pins `1.2.3`; `@scope/name` and `@scope/name@latest` pin nothing. Not a
    /// convenience: a row that says "version 1.2.3" for an unpinned package would be repeating the
    /// *entry's* version as though it were the artifact's, and those are different claims.
    pub fn pinned_version(&self) -> Option<&str> {
        let at = self.package.rfind('@')?;
        // A leading `@` is npm's scope marker, not a version separator.
        if at == 0 {
            return None;
        }
        let version = &self.package[at + 1..];
        if version.is_empty() || version == "latest" {
            return None;
        }
        Some(version)
    }
}

/// The optional preview channel (`agent.schema.json`'s `previewChannel`).
#[derive(Debug, Clone, Deserialize)]
pub struct Preview {
    pub version: String,
    /// Package-based only — the schema's `previewChannel.distribution` has `npx` and `uvx` and no
    /// `binary`. So a preview is never something this host would download itself, which is why
    /// this type reuses [`Package`] and cannot express an archive.
    #[serde(default)]
    pub distribution: PreviewDistribution,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PreviewDistribution {
    #[serde(default)]
    pub npx: Option<Package>,
    #[serde(default)]
    pub uvx: Option<Package>,
}

/// The six targets the schema names (`agent.schema.json`'s `binaryDistribution.propertyNames`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Platform {
    DarwinAarch64,
    DarwinX86_64,
    LinuxAarch64,
    LinuxX86_64,
    WindowsAarch64,
    WindowsX86_64,
}

impl Platform {
    pub const ALL: [Platform; 6] = [
        Platform::DarwinAarch64,
        Platform::DarwinX86_64,
        Platform::LinuxAarch64,
        Platform::LinuxX86_64,
        Platform::WindowsAarch64,
        Platform::WindowsX86_64,
    ];

    /// The key the schema spells this target with. The same six strings are the wire's.
    pub fn key(self) -> &'static str {
        match self {
            Platform::DarwinAarch64 => "darwin-aarch64",
            Platform::DarwinX86_64 => "darwin-x86_64",
            Platform::LinuxAarch64 => "linux-aarch64",
            Platform::LinuxX86_64 => "linux-x86_64",
            Platform::WindowsAarch64 => "windows-aarch64",
            Platform::WindowsX86_64 => "windows-x86_64",
        }
    }

    pub fn parse(key: &str) -> Option<Self> {
        Platform::ALL.into_iter().find(|p| p.key() == key)
    }

    /// The target this build runs on, or `None` on one the schema does not name.
    ///
    /// Follows the platform this app ships for (§3.2: Linux, and WebKitGTK 4.1 as the engine), so
    /// the arm that matters here is Linux — the others are named because the schema names them and
    /// a document is read in full, not because this build offers them.
    pub fn current() -> Option<Self> {
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            return Some(Platform::LinuxX86_64);
        }
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        {
            return Some(Platform::LinuxAarch64);
        }
        // Not a target this build ships for. `None` is the honest answer and the one
        // `Standing::Unsupported` is built for, rather than a guess that would offer a download
        // for a machine this app cannot run on.
        #[allow(unreachable_code)]
        None
    }
}

/// Which package manager would run a package distribution.
///
/// The distinction is `uvx` versus `npx` and not a product name, because it is the *manager* that
/// owns the trust decision: it resolves the platform, fetches the artifact, and keeps its own
/// integrity record. NekoWite registers the invocation and is not part of that chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageManager {
    Npx,
    Uvx,
}

impl PackageManager {
    /// The program a registration would point at. `npx` arranges its own cache; `uvx` is `uv`'s.
    pub fn program(self) -> &'static str {
        match self {
            PackageManager::Npx => "npx",
            PackageManager::Uvx => "uvx",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            PackageManager::Npx => "npx",
            PackageManager::Uvx => "uvx",
        }
    }
}

/// What this host can say about one entry's distribution — facts about a process.
///
/// No arm of this describes a capability, and that is the invariant the type exists to hold: the
/// only way to learn what an engine can do is to start it and read its handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Standing {
    /// The entry publishes a package-manager invocation this host could register.
    ///
    /// The program is the package manager's, so the fetch is the manager's too: NekoWite hands the
    /// artifact's provenance to a tool the user already trusts and records the result as
    /// [`super::registry::InstallSource::External`]. Nothing in this arm downloads anything.
    ViaPackageManager {
        manager: PackageManager,
        package: String,
        args: Vec<String>,
    },
    /// The entry publishes an archive for the machine this build runs on, and **no package-based
    /// distribution at all**. Using it would make NekoWite the downloader, which is the decision
    /// [`InstallGate`] describes and this build does not take.
    ArchiveOnly { platform: Platform, cmd: String },
    /// An archive is published for other machines, and none for this one, and there is no package
    /// distribution either.
    Unsupported { published: Vec<Platform> },
    /// The entry publishes distributions and every one of them is a kind this build does not
    /// understand. The names are kept so a row can say which.
    Unrecognised { kinds: Vec<String> },
}

impl Standing {
    /// Whether this host could act on the entry today.
    ///
    /// Exactly one arm is actionable, and the reason is the same for the three that are not: each
    /// would require this app to obtain the artifact itself, under a trust chain §3.3 does not let
    /// it have ([`InstallGate::Digest`]).
    ///
    /// - [`Standing::ViaPackageManager`] — the package manager fetches. NekoWite registers an
    ///   invocation and joins no trust chain of its own, so there is nothing here to gate.
    /// - [`Standing::ArchiveOnly`] — actionable only if this app were the downloader. It is not,
    ///   and that is a decision rather than a gap: see [`InstallGate`].
    /// - [`Standing::Unsupported`] and [`Standing::Unrecognised`] — nothing to run on this
    ///   machine, or nothing this build can describe.
    ///
    /// A page reads this to decide whether to draw a control at all. Offering one for an
    /// inactionable entry is the failure 「不能让按钮看起来可用」 names, so the question is a method
    /// on the value rather than a match arm a page could get wrong.
    pub fn is_actionable(&self) -> bool {
        matches!(self, Standing::ViaPackageManager { .. })
    }
}

/// The checks §3.3 requires of a download, and which of them a registry entry can support.
///
/// This is the module's answer to "why is there no Install button", as a value rather than a
/// paragraph. `update.rs`'s gate (`Check::ALL`, `update.rs:198-204`) is the shape being compared
/// against, and each arm below names what that gate does and what a catalogue entry can offer
/// instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallGate {
    /// **The digest. Does not transfer, and this is the one that decides it.**
    ///
    /// §3.3's rule is that a response must not supply both halves of its own proof
    /// (`update.rs:6-9`, `:160-170`): the digest that counts is the one in the app's own
    /// [`super::update::PinnedRelease`], which ships inside the binary (`update.rs:115-119`). A
    /// registry entry's `sha256` arrives in the same document as its `archive` URL — one fetch,
    /// one origin, both halves — so checking it proves the download is self-consistent and nothing
    /// more. It is the same status as `ArtifactClaims`, which `update.rs` records and never reads.
    /// Worse, the field is `Option` in the schema: an entry may publish no digest at all, and a
    /// gate that cannot run is not a gate that passed.
    Digest,
    /// **The architecture. Transfers.**
    ///
    /// `update.rs:347-354` reads a 64-byte ELF header out of the candidate file itself, which is
    /// self-contained and so works for any URL. For a registry entry the check changes meaning
    /// slightly and stays necessary: the platform key is the publisher's claim, so the header is
    /// what confirms the artifact matches the key it was filed under.
    Architecture,
    /// **The execute permission. Transfers unchanged.**
    ///
    /// `update.rs:356-377` refuses a staged file that already carries a bit and applies `0o755`
    /// only after the checks that can be made without one. A downloaded archive is the same
    /// situation, and the rule §3.2 states (未验证文件不得执行) is the same rule.
    ExecuteBit,
    /// **The version. Transfers in part.**
    ///
    /// `update.rs:379-394` compares what the candidate prints against the version its
    /// `PinnedRelease` names. For a registry entry the version compared against is the
    /// *publisher's* string in the document, so the check confirms the artifact matches its own
    /// listing rather than that either is what this app intended. For a package distribution it
    /// may not be runnable at all: the schema permits an unpinned `package`
    /// ([`Package::pinned_version`] answers `None`), and nothing in the schema says an engine
    /// answers `--version` with its entry's version.
    Version,
    /// **ACP initialisation. Transfers, and it is the only check that measures a capability.**
    ///
    /// `update.rs:396-399` performs this host's handshake against the candidate, which is what
    /// `update.rs`'s own [`super::update::Handshake`] (`:151-158`) carries. For a catalogue entry
    /// this is the check that turns a listing into a measured engine — and it is per (agent,
    /// version), so it cannot be run once for the registry and reused: two entries are two
    /// programs, and a version change is a new thing to ask.
    AcpInitialization,
    /// **The contract tests. Do not transfer.**
    ///
    /// §3.3's last check pins a release by running this host's own suite against it. That is
    /// possible for the one engine this app bundles and not for a registry of third-party
    /// engines: there is no suite that a `uvx` invocation of someone else's agent is expected to
    /// pass, and inventing one would make this app the arbiter of a protocol it does not own.
    ContractTests,
}

impl InstallGate {
    pub const ALL: [InstallGate; 6] = [
        InstallGate::Digest,
        InstallGate::Architecture,
        InstallGate::ExecuteBit,
        InstallGate::Version,
        InstallGate::AcpInitialization,
        InstallGate::ContractTests,
    ];

    /// Whether this check can run for an entry that came from the registry.
    ///
    /// `false` is not a gap in this build's work: it is the reason the archive arm of
    /// [`Standing`] offers no action. Anything other than `true` here is a check that would have to
    /// be replaced by a *decision* — pinning a digest in-app, or shipping a suite — and neither is
    /// a catalogue's to make.
    pub fn transfers(self) -> bool {
        match self {
            // Both halves of the proof come from one fetch; and the field is optional besides.
            InstallGate::Digest => false,
            InstallGate::Architecture
            | InstallGate::ExecuteBit
            | InstallGate::AcpInitialization => true,
            // Only in part: runnable for a binary whose `--version` follows the convention, not
            // runnable at all for an unpinned package.
            InstallGate::Version => false,
            // Nothing a third-party registry entry could be held to.
            InstallGate::ContractTests => false,
        }
    }

    /// The wire spelling, for the reason `HostFeature::as_str` gives: one vocabulary for one value.
    pub fn as_str(self) -> &'static str {
        match self {
            InstallGate::Digest => "digest",
            InstallGate::Architecture => "architecture",
            InstallGate::ExecuteBit => "execute-permission",
            InstallGate::Version => "version",
            InstallGate::AcpInitialization => "acp-initialization",
            InstallGate::ContractTests => "contract-tests",
        }
    }
}

impl Entry {
    /// What this host could do with the entry's distribution, described and not performed.
    pub fn standing(&self) -> Standing {
        let current = Platform::current();
        // A package distribution is preferred over an archive even when both are published, and
        // Zed makes the same call for its own reason (`agent_registry_store.rs:445-456` picks the
        // binary when the platform is supported). The reason here is the trust one: the manager
        // owns provenance, and an archive makes this app the downloader.
        if let Some((manager, package)) = self.package_distribution() {
            return Standing::ViaPackageManager {
                manager,
                package: package.package.clone(),
                args: package.args.clone(),
            };
        }
        let published: Vec<Platform> = self
            .distribution
            .binary
            .keys()
            .filter_map(|key| Platform::parse(key))
            .collect();
        match current.and_then(|platform| {
            self.distribution
                .binary
                .get(platform.key())
                .map(|target| (platform, target))
        }) {
            Some((platform, target)) => Standing::ArchiveOnly {
                platform,
                cmd: target.cmd.clone(),
            },
            None if !published.is_empty() => {
                let mut published = published;
                published.sort();
                Standing::Unsupported { published }
            }
            None => {
                let mut kinds: Vec<String> = self.distribution.other.keys().cloned().collect();
                kinds.sort();
                Standing::Unrecognised { kinds }
            }
        }
    }

    /// The package distribution to prefer, `npx` before `uvx` when both are published.
    ///
    /// A documented choice rather than a discovered one: the schema gives no precedence, and the
    /// two are not equivalent — an engine that publishes both has made two different promises, and
    /// picking one silently would hide the other. `npx` is first because a Node runtime is more
    /// likely to be present on a desktop Linux system than `uv`; the row reports which was chosen.
    pub fn package_distribution(&self) -> Option<(PackageManager, &Package)> {
        self.distribution
            .npx
            .as_ref()
            .map(|package| (PackageManager::Npx, package))
            .or_else(|| {
                self.distribution
                    .uvx
                    .as_ref()
                    .map(|package| (PackageManager::Uvx, package))
            })
    }

    /// The argument array a registration would carry for a package distribution, or `None` when
    /// the entry has none.
    ///
    /// The shape §3.4.3 requires: `program` and `args` stay separate, so this builds the array and
    /// never a command line. The package is the first argument and its own value — a package name
    /// containing a space is npm's problem, not a separator here.
    pub fn package_invocation(&self) -> Option<(PackageManager, Vec<String>)> {
        let (manager, package) = self.package_distribution()?;
        let mut args = vec![package.package.clone()];
        args.extend(package.args.iter().cloned());
        Some((manager, args))
    }
}

/// The registry id charset, `agent.schema.json`'s `^[a-z][a-z0-9-]*$`.
fn is_registry_id(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `agent.schema.json`'s `^[0-9]+\.[0-9]+\.[0-9]+$` — the stable channel's version, with no
/// pre-release suffix. The preview channel's pattern is a separate one and is not this.
fn is_semver(value: &str) -> bool {
    let mut parts = value.split('.');
    let (Some(major), Some(minor), Some(patch), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    [major, minor, patch]
        .into_iter()
        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// Why a whole document was refused, as opposed to one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentError {
    /// The bytes are not the JSON this schema describes.
    Malformed { detail: String },
    /// `version` does not parse as `x.y.z`, so the schema's own pattern did not hold.
    Version { value: String },
    /// A major version this build has not read. Refused rather than parsed on the assumption that
    /// the shape held — the one thing a catalogue must not guess at.
    UnsupportedVersion { value: String, supported: u64 },
}

impl fmt::Display for DocumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DocumentError::Malformed { detail } => {
                write!(f, "the registry is not readable: {detail}")
            }
            DocumentError::Version { value } => {
                write!(f, "`{value}` is not a registry schema version")
            }
            DocumentError::UnsupportedVersion { value, supported } => write!(
                f,
                "this build reads registry schema {supported}.x, and the document is {value}"
            ),
        }
    }
}

/// One entry as a page reads it: the facts, the standing, and the defects that were found.
///
/// Defective entries are *returned* rather than dropped. A catalogue that silently omitted an
/// entry would make a missing engine look like an engine that does not exist, which is the same
/// failure as a button that offers nothing.
#[derive(Debug, Clone)]
pub struct CatalogueRow {
    pub entry: Entry,
    pub standing: Standing,
    pub defects: Vec<EntryDefect>,
}

impl CatalogueRow {
    /// Whether the entry is complete enough to act on.
    ///
    /// Two questions, and both must be yes: the document said everything the schema requires of
    /// the entry, *and* what it published is something this host can actually do something with
    /// ([`Standing::is_actionable`]). An entry that parses perfectly and publishes only an archive
    /// is not actionable here, and a row that counted it as offerable would be the button this
    /// module exists to not draw.
    pub fn is_offerable(&self) -> bool {
        self.defects.is_empty() && self.standing.is_actionable()
    }
}

/// A parsed catalogue: the registry's entries, each with what this host could do about it.
#[derive(Debug, Clone)]
pub struct Catalogue {
    pub version: String,
    pub rows: Vec<CatalogueRow>,
}

impl Catalogue {
    /// The row for `id`, if the registry publishes one.
    pub fn row(&self, id: &str) -> Option<&CatalogueRow> {
        self.rows.iter().find(|row| row.entry.id == id)
    }

    /// How many rows are complete enough to offer, so a page can say what it is showing.
    pub fn offerable(&self) -> usize {
        self.rows.iter().filter(|row| row.is_offerable()).count()
    }
}

/// Read the registry document.
///
/// The whole of this module's input, and bytes already in hand: nothing here has a URL, a socket
/// or a process. Where those bytes come from is [`super::super::commands::agent_registry`]'s
/// decision, and keeping it out of this function is what makes the schema testable without a
/// network.
pub fn parse(bytes: &[u8]) -> Result<Catalogue, DocumentError> {
    let document: CatalogueDocument =
        serde_json::from_slice(bytes).map_err(|error| DocumentError::Malformed {
            detail: error.to_string(),
        })?;
    let major = document
        .version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u64>().ok())
        .ok_or_else(|| DocumentError::Version {
            value: document.version.clone(),
        })?;
    if major != SUPPORTED_REGISTRY_MAJOR {
        return Err(DocumentError::UnsupportedVersion {
            value: document.version.clone(),
            supported: SUPPORTED_REGISTRY_MAJOR,
        });
    }
    let rows = document
        .agents
        .into_iter()
        .map(|entry| {
            let mut defects: Vec<EntryDefect> = Vec::new();
            if let Err(defect) = entry.validate() {
                defects.push(defect);
            }
            for (key, target) in &entry.distribution.binary {
                if Platform::parse(key).is_none() {
                    defects.push(EntryDefect::Archive {
                        url: key.clone(),
                        reason: "not one of the six platform targets the schema names",
                    });
                }
                if let Some(reason) = archive_suffix_reason(&target.archive) {
                    defects.push(EntryDefect::Archive {
                        url: target.archive.clone(),
                        reason,
                    });
                }
            }
            let standing = entry.standing();
            CatalogueRow {
                entry,
                standing,
                defects,
            }
        })
        .collect();
    Ok(Catalogue {
        version: document.version,
        rows,
    })
}

/// Why an archive URL is not one the schema allows, or `None` when it is.
///
/// The schema names the formats explicitly (`archive`: `.zip`, `.tar.gz`, `.tgz`, `.tar.bz2`,
/// `.tbz2`, or a raw binary) and refuses installer formats (.dmg, .pkg, .deb, .rpm). Worth
/// checking rather than trusting: the two lists are the difference between a file this host could
/// extract and a file it would have to hand to the system package manager, which is a different
/// act with a different trust model.
fn archive_suffix_reason(url: &str) -> Option<&'static str> {
    const INSTALLERS: [&str; 4] = [".dmg", ".pkg", ".deb", ".rpm"];
    let lower = url.to_ascii_lowercase();
    if let Some(suffix) = INSTALLERS.iter().find(|suffix| lower.ends_with(**suffix)) {
        // Not a borrow of `suffix`'s text: the reason is a fixed sentence per case, and the
        // matched suffix is already in the URL a row prints.
        let _ = suffix;
        return Some("an installer format, which the schema does not allow as an archive");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An entry shaped exactly like the schema's own example, so the parser is exercised against
    /// the document it will actually meet rather than against a convenient one.
    fn document(agents: &str) -> String {
        format!(r#"{{"version":"1.0.0","agents":[{agents}]}}"#)
    }

    fn full_entry() -> &'static str {
        r#"{
            "id": "someagent",
            "name": "SomeAgent",
            "version": "1.0.0",
            "description": "Agent for code editing",
            "repository": "https://github.com/example/someagent",
            "authors": ["Example Team"],
            "license": "MIT",
            "license_url": "https://github.com/example/someagent/blob/main/LICENSE",
            "icon": "icon.svg",
            "distribution": {
              "npx": { "package": "@acme/ai-agent", "args": ["--acp"], "env": {"AGENT_MODE": "production"} },
              "binary": {
                "linux-x86_64": {
                  "archive": "https://example.com/someagent-linux-x64.tar.gz",
                  "cmd": "./someagent",
                  "args": ["acp"],
                  "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
                }
              }
            }
        }"#
    }

    #[test]
    fn the_schema_s_example_entry_parses_field_for_field() {
        let catalogue = parse(document(full_entry()).as_bytes()).expect("the example is valid");
        assert_eq!(catalogue.version, "1.0.0");
        let row = catalogue.row("someagent").expect("the entry is there");
        assert!(row.is_offerable(), "no defects: {:?}", row.defects);
        assert_eq!(row.entry.name, "SomeAgent");
        assert_eq!(row.entry.version, "1.0.0");
        assert_eq!(row.entry.authors, vec!["Example Team".to_string()]);
        assert_eq!(row.entry.license.as_deref(), Some("MIT"));
        assert_eq!(
            row.entry.icon_url().as_deref(),
            Some(
                "https://raw.githubusercontent.com/agentclientprotocol/registry/main/someagent/icon.svg"
            )
        );
        // Both distributions survive parsing. Zed's parser has no `uvx` field at all
        // (`agent_registry_store.rs:658-664`), which is the difference this module keeps.
        assert!(row.entry.distribution.npx.is_some());
        assert_eq!(row.entry.distribution.binary.len(), 1);
    }

    #[test]
    fn a_uvx_entry_is_read_rather_than_dropped() {
        // The kind Zed cannot represent. A `uvx`-only entry is one its builder skips
        // (`agent_registry_store.rs:445-456`), so this is the case that proves the schema is being
        // read rather than a client's subset of it.
        let entry = r#"{
            "id": "pyagent", "name": "PyAgent", "version": "2.0.0", "description": "d",
            "license_url": "https://example.com/l",
            "distribution": { "uvx": { "package": "pyagent", "args": ["serve", "--acp"] } }
        }"#;
        let catalogue = parse(document(entry).as_bytes()).expect("valid");
        let row = catalogue.row("pyagent").expect("kept, not dropped");
        assert_eq!(
            row.standing,
            Standing::ViaPackageManager {
                manager: PackageManager::Uvx,
                package: "pyagent".to_string(),
                args: vec!["serve".to_string(), "--acp".to_string()],
            }
        );
    }

    #[test]
    fn a_package_distribution_is_preferred_over_an_archive() {
        // Both kinds published, and the choice is the trust one: the manager owns provenance,
        // an archive would make this app the downloader.
        let catalogue = parse(document(full_entry()).as_bytes()).expect("valid");
        let row = catalogue.row("someagent").expect("present");
        match &row.standing {
            Standing::ViaPackageManager {
                manager, package, ..
            } => {
                assert_eq!(*manager, PackageManager::Npx);
                assert_eq!(package, "@acme/ai-agent");
            }
            other => panic!("expected the package arm, got {other:?}"),
        }
        // And the invocation is an array, never a command line (§3.4.3).
        assert_eq!(
            row.entry.package_invocation(),
            Some((
                PackageManager::Npx,
                vec!["@acme/ai-agent".to_string(), "--acp".to_string()]
            ))
        );
    }

    #[test]
    fn an_archive_only_entry_is_named_as_the_decision_it_is() {
        // No package distribution, so using it would make NekoWite the downloader. The standing
        // says so rather than offering an action.
        let entry = r#"{
            "id": "binaryonly", "name": "BinaryOnly", "version": "1.0.0", "description": "d",
            "license_url": "https://example.com/l",
            "distribution": { "binary": {
                "linux-x86_64": { "archive": "https://example.com/a.tar.gz", "cmd": "./a" }
            } }
        }"#;
        let catalogue = parse(document(entry).as_bytes()).expect("valid");
        let row = catalogue.row("binaryonly").expect("present");
        assert_eq!(
            row.standing,
            Standing::ArchiveOnly {
                platform: Platform::LinuxX86_64,
                cmd: "./a".to_string(),
            }
        );
        assert_eq!(row.entry.package_invocation(), None);
    }

    #[test]
    fn a_row_no_action_could_be_taken_on_is_not_offerable() {
        // The rule 「不能让按钮看起来可用、点击后才发现不支持」, as a property rather than a habit.
        // All four arm shapes, and only the package-manager one is something this host can do
        // today — the other three each need this app to obtain the artifact itself, under a trust
        // chain §3.3 does not let it have.
        let via_manager = Standing::ViaPackageManager {
            manager: PackageManager::Npx,
            package: "p".to_string(),
            args: Vec::new(),
        };
        let archive_only = Standing::ArchiveOnly {
            platform: Platform::LinuxX86_64,
            cmd: "./a".to_string(),
        };
        let unsupported = Standing::Unsupported {
            published: vec![Platform::DarwinAarch64],
        };
        let unrecognised = Standing::Unrecognised {
            kinds: vec!["docker".to_string()],
        };
        assert!(via_manager.is_actionable());
        assert!(!archive_only.is_actionable());
        assert!(!unsupported.is_actionable());
        assert!(!unrecognised.is_actionable());

        // And the same four through a whole document, so the property holds on the path a page
        // actually reads rather than only on values a test built by hand.
        let entries = [
            r#"{"id":"mgr","name":"n","version":"1.0.0","description":"d",
                "license_url":"https://e.com/l","distribution":{"npx":{"package":"p"}}}"#,
            r#"{"id":"arc","name":"n","version":"1.0.0","description":"d",
                "license_url":"https://e.com/l","distribution":{"binary":{
                  "linux-x86_64":{"archive":"https://e.com/a.tar.gz","cmd":"./a"}}}}"#,
            r#"{"id":"mac","name":"n","version":"1.0.0","description":"d",
                "license_url":"https://e.com/l","distribution":{"binary":{
                  "darwin-aarch64":{"archive":"https://e.com/a.zip","cmd":"./a"}}}}"#,
            r#"{"id":"odd","name":"n","version":"1.0.0","description":"d",
                "license_url":"https://e.com/l","distribution":{"docker":{"image":"x"}}}"#,
        ];
        let catalogue = parse(document(&entries.join(",")).as_bytes()).expect("valid");
        assert_eq!(catalogue.rows.len(), 4, "every row is kept, none dropped");
        // None of the four has a defect: each published what the schema asks for. The difference
        // is entirely whether this host can act, which is what being offerable turns on.
        assert!(
            catalogue.rows.iter().all(|row| row.defects.is_empty()),
            "defects are a separate question from actionability"
        );
        assert_eq!(catalogue.offerable(), 1);
        assert!(catalogue.row("mgr").expect("present").is_offerable());
        for id in ["arc", "mac", "odd"] {
            assert!(
                !catalogue.row(id).expect("present").is_offerable(),
                "{id} must not be offered"
            );
        }
    }

    #[test]
    fn an_entry_for_other_machines_reports_what_it_publishes() {
        let entry = r#"{
            "id": "maconly", "name": "MacOnly", "version": "1.0.0", "description": "d",
            "license_url": "https://example.com/l",
            "distribution": { "binary": {
                "darwin-aarch64": { "archive": "https://example.com/a.zip", "cmd": "./a" }
            } }
        }"#;
        let catalogue = parse(document(entry).as_bytes()).expect("valid");
        let row = catalogue.row("maconly").expect("present");
        match &row.standing {
            Standing::Unsupported { published } => {
                assert_eq!(published, &vec![Platform::DarwinAarch64]);
            }
            other => panic!("expected the unsupported arm, got {other:?}"),
        }
    }

    #[test]
    fn a_distribution_kind_the_schema_does_not_define_is_reported_not_fatal() {
        // A future distribution kind must make one row say what it could not read, rather than
        // failing the whole catalogue or silently offering a row with no distribution at all.
        let entry = r#"{
            "id": "futuristic", "name": "Future", "version": "1.0.0", "description": "d",
            "license_url": "https://example.com/l",
            "distribution": { "docker": { "image": "example/agent" } }
        }"#;
        let catalogue = parse(document(entry).as_bytes()).expect("one unknown kind is not fatal");
        let row = catalogue.row("futuristic").expect("present");
        assert_eq!(
            row.standing,
            Standing::Unrecognised {
                kinds: vec!["docker".to_string()]
            }
        );
        // And the *other* entries still parsed: the point of not failing the document.
        let both = parse(document(&format!("{entry},{}", full_entry())).as_bytes()).expect("valid");
        assert_eq!(both.rows.len(), 2);
        assert_eq!(both.offerable(), 1);
    }

    #[test]
    fn the_schema_s_required_fields_are_required() {
        // Each defect is found and the row survives with it, which is the shape a page needs:
        // a row that says what is wrong rather than an entry that vanished.
        let cases: [(&str, EntryDefect); 4] = [
            (
                r#"{"id":"Bad_Id","name":"n","version":"1.0.0","description":"d",
                    "license_url":"https://e.com/l","distribution":{"npx":{"package":"p"}}}"#,
                EntryDefect::Id {
                    value: "Bad_Id".to_string(),
                },
            ),
            (
                r#"{"id":"ok","name":"n","version":"1.0","description":"d",
                    "license_url":"https://e.com/l","distribution":{"npx":{"package":"p"}}}"#,
                EntryDefect::Version {
                    value: "1.0".to_string(),
                },
            ),
            (
                r#"{"id":"ok","name":"n","version":"1.0.0","description":"d",
                    "license_url":"https://e.com/l","distribution":{}}"#,
                EntryDefect::NoDistribution,
            ),
            (
                r#"{"id":"ok","name":"n","version":"1.0.0","description":"d",
                    "distribution":{"npx":{"package":"p"}}}"#,
                EntryDefect::NoLicenseUrl,
            ),
        ];
        for (entry, expected) in cases {
            let catalogue = parse(document(entry).as_bytes()).expect("the document still parses");
            let row = &catalogue.rows[0];
            assert_eq!(row.defects, vec![expected.clone()], "{entry}");
            assert!(!row.is_offerable(), "{entry}");
        }
    }

    #[test]
    fn the_licence_url_carve_out_is_the_schema_s_own() {
        // `agent.schema.json:8-16` exempts exactly one id. Worth its own test: an exemption read
        // as "the field is optional" would be a row that offers an engine with no terms to read.
        let exempt = r#"{"id":"dimcode","name":"n","version":"1.0.0","description":"d",
            "distribution":{"npx":{"package":"p"}}}"#;
        let catalogue = parse(document(exempt).as_bytes()).expect("valid");
        assert!(catalogue.rows[0].is_offerable());
        assert!(catalogue.rows[0].entry.license_url.is_none());
    }

    #[test]
    fn an_installer_format_is_not_an_archive() {
        // The schema names the archive formats and refuses installer formats, so a `.deb` is a
        // document this build does not act on rather than a file it would try to extract.
        let entry = r#"{
            "id": "debs", "name": "Debs", "version": "1.0.0", "description": "d",
            "license_url": "https://example.com/l",
            "distribution": { "binary": {
                "linux-x86_64": { "archive": "https://example.com/a.deb", "cmd": "./a" }
            } }
        }"#;
        let catalogue = parse(document(entry).as_bytes()).expect("valid");
        let row = catalogue.row("debs").expect("present");
        assert_eq!(row.defects.len(), 1);
        assert!(matches!(row.defects[0], EntryDefect::Archive { .. }));
    }

    #[test]
    fn a_newer_schema_major_is_refused_rather_than_parsed() {
        // The one thing a catalogue must not do: read a shape it has not read before and present
        // the result as though the fields meant what this build thinks they mean.
        let error = parse(br#"{"version":"2.0.0","agents":[]}"#).expect_err("refused");
        assert_eq!(
            error,
            DocumentError::UnsupportedVersion {
                value: "2.0.0".to_string(),
                supported: SUPPORTED_REGISTRY_MAJOR,
            }
        );
        assert!(parse(br#"{"agents":[]}"#).is_err(), "no version at all");
        assert!(parse(b"not json").is_err());
    }

    #[test]
    fn a_package_that_pins_no_version_says_so() {
        // The schema permits an unpinned package, so a row cannot state a version the artifact
        // has not promised. `@scope/name` and `@scope/name@latest` both pin nothing, and the
        // scope's own `@` is not a separator.
        let unpinned = Package {
            package: "@acme/ai-agent".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
        };
        assert_eq!(unpinned.pinned_version(), None);
        let latest = Package {
            package: "@acme/ai-agent@latest".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
        };
        assert_eq!(latest.pinned_version(), None);
        let pinned = Package {
            package: "@acme/ai-agent@1.2.3".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
        };
        assert_eq!(pinned.pinned_version(), Some("1.2.3"));
        let bare = Package {
            package: "uvx-agent@0.8.65".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
        };
        assert_eq!(bare.pinned_version(), Some("0.8.65"));
    }

    #[test]
    fn the_install_gate_names_what_does_not_transfer() {
        // The module's answer to "why is there no Install button", as a value. `Digest` is the
        // arm that decides it: §3.3 forbids a response supplying both halves of its own proof, and
        // a registry entry's `sha256` arrives in the same document as its `archive` URL
        // (`update.rs:6-9`, `:160-170`).
        assert!(!InstallGate::Digest.transfers());
        assert!(!InstallGate::Version.transfers());
        assert!(!InstallGate::ContractTests.transfers());
        assert!(InstallGate::Architecture.transfers());
        assert!(InstallGate::ExecuteBit.transfers());
        assert!(InstallGate::AcpInitialization.transfers());
        // Every check `update.rs`'s gate runs has a counterpart here, so this list cannot fall
        // behind that one without failing to exist.
        let named: Vec<&str> = InstallGate::ALL
            .into_iter()
            .map(InstallGate::as_str)
            .collect();
        assert_eq!(
            named,
            vec![
                "digest",
                "architecture",
                "execute-permission",
                "version",
                "acp-initialization",
                "contract-tests"
            ]
        );
        // And the arms named the way `update.rs` names its own (`Check::as_str`), so a reader can
        // hold the two lists against each other.
        assert_eq!(InstallGate::ExecuteBit.as_str(), "execute-permission");
    }

    #[test]
    fn the_registry_id_charset_is_narrower_than_this_app_s() {
        // The claim `Entry::registration_id` rests on: every id the schema allows is one this
        // app's `validate_id` accepts, so mapping one to a registration needs no translation.
        for id in ["opencode", "claude-acp", "qwen-code", "a", "a1-b2"] {
            assert!(is_registry_id(id), "{id} should be a registry id");
        }
        for id in ["Opencode", "1agent", "-agent", "agent_1", "agent.x", ""] {
            assert!(!is_registry_id(id), "{id} should not be a registry id");
        }
    }
}
