//! One of `update.rs`'s children: the proof a candidate must produce.
//!
//! Split out of `update.rs` when it passed §13.1's 600-line default. The seam is "changes when what
//! counts as proof changes" — the order of the gate, and the two ways a candidate is asked to prove
//! itself. What a candidate *says* is `claims.rs`'s vocabulary; what a refusal is called is
//! `error.rs`'s.

use super::super::binary_registry;
use super::super::session::INITIALIZE_BOUND;
use super::super::{env_pairs, isolated_profile_env, EngineConnection, EngineLaunch};
use super::claims::{Artifact, Check, Handshake, Verified};
use super::error::UpdateError;
use super::manifest::{PinnedRelease, VERSION_BOUND};
use futures_util::future::BoxFuture;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

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
    let reported_version =
        probe
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
                Ok(Ok(output)) if !output.status.success() => {
                    Err(format!("--version exited with {}", output.status))
                }
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
            let handshake =
                response
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
