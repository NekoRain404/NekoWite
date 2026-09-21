//! The start path's own half: which program a launch resolves, before any engine is started.
//!
//! §3.1.1's two places, in the order §3.3 defines — and no search of `PATH`, because the engine
//! this app runs is the one it ships or installed itself.

use std::fs;
use std::path::Path;

use nekowite_lib::agent_runtime::binary_registry::BinaryRegistry;
use nekowite_lib::state;

use crate::support::{rooted, temp_dir};

#[test]
fn the_program_a_start_launches_is_the_promoted_release_or_the_sidecar() {
    // §3.1.1's two places, in the order §3.3 defines: a promoted release when the pointer names a
    // launchable one, and otherwise the engine shipped beside the executable. Nothing is searched
    // for on `PATH`, because the engine this app runs is the one it ships or installed itself.
    let managed = temp_dir("program-managed");
    let beside = temp_dir("program-beside");

    let refusal = state::program_to_launch(&managed, &beside).expect_err("no engine anywhere");
    assert!(
        refusal.contains(&rooted(&beside)),
        "the refusal names the directory it looked in: {refusal}"
    );

    let sidecar = beside.join("opencode");
    make_executable(&sidecar, "#!/bin/sh\nexit 0\n");
    assert_eq!(
        state::program_to_launch(&managed, &beside).expect("the sidecar is launchable"),
        sidecar
    );

    // A promoted release wins: it is the version this app installed and verified itself.
    let layout = BinaryRegistry::new(&managed).expect("the managed layout");
    let promoted = layout.program_of("1.2.3");
    fs::create_dir_all(promoted.parent().expect("a release directory")).expect("releases");
    make_executable(&promoted, "#!/bin/sh\nexit 0\n");
    layout.set_active("1.2.3").expect("the pointer moves to it");
    assert_eq!(
        state::program_to_launch(&managed, &beside).expect("the promoted release"),
        promoted
    );
}

fn make_executable(path: &Path, content: &str) {
    fs::write(path, content).expect("the file");
    let mut mode = fs::metadata(path).expect("metadata").permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o755);
    fs::set_permissions(path, mode).expect("an executable file");
}
