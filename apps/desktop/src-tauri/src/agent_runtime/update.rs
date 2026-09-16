//! The update path: what a candidate must prove before the active pointer moves, and what a
//! rollback must not discard.
//!
//! §3.3 is a list of failures rather than features, and each one is a rule here:
//!
//! - **A digest that arrived with the artifact proves nothing.** [`Artifact::claims`] carries what
//!   the download response said about itself, and no decision in this module reads it. The only
//!   digest that counts is the one in the app's own [`PinnedRelease`] record, which ships inside
//!   the binary — so a response cannot supply both halves of its own proof.
//! - **A download is not executable until it has passed.** [`verify`] runs the checks in one order,
//!   and the order is the rule: the digest and the architecture are read before the file is given
//!   an execute bit, and the bit is given before anything runs it. `downloads/` holds bytes
//!   (未验证文件不得执行); only [`promote`] makes one of them the version this app starts.
//! - **No hot-swap while a session is live.** [`promote`] asks [`SessionActivity`] before it moves
//!   the pointer, so the question is asked rather than assumed, and this module never reaches into
//!   the agent registry to answer it.
//! - **A migrated profile cannot be rolled back by moving a binary.** [`rollback`] refuses that
//!   outright (若新版本已迁移数据库，不得仅回退二进制), and when a restore is confirmed it retains the
//!   newer data first, refuses to touch the profile if the backup is unusable, and reports what it
//!   could not reconcile. A profile no version record covers is refused the same way
//!   ([`UpdateError::UnrecordedState`]) rather than assumed to be safe: the refusal fails closed.
//!
//! What this module deliberately does not own: profiles (T12), agent definitions (T3a), and the
//! question of which of their releases a network should be asked about.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::future::BoxFuture;

use super::binary_registry::{self, BinaryRegistry, LayoutError};
use super::registry::{InstallSource, UpdatePolicy};
use super::session::INITIALIZE_BOUND;
use super::{env_pairs, EngineConnection, EngineLaunch, isolated_profile_env};

/// How long a candidate gets to answer `--version`.
///
/// Shorter than the handshake's bound on purpose: printing a version is not a negotiation, and a
/// program that cannot do it promptly is a program this host should not be waiting on. The decision
/// to make it a *bound* rather than a wait is §6.2's (a timeout is what keeps a hang from becoming
/// the app's hang), applied here to the one process this module starts on its own.
pub const VERSION_BOUND: Duration = Duration::from_secs(10);

/// One release this app is willing to install, and the facts that make it checkable.
///
/// The fields are the supply-chain record §3.3 asks for: which version, for which target, from
/// which source, under which licence, and the digest that ties all of it to a file. Records come
/// from [`shipped`] in production; a record is never built from a network response, which is what
/// `Artifact::claims` being a separate type is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedRelease {
    version: String,
    target: String,
    sha256: String,
    /// Where the artifact came from, and through which channel — the provenance that makes a
    /// digest worth checking. §5.6 of the architecture record is why this is one channel and not
    /// two: the registry's entry for a version and this app's artifact are not guaranteed to be
    /// byte-identical, so only the channel this app actually downloads through may be recorded.
    source: String,
    licence: String,
    /// The invocation that puts this release into ACP mode. Part of the record rather than of the
    /// probe, so the update path never has to know an engine's name to check one.
    acp_args: Vec<String>,
}

