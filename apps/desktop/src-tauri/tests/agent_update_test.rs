//! R6 — the bundled engine and the update path, which is mostly a set of refusals.
//!
//! T14's acceptance is not "the update works". It is three refusals, and every test here is one of
//! them:
//!
//! 1. **无系统 CLI 可启动** — the engine is found beside this app, never on `PATH`, so a machine
//!    with no `opencode` installed still starts one.
//! 2. **坏摘要不执行** — a candidate whose digest does not match the app's own release record is
//!    never handed to anything that could run it, and never gets an execute bit.
//! 3. **迁移失败不破坏旧 profile** — a rollback that cannot complete leaves the profile it was about
//!    to replace exactly as it was, and never silently discards what the newer version wrote.
//!
//! The happy path matters too, but only as the thing the refusals are measured against: a gate that
//! refuses everything would pass every test above and ship a broken feature.
//!
//! Every profile, download and release in this file is built under the repository's own `target/`
//! directory (plan §3.2: 开发测试的临时 profile 必须放仓库内的测试临时目录). Nothing here reads or
//! writes the developer's real OpenCode profile, real configuration or real credentials — including
//! the one test that runs the pinned artifact, whose `HOME`, XDG roots and `PATH` are a scratch
//! directory.

use nekowite_lib::agent_runtime;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};

use agent_runtime::binary_registry::{self, BinaryRegistry, LayoutError};
use agent_runtime::registry::{InstallSource, UpdatePolicy};
use agent_runtime::update::{
    self, AcpProbe, Artifact, ArtifactClaims, CandidateProbe, Check, Handshake, PinnedRelease,
    ProfileState, RollbackRequest, SessionActivity, UpdateError,
};

const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

/// The pinned Linux artifact, as `scripts/fetch-opencode-linux.sh` installs it (gitignored: it is a
/// pipeline product, and a checkout without it is normal).
fn pinned_artifact() -> PathBuf {
    Path::new(MANIFEST_DIR).join("binaries/opencode-x86_64-unknown-linux-gnu")
}

