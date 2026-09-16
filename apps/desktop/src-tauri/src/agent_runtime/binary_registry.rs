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

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::registry::InstallSource;

/// The directory §3.2 puts the runtime's own files in, under the app's data directory.
pub const RUNTIME_DIR: &str = "agent-runtime";
/// One directory per verified version.
pub const RELEASES_DIR: &str = "releases";
/// Where a download waits until it has passed (§3.2: 未验证文件不得执行).
pub const DOWNLOADS_DIR: &str = "downloads";
/// Where the managed roots of profiles live (T12 owns what goes in them).
pub const PROFILES_DIR: &str = "agent-profiles";
/// Where retained material lives, scoped and stamped.
pub const RECOVERY_DIR: &str = "agent-recovery";
/// The pointer file's name, as §3.2 draws it.
pub const POINTER_FILE: &str = "active.json";

/// The program's name inside a release directory, and beside the app's own executable.
///
/// One name for both because that is what the bundler produces: Tauri's `copy_binaries` strips the
/// `-<target>` suffix it added at build time, so the installed sidecar is `usr/bin/opencode` next
/// to `usr/bin/nekowite` — the same bare name this module installs a verified version under.
pub const PROGRAM_NAME: &str = "opencode";

/// The `e_machine` value for [`SUPPORTED_TARGET`] — `EM_X86_64`, from the ELF specification.
const EM_X86_64: u16 = 62;

/// The only architecture this release claims to support (§3.2: 只声称支持实际验证的架构).
///
/// A second architecture is a second artifact and a second compatibility verification, so it is not
/// a matter of adding a name here.
pub const SUPPORTED_TARGET: &str = "x86_64-unknown-linux-gnu";

/// Where a managed root may not be (§3.3: 不执行 `sudo`，不写 AppImage 挂载目录或系统包目录).
///
/// Held as paths rather than as a rule about permissions: the app's own data directory is what
/// `BinaryRegistry::new` is for, and a root inside any of these is a request to write where the
/// distribution or the mounted image owns the files.
const SYSTEM_PREFIXES: [&str; 9] = [
    "/usr", "/etc", "/opt", "/var", "/bin", "/sbin", "/lib", "/lib64", "/boot",
];

/// Where an AppImage mounts itself. Matching the prefix rather than the exact spelling keeps this
/// from depending on the image's name; the mount is read-only anyway, so anything under it is a
/// path the app could never write to and must never try (`sudo` is not a fallback, §3.3).
const APPIMAGE_MOUNT_PREFIX: &str = "/tmp/.mount_";

/// The target this host can install for.
pub fn supported_target() -> &'static str {
    SUPPORTED_TARGET
}

/// Whether this release claims to support `target`.
pub fn is_supported(target: &str) -> bool {
    target == SUPPORTED_TARGET
}

/// Why a path in the managed layout was refused. Data only — the wording a user reads belongs to
/// the frontend, which maps these to sentences the same way it maps `registry::RegistryError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayoutError {
    /// A root that is not absolute would resolve against this process's working directory — the
    /// app's, not the user's — so it names nothing that can be reasoned about.
    Relative { root: PathBuf },
    /// A root the app does not own (§3.3): a system directory, or an AppImage mount point.
    OutsideManagedScope { root: PathBuf, reason: &'static str },
    /// A version or target this release does not install for.
    UnsupportedTarget { target: String },
    /// A name that cannot be a path component: empty, `.`, `..`, or carrying a separator. §3.2 puts
    /// profile ids and versions into directory names, so this is a path traversal dressed as
    /// configuration.
    InvalidName { field: &'static str, value: String },
    /// The version named is not on disk, so there is nothing to point at.
    NotInstalled { version: String, program: PathBuf },
    /// The pointer file is there and unreadable as a pointer.
    MalformedPointer { path: PathBuf, detail: String },
    /// The filesystem said no.
    Io { path: PathBuf, detail: String },
}

/// Which release is active — §3.2's `active.json`, field for field.
///
/// `previous` is kept because a rollback is a normal operation (§3.3) rather than a recovery: it
/// names where the pointer was, so returning to it is a decision about a version the app knows
/// rather than a guess at the file system's contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveRelease {
    pub version: String,
    pub target: String,
    #[serde(default)]
    pub previous: Option<String>,
}

