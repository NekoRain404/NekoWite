//! The trust chain, and its first link: the record a download has to match.
//!
//! §3.3's sharpest rule is a refusal to believe something: 不能从同一不可信响应同时获取二进制和摘要便声称
//! 可信. A response that carries its own digest proves only that the response is self-consistent, so
//! what these tests hold down is that **no decision reads what the artifact says about itself** —
//! the digest that counts is the one compiled into the app, and a version that record does not name
//! has nothing to be verified against.

use nekowite_lib::agent_runtime;

use agent_runtime::binary_registry::{self, BinaryRegistry};
use agent_runtime::update::{self, ArtifactClaims, PinnedRelease, UpdateError};

use crate::support::{
    elf_bytes, mode_of, release_of, scratch, sha256_hex, staged, with_machine, FakeProbe,
};

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
    let agreeable = staged(
        &registry,
        "9.9.9",
        &bytes,
        claim(release.sha256().to_string()),
    );
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

/// The pinned record and the shipped manifest are one fact in several places; this is where the
/// shipped one is held down, and where the packaging script's expectations are stated.
///
/// The channel decision §5.6 requires is visible in the record itself: the provenance names npm's
/// platform package, and the digest is the sha256 of the program it contains — not the ACP
/// registry's GitHub artifact for a different version, whose digest could never check this one.
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
        pinned.source().contains("opencode-linux-x64"),
        "the record must name the channel the artifact came through: {}",
        pinned.source()
    );
    assert_eq!(update::shipped_versions(), vec!["1.18.29"]);
    // §3.3: 第三方许可证和分发义务进入发布清单 — the record carries the licence, and the packaging
    // script reads it from there instead of keeping a second list.
    assert_eq!(pinned.licence(), "MIT");
}
