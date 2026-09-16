//! The scratch world the domain files share: a repository-internal place to build profiles and
//! releases, a probe that answers what a candidate would answer, and the handful of file helpers the
//! assertions are written in.
//!
//! Two of these carry a decision rather than convenience:
//!
//! - [`scratch`] builds inside the repository (`target/agent-update-test/`), because plan §3.2
//!   forbids a test profile anywhere near the developer's real credentials — gitignored, wiped by
//!   `cargo clean`, and impossible to confuse with a user's own engine state.
//! - [`FakeProbe`] counts how often it was asked. "The digest is checked before anything runs" is
//!   only observable through a side effect, and the only thing in this process that would run a
//!   candidate is a probe — so a refusal that leaves the count at zero is the measurement.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use sha2::{Digest, Sha256};

use nekowite_lib::agent_runtime;
use agent_runtime::binary_registry::{self, BinaryRegistry};
use agent_runtime::update::{
    Artifact, ArtifactClaims, CandidateProbe, Handshake, PinnedRelease, SessionActivity,
};

use futures_util::future::BoxFuture;

pub const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

/// The pinned Linux artifact, as `scripts/fetch-opencode-linux.sh` installs it (gitignored: it is a
/// pipeline product, and a checkout without it is normal).
pub fn pinned_artifact() -> PathBuf {
    Path::new(MANIFEST_DIR).join("binaries/opencode-x86_64-unknown-linux-gnu")
}

/// A scratch directory inside the repository.
pub fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(MANIFEST_DIR)
        .join("target/agent-update-test")
        .join(format!("{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Every file under `root`, with its contents and mode — the shape used to assert that a refusal
/// changed nothing, and that a restore put back exactly what was saved.
pub fn tree(root: &Path) -> Vec<(String, Vec<u8>, u32)> {
    use std::os::unix::fs::PermissionsExt;
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display())) {
            let entry = entry.expect("directory entry");
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .expect("inside the tree")
                    .to_string_lossy()
                    .into_owned();
                let mode = entry.metadata().expect("metadata").permissions().mode() & 0o777;
                found.push((relative, fs::read(&path).expect("read file"), mode));
            }
        }
    }
    found.sort();
    found
}

pub fn write_file(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(path, contents).expect("write file");
}

pub fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod");
}

pub fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).expect("metadata").permissions().mode()
}

/// A real ELF, borrowed from this machine.
///
/// The architecture check reads the file's own header, so a candidate that is not an ELF in the
/// first place cannot exercise anything that follows it. A copy of a system binary is both real
/// bytes and a file the tests are free to modify.
pub fn elf_bytes() -> Vec<u8> {
    for candidate in ["/bin/true", "/usr/bin/true", "/bin/sh", "/usr/bin/env"] {
        if let Ok(bytes) = fs::read(candidate) {
            if bytes.len() > 64 && &bytes[..4] == b"\x7fELF" {
                return bytes;
            }
        }
    }
    panic!("no ELF binary to copy on this machine");
}

/// Rewrites the `e_machine` field of an ELF header, so a real file can be asked to look like one
/// built for another architecture.
pub fn with_machine(mut bytes: Vec<u8>, machine: u16) -> Vec<u8> {
    bytes[18..20].copy_from_slice(&machine.to_le_bytes());
    bytes
}

/// A pinned release record over bytes a test controls.
///
/// The shipped records are `update::shipped`; the update path takes the record as an argument, so
/// that the app's own release process is the only thing that has to supply one in production.
pub fn release_of(version: &str, bytes: &[u8]) -> PinnedRelease {
    PinnedRelease::new(
        version,
        binary_registry::supported_target(),
        &sha256_hex(bytes),
        "built by agent_update_test.rs",
        "MIT",
        vec!["acp".to_string()],
    )
}

/// The probe, faked: it answers what a candidate would answer, and counts how often it was asked.
pub struct FakeProbe {
    version: String,
    handshake: Result<Handshake, String>,
    calls: AtomicUsize,
}

impl FakeProbe {
    /// A probe that answers correctly for `version`.
    pub fn answering(version: &str) -> Self {
        Self {
            version: version.to_string(),
            handshake: Ok(Handshake {
                agent_name: "FakeAgent".to_string(),
                agent_version: version.to_string(),
                protocol_version: 1,
            }),
            calls: AtomicUsize::new(0),
        }
    }

    pub fn refusing_the_handshake(mut self) -> Self {
        self.handshake = Err("the engine exited before answering initialize".to_string());
        self
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl CandidateProbe for FakeProbe {
    fn version<'a>(&'a self, _program: &'a Path) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.version.clone())
        })
    }

    fn acp_initialization<'a>(
        &'a self,
        _program: &'a Path,
    ) -> BoxFuture<'a, Result<Handshake, String>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.handshake.clone()
        })
    }
}

/// The seam §3.3's "no hot-swap while a session is live" is refused through: a question the update
/// path asks, so it never has to reach into the agent registry to answer it.
pub struct Sessions(usize);

impl Sessions {
    /// A host that reports `count` running sessions.
    pub fn live(count: usize) -> Self {
        Self(count)
    }
}

impl SessionActivity for Sessions {
    fn live_sessions(&self) -> usize {
        self.0
    }
}

pub fn idle() -> Sessions {
    Sessions(0)
}

/// Stages `bytes` in the registry's download area and returns the artifact the gate takes.
pub fn staged(
    registry: &BinaryRegistry,
    version: &str,
    bytes: &[u8],
    claims: Option<ArtifactClaims>,
) -> Artifact {
    let path = registry
        .stage(version, binary_registry::supported_target(), bytes)
        .expect("stage the candidate");
    Artifact { path, claims }
}