/// A scratch directory inside the repository.
///
/// Inside the repository on purpose: plan §3.2 forbids a test profile anywhere near the developer's
/// real credentials, and `target/` is where scratch belongs — gitignored, wiped by `cargo clean`,
/// and impossible to confuse with a user's own engine state.
fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(MANIFEST_DIR)
        .join("target/agent-update-test")
        .join(format!("{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

fn sha256_hex(bytes: &[u8]) -> String {
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
fn tree(root: &Path) -> Vec<(String, Vec<u8>, u32)> {
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

fn write_file(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(path, contents).expect("write file");
}

fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod");
}

fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).expect("metadata").permissions().mode()
}

/// A real ELF, borrowed from this machine.
///
/// The architecture check reads the file's own header, so a candidate that is not an ELF in the
/// first place cannot exercise anything that follows it. A copy of a system binary is both real
/// bytes and a file the tests are free to modify.
fn elf_bytes() -> Vec<u8> {
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
fn with_machine(mut bytes: Vec<u8>, machine: u16) -> Vec<u8> {
    bytes[18..20].copy_from_slice(&machine.to_le_bytes());
    bytes
}

/// A pinned release record over bytes this test controls.
///
/// The shipped records are [`update::shipped`]; the update path takes the record as an argument, so
/// that the app's own release process is the only thing that has to supply one in production.
fn release_of(version: &str, bytes: &[u8]) -> PinnedRelease {
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
///
/// The count is load-bearing. "The digest is checked before anything runs" is only observable
/// through a side effect, and the only thing in this process that would run a candidate is the
/// probe — so a refusal that leaves the count at zero is the measurement.
struct FakeProbe {
    version: String,
    handshake: Result<Handshake, String>,
    calls: AtomicUsize,
}

impl FakeProbe {
    /// A probe that answers correctly for `version`.
    fn answering(version: &str) -> Self {
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

    fn refusing_the_handshake(mut self) -> Self {
        self.handshake = Err("the engine exited before answering initialize".to_string());
        self
    }

    fn calls(&self) -> usize {
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
struct Sessions(usize);

impl SessionActivity for Sessions {
    fn live_sessions(&self) -> usize {
        self.0
    }
}

fn idle() -> Sessions {
    Sessions(0)
}

/// Stages `bytes` in the registry's download area and returns the artifact the gate takes.
fn staged(
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

// ---------------------------------------------------------------------------
// 1. 无系统 CLI 可启动 — the engine is the one beside this app
// ---------------------------------------------------------------------------

/// The pinned record is a claim about a real file, and this is where it is checked: if the artifact
/// in the tree is not the one the manifest names, the manifest is wrong (or the artifact is), and
/// every later proof built on it is void.
///
/// It runs the whole gate against the real engine — digest, architecture, execute bit, `--version`,
/// and a real ACP handshake — with `HOME`, the XDG roots and `PATH` pointed at a scratch directory.
/// That is the "starts with no system CLI" half of the acceptance in its strongest available form:
/// the artifact is run by a process whose `PATH` contains nothing, under roots that are not the
/// developer's.
#[tokio::test]
async fn the_pinned_record_describes_the_artifact_the_fetch_script_installs() {
    let artifact_path = pinned_artifact();
    if !artifact_path.is_file() {
        eprintln!(
            "SKIP: {} is absent; run scripts/fetch-opencode-linux.sh",
            artifact_path.display()
        );
        return;
    }

    let bytes = fs::read(&artifact_path).expect("read the artifact");
    let release = update::shipped("1.18.29").expect("the shipped manifest names the pinned version");
    assert_eq!(
        sha256_hex(&bytes),
        release.sha256(),
        "the artifact in the tree is not the one the pinned record names"
    );

    let registry = BinaryRegistry::new(scratch("pinned")).expect("managed root");
    let artifact = staged(&registry, release.version(), &bytes, None);
    let probe = AcpProbe::new(scratch("pinned-profile"), release.acp_args());
    let verified = update::verify(release, &artifact, &probe)
        .await
        .expect("the pinned artifact passes every check");

    assert_eq!(verified.reported_version, "1.18.29");
    assert_eq!(verified.handshake.agent_name, "OpenCode");
    assert_eq!(verified.handshake.protocol_version, 1);
    assert_eq!(verified.checks, Check::ALL.to_vec());
    assert_eq!(
        mode_of(&verified.program) & 0o111,
        0o111,
        "a verified candidate is executable"
    );
}

/// Where the packaged engine is looked for, and where it is not.
///
/// The directory Tauri resolves is passed in rather than derived here: the bundled sidecar's
/// location is a packaging fact (`bundle.externalBin` puts it beside the app's own executable,
/// under its bare name), and hardcoding a development path is what §3.2 forbids.
#[test]
fn the_bundled_engine_is_the_one_beside_the_app_and_never_one_from_the_path() {
    let app_dir = scratch("sidecar-app");
    let bundled = app_dir.join("opencode");
    write_file(&bundled, "#!/bin/sh\nexit 0\n");
    make_executable(&bundled);

    let found = binary_registry::bundled_program(&app_dir).expect("the sidecar beside the app");
    assert_eq!(found.path, bundled);
    assert_eq!(found.source, InstallSource::Bundled);

    // The same situation, with a system-shaped `opencode` in a directory that stands in for `PATH`:
    // nothing is found beside the app, so nothing is found at all. There is no fallback to a system
    // CLI for this module to take.
    let path_like = scratch("sidecar-path");
    let poison = path_like.join("opencode");
    write_file(&poison, "#!/bin/sh\nexit 0\n");
    make_executable(&poison);
    let empty_app_dir = scratch("sidecar-empty");
    assert_eq!(
        binary_registry::bundled_program(&empty_app_dir),
        None,
        "a bundled source with no sidecar must not resolve to something else"
    );
}

/// The two promises that make the clause above structural rather than incidental: nothing in these
/// modules looks a program up on `PATH`, and nothing runs a system package manager or `sudo`.
///
/// The scan is over the module sources, so it fails if a later change reintroduces one of these in
/// a shape no other test could reach.
#[test]
fn neither_module_reaches_for_the_path_or_a_system_tool() {
    let mut checked = 0;
    for name in ["binary_registry.rs", "update.rs"] {
        let path = Path::new(MANIFEST_DIR).join("src/agent_runtime").join(name);
        let source = fs::read_to_string(&path).expect("the module source");
        for (number, line) in source.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("").trim();
            for forbidden in ["sudo", "upgrade", "\"PATH\"", "'PATH'"] {
                assert!(
                    !code.contains(forbidden),
                    "{}:{} names {forbidden} outside a comment: {line}",
                    path.display(),
                    number + 1
                );
            }
        }
        checked += 1;
    }
    assert_eq!(checked, 2, "both modules must be scanned");
}

// ---------------------------------------------------------------------------
// 2. 坏摘要不执行 — the trust chain, and its first link
// ---------------------------------------------------------------------------

/// §3.3's sharpest rule, in the shape it has to be enforced: 不能从同一不可信响应同时获取二进制和摘要便
/// 声称可信.
///
/// The artifact carries what the download claimed about itself, and no decision reads any of it. Two
/// artifacts with the same bytes are the same artifact whatever each one claims, and bytes that
/// match their own claim but not the record are still refused.
#[tokio::test]
async fn a_digest_that_arrived_with_the_artifact_is_not_consulted() {
    let registry = BinaryRegistry::new(scratch("claims")).expect("managed root");
    let bytes = elf_bytes();
    let release = release_of("9.9.9", &bytes);
    let probe = FakeProbe::answering("9.9.9");
    let claim = |digest: String| {
        Some(ArtifactClaims {
            digest: Some(digest),
            version: Some("9.9.9".to_string()),
        })
    };

    // The honest-looking claim: the artifact says its digest is the one the app expects.
    let agreeable = staged(&registry, "9.9.9", &bytes, claim(release.sha256().to_string()));
    assert!(update::verify(&release, &agreeable, &probe).await.is_ok());

    // The same claim, made by bytes the record does not name. If the claim were consulted this
    // would pass; it is refused because nothing reads it.
    let tampered = staged(
        &registry,
        "9.9.9",
        &with_machine(bytes.clone(), 0x00b7),
        claim(release.sha256().to_string()),
    );
    match update::verify(&release, &tampered, &probe).await {
        Err(UpdateError::DigestMismatch { .. }) => {}
        other => panic!("expected a digest refusal, got {other:?}"),
    }

    // And the other direction: a truthful claim about bytes the app did not pin.
    let unpinned = with_machine(bytes.clone(), 0x00b3);
    let truthful = staged(&registry, "9.9.9", &unpinned, claim(sha256_hex(&unpinned)));
    assert!(update::verify(&release, &truthful, &probe).await.is_err());
}

/// 坏摘要不执行, measured: the candidate is never handed to the probe, and it never carries an
/// execute bit. This is what §3.2 names the `downloads/` directory for (未验证文件不得执行).
#[tokio::test]
async fn an_artifact_whose_digest_does_not_match_the_record_is_never_run() {
    let registry = BinaryRegistry::new(scratch("bad-digest")).expect("managed root");
    let release = release_of("9.9.9", &elf_bytes());
    // One byte different: the same size, the same architecture, a different file.
    let mut wrong = elf_bytes();
    let last = wrong.len() - 1;
    wrong[last] ^= 0xff;

    let artifact = staged(&registry, "9.9.9", &wrong, None);
    let probe = FakeProbe::answering("9.9.9");

    match update::verify(&release, &artifact, &probe).await {
        Err(UpdateError::DigestMismatch { expected, actual }) => {
            assert_eq!(expected, release.sha256());
            assert_eq!(actual, sha256_hex(&wrong));
        }
        other => panic!("expected a digest refusal, got {other:?}"),
    }
    assert_eq!(probe.calls(), 0, "a refused candidate must not be run");
    assert_eq!(
        mode_of(&artifact.path) & 0o111,
        0,
        "a candidate that failed verification must not be executable"
    );
    assert_eq!(registry.active().expect("pointer"), None);
    assert_eq!(registry.installed(), Vec::<String>::new());
    // Still in the download area, where whoever is diagnosing the refusal can see what it was.
    assert!(artifact.path.starts_with(registry.downloads()));
}

/// The record is the only way a version can be verified: a version it does not name has no digest
/// to check against, and this host does not invent one.
#[tokio::test]
async fn a_version_the_record_does_not_name_has_nothing_to_verify_against() {
    assert!(update::shipped("0.0.0").is_none());
    assert!(update::shipped("1.18.29").is_some());

    // A record naming a target this release does not support is refused rather than reasoned about:
    // §3.2 requires claiming only the architecture that was actually verified.
    let registry = BinaryRegistry::new(scratch("unsupported-target")).expect("managed root");
    let bytes = elf_bytes();
    let release = PinnedRelease::new(
        "9.9.9",
        "aarch64-unknown-linux-gnu",
        &sha256_hex(&bytes),
        "test",
        "MIT",
        vec!["acp".to_string()],
    );
    let artifact = staged(&registry, "9.9.9", &bytes, None);
    match update::verify(&release, &artifact, &FakeProbe::answering("9.9.9")).await {
        Err(UpdateError::UnsupportedTarget { target }) => {
            assert_eq!(target, "aarch64-unknown-linux-gnu")
        }
        other => panic!("expected an unsupported-target refusal, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 3. The gate: what a candidate must prove before the pointer moves
// ---------------------------------------------------------------------------

/// The order is the rule (§3.3's list, in the only sequence that makes the digest worth anything),
/// and the pointer moves only after the last check.
#[tokio::test]
async fn the_gate_passes_in_order_and_the_pointer_moves_after_it() {
    let registry = BinaryRegistry::new(scratch("happy")).expect("managed root");
    let bytes = elf_bytes();
    let release = release_of("9.9.9", &bytes);
    let artifact = staged(&registry, "9.9.9", &bytes, None);

    let verified = update::verify(&release, &artifact, &FakeProbe::answering("9.9.9"))
        .await
        .expect("a candidate that passes every check");
    assert_eq!(verified.checks, Check::ALL.to_vec());
    assert_eq!(verified.digest, release.sha256());
    assert_eq!(verified.reported_version, "9.9.9");

    let active = update::promote(&registry, &verified, &idle()).expect("promote");
    assert_eq!(active.version, "9.9.9");
    assert_eq!(active.target, binary_registry::supported_target());

    // The pointer, on disk, in §3.2's shape — and the program it names, executable.
    let pointer = fs::read_to_string(registry.root().join("active.json")).expect("active.json");
    assert!(pointer.contains("\"version\":\"9.9.9\""), "{pointer}");
    let program = registry
        .active_program()
        .expect("pointer readable")
        .expect("an active program");
    assert_eq!(program.source, InstallSource::Managed);
    assert_eq!(program.version.as_deref(), Some("9.9.9"));
    assert_eq!(program.path, registry.program_of("9.9.9"));
    assert_eq!(mode_of(&program.path) & 0o111, 0o111);
    assert_eq!(registry.installed(), vec!["9.9.9".to_string()]);

    // The download area no longer holds it: promotion moves the candidate rather than copying it,
    // so there is one executable copy of one version and not two.
    assert!(!artifact.path.exists());
}

/// Architecture, from the file's own header: a candidate built for another machine is what this
/// check exists for, and a text file that happens to have the right digest is the other case.
#[tokio::test]
async fn a_candidate_built_for_another_architecture_is_refused() {
    let registry = BinaryRegistry::new(scratch("arch")).expect("managed root");
    let x86 = elf_bytes();

    let cases: [(&str, Vec<u8>); 4] = [
        ("aarch64", with_machine(x86.clone(), 0x00b7)),
        ("a 32-bit ELF", {
            let mut bytes = x86.clone();
            bytes[4] = 1; // EI_CLASS
            bytes
        }),
        ("not an ELF at all", b"#!/bin/sh\nexit 0\n".to_vec()),
        ("truncated", x86[..16].to_vec()),
    ];

    for (label, bytes) in cases {
        let release = release_of("9.9.9", &bytes);
        let artifact = staged(&registry, "9.9.9", &bytes, None);
        let probe = FakeProbe::answering("9.9.9");
        match update::verify(&release, &artifact, &probe).await {
            Err(UpdateError::NotExecutable { .. }) => {}
            other => panic!("{label} should have been refused, got {other:?}"),
        }
        assert_eq!(
            probe.calls(),
            0,
            "{label}: nothing runs before the header is read"
        );
        assert_eq!(registry.active().expect("pointer"), None);
    }
}

/// The version check: what the candidate says about itself has to be what the record names. This is
/// the first check that has to run the candidate, which is why it comes after the two that do not.
#[tokio::test]
async fn a_candidate_that_reports_another_version_is_refused() {
    let registry = BinaryRegistry::new(scratch("version")).expect("managed root");
    let bytes = elf_bytes();
    let release = release_of("9.9.9", &bytes);
    let artifact = staged(&registry, "9.9.9", &bytes, None);

    match update::verify(&release, &artifact, &FakeProbe::answering("9.9.8")).await {
        Err(UpdateError::VersionMismatch { expected, reported }) => {
            assert_eq!(expected, "9.9.9");
            assert_eq!(reported, "9.9.8");
        }
        other => panic!("expected a version refusal, got {other:?}"),
    }
    assert_eq!(registry.active().expect("pointer"), None);
}

/// A candidate this host cannot talk to is not an update. The refusal names the stage, so a user
/// reads "it never answered the protocol" rather than "the update failed".
#[tokio::test]
async fn a_candidate_that_fails_the_handshake_is_refused() {
    let registry = BinaryRegistry::new(scratch("handshake")).expect("managed root");
    let bytes = elf_bytes();
    let release = release_of("9.9.9", &bytes);
    let artifact = staged(&registry, "9.9.9", &bytes, None);

    match update::verify(
        &release,
        &artifact,
        &FakeProbe::answering("9.9.9").refusing_the_handshake(),
    )
    .await
    {
        Err(UpdateError::Probe { check, detail }) => {
            assert_eq!(check, Check::AcpInitialization);
            assert!(detail.contains("initialize"), "{detail}");
        }
        other => panic!("expected a probe refusal, got {other:?}"),
    }
    assert_eq!(registry.active().expect("pointer"), None);
}

/// An interrupted download must not affect the current version (§3.3), which is only true if the
/// candidate is kept out of the release tree until it has passed.
#[tokio::test]
async fn an_interrupted_download_leaves_the_active_version_alone() {
    let registry = BinaryRegistry::new(scratch("interrupted")).expect("managed root");

    let first = elf_bytes();
    let release = release_of("9.9.9", &first);
    let artifact = staged(&registry, "9.9.9", &first, None);
    let verified = update::verify(&release, &artifact, &FakeProbe::answering("9.9.9"))
        .await
        .expect("the first version installs");
    update::promote(&registry, &verified, &idle()).expect("promote");
    let active_before = registry.active().expect("pointer").expect("active");
    let program_before = registry.program_of("9.9.9");
    let bytes_before = fs::read(&program_before).expect("the active program");

    // A half-written second version: the download stopped in the middle of the file.
    let release = release_of("9.9.10", &elf_bytes());
    let artifact = staged(&registry, "9.9.10", &elf_bytes()[..4096], None);
    assert!(update::verify(&release, &artifact, &FakeProbe::answering("9.9.10"))
        .await
        .is_err());

    assert_eq!(registry.active().expect("pointer"), Some(active_before));
    assert_eq!(registry.installed(), vec!["9.9.9".to_string()]);
    assert_eq!(fs::read(&program_before).expect("still there"), bytes_before);
}

/// §3.3: 活跃会话期间不热替换进程. The pointer is what a start resolves through, so moving it while an
/// engine is running is exactly the swap this refuses.
#[tokio::test]
async fn the_pointer_does_not_move_while_a_session_is_live() {
    let registry = BinaryRegistry::new(scratch("live")).expect("managed root");
    let bytes = elf_bytes();
    let release = release_of("9.9.9", &bytes);
    let artifact = staged(&registry, "9.9.9", &bytes, None);
    let verified = update::verify(&release, &artifact, &FakeProbe::answering("9.9.9"))
        .await
        .expect("verified");

    match update::promote(&registry, &verified, &Sessions(1)) {
        Err(UpdateError::SessionLive { sessions }) => assert_eq!(sessions, 1),
        other => panic!("expected a live-session refusal, got {other:?}"),
    }
    assert_eq!(registry.active().expect("pointer"), None);
    assert_eq!(registry.installed(), Vec::<String>::new());
    assert!(
        artifact.path.exists(),
        "a refused promotion leaves the candidate where the next attempt can use it"
    );
}

/// The download area's rule (未验证文件不得执行) made structural: a candidate that already has an
/// execute bit did not come from this host's downloader, and the gate refuses to bless it.
#[tokio::test]
async fn a_staged_candidate_that_is_already_executable_is_refused() {
    let registry = BinaryRegistry::new(scratch("pre-exec")).expect("managed root");
    let bytes = elf_bytes();
    let release = release_of("9.9.9", &bytes);
    let artifact = staged(&registry, "9.9.9", &bytes, None);
    make_executable(&artifact.path);

    match update::verify(&release, &artifact, &FakeProbe::answering("9.9.9")).await {
        Err(UpdateError::StagedExecutable { .. }) => {}
        other => panic!("expected a staging refusal, got {other:?}"),
    }
    assert_eq!(registry.active().expect("pointer"), None);
}

// ---------------------------------------------------------------------------
// 4. 迁移失败不破坏旧 profile — rollback, and what it must not discard
// ---------------------------------------------------------------------------

/// The world a rollback happens in: two installed versions, and a profile one of them has written.
struct RollbackScene {
    registry: BinaryRegistry,
    profile: PathBuf,
    states: Vec<ProfileState>,
}

impl RollbackScene {
    /// `written_by` is the version that last wrote the profile, as the app's own record has it —
    /// `None` for a profile nothing has run against yet.
    fn new(label: &str, older: &str, newer: &str, written_by: Option<&str>) -> Self {
        let registry = BinaryRegistry::new(scratch(label)).expect("managed root");
        for version in [older, newer] {
            let program = registry.program_of(version);
            fs::create_dir_all(program.parent().expect("release directory"))
                .expect("release directory");
            fs::copy("/bin/true", &program).expect("install a program");
            registry.set_active(version).expect("install the version");
        }
        registry.set_active(older).expect("the pointer starts on the older");

        let profile = scratch(&format!("{label}-profile"));
        write_file(&profile.join("config.json"), "{\"model\":\"a\"}");
        write_file(&profile.join("sessions/01.json"), "{\"session\":\"one\"}");
        // What the newer version wrote when it migrated: the session it appended.
        write_file(
            &profile.join("sessions/02.json"),
            "{\"session\":\"two\",\"by\":\"newer\"}",
        );

        let states = vec![ProfileState {
            profile_id: "default".to_string(),
            root: profile.clone(),
            written_by: written_by.map(str::to_string),
        }];
        Self {
            registry,
            profile,
            states,
        }
    }

    fn active_version(&self) -> String {
        self.registry
            .active()
            .expect("pointer")
            .expect("an active release")
            .version
    }
}

/// 若新版本已迁移数据库，不得仅回退二进制 (§3.3). The refusal is the point: moving the pointer back
/// under a migrated profile would hand an older engine a store a newer one rewrote.
#[test]
fn a_bare_binary_rollback_is_refused_once_the_newer_version_wrote_the_profile() {
    let scene = RollbackScene::new("migrated", "9.9.9", "9.9.10", Some("9.9.10"));
    let before = tree(&scene.profile);

    match update::rollback(
        &scene.registry,
        RollbackRequest {
            to_version: "9.9.9",
            profiles: &scene.states,
            restore_from: None,
            engine_stopped: true,
            confirm_data_restore: false,
        },
    ) {
        Err(UpdateError::StateMigrated { profiles }) => assert_eq!(profiles, vec!["default"]),
        other => panic!("expected a migration refusal, got {other:?}"),
    }

    assert_eq!(scene.active_version(), "9.9.9");
    assert_eq!(
        tree(&scene.profile),
        before,
        "a refused rollback touched the profile"
    );
}

/// A rollback that is not restoring still must not discard what the upgrade produced (§3.3): the
/// newer session stays, in the profile and in a retained copy, and the report says the two were not
/// reconciled.
#[test]
fn a_rollback_keeps_the_newer_data_even_when_nothing_is_restored() {
    let scene = RollbackScene::new("retain-only", "9.9.9", "9.9.10", Some("9.9.10"));
    let before = tree(&scene.profile);

    let report = update::rollback(
        &scene.registry,
        RollbackRequest {
            to_version: "9.9.9",
            profiles: &scene.states,
            restore_from: None,
            engine_stopped: true,
            confirm_data_restore: true,
        },
    )
    .expect("a confirmed rollback");

    assert_eq!(report.active.version, "9.9.9");
    assert!(!report.restored, "there was no backup to restore from");
    let retained = report.retained.first().expect("a retained copy");
    assert_eq!(
        tree(retained),
        before,
        "the retained copy is what the profile held before the rollback"
    );
    assert_eq!(
        tree(&scene.profile),
        before,
        "nothing was restored, so the profile is untouched"
    );
    assert_eq!(
        report.unreconciled,
        vec!["default"],
        "a rollback under migrated state must name what it did not reconcile"
    );
}

/// 迁移失败不破坏旧 profile: the backup this was going to restore from is unusable, and the profile
/// it would have replaced is exactly as it was. The pointer is unmoved, and no recovery directory is
/// left behind by the refusal.
#[test]
fn a_backup_that_cannot_be_read_does_not_damage_the_profile() {
    let scene = RollbackScene::new("bad-backup", "9.9.9", "9.9.10", Some("9.9.10"));
    let before = tree(&scene.profile);
    let empty_backup = scratch("bad-backup-source");

    for (label, backup) in [
        ("missing", scene.registry.root().join("no-such-backup")),
        ("empty", empty_backup.clone()),
    ] {
        match update::rollback(
            &scene.registry,
            RollbackRequest {
                to_version: "9.9.9",
                profiles: &scene.states,
                restore_from: Some(&backup),
                engine_stopped: true,
                confirm_data_restore: true,
            },
        ) {
            Err(UpdateError::BackupIncomplete { profile_id, .. }) => {
                assert_eq!(profile_id, "default")
            }
            other => panic!("{label}: expected a backup refusal, got {other:?}"),
        }
        assert_eq!(
            tree(&scene.profile),
            before,
            "{label}: the profile was touched"
        );
        assert_eq!(
            scene.active_version(),
            "9.9.9",
            "{label}: the pointer moved despite the refusal"
        );
    }
    assert!(
        !scene.registry.recovery("default").exists(),
        "a refused rollback must not leave a recovery directory behind"
    );
}

/// The other half of §3.3's rule: 回退不得默默丢弃升级后产生的会话. A confirmed rollback keeps the
/// newer data before it restores, leaves the newer release on disk, and says out loud what it could
/// not reconcile.
#[test]
fn a_confirmed_rollback_retains_the_newer_data_and_keeps_the_newer_release() {
    let scene = RollbackScene::new("restore", "9.9.9", "9.9.10", Some("9.9.10"));
    let before = tree(&scene.profile);

    // The pre-upgrade snapshot, as a backup of `agent-profiles/` looks: the same profile without
    // what the newer version appended.
    let backup = scratch("restore-backup");
    write_file(
        &backup.join("default/config.json"),
        "{\"model\":\"a\",\"from\":\"backup\"}",
    );
    write_file(
        &backup.join("default/sessions/01.json"),
        "{\"session\":\"one\"}",
    );

    let report = update::rollback(
        &scene.registry,
        RollbackRequest {
            to_version: "9.9.9",
            profiles: &scene.states,
            restore_from: Some(&backup),
            engine_stopped: true,
            confirm_data_restore: true,
        },
    )
    .expect("a confirmed rollback");

    assert_eq!(report.active.version, "9.9.9");
    assert!(report.restored);

    // The newer data, retained before the restore, byte for byte what was there.
    let retained = report.retained.first().expect("a retained copy");
    assert_eq!(
        tree(retained),
        before,
        "the retained copy holds what the profile held before the restore"
    );

    // And the profile is the backup, not a merge of the two.
    assert_eq!(
        fs::read_to_string(scene.profile.join("config.json")).expect("config"),
        "{\"model\":\"a\",\"from\":\"backup\"}"
    );
    assert!(
        !scene.profile.join("sessions/02.json").exists(),
        "the restore puts back the backup; it does not pretend to merge"
    );
    assert_eq!(report.unreconciled, vec!["default"]);

    // The newer release stays where it is: the old version is kept usable, not the new one removed.
    assert!(scene.registry.installed().contains(&"9.9.10".to_string()));
}

/// Moving the pointer while an engine is running is the same hot-swap the update path refuses.
#[test]
fn a_rollback_is_refused_while_the_engine_is_running() {
    let scene = RollbackScene::new("rollback-live", "9.9.9", "9.9.10", None);
    let before = tree(&scene.profile);

    match update::rollback(
        &scene.registry,
        RollbackRequest {
            to_version: "9.9.9",
            profiles: &scene.states,
            restore_from: None,
            engine_stopped: false,
            confirm_data_restore: true,
        },
    ) {
        Err(UpdateError::EngineRunning) => {}
        other => panic!("expected a running-engine refusal, got {other:?}"),
    }
    assert_eq!(tree(&scene.profile), before);
    assert_eq!(scene.active_version(), "9.9.9");
}

// ---------------------------------------------------------------------------
// 5. Who may be replaced at all, and where a managed root may live
// ---------------------------------------------------------------------------

/// §3.4.6 and §3.3 together: an external installation gets a version notice and a native entry
/// point, never a fetch. The policy is the registry's (T3a); this is the half that acts on it.
#[test]
fn an_external_installation_is_never_replaced_by_the_update_path() {
    assert_eq!(
        InstallSource::External.update_policy(),
        UpdatePolicy::ReportedOnly
    );
    match update::may_replace(InstallSource::External) {
        Err(UpdateError::NotUpdatable { source }) => assert_eq!(source, InstallSource::External),
        other => panic!("expected a refusal, got {other:?}"),
    }
    for source in [InstallSource::Bundled, InstallSource::Managed] {
        assert_eq!(source.update_policy(), UpdatePolicy::HostManaged);
        assert!(update::may_replace(source).is_ok());
    }
}

/// §3.3: 不执行 sudo，不写 AppImage 挂载目录或系统包目录. A managed root that is one of those is
/// refused at construction, so nothing later can write there by accident.
#[test]
fn a_managed_root_outside_what_the_app_owns_is_refused() {
    for root in [
        "/usr/lib/nekowite",
        "/etc/nekowite",
        "/opt/nekowite",
        "/var/lib/nekowite",
        "/bin",
        "/tmp/.mount_NekoWiteABCD/usr/share",
        "/",
        "/nekowite",
    ] {
        match BinaryRegistry::new(root) {
            Err(LayoutError::OutsideManagedScope { root: refused, .. }) => {
                assert_eq!(refused, PathBuf::from(root))
            }
            other => panic!("{root} should have been refused, got {other:?}"),
        }
    }
    match BinaryRegistry::new("relative/agent-runtime") {
        Err(LayoutError::Relative { .. }) => {}
        other => panic!("a relative managed root should have been refused, got {other:?}"),
    }
    // Where Tauri resolves the app's own data directory, it is accepted.
    assert!(BinaryRegistry::new(scratch("accepted-root")).is_ok());
}

/// §3.2's layout, as paths: the release tree, the download area and the recovery area are the ones
/// the plan names, and a version is a path component rather than a string that could escape.
#[test]
fn the_layout_is_the_one_the_plan_names() {
    let registry = BinaryRegistry::new(scratch("layout")).expect("managed root");
    assert!(registry.downloads().ends_with("agent-runtime/downloads"));
    assert!(registry.recovery("default").ends_with("agent-recovery/default"));
    assert!(registry
        .program_of("1.2.3")
        .ends_with("agent-runtime/releases/1.2.3/x86_64-unknown-linux-gnu/opencode"));

    for escape in ["../../etc", "a/b", "", ".", ".."] {
        assert!(
            registry
                .stage(escape, binary_registry::supported_target(), b"x")
                .is_err(),
            "{escape:?} must not become a path component"
        );
    }
}

/// Versions are ordered numerically, everywhere the app orders them.
///
/// This is the decision a rollback's migration check turns on: `1.18.10` came after `1.18.9`, and a
/// comparison that read them as strings would say a rollback from the newer one to the older one was
/// a rollback to a newer one — refusing the wrong way round, or not refusing at all.
#[test]
fn versions_are_compared_numerically_rather_than_alphabetically() {
    assert!(binary_registry::is_newer("1.18.10", "1.18.9"));
    assert!(!binary_registry::is_newer("1.18.9", "1.18.10"));
    assert!(binary_registry::is_newer("1.19.0", "1.18.29"));
    assert!(!binary_registry::is_newer("1.18.29", "1.18.29"));

    let registry = BinaryRegistry::new(scratch("ordering")).expect("managed root");
    for version in ["1.18.9", "1.18.10", "1.18.2"] {
        let program = registry.program_of(version);
        fs::create_dir_all(program.parent().expect("release directory")).expect("release directory");
        fs::copy("/bin/true", &program).expect("install a program");
    }
    assert_eq!(
        registry.installed(),
        vec!["1.18.2", "1.18.9", "1.18.10"],
        "the installed list is oldest first"
    );
}

/// The pinned record and the shipped manifest are one fact in several places; this is where the
/// shipped one is held down, and where the packaging script's expectations are stated.
#[test]
fn the_shipped_manifest_names_only_what_this_release_supports() {
    assert_eq!(
        binary_registry::supported_target(),
        "x86_64-unknown-linux-gnu"
    );
    assert!(binary_registry::is_supported(
        binary_registry::supported_target()
    ));
    assert!(!binary_registry::is_supported("aarch64-unknown-linux-gnu"));

    let pinned = update::shipped("1.18.29").expect("the pinned version");
    assert_eq!(pinned.version(), "1.18.29");
    assert_eq!(pinned.target(), binary_registry::supported_target());
    assert_eq!(pinned.sha256().len(), 64);
    assert!(
        pinned.source().contains("opencode"),
        "the record must name where the artifact came from: {}",
        pinned.source()
    );
    assert_eq!(update::shipped_versions(), vec!["1.18.29"]);
    // §3.3: 第三方许可证和分发义务进入发布清单 — the record carries the licence, and the packaging
    // script reads it from there instead of keeping a second list.
    assert_eq!(pinned.licence(), "MIT");
}

/// The probe the gate uses in production runs a real process, so it has to be bounded: a candidate
/// that hangs must fail the update rather than the app.
#[tokio::test]
async fn the_process_probe_is_bounded_and_never_answers_for_a_silent_candidate() {
    let probe = AcpProbe::new(scratch("probe-timeout"), vec!["acp".to_string()])
        .with_bound(Duration::from_millis(50));
    let program = scratch("probe-program").join("opencode");
    write_file(&program, "#!/bin/sh\nsleep 30\n");
    make_executable(&program);

    assert!(
        probe.version(&program).await.is_err(),
        "a program that never answers `--version` must not pass"
    );
    assert!(
        probe.acp_initialization(&program).await.is_err(),
        "a handshake that never arrives must not pass"
    );

    // The probe runs the candidate under its own profile roots, and the profile it was given is the
    // one it uses: the developer's own engine state is never the probe's.
    assert!(probe.profile().starts_with(Path::new(MANIFEST_DIR)));
}