impl PinnedRelease {
    /// Builds a record. Called by the shipped manifest below, and by tests that need bytes they
    /// control; never from anything a download said.
    pub fn new(
        version: &str,
        target: &str,
        sha256: &str,
        source: &str,
        licence: &str,
        acp_args: Vec<String>,
    ) -> Self {
        Self {
            version: version.to_string(),
            target: target.to_string(),
            sha256: sha256.to_string(),
            source: source.to_string(),
            licence: licence.to_string(),
            acp_args,
        }
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn target(&self) -> &str {
        &self.target
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn licence(&self) -> &str {
        &self.licence
    }

    pub fn acp_args(&self) -> Vec<String> {
        self.acp_args.clone()
    }
}

/// The releases this build will install, compiled in.
///
/// This is the trusted half of §3.3's rule. The digest lives here and not in a file the app reads
/// at run time, because a file beside the download is one more thing an attacker who can reach the
/// download can reach; the record travels with the binary that checks it.
fn manifest() -> &'static [PinnedRelease] {
    static MANIFEST: OnceLock<Vec<PinnedRelease>> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        vec![PinnedRelease::new(
            "1.18.29",
            binary_registry::supported_target(),
            // sha256 of the *program*, which is what the gate hashes; the tarball it was extracted
            // from is pinned by `scripts/fetch-opencode-linux.sh` with npm's own sha512 integrity
            // for `opencode-linux-x64@1.18.29`, and `scripts/verify-opencode-linux.sh` holds the two
            // records against each other on every packaged release.
            "ca6c0e1f42be3120595bf6848937e7586ec862c87fa7aa111e89c7cc6e9a4650",
            "npm opencode-linux-x64@1.18.29 (registry integrity sha512 verified on fetch)",
            "MIT",
            vec!["acp".to_string()],
        )]
    })
}

/// The record for `version`, if this build installs it.
pub fn shipped(version: &str) -> Option<&'static PinnedRelease> {
    manifest().iter().find(|release| release.version == version)
}

/// Every version this build installs, so a settings page can say what it will accept.
pub fn shipped_versions() -> Vec<&'static str> {
    manifest()
        .iter()
        .map(|release| release.version.as_str())
        .collect()
}

/// What the engine answers in the handshake — the part of the ACP initialization this host can
/// judge without a model, a credential or a network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    pub agent_name: String,
    pub agent_version: String,
    pub protocol_version: u16,
}

/// What a download claimed about itself.
///
/// Recorded, never consulted. A response that carries its own digest proves only that the response
/// is self-consistent (§3.3: 不能从同一不可信响应同时获取二进制和摘要便声称可信), so this type exists to
/// keep the claim visible — in the refusal a user reads, and in the report of a promotion — while
/// every decision in this module goes through [`PinnedRelease`] instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactClaims {
    pub digest: Option<String>,
    pub version: Option<String>,
}

/// A downloaded candidate, staged in the download area and not yet verified.
#[derive(Debug, Clone)]
pub struct Artifact {
    pub path: PathBuf,
    pub claims: Option<ArtifactClaims>,
}

/// One step of the gate, in the order it runs.
///
/// The order is the content: a digest checked after the candidate has run is worth nothing, so the
/// sequence is a value rather than a comment, and [`Verified::checks`] carries it to the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    /// The bytes match the digest in the app's own record.
    Digest,
    /// The file is a 64-bit little-endian ELF for this release's architecture.
    Architecture,
    /// The candidate carries no execute bit before this check, and one after it.
    ExecuteBit,
    /// `--version` answers with the version the record names.
    Version,
    /// The candidate completes this host's ACP handshake.
    AcpInitialization,
}

impl Check {
    pub const ALL: [Check; 5] = [
        Check::Digest,
        Check::Architecture,
        Check::ExecuteBit,
        Check::Version,
        Check::AcpInitialization,
    ];

    /// A short name for a refusal or a log line; the user-facing wording is the frontend's.
    pub fn as_str(self) -> &'static str {
        match self {
            Check::Digest => "digest",
            Check::Architecture => "architecture",
            Check::ExecuteBit => "execute-permission",
            Check::Version => "version",
            Check::AcpInitialization => "acp-initialization",
        }
    }
}

/// A candidate that passed every check.
///
/// The only thing [`promote`] accepts, and the reason the order in [`Check`] cannot be skipped: the
/// value is produced at the end of the gate, so a caller that wants the pointer moved has to have
/// run all of it.
#[derive(Debug, Clone)]
pub struct Verified {
    /// The staged file, still in the download area, now executable.
    pub program: PathBuf,
    pub version: String,
    pub target: String,
    pub digest: String,
    /// What the candidate said about itself when asked. Kept beside the record's version so a
    /// mismatch can be read rather than inferred.
    pub reported_version: String,
    pub handshake: Handshake,
    pub checks: Vec<Check>,
    /// What the download claimed. Diagnostics only — see [`ArtifactClaims`].
    pub claims: Option<ArtifactClaims>,
}

