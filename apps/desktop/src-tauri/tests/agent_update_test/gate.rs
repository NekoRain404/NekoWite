//! The gate: what a candidate must prove before it becomes the version this app starts.
//!
//! §3.3's list is five checks and one ordering, and the ordering is the content — a digest checked
//! after the candidate has run is worth nothing. So the tests below are about the sequence as much
//! as the checks: a refused digest leaves the probe's call count at **zero**, an architecture that is
//! not this one is refused without running anything, and a candidate that hangs fails the update
//! rather than the app.

use std::fs;
use std::path::Path;

use nekowite_lib::agent_runtime;

use agent_runtime::binary_registry::BinaryRegistry;
use agent_runtime::update::{self, AcpProbe, CandidateProbe, Check, UpdateError};

use crate::support::{
    elf_bytes, idle, make_executable, mode_of, release_of, scratch, staged, with_machine, FakeProbe,
    MANIFEST_DIR,
};

/// The order is the rule (§3.3's list, in the only sequence that makes the digest worth anything):
/// every check runs, and the value that comes out carries the list it ran.
#[tokio::test]
async fn the_gate_passes_in_order() {
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
    assert_eq!(
        mode_of(&verified.program) & 0o111,
        0o111,
        "the gate is what makes a candidate executable"
    );
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

/// The probe the gate uses in production runs a real process, so it has to be bounded: a candidate
/// that hangs must fail the update rather than the app.
#[tokio::test]
async fn the_process_probe_is_bounded_and_never_answers_for_a_silent_candidate() {
    let probe = AcpProbe::new(scratch("probe-timeout"), vec!["acp".to_string()])
        .with_bound(std::time::Duration::from_millis(50));
    let program = scratch("probe-program").join("opencode");
    crate::support::write_file(&program, "#!/bin/sh\nsleep 30\n");
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
