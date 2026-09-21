//! The real engine: the handshake against the artifact the app ships, skipped — loudly — when the
//! pipeline product is absent, as it is in a plain checkout (P0 §1).

use std::path::Path;

use nekowite_lib::agent_runtime::{env_pairs, isolated_profile_env, EngineLaunch};

use crate::support::{start, temp_dir};

// ---------------------------------------------------------------------------
// The real engine
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_real_engine_negotiates_protocol_version_one() {
    // The artifact is a pipeline product and gitignored (P0 §1), so a checkout
    // without it is normal — that is a skip, not a failure. Run
    // `scripts/fetch-opencode-linux.sh` to make this test mean something.
    let binary =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/opencode-x86_64-unknown-linux-gnu");
    if !binary.is_file() {
        eprintln!(
            "SKIP: {} is absent; run scripts/fetch-opencode-linux.sh",
            binary.display()
        );
        return;
    }

    // Its own HOME and XDG roots: plan §10.4 forbids exercising the developer's
    // real OpenCode profile, and the engine writes config and state under those
    // roots as soon as it starts.
    let profile = temp_dir("real-profile");
    let launch = EngineLaunch {
        program: binary,
        args: vec!["acp".to_string()],
        env: env_pairs(isolated_profile_env(&profile)),
        ca_bundle: None,
    };
    let (runtime, _events) = start(&launch).await;

    // Nothing past the handshake: `initialize` costs nothing and needs no
    // credentials, so this stays a test and not a bill.
    let response = runtime
        .initialize()
        .await
        .expect("the real engine initializes");

    assert_eq!(response.protocol_version.as_u16(), 1);
    let info = response.agent_info.expect("agentInfo");
    assert_eq!(info.name, "OpenCode");
    // Not pinned to 1.18.29: the artifact is updated by its own task (T14), and
    // a test that failed on an engine upgrade would be reporting the version
    // bump rather than a broken handshake.
    assert!(
        info.version.starts_with(char::is_numeric),
        "agentInfo.version should look like a version, got {:?}",
        info.version
    );
    runtime.shutdown();
}