/// One program this app could start, as the settings page reports it (§3.1.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    pub path: PathBuf,
    /// The version the app's own record names for it. `None` for the bundled sidecar, whose version
    /// is the release manifest's fact (`update::shipped`) rather than a directory name.
    pub version: Option<String>,
    pub source: InstallSource,
}

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
        versions.sort_by(|left, right| version_key(left).cmp(&version_key(right)).then_with(|| left.cmp(right)));
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
        crate::storage::atomic_write::atomic_write(&self.root.join(POINTER_FILE), &text)
            .map_err(|detail| LayoutError::Io {
                path: self.root.join(POINTER_FILE),
                detail,
            })?;
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
    format!("{millis}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// The packaged engine, from the directory the host resolved for the app's own executable.
///
/// §3.2 resolves the sidecar through Tauri rather than through a development path, and Tauri has two
/// spellings for what it produced: the installed bundle carries the bare name (`copy_binaries`
/// strips the `-<target>` suffix the build input needs, which is why the artifact on disk ends in
/// `-x86_64-unknown-linux-gnu` and the one in the package does not), and a build tree can still have
/// the suffixed one beside the binary. Both are checked here; neither is searched for on `PATH`,
/// because §3.1.1 is that the user has this engine whether or not they have one of their own.
pub fn bundled_program(directory: &Path) -> Option<Program> {
    let candidates = [
        directory.join(PROGRAM_NAME),
        directory.join(format!("{PROGRAM_NAME}-{SUPPORTED_TARGET}")),
    ];
    candidates
        .into_iter()
        .find(|path| is_launchable(path))
        .map(|path| Program {
            path,
            version: None,
            source: InstallSource::Bundled,
        })
}

/// Refuses a root the app does not own (§3.3).
fn assert_scope(root: &Path) -> Result<(), LayoutError> {
    if !root.is_absolute() {
        return Err(LayoutError::Relative {
            root: root.to_path_buf(),
        });
    }
    for prefix in SYSTEM_PREFIXES {
        if root.starts_with(prefix) {
            return Err(LayoutError::OutsideManagedScope {
                root: root.to_path_buf(),
                reason: "the distribution owns this directory, and this host never installs into a \
                         system package directory",
            });
        }
    }
    // A string comparison rather than `Path::starts_with`, which compares whole components: an
    // AppImage's mount directory is named `.mount_<something random>`, so the component after `/tmp`
    // is exactly the part that varies.
    if root.to_string_lossy().starts_with(APPIMAGE_MOUNT_PREFIX) {
        return Err(LayoutError::OutsideManagedScope {
            root: root.to_path_buf(),
            reason: "this is an AppImage mount point, which is a read-only location for the image \
                     and not a place to write",
        });
    }
    // The app's data directory is what Tauri resolves for it, and that is always below the user's
    // home, a corporate profile or a distribution's own data root — never a bare top-level
    // directory. A root one level under `/` is a configuration mistake that would scatter releases,
    // profiles and recovery material across the filesystem, so it is refused where an operator can
    // see the refusal rather than where the first write happens.
    if root.parent().is_none_or(|parent| parent == Path::new("/")) {
        return Err(LayoutError::OutsideManagedScope {
            root: root.to_path_buf(),
            reason: "the agent runtime's data belongs under the app's own data directory, not at \
                     the root of the filesystem",
        });
    }
    Ok(())
}

/// Whether a name can be a path component.
///
/// The same charset `registry.rs` uses for its ids, and duplicated rather than shared because the
/// two answer different questions about different namespaces — this one is about versions and
/// targets, which come from the release flow, and that one is about agent, profile and vault ids,
/// which come from a form.
fn validate_component(field: &'static str, value: &str) -> Result<(), LayoutError> {
    let usable = !value.is_empty()
        && value.len() <= 64
        && value != "."
        && value != ".."
        && !value.starts_with('.')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if usable {
        Ok(())
    } else {
        Err(LayoutError::InvalidName {
            field,
            value: value.to_string(),
        })
    }
}

/// Whether a path is a file someone could run. `fs::metadata` follows symlinks, so a link to an
/// executable counts — which is what a distribution that ships one under `/usr/bin` looks like.
fn is_launchable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

// ---------------------------------------------------------------------------
// The layout's own file operations
// ---------------------------------------------------------------------------
//
// These belong here rather than with the update policy that calls them for the same reason the paths
// do: they are statements about §3.2's directories — a profile tree, the recovery area beside it —
// and the rules they keep (links are recreated and never followed, a tree that cannot be read is not
// a tree, the replaced tree is kept) are rules about where this app is allowed to write. *When* one
// of them may run is the update path's decision; *what it does to the filesystem* is this module's.

/// Whether `candidate` is a later version than `base`.
///
/// Component-wise and numeric, because the comparison decides whether a rollback crosses a data
/// migration: `1.18.10` is newer than `1.18.9`, which string comparison gets backwards. A component
/// that is not a number reads as zero, which treats an unparseable version as the oldest rather than
/// as a newer one — the direction that asks for confirmation instead of assuming it is safe.
pub fn is_newer(candidate: &str, base: &str) -> bool {
    version_key(candidate).cmp(&version_key(base)) == std::cmp::Ordering::Greater
}

/// A version as its numeric components.
///
/// The key everything that orders versions compares, so `is_newer` and `installed` can never
/// disagree about which of two versions is the later one.
fn version_key(version: &str) -> Vec<u64> {
    version
        .split(['.', '-', '+'])
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

/// Whether a directory holds something that can be put back in place of a profile.
///
/// Deliberately shallow. This host does not know the engine's own store format — §3.3's 报告限制 is
/// exactly about that — so what it can answer is "there is a tree here to restore", not "this backup
/// is a valid engine store". The stronger claim is left unsaid rather than implied.
pub fn is_restorable(path: &Path) -> bool {
    fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_some())
}

/// Copies a tree, keeping modes and links.
///
/// Symlinks are recreated rather than followed: a link inside a profile that points out of it would
/// otherwise make the copy write outside the managed roots this module is confined to.
pub fn retain_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            let link = fs::read_link(&source).map_err(|error| error.to_string())?;
            std::os::unix::fs::symlink(link, &target).map_err(|error| error.to_string())?;
        } else if metadata.is_dir() {
            retain_tree(&source, &target)?;
        } else {
            // `fs::copy` carries the mode across, which matters for a profile whose files include
            // anything the user made read-only.
            fs::copy(&source, &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Puts `backup` in place of `root`, in the order that cannot lose the old one.
///
/// The backup is copied into a staging directory beside the profile first, so a copy that fails
/// partway leaves the profile alone; only then is the live profile moved aside and the staged copy
/// moved in. If that last move fails, the first move is undone and the caller is told. What was moved
/// aside ends up under `recovery` rather than being deleted: the retained copy beside it is the same
/// data, and keeping both costs disk while deleting either could cost a session.
pub fn restore_tree(root: &Path, backup: &Path, recovery: &Path) -> Result<(), String> {
    let parent = root.parent().ok_or("the profile root has no parent")?;
    let staging = parent.join(format!(".restore-{}", stamp()));
    let moved_aside = recovery.join(format!("{}-replaced", stamp()));
    let outcome = (|| -> Result<(), String> {
        retain_tree(backup, &staging)?;
        if root.exists() {
            fs::create_dir_all(recovery).map_err(|error| error.to_string())?;
            fs::rename(root, &moved_aside).map_err(|error| error.to_string())?;
        }
        match fs::rename(&staging, root) {
            Ok(()) => Ok(()),
            Err(error) => {
                if moved_aside.exists() {
                    let _ = fs::rename(&moved_aside, root);
                }
                Err(error.to_string())
            }
        }
    })();
    if outcome.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    outcome
}

/// A name for one retained copy, unique per process and per moment.
fn stamp() -> String {
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

/// Writes bytes readable and writable by the user and executable by nobody.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), LayoutError> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut file = fs::OpenOptions::new()
        .write(true)
        // `create_new` rather than `create`: a staged candidate is never written over, so a name
        // that is already taken is a name this call did not produce, and the caller learns that
        // rather than getting a file it did not ask for.
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| LayoutError::Io {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })?;
    file.write_all(bytes).map_err(|error| LayoutError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| LayoutError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })
}

