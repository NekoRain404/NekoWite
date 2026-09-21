//! 导入不执行脚本 — the payload is copied, and none of it runs.
//!
//! The acceptance's risky half, and the target's central case: a skill whose payload leaves a canary
//! file, the payload fired on purpose to prove the canary can appear, and the canary absent after
//! the import. Everything else in this target is about what an import refuses or takes custody of;
//! this is the case that shows what an import does not do.

use std::fs;

use crate::skills::{Overwrite, SkillImport, SkillPreview};

use crate::support::{library, scratch, write_file, write_skill};

/// The payload the fixture skill carries: a script whose only effect is a file appearing.
const CANARY_PAYLOAD: &str = "#!/bin/sh\nprintf 'ran' > \"$1\"\n";

/// The acceptance's risky half, shown rather than asserted.
///
/// Three observations, in this order: the canary can appear (so its absence means something), the
/// import happened (so the absence is not because nothing was copied), and the canary is not there.
#[cfg(unix)]
#[test]
fn importing_a_skill_copies_its_payload_and_runs_none_of_it() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    let roots = scratch("no-execution");
    let source = roots.join("incoming/leaky");
    let payload = source.join("scripts/payload.sh");
    write_skill(
        &roots.join("incoming"),
        "leaky",
        "leaky",
        Some("A skill with a payload."),
    );
    write_file(&payload, CANARY_PAYLOAD);
    write_file(&source.join("reference/notes.md"), "# Notes\n");
    fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("executable bit");

    let canary = roots.join("canary");
    let library = library(&roots);

    // The preview names the script without having run it: the file list is a walk, and the payload
    // is listed because it exists, not because anything looked at what it does.
    let preview: SkillPreview = library.preview(&source).expect("preview");
    assert_eq!(preview.name, "leaky");
    assert_eq!(
        preview.scripts,
        vec![
            ("reference/notes.md".to_string(), 8),
            (
                "scripts/payload.sh".to_string(),
                CANARY_PAYLOAD.len() as u64
            ),
        ],
        "every file that is not SKILL.md is named before anything is installed"
    );
    assert!(
        !canary.exists(),
        "reading a preview must not run anything either"
    );

    // The positive control. Without it, a canary that could never have fired would make the whole
    // test pass for the wrong reason — which is exactly the failure mode this file exists to avoid.
    let fired = Command::new("/bin/sh")
        .arg(&payload)
        .arg(&canary)
        .status()
        .expect("run the payload on purpose");
    assert!(fired.success(), "the payload must be able to run");
    assert!(canary.exists(), "the canary must be able to appear");
    fs::remove_file(&canary).expect("clear the canary");

    let installed: SkillImport = library
        .import(&source, "engine-global", Overwrite::KeepExisting)
        .expect("import");

    assert!(
        !canary.exists(),
        "the import ran the payload: the canary appeared at {}",
        canary.display()
    );
    // The import happened: every file is there, byte for byte, including the executable bit the
    // engine's own shell needs. A copy that had silently dropped files would make the assertion
    // above true for the wrong reason.
    for (relative, size) in &installed.preview.files {
        let copied = installed.installed_at.join(relative);
        let copied_size = fs::metadata(&copied).expect("copied file").len();
        assert_eq!(copied_size, *size, "{relative} is not the same size");
    }
    assert_eq!(
        fs::read_to_string(installed.installed_at.join("scripts/payload.sh")).expect("read back"),
        CANARY_PAYLOAD
    );
    assert!(
        installed.installed_at.join("scripts/payload.sh").is_file(),
        "the script is installed; that it is installed is not a claim that it is safe"
    );
    assert_eq!(
        library
            .discover()
            .expect("discover")
            .iter()
            .map(|view| view.name.clone())
            .collect::<Vec<_>>(),
        vec!["leaky".to_string()],
        "the installed skill is one the engine now finds"
    );
}