/// Why an update or a rollback was refused. Data only: the frontend maps these to sentences, the
/// same way it maps `registry::RegistryError` — every variant carries what a sentence needs (the
/// version, the path the data was kept at, how many sessions are running) and none of them carries
/// wording, so there is one place where a refusal becomes something a user reads.
#[derive(Debug, Clone)]
pub enum UpdateError {
    /// The bytes are not what the app's record names. This is the refusal that stops everything
    /// else: nothing has run, and nothing will.
    DigestMismatch { expected: String, actual: String },
    /// Not a file this release can execute: wrong architecture, wrong class, or not an executable
    /// at all.
    NotExecutable { path: PathBuf, reason: String },
    /// A staged candidate arrived with an execute bit, so it did not come from the download path
    /// this module owns (§3.2: 未验证文件不得执行).
    StagedExecutable { path: PathBuf },
    /// The candidate answers with a version the record does not name.
    VersionMismatch { expected: String, reported: String },
    /// A probe failed at a named stage.
    Probe { check: Check, detail: String },
    /// A release for an architecture this build does not claim to support (§3.2).
    UnsupportedTarget { target: String },
    /// The pointer was asked to move while an engine is running (§3.3: 活跃会话期间不热替换进程).
    SessionLive { sessions: usize },
    /// The pointer was asked to move for a version that is not installed. §3.3's rule is that an
    /// incompatible version leaves the *old* one usable, and a version that is not on disk is not
    /// usable by anyone.
    VersionNotInstalled { version: String, program: PathBuf },
    /// A `Verified` value that did not pass every check.
    NotVerified,
    /// The profile has been written by a version newer than the one being returned to, so moving the
    /// binary back alone would hand an older engine a store a newer one rewrote.
    StateMigrated { profiles: Vec<String> },
    /// No record covers which version last wrote the profile, so this host cannot tell whether a
    /// rollback would cross a state migration. Refused rather than assumed (§3.3): 若新版本已迁移
    /// 数据库，不得仅回退二进制, and "we cannot tell" is not "it did not happen". The confirmation that
    /// clears it is the same one [`UpdateError::StateMigrated`] takes, because the user is being
    /// asked the same question — do you want the data-restore path, or not.
    UnrecordedState { profiles: Vec<String> },
    /// A restore was asked for while an engine could still be writing.
    EngineRunning,
    /// The backup named for a restore cannot be read, or does not hold the profile it should.
    BackupIncomplete { profile_id: String, path: PathBuf },
    /// The newer data could not be retained, so the rollback was stopped rather than performed
    /// (§3.3: 回退不得默默丢弃升级后产生的会话).
    Unpreserved {
        profile_id: String,
        path: PathBuf,
        detail: String,
    },
    /// A restore failed; the profile it was replacing is still in place.
    RestoreFailed { profile_id: String, detail: String },
    /// An installation this host may report on but never replace (§3.4.6).
    NotUpdatable { source: InstallSource },
    /// The managed layout refused the path.
    Layout(LayoutError),
    /// The filesystem said no.
    Io { path: PathBuf, detail: String },
}

impl From<LayoutError> for UpdateError {
    fn from(error: LayoutError) -> Self {
        UpdateError::Layout(error)
    }
}

/// What this host asks a candidate to prove by running it.
///
/// One method per check, so a refusal names the stage it failed at instead of "the probe failed",
/// and so the gate can be exercised without a 184 MB artifact: the tests answer these directly.
pub trait CandidateProbe: Sync {
    /// The version the candidate reports about itself.
    fn version<'a>(&'a self, program: &'a Path) -> BoxFuture<'a, Result<String, String>>;

    /// The handshake this host speaks, performed against the candidate.
    fn acp_initialization<'a>(
        &'a self,
        program: &'a Path,
    ) -> BoxFuture<'a, Result<Handshake, String>>;
}

