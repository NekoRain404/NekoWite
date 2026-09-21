//! What this host can say about one entry's distribution, described and not performed.
//!
//! No arm of [`Standing`] describes a capability, and that is the invariant the type exists to
//! hold: the only way to learn what an engine can do is to start it and read its handshake
//! ([`super::super::capabilities`]). The module changes when *this host's reading* changes — which
//! distribution it prefers, what it would do with an archive, which package manager it would name,
//! and what an invocation's argument array looks like — and not when the schema does
//! ([`super::distribution`]) or when §3.3's install checks do ([`super::install_gate`]). That is
//! why the preference order and the two invocation builders live here beside the value a page
//! reads: a page that drew a control from a schema field rather than from [`Standing::is_actionable`]
//! would be offering an engine this host cannot start.
use super::distribution::Package;
use super::manifest::Entry;
use super::platform::Platform;

// The install gate is named by doc links below — `Standing::is_actionable` is where "why is there
// no button" is answered — and by no line of code in this module.
#[allow(unused_imports)]
use super::install_gate::InstallGate;

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
    /// [`super::super::registry::InstallSource::External`]. Nothing in this arm downloads anything.
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
