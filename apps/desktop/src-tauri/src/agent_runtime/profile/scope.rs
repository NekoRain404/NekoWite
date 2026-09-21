//! The scope model: which roots this host injects, which configuration the engine still reads on its
//! own, and the mode that decides between the two.
//!
//! **Why it is a file of its own.** `docs/dev.md:286` puts the budget for a business source file at
//! 600 lines, and [`super`] was 1027. The split is by *reason to change*, which is the criterion
//! that section states rather than the line count: this module moves when a *measured fact about the
//! engine's discovery* moves — a surface that turns out to be closed after all, a merge the engine
//! adds, a mode's answer to "may this host write here" — while [`super`] moves when the profile's
//! record or its readout does. The list of surfaces is here rather than in the readout for the
//! reason its doc gives: a page that renders a list can be corrected one arm at a time, and a
//! sentence cannot.
//!
//! The injected half is derived from [`isolated_profile_env`] — the same function the launch uses —
//! so the report cannot drift from what the engine is given. That function stays in
//! `agent_runtime::process`, where the launch and the environment it pins are one subject; this
//! module is the *report* of it, not a second copy.
//!
//! Every name a caller reached as `profile::X` before the split still resolves — [`super`]
//! re-exports it — and the methods stay inherent methods on [`Profile`].

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::super::process::isolated_profile_env;
use super::Profile;

/// §8.1's configuration mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigMode {
    /// The app's own profile: `HOME` and the XDG roots point inside the profile root, so the engine
    /// writes its configuration and credentials where this host owns them.
    AppManaged,
    /// The user's own installation, explicitly chosen (§8.1: 「已有 OpenCode 用户可显式选择复用其
    /// 配置」). Nothing is injected and nothing is written: the host reports what it finds, because a
    /// page that edited the file the user's own tools also read is the overwrite the mode switch is
    /// required not to perform.
    UserConfig,
}

impl ConfigMode {
    pub fn id(self) -> &'static str {
        match self {
            ConfigMode::AppManaged => "app-managed",
            ConfigMode::UserConfig => "user-config",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "app-managed" => Some(ConfigMode::AppManaged),
            "user-config" => Some(ConfigMode::UserConfig),
            _ => None,
        }
    }

    /// Whether this host may write configuration documents in this mode (see [`ConfigMode`]).
    pub fn host_writes(self) -> bool {
        matches!(self, ConfigMode::AppManaged)
    }
}

/// One configuration source, as the settings page reports it (§8.1: 「列出实际生效源」).
///
/// An enum rather than a list of paths, because the second arm is the point: §8.1 forbids
/// presenting the injected roots as though nothing else were read, and a shape that can only hold
/// paths has nowhere to say that.
#[derive(Debug, Clone)]
pub enum ConfigSource {
    /// A root this host sets, derived from what the launch environment actually gets rather than
    /// from a list kept beside it.
    Injected { variable: String, path: PathBuf },
    /// A merge this host does not set and does not claim to have closed. The engine's own discovery
    /// rules are the engine's (§8.1: `OPENCODE_CONFIG_DIR` is not a complete isolation switch, and
    /// pretending otherwise is the claim the plan forbids).
    EngineDiscovery { what: DiscoverySurface },
}