/// The gate, in the order §3.3 lists it.
///
/// Every step before the last one is cheap and none of them run the candidate before the digest has
/// matched: `ArtifactClaims` is not read here at all, and the file has no execute bit until the two
/// checks that can be made without one have passed.
pub async fn verify<P: CandidateProbe>(
    release: &PinnedRelease,
    artifact: &Artifact,
    probe: &P,
) -> Result<Verified, UpdateError> {
    if release.target != binary_registry::supported_target() {
        return Err(UpdateError::UnsupportedTarget {
            target: release.target.clone(),
        });
    }
    let mut checks = Vec::with_capacity(Check::ALL.len());

    // 1. The bytes against the app's own record. The artifact's claims are not consulted — see
    //    `ArtifactClaims`; if the digest is wrong, nothing below this line happens at all.
    let actual = binary_registry::digest_of(&artifact.path).await?;
    if actual != release.sha256 {
        return Err(UpdateError::DigestMismatch {
            expected: release.sha256.clone(),
            actual,
        });
    }
    checks.push(Check::Digest);

    // 2. The architecture, from the file's own header. A candidate built for another machine is the
    //    failure this exists for, and reading it costs a 64-byte read rather than a run.
    let header = binary_registry::read_elf_header(&artifact.path)?;
    binary_registry::check_elf(&header).map_err(|reason| UpdateError::NotExecutable {
        path: artifact.path.clone(),
        reason,
    })?;
    checks.push(Check::Architecture);

    // 3. The execute bit. Two directions, both structural: a candidate that *already* had one did
    //    not come from this host's downloader and is refused, and the bit is applied here so that
    //    everything the checks below run is a file this gate made executable, on purpose.
    let mode = binary_registry::mode_of(&artifact.path)?;
    if mode & 0o111 != 0 {
        return Err(UpdateError::StagedExecutable {
            path: artifact.path.clone(),
        });
    }
    fs::set_permissions(&artifact.path, fs::Permissions::from_mode(0o755)).map_err(|error| {
        UpdateError::Io {
            path: artifact.path.clone(),
            detail: error.to_string(),
        }
    })?;
    if binary_registry::mode_of(&artifact.path)? & 0o111 == 0 {
        return Err(UpdateError::NotExecutable {
            path: artifact.path.clone(),
            reason: "the execute permission could not be applied".to_string(),
        });
    }
    checks.push(Check::ExecuteBit);

    // 4. What the candidate says it is.
    let reported_version = probe
        .version(&artifact.path)
        .await
        .map_err(|detail| UpdateError::Probe {
            check: Check::Version,
            detail,
        })?;
    if reported_version != release.version {
        return Err(UpdateError::VersionMismatch {
            expected: release.version.clone(),
            reported: reported_version,
        });
    }
    checks.push(Check::Version);

    // 5. The handshake. A candidate this host cannot talk to is not an update, whatever it says
    //    about its own version.
    let handshake = probe
        .acp_initialization(&artifact.path)
        .await
        .map_err(|detail| UpdateError::Probe {
            check: Check::AcpInitialization,
            detail,
        })?;
    if handshake.protocol_version != 1 {
        return Err(UpdateError::Probe {
            check: Check::AcpInitialization,
            detail: format!(
                "the engine negotiated protocol version {}, and this host speaks 1",
                handshake.protocol_version
            ),
        });
    }
    checks.push(Check::AcpInitialization);

    Ok(Verified {
        program: artifact.path.clone(),
        version: release.version.clone(),
        target: release.target.clone(),
        digest: actual,
        reported_version,
        handshake,
        checks,
        claims: artifact.claims.clone(),
    })
}

/// The probe that runs the candidate: this host's own ACP client, and `--version`.
///
/// The process-side flags are the same ones `agent_runtime_test.rs` uses against the real engine,
/// which is what makes that test the measurement this one is built on.
///
/// `args` come from the release record rather than from here ([`PinnedRelease::acp_args`]): how a
/// release is put into ACP mode is a fact about that release, and the alternative — naming the
/// invocation in this file — is the `if (agentId === 'opencode')` §3.4 forbids, one module down.
pub struct AcpProbe {
    profile: PathBuf,
    args: Vec<String>,
    bound: Duration,
}