// ---------------------------------------------------------------------------
// What a file at one of those paths is
// ---------------------------------------------------------------------------
//
// The same question [`is_launchable`] answers, asked further: a program at a path is a file with an
// execute bit, an ELF built for the one architecture this release claims, and a specific sequence of
// bytes. It lives here rather than with the update gate that asks it because none of these is a
// judgement about *this app's* willingness to install something — they are facts about a file, and
// the module that names the paths is where facts about what is at them belong.

/// The digest of a file, streamed and off the async runtime.
///
/// A release artifact is a hundred-odd megabytes, so this reads in bounded chunks and hashes as it
/// goes; doing it on the runtime's own thread would stall every other task in the app for the
/// duration.
pub async fn digest_of(path: &Path) -> Result<String, LayoutError> {
    let reading = path.to_path_buf();
    let hashed = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut file = fs::File::open(&reading).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok::<String, String>(hex(&hasher.finalize()))
    })
    .await
    .map_err(|error| LayoutError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    hashed.map_err(|detail| LayoutError::Io {
        path: path.to_path_buf(),
        detail,
    })
}

/// Lowercase hexadecimal, which is the spelling every release record and tool prints.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The first bytes of a file, for [`check_elf`].
///
/// A file shorter than a header is not an error here: it is a candidate that `check_elf` refuses with
/// a sentence about what it actually is, rather than a read failure that reads like the filesystem's
/// problem.
pub fn read_elf_header(path: &Path) -> Result<Vec<u8>, LayoutError> {
    use std::io::Read;
    let mut header = vec![0u8; 64];
    let mut file = fs::File::open(path).map_err(|error| LayoutError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    let read = file.read(&mut header).map_err(|error| LayoutError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    header.truncate(read);
    Ok(header)
}

/// The ELF header, as the checks that can be made without running the file.
///
/// Deliberately the small set §3.3's architecture check needs, and no more: magic, class, byte order,
/// executable-vs-PIE, and the machine. A fuller validation (program headers, dynamic loader) would be
/// a different claim about a file this host is about to run under its own supervision.
pub fn check_elf(header: &[u8]) -> Result<(), String> {
    if header.len() < 20 || &header[..4] != b"\x7fELF" {
        return Err("the file does not begin with an ELF header".to_string());
    }
    if header[4] != 2 {
        return Err(format!("the ELF is class {} rather than 64-bit", header[4]));
    }
    if header[5] != 1 {
        return Err("the ELF is not little-endian".to_string());
    }
    let kind = u16::from_le_bytes([header[16], header[17]]);
    if kind != 2 && kind != 3 {
        return Err(format!(
            "the ELF is of type {kind}: neither an executable nor a position-independent one"
        ));
    }
    let machine = u16::from_le_bytes([header[18], header[19]]);
    if machine != EM_X86_64 {
        return Err(format!(
            "the program is built for machine {machine:#06x}, and this release installs x86-64 \
             ({EM_X86_64:#06x}) only"
        ));
    }
    Ok(())
}

/// A file's permission bits.
pub fn mode_of(path: &Path) -> Result<u32, LayoutError> {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|meta| meta.permissions().mode())
        .map_err(|error| LayoutError::Io {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })
}
