//! The six platform keys the schema names, and which of them this build runs on.
//!
//! A key is the publisher's claim about an artifact, not a measurement: the schema's
//! `propertyNames` pins the set, and [`Platform::parse`] refusing a seventh is what makes an
//! unrecognised key a document defect ([`super::refusal`]) rather than a target to guess at. It
//! changes when the schema renames or adds a target, or when this build ships for a machine it does
//! not ship for today — and not when a distribution kind, a refusal or this host's reading of an
//! entry does.
// `Standing::Unsupported` is named by a doc link on `Platform::current` and by nothing in the code
// here; the allow keeps the link resolving without inventing a use for it.
#[allow(unused_imports)]
use super::standing::Standing;

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