impl AcpProbe {
    /// A probe whose engine gets its own profile roots (§3.2's `agent-profiles/<profile-id>/`), so
    /// verifying a candidate never reads or writes the state of an engine the user is running.
    pub fn new(profile: impl Into<PathBuf>, args: Vec<String>) -> Self {
        let profile = profile.into();
        // Best effort, and only so the paths exist for the engine to write into; a failure here is
        // reported by the engine itself rather than guessed at here.
        let _ = fs::create_dir_all(&profile);
        Self {
            profile,
            args,
            bound: INITIALIZE_BOUND,
        }
    }

    /// How long the candidate gets, for both the version and the handshake.
    pub fn with_bound(mut self, bound: Duration) -> Self {
        self.bound = bound;
        self
    }

    /// The profile roots this probe hands its candidate.
    pub fn profile(&self) -> &Path {
        &self.profile
    }
}

impl CandidateProbe for AcpProbe {
    fn version<'a>(&'a self, program: &'a Path) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            // Printing a version is not a negotiation, so it gets the shorter of the two bounds: a
            // program that cannot do it promptly is not one this host should be waiting on.
            let bound = self.bound.min(VERSION_BOUND);
            let mut command = tokio::process::Command::new(program);
            command.arg("--version");
            // A cleared environment, then nothing but the roots of this probe's own profile: the
            // question "does this run without a system CLI" is answered by there being no `PATH` for
            // one to be found on, and the question "does this read the developer's profile" by the
            // only roots it is given being this probe's.
            command.env_clear();
            for (name, value) in isolated_profile_env(&self.profile) {
                command.env(name, value);
            }
            match tokio::time::timeout(bound, command.output()).await {
                Err(_) => Err(format!(
                    "{} did not answer --version within {bound:?}",
                    program.display()
                )),
                Ok(Err(error)) => Err(error.to_string()),
                Ok(Ok(output)) if !output.status.success() => Err(format!(
                    "--version exited with {}",
                    output.status
                )),
                Ok(Ok(output)) => {
                    let reported = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if reported.is_empty() {
                        return Err("--version printed nothing".to_string());
                    }
                    Ok(reported)
                }
            }
        })
    }

    fn acp_initialization<'a>(
        &'a self,
        program: &'a Path,
    ) -> BoxFuture<'a, Result<Handshake, String>> {
        Box::pin(async move {
            // The host's own client, not a second protocol implementation: a candidate that passes
            // here has passed against the code that will actually run it.
            let launch = EngineLaunch {
                program: program.to_path_buf(),
                args: self.args.clone(),
                // Roots only: a candidate is probed before this app has a profile for it to
                // authenticate with, and a credential has nothing to add to a handshake.
                env: env_pairs(isolated_profile_env(&self.profile)),
                ca_bundle: None,
            };
            let (connection, _events) = EngineConnection::connect(&launch)
                .await
                .map_err(|error| error.failure_message())?;
            let response = connection.initialize(self.bound).await;
            // Whatever happened, the candidate is stopped through the same shutdown sequence a
            // running engine gets: asking first, then the group signal (§6.2).
            let handshake = response
                .map_err(|error| error.failure_message())
                .and_then(|response| {
                let info = response
                    .agent_info
                    .ok_or_else(|| "the handshake carried no agentInfo".to_string())?;
                Ok(Handshake {
                    agent_name: info.name,
                    agent_version: info.version,
                    protocol_version: response.protocol_version.as_u16(),
                })
            });
            connection.shutdown();
            handshake
        })
    }
}

/// Whether sessions are live, as the update path has to know before it moves the pointer.
///
/// A trait rather than a call into the agent registry (§3.4: the two registries stay apart): the
/// update path needs the answer to one question, and a caller that owns the sessions is the one
/// that has it.
pub trait SessionActivity {
    fn live_sessions(&self) -> usize;
}

