//! Which binary, at which version, at which path — and is it the active one.
//!
//! §3.4 splits agent handling in two and forbids merging them: `registry.rs` (T3a) owns the
//! *definitions* — which engines this app may start, and with what identity — and this module owns
//! the *versions and paths* of the programs themselves. Not one manager, because merging them would
//! make "update this engine" and "start the engine the user registered" the same operation.
//!
//! So nothing here knows what an agent is, what a profile is, or what a session is. What it knows
//! is §3.2's layout under the app's data directory:
//!
//! ```text
//! agent-runtime/
//!   releases/<version>/<target>/opencode   # one verified version per directory
//!   active.json                            # the pointer that names the active one
//!   downloads/                             # 未验证文件不得执行
//! agent-profiles/<profile-id>/             # the profile roots (owned by T12)
//! agent-recovery/<profile-id>/             # retained material, bounded and stamped
//! ```
//!
//! Two rules are structural here rather than documented. **The root is refused unless the app could
//! own it** — §3.3 forbids writing system package directories or AppImage mount points, and the
//! place to refuse that is where the root is first named, not where it is first written to. And
//! **a staged candidate is never executable**: the download area holds bytes, verification is what
//! turns them into a program (`update.rs`), and the pointer is the only thing that makes a program
//! the one this app starts.
//!
//! What a file at one of these paths *is* — an execute bit, a digest, an ELF header for the one
//! architecture this release claims — is here too, for the same reason: those are facts about a file
//! at a path, while *whether this app is willing to install it* is the update path's judgement.
//!
//! **Where the parts live.** The file passed §13.1's 600-line default, so it was split by reason to
//! change rather than by arithmetic: the directory names and the refusals are `layout.rs`'s, the
//! records and the retained-tree operations are `releases.rs`'s, the target this build installs for
//! is `platform.rs`'s, and what a file at one of these paths *is* — a digest, an ELF header — is
//! `elf.rs`'s. They are children of this file rather than siblings of it, so `binary_registry.rs`
//! stays the root of the module's path: rustc resolves a bare `mod name;` written here to
//! `binary_registry/<name>.rs`, and every path that named `agent_runtime::binary_registry::…` before
//! the split still resolves through the re-exports below.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::registry::InstallSource;

// Bare `mod name;`, which is what finds `binary_registry/<name>.rs` beside this file — the root keeps
// its own name rather than becoming `binary_registry/mod.rs`, so every caller that names
// `binary_registry` still resolves through it. Deliberately *not* `#[path = "binary_registry/<name>.rs"]`:
// `tests/module_tree_test.rs` replays rustc's walk with a comment stripper that removes string
// literals along with comments, so a path attribute is invisible to it and its children read as
// orphans. Nothing `#[path]`-includes `binary_registry.rs`, so the plain declaration is both
// sufficient and what the tree check can see.
mod elf;
mod layout;
mod platform;
mod releases;

// The re-exports below are what keeps every path that resolved before this split resolving after it:
// `agent_runtime::binary_registry::X` is spelled exactly as it was, and the callers
// (`update/{error,manifest,verify,rollback}.rs`, `state/app_state.rs`, the `tests/agent_update_test`
// target and `tests/agent_session_ipc_test.rs`) are not this change's to rewrite. Only the items that
// were `pub` are re-exported here; everything that was private to this file stays `pub(super)` in its
// child, which is the narrowest scope that compiles.
pub use elf::{check_elf, digest_of, hex, read_elf_header};
pub use layout::{
    mode_of, LayoutError, DOWNLOADS_DIR, POINTER_FILE, PROFILES_DIR, PROGRAM_NAME, RECOVERY_DIR,
    RELEASES_DIR, RUNTIME_DIR,
};
pub use platform::{is_supported, supported_target, SUPPORTED_TARGET};
pub use releases::{
    bundled_program, is_newer, is_restorable, restore_tree, retain_tree, ActiveRelease, Program,
};

// The helpers that were private when they shared this file with the table below, and are `pub(super)`
// in their child now. Imported rather than re-exported: an item that could not be named from outside
// `binary_registry.rs` before the split still cannot be, and `pub use` would widen it.
use self::layout::{assert_scope, validate_component, write_private};
use self::releases::{is_launchable, stamp, version_key};

/// The managed layout, and the pointer inside it.
///
/// Constructed from the app's **data directory** (Tauri's `app_data_dir`), because §3.2's three
/// siblings — `agent-runtime/`, `agent-profiles/` and `agent-recovery/` — are siblings under it, and
/// a caller that assembled them itself would be the second place the layout is written down.
#[derive(Debug, Clone)]
pub struct BinaryRegistry {
    data: PathBuf,
    root: PathBuf,
}

impl BinaryRegistry {
    /// Opens the layout belonging to the app data directory `data`, resolved by whoever knows where
    /// that is (§3.2), never guessed here.
    pub fn new(data: impl Into<PathBuf>) -> Result<Self, LayoutError> {
        let data = data.into();
        assert_scope(&data)?;
        Ok(Self {
            root: data.join(RUNTIME_DIR),
            data,
        })
    }

    /// The runtime's own directory (`<data>/agent-runtime`).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where a download waits until it has passed (§3.2: 未验证文件不得执行).
    pub fn downloads(&self) -> PathBuf {
        self.root.join(DOWNLOADS_DIR)
    }

    /// Where the managed roots of profiles live (T12 owns the profiles themselves).
    pub fn profiles(&self) -> PathBuf {
        self.data.join(PROFILES_DIR)
    }

    /// The retained material for one profile (§3.2's `agent-recovery/<profile-id>/`).
    pub fn recovery(&self, profile_id: &str) -> PathBuf {
        self.data.join(RECOVERY_DIR).join(profile_id)
    }

