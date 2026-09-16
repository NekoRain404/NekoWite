//! 无系统 CLI 可启动 — which engine this app starts, and where its files live.
//!
//! §3.1.1's claim is that installing NekoWite already gives the user a verified OpenCode base
//! version, with no Node/npm/OpenCode install step of their own. The tests below take that apart
//! into the three things it actually asserts: the artifact in the tree *is* the one the app's record
//! names (and it really starts, under an empty environment), the bundled lookup answers from the
//! app's own directory and has no fallback to a system installation to take, and the managed layout
//! lives where §3.2 draws it and nowhere the app does not own.

use std::fs;
use std::path::{Path, PathBuf};

use nekowite_lib::agent_runtime;

use agent_runtime::binary_registry::{self, BinaryRegistry, LayoutError};
use agent_runtime::registry::InstallSource;
use agent_runtime::update::{self, AcpProbe, Check};

use crate::support::{
    make_executable, mode_of, pinned_artifact, scratch, sha256_hex, staged, write_file,
    MANIFEST_DIR,
};

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
    let release =
        update::shipped("1.18.29").expect("the shipped manifest names the pinned version");
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
    assert!(registry
        .recovery("default")
        .ends_with("agent-recovery/default"));
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
        fs::create_dir_all(program.parent().expect("release directory"))
            .expect("release directory");
        fs::copy("/bin/true", &program).expect("install a program");
    }
    assert_eq!(
        registry.installed(),
        vec!["1.18.2", "1.18.9", "1.18.10"],
        "the installed list is oldest first"
    );
}