/// Moves the pointer to a verified version, refusing while anything is running.
///
/// The candidate is moved rather than copied, so the download area does not keep an executable
/// second copy of a version, and the pointer is written last: a failure between the two leaves a
/// release on disk that nothing points at, which is a state the next attempt fixes.
pub fn promote(
    registry: &BinaryRegistry,
    verified: &Verified,
    activity: &dyn SessionActivity,
) -> Result<binary_registry::ActiveRelease, UpdateError> {
    if verified.checks != Check::ALL.to_vec() {
        return Err(UpdateError::NotVerified);
    }
    let live = activity.live_sessions();
    if live > 0 {
        return Err(UpdateError::SessionLive { sessions: live });
    }
    let program = registry.program_of(&verified.version);
    let directory = program.parent().unwrap_or(registry.root()).to_path_buf();
    fs::create_dir_all(&directory).map_err(|error| UpdateError::Io {
        path: directory.clone(),
        detail: error.to_string(),
    })?;
    fs::rename(&verified.program, &program).map_err(|error| UpdateError::Io {
        path: program.clone(),
        detail: error.to_string(),
    })?;
    Ok(registry.set_active(&verified.version)?)
}

/// What one version left in one profile.
///
/// The app's own record of it, not the engine's: an engine that migrates a store is the reason this
/// field exists, and the host learns it from the version that ran rather than from the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileState {
    pub profile_id: String,
    /// The profile's managed root (§3.2's `agent-profiles/<profile-id>/`).
    pub root: PathBuf,
    /// The version that last wrote this profile's state, as the app recorded it — including the
    /// version that was active when the app created the profile.
    ///
    /// `None` is not "nothing has written it": it is "this host has no record of what wrote it".
    /// [`rollback`] treats that as a migration it cannot rule out rather than as one it can, which
    /// is the difference between refusing a bare rollback and silently crossing a store format
    /// change. T12 owns writing this field.
    pub written_by: Option<String>,
}

/// A rollback, and the confirmations it needs.
///
/// `confirm_data_restore` is the user's answer to §3.3's rule (若新版本已迁移数据库，不得仅回退二进制):
/// without it, a rollback under migrated state — or under a profile no version record covers — is
/// refused rather than performed, because the binary is the easy half and the data is the half that
/// loses work.
#[derive(Debug, Clone)]
pub struct RollbackRequest<'a> {
    pub to_version: &'a str,
    pub profiles: &'a [ProfileState],
    /// A snapshot of `agent-profiles/` to restore from: the backup root, whose children are profile
    /// ids. `None` moves the pointer and retains the newer data without restoring anything.
    pub restore_from: Option<&'a Path>,
    /// §3.3: 必要时在进程停止后备份 profile. Nothing is copied or moved while an engine could be
    /// writing, so this is a statement by the caller rather than something this module can check.
    pub engine_stopped: bool,
    pub confirm_data_restore: bool,
}

/// What a rollback did, including what it could not do.
#[derive(Debug, Clone)]
pub struct RollbackReport {
    pub active: binary_registry::ActiveRelease,
    /// Where the newer data was kept, one directory per profile that had any.
    pub retained: Vec<PathBuf>,
    pub restored: bool,
    /// §3.3: 无法兼容时报告限制 — the profiles whose newer data was retained rather than reconciled,
    /// which is every profile a rollback crossed a migration on. This host copies the newer material
    /// and puts the backup back, and it never merges the two, because it does not know the engine's
    /// own store format; a session the newer version wrote is therefore somewhere the user can find
    /// it and not in the profile they are about to open. The sentence is the frontend's, as with
    /// every other report here.
    pub unreconciled: Vec<String>,
}