/// Which of the engine's own merges this profile still takes.
///
/// Named one at a time rather than summed up in a sentence, because the sentence this replaces grew
/// false the moment the isolation was measured. It said the engine's own discovery was 「not claimed
/// to have been turned off」 — true of the configuration roots, and untrue of the two compatible
/// `skills` directories, which the app-managed launch had by then stopped reading. A page that
/// renders a summary cannot be corrected when one clause of it changes; a page that renders a list
/// of surfaces can, and each arm here is one that was measured.
///
/// **The wording is not here.** Each arm serializes to a key the page's own copy is looked up by
/// (carried across the boundary as `what`, the field name from when it held prose — see
/// `commands/agent_settings.rs`), so the sentences a user reads live in the i18n catalogue with
/// every other sentence, and a second English wording in Rust cannot drift from them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
// The kebab-case spelling `ConfigMode::id` uses, so every id that crosses this boundary is written
// the one way; the field keeps `commands/agent_settings.rs` unchanged by serializing *into* the
// shape it already sends.
#[serde(rename_all = "kebab-case")]
pub enum DiscoverySurface {
    /// Nothing narrower is worth naming: this profile *is* the user's own installation, so the
    /// engine reads what it always reads and this host enumerates none of it.
    Reused,
    /// The configuration of the folder a session runs in and of every folder above it, merged into
    /// this profile (measured). **Every folder above it means every one of them**, which is not
    /// what "a vault's own configuration" would suggest: on a plain tree with no checkout to stop
    /// it, the walk reads a vault's `.opencode` and `opencode.json`, its parent's, and the user's
    /// home directory's, so what reaches this profile is the developer's own configuration as well
    /// as the folder's — providers and permission rules both. The engine honours
    /// `OPENCODE_DISABLE_PROJECT_CONFIG` for exactly this merge and this host does not set it:
    /// which project configuration an engine reads is a fact about that engine (§3.4), and reading
    /// the vault's own configuration may be wanted. Reported, not decided here, and the sentence a
    /// user reads (`agent.ts`'s `project`, "and in every folder above it") says the same thing.
    Project,
    /// Linux's managed configuration root, `/etc/opencode`, merged at global precedence: a system
    /// administrator's providers and permission rules reach every profile, and no supported switch
    /// closes it. Reported because a page that drew only what this host sets would leave a reader
    /// to assume nothing else was there.
    Managed,
}

impl Profile {
    pub fn mode(&self) -> ConfigMode {
        self.fields.mode
    }

    /// The sources the engine will actually read, as far as this host knows them.
    ///
    /// The injected half is derived from [`isolated_profile_env`] — the same function the launch
    /// uses — so the report cannot drift from what the engine is given, and the rest is the part
    /// §8.1 requires be said out loud: these roots are what this host sets, and they do not close
    /// the engine's own discovery.
    ///
    /// What the launch injects and what this lists are not quite the same set, and the difference
    /// is stated rather than smoothed over: [`isolated_profile_env`] also carries one *switch* —
    /// `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, the engine's own way of stopping its path-driven scan
    /// of `.claude` and `.agents` — and a switch is not a source. [`ConfigSource::Injected`] is a
    /// root, a page renders it as a directory, and reporting `1` as one would be the kind of
    /// confident nonsense §8.1 is about. A switch is a fact about a *scope* rather than about a
    /// configuration root, and the readout that carries it is the skills one
    /// (`skills::SkillScope::suppressed_by`); this list keeps the roots, and names the merges that
    /// remain below rather than summarizing them.
    pub fn sources(&self) -> Vec<ConfigSource> {
        let mut sources: Vec<ConfigSource> = match self.fields.mode {
            ConfigMode::AppManaged => isolated_profile_env(&self.root)
                .into_iter()
                // An absolute path is what a root is; everything else the launch carries is a
                // value, and the readout has no place to put one.
                .filter(|(_, value)| Path::new(value).is_absolute())
                .map(|(variable, path)| ConfigSource::Injected {
                    variable,
                    path: PathBuf::from(path),
                })
                .collect(),
            ConfigMode::UserConfig => Vec::new(),
        };
        sources.extend(
            self.discovery_surfaces()
                .iter()
                .map(|surface| ConfigSource::EngineDiscovery { what: *surface }),
        );
        sources
    }

    /// The engine's own merges this profile still takes, one per surface (see
    /// [`DiscoverySurface`]).
    ///
    /// An isolated profile narrows the engine's discovery to exactly the merges no injected root
    /// reaches, and those are the ones a page has to state — leaving them out is what would let a
    /// reader take the injected list for the whole of it. A profile reusing the user's own
    /// installation narrows nothing, and naming two of the merges *it* keeps would read as though
    /// the rest had been closed.
    fn discovery_surfaces(&self) -> &'static [DiscoverySurface] {
        match self.fields.mode {
            ConfigMode::AppManaged => &[DiscoverySurface::Project, DiscoverySurface::Managed],
            ConfigMode::UserConfig => &[DiscoverySurface::Reused],
        }
    }
}