    /// Where the *next* retained copy of a profile goes: inside that profile's recovery directory,
    /// under a name nothing else in this process will take.
    ///
    /// Scoping the retained copies by profile id is what §3.2's 「有范围和保留期限的恢复资料」 asks for:
    /// material that can be found by the profile it belongs to, and named so that one rollback never
    /// writes over another's evidence.
    pub fn retained_path(&self, profile_id: &str) -> PathBuf {
        self.recovery(profile_id).join(stamp())
    }

    /// Where a verified version's program lives: `releases/<version>/<target>/opencode`.
    pub fn program_of(&self, version: &str) -> PathBuf {
        self.root
            .join(RELEASES_DIR)
            .join(version)
            .join(SUPPORTED_TARGET)
            .join(PROGRAM_NAME)
    }

    /// The pointer, or `None` when nothing has been promoted yet.
    pub fn active(&self) -> Result<Option<ActiveRelease>, LayoutError> {
        let path = self.root.join(POINTER_FILE);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(LayoutError::Io {
                    path,
                    detail: error.to_string(),
                })
            }
        };
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|error| LayoutError::MalformedPointer {
                path,
                detail: error.to_string(),
            })
    }

    /// Every version with a program on disk, oldest first.
    ///
    /// Read from the filesystem rather than from a stored list: a version is installed when its
    /// program is there, and a list that could disagree with the disk would be a second answer to
    /// the same question. A version whose directory exists without a program is not installed — an
    /// abandoned release, which the next promotion writes into again rather than reusing in place.
    ///
    /// The order is the numeric one, not the alphabetical one: `1.18.10` comes after `1.18.9`, and a
    /// list that got that backwards would put the older release last in a settings page that is
    /// telling a user which version they are running.
    pub fn installed(&self) -> Vec<String> {
        let releases = self.root.join(RELEASES_DIR);
        let Ok(entries) = fs::read_dir(&releases) else {
            return Vec::new();
        };
        let mut versions: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|version| is_launchable(&self.program_of(version)))
            .collect();
        versions.sort_by(|left, right| {
            version_key(left)
                .cmp(&version_key(right))
                .then_with(|| left.cmp(right))
        });
        versions
    }

    /// Moves the pointer to `version`, recording where it came from.
    ///
    /// The program has to be there: a pointer to a version that is not installed is a state where
    /// the app has no engine at all, and §3.3's rule that an incompatible version leaves the old one
    /// usable is about versions that exist.
    pub fn set_active(&self, version: &str) -> Result<ActiveRelease, LayoutError> {
        validate_component("version", version)?;
        let program = self.program_of(version);
        if !is_launchable(&program) {
            return Err(LayoutError::NotInstalled {
                version: version.to_string(),
                program,
            });
        }
        let previous = self
            .active()?
            .map(|active| active.version)
            .filter(|held| held != version);
        let active = ActiveRelease {
            version: version.to_string(),
            target: SUPPORTED_TARGET.to_string(),
            previous,
        };
        let text = serde_json::to_string(&active).expect("a pointer serializes");
        // Through the crate's atomic write, so a power loss leaves the old pointer or the new one
        // and never a truncated file that reads as "no engine installed".
        crate::storage::atomic_write::atomic_write(&self.root.join(POINTER_FILE), &text).map_err(
            |detail| LayoutError::Io {
                path: self.root.join(POINTER_FILE),
                detail,
            },
        )?;
        Ok(active)
    }

    /// The program the pointer names, if it is still there.
    ///
    /// `None` covers both "nothing has been promoted" and "the version it names is gone". Falling
    /// back to the bundled sidecar is the caller's decision (§3.1.1: the app ships a verified base
    /// version), and this call answering `None` is what makes that fallback well defined rather than
    /// a failure to start.
    pub fn active_program(&self) -> Result<Option<Program>, LayoutError> {
        let Some(active) = self.active()? else {
            return Ok(None);
        };
        let path = self.program_of(&active.version);
        if !is_launchable(&path) {
            return Ok(None);
        }
        Ok(Some(Program {
            path,
            version: Some(active.version),
            source: InstallSource::Managed,
        }))
    }

    /// Writes candidate bytes into the download area, **without an execute bit**.
    ///
    /// This is the whole of the download area's contract (§3.2: 未验证文件不得执行): bytes that have
    /// not been verified are bytes. Making them executable is [`super::update::verify`]'s act, after
    /// the digest has matched.
    ///
    /// Each call gets its own file name, and it is created fresh rather than overwritten. The name
    /// carries the version and the target so a refused candidate can be found by whoever is
    /// diagnosing the refusal, plus one attempt marker: two attempts at the same version — a retry
    /// after an interrupted download, or a second copy of a candidate whose first verification
    /// already made it executable — are different files, so neither can turn into the other between
    /// a verification and the promotion it was going to justify.
    pub fn stage(&self, version: &str, target: &str, bytes: &[u8]) -> Result<PathBuf, LayoutError> {
        validate_component("version", version)?;
        if !is_supported(target) {
            return Err(LayoutError::UnsupportedTarget {
                target: target.to_string(),
            });
        }
        let directory = self.downloads();
        fs::create_dir_all(&directory).map_err(|error| LayoutError::Io {
            path: directory.clone(),
            detail: error.to_string(),
        })?;
        let path = directory.join(format!("{version}-{target}-{}", attempt()));
        write_private(&path, bytes)?;
        Ok(path)
    }
}

/// A per-attempt marker: unique per process and per call, so a staged file is never reused.
fn attempt() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    format!(
        "{millis}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}