/// Returns to an older installed version, keeping what the newer one produced.
///
/// The order is the whole of §3.3's rollback rule, and it is deliberately the slow one: validate
/// everything, then retain, then restore, then move the pointer. Every refusal happens before the
/// first byte is copied, which is what makes 迁移失败不破坏旧 profile true rather than hopeful — a
/// rollback that cannot be completed leaves the profile exactly as it was.
pub fn rollback(
    registry: &BinaryRegistry,
    request: RollbackRequest<'_>,
) -> Result<RollbackReport, UpdateError> {
    if !request.engine_stopped {
        return Err(UpdateError::EngineRunning);
    }
    let program = registry.program_of(request.to_version);
    if !program.is_file() {
        return Err(UpdateError::VersionNotInstalled {
            version: request.to_version.to_string(),
            program,
        });
    }

    // Which profiles a newer version has written, and which ones no record covers.
    //
    // Comparing by the app's record rather than by the filesystem's timestamps, so a profile touched
    // by a *sync* does not read as migrated. The second list is the fail-closed half: while T12 has
    // not written a record yet, every profile is in it, and a rollback over a profile this host
    // cannot speak for is refused rather than assumed to be older than the version being returned
    // to. §3.3's rule is about a database a newer version rewrote; "we cannot tell" is not "it did
    // not happen", and the silent pass is the data-loss path the rule exists to prevent.
    let mut migrated: Vec<&ProfileState> = Vec::new();
    let mut unrecorded: Vec<&ProfileState> = Vec::new();
    for state in request.profiles {
        match state.written_by.as_deref() {
            None => unrecorded.push(state),
            Some(writer) if binary_registry::is_newer(writer, request.to_version) => {
                migrated.push(state)
            }
            Some(_) => {}
        }
    }
    if !request.confirm_data_restore {
        if !migrated.is_empty() {
            return Err(UpdateError::StateMigrated {
                profiles: migrated
                    .iter()
                    .map(|state| state.profile_id.clone())
                    .collect(),
            });
        }
        if !unrecorded.is_empty() {
            return Err(UpdateError::UnrecordedState {
                profiles: unrecorded
                    .iter()
                    .map(|state| state.profile_id.clone())
                    .collect(),
            });
        }
    }
    // Everything this rollback cannot vouch for: a profile a newer version wrote, and a profile no
    // record covers. Both are retained before anything is replaced, because "we cannot prove this
    // state is ours to drop" answers the retention question the same way it answers the refusal.
    let crossing: Vec<&ProfileState> = migrated
        .iter()
        .chain(unrecorded.iter())
        .copied()
        .collect();

    // Every backup is checked before any of them is used: a rollback that restores one profile and
    // then finds the next backup unreadable has already damaged the state it was recovering.
    let mut planned: Vec<(&ProfileState, PathBuf)> = Vec::new();
    if let Some(backup) = request.restore_from {
        for state in &crossing {
            let source = backup.join(&state.profile_id);
            if !binary_registry::is_restorable(&source) {
                return Err(UpdateError::BackupIncomplete {
                    profile_id: state.profile_id.clone(),
                    path: source,
                });
            }
            planned.push((state, source));
        }
    }

    // Retention, before anything is replaced: the newer data is what a rollback is most likely to
    // lose, and a failure to keep it stops the rollback instead of proceeding without it.
    let mut retained = Vec::new();
    for state in &crossing {
        let destination = registry.retained_path(&state.profile_id);
        binary_registry::retain_tree(&state.root, &destination).map_err(|detail| UpdateError::Unpreserved {
            profile_id: state.profile_id.clone(),
            path: destination.clone(),
            detail,
        })?;
        retained.push(destination);
    }

    let mut restored = false;
    for (state, source) in planned {
        binary_registry::restore_tree(&state.root, &source, &registry.recovery(&state.profile_id))
            .map_err(|detail| UpdateError::RestoreFailed {
                profile_id: state.profile_id.clone(),
                detail,
            },
        )?;
        restored = true;
    }

    // The pointer last: it is what a start resolves through, so it names the version whose profile
    // has been put back rather than the one being left.
    let active = registry.set_active(request.to_version)?;
    Ok(RollbackReport {
        active,
        retained,
        restored,
        unreconciled: crossing
            .iter()
            .map(|state| state.profile_id.clone())
            .collect(),
    })
}

/// Whether this installation may be replaced at all (§3.4.6, §3.3).
///
/// The policy is the registry's, by provenance — an external installation gets a version notice and
/// a user-initiated native entry point, and this is the half that refuses to act on anything else.
pub fn may_replace(source: InstallSource) -> Result<(), UpdateError> {
    match source.update_policy() {
        UpdatePolicy::HostManaged => Ok(()),
        UpdatePolicy::ReportedOnly => Err(UpdateError::NotUpdatable { source }),
    }
}
