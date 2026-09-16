//! Switching versions — forward through `promote`, back through `rollback` — and what neither
//! direction may discard.
//!
//! §3.3's rollback rules are about data loss, so each test names the failure it prevents:
//! 活跃会话期间不热替换进程 (the pointer does not move under a live engine), 若新版本已迁移数据库，不得仅
//! 回退二进制 (a profile a newer version wrote is refused rather than crossed), 迁移失败不破坏旧 profile
//! (a rollback that cannot complete changes nothing), and 回退不得默默丢弃升级后产生的会话 (the newer
//! data is retained before anything is put back, and the report says what was not reconciled).
//!
//! The unwritten-record case is the fail-closed half of the second rule: while T12 has not recorded
//! which version wrote a profile, every profile is refused the same way rather than assumed to be
//! older than the version being returned to.

use std::fs;
use std::path::PathBuf;

use nekowite_lib::agent_runtime;

use agent_runtime::binary_registry::{self, BinaryRegistry};
use agent_runtime::registry::{InstallSource, UpdatePolicy};
use agent_runtime::update::{self, ProfileState, RollbackRequest, UpdateError};

use crate::support::{
    elf_bytes, idle, mode_of, release_of, scratch, staged, tree, write_file, FakeProbe, Sessions,
};

/// The pointer is §3.2's `active.json`, and promotion is the only thing that moves it — the candidate
/// is moved rather than copied, so the download area does not keep an executable second copy.
#[tokio::test]
async fn the_pointer_moves_only_after_the_gate_has_passed() {
    let registry = BinaryRegistry::new(scratch("promote")).expect("managed root");
    let bytes = elf_bytes();
    let release = release_of("9.9.9", &bytes);
    let artifact = staged(&registry, "9.9.9", &bytes, None);
    let verified = update::verify(&release, &artifact, &FakeProbe::answering("9.9.9"))
        .await
        .expect("verified");

    let active = update::promote(&registry, &verified, &idle()).expect("promote");
    assert_eq!(active.version, "9.9.9");
    assert_eq!(active.target, binary_registry::supported_target());

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

    match update::promote(&registry, &verified, &Sessions::live(1)) {
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

/// The world a rollback happens in: two installed versions, a profile, and a record of which version
/// last wrote it.
struct RollbackScene {
    registry: BinaryRegistry,
    profile: PathBuf,
    states: Vec<ProfileState>,
}

impl RollbackScene {
    /// `written_by` is the version the app's own record names for the profile's state — `None` for a
    /// profile no record covers, which is the case [`rollback`](update::rollback) refuses.
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

    fn rollback(
        &self,
        to_version: &str,
        restore_from: Option<&std::path::Path>,
        engine_stopped: bool,
        confirm_data_restore: bool,
    ) -> Result<update::RollbackReport, UpdateError> {
        update::rollback(
            &self.registry,
            RollbackRequest {
                to_version,
                profiles: &self.states,
                restore_from,
                engine_stopped,
                confirm_data_restore,
            },
        )
    }
}

/// 若新版本已迁移数据库，不得仅回退二进制 (§3.3). The refusal is the point: moving the pointer back
/// under a migrated profile would hand an older engine a store a newer one rewrote.
#[test]
fn a_bare_binary_rollback_is_refused_once_the_newer_version_wrote_the_profile() {
    let scene = RollbackScene::new("migrated", "9.9.9", "9.9.10", Some("9.9.10"));
    let before = tree(&scene.profile);

    match scene.rollback("9.9.9", None, true, false) {
        Err(UpdateError::StateMigrated { profiles }) => assert_eq!(profiles, vec!["default"]),
        other => panic!("expected a migration refusal, got {other:?}"),
    }

    assert_eq!(scene.active_version(), "9.9.9");
    assert_eq!(
        tree(&scene.profile),
        before,
        "a refused rollback touched the profile"
    );
    assert!(
        !scene.registry.recovery("default").exists(),
        "a refused rollback must not leave a recovery directory behind"
    );
}

/// The fail-closed half, and the one that matters while the record is unwritten: a profile no record
/// covers is a profile whose store this host cannot vouch for, so the bare rollback is refused rather
/// than allowed to cross a migration nobody can see.
///
/// T12 owns writing `written_by`. Until it does, every profile is in this state and this refusal is
/// what stands between a rollback and a silently crossed store format.
#[test]
fn an_unrecorded_profile_refuses_a_bare_rollback() {
    let scene = RollbackScene::new("unrecorded", "9.9.9", "9.9.10", None);
    let before = tree(&scene.profile);

    match scene.rollback("9.9.9", None, true, false) {
        Err(UpdateError::UnrecordedState { profiles }) => assert_eq!(profiles, vec!["default"]),
        other => panic!("expected an unrecorded-state refusal, got {other:?}"),
    }

    assert_eq!(scene.active_version(), "9.9.9");
    assert_eq!(tree(&scene.profile), before);
    assert!(!scene.registry.recovery("default").exists());
}

/// A record that names the version being returned to is *not* refused, and nothing is retained for
/// it: the field is what makes the refusal precise rather than a blanket "rollbacks need a
/// confirmation". This is the shape T12's records turn every profile into.
#[test]
fn a_recorded_older_writer_needs_no_confirmation() {
    let scene = RollbackScene::new("recorded", "9.9.9", "9.9.10", Some("9.9.9"));
    let before = tree(&scene.profile);

    let report = scene
        .rollback("9.9.9", None, true, false)
        .expect("a rollback the record says is safe");

    assert_eq!(report.active.version, "9.9.9");
    assert!(report.retained.is_empty(), "nothing crossed a migration");
    assert!(report.unreconciled.is_empty());
    assert_eq!(
        tree(&scene.profile),
        before,
        "nothing was restored, so the profile is untouched"
    );
}

/// With the confirmation, the unknown case proceeds *and* is treated like a migration for the one
/// thing that matters: the newer data is copied out before anything could replace it, because "we
/// cannot prove this state is ours to drop" answers the retention question too.
#[test]
fn a_confirmed_rollback_of_an_unrecorded_profile_still_retains() {
    let scene = RollbackScene::new("unrecorded-confirmed", "9.9.9", "9.9.10", None);
    let before = tree(&scene.profile);

    let report = scene
        .rollback("9.9.9", None, true, true)
        .expect("a confirmed rollback");

    assert_eq!(report.active.version, "9.9.9");
    assert_eq!(report.unreconciled, vec!["default"]);
    let retained = report.retained.first().expect("a retained copy");
    assert_eq!(tree(retained), before);
    assert!(scene.registry.installed().contains(&"9.9.10".to_string()));
}

/// A rollback that is not restoring still must not discard what the upgrade produced (§3.3): the
/// newer session stays, in the profile and in a retained copy, and the report says the two were not
/// reconciled.
#[test]
fn a_rollback_keeps_the_newer_data_even_when_nothing_is_restored() {
    let scene = RollbackScene::new("retain-only", "9.9.9", "9.9.10", Some("9.9.10"));
    let before = tree(&scene.profile);

    let report = scene
        .rollback("9.9.9", None, true, true)
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
        match scene.rollback("9.9.9", Some(&backup), true, true) {
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

    let report = scene
        .rollback("9.9.9", Some(&backup), true, true)
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

/// Moving the pointer while an engine is running is the same hot-swap the update path refuses —
/// checked before anything else, so a rollback asked for at the wrong moment costs nothing.
#[test]
fn a_rollback_is_refused_while_the_engine_is_running() {
    let scene = RollbackScene::new("rollback-live", "9.9.9", "9.9.10", None);
    let before = tree(&scene.profile);

    match scene.rollback("9.9.9", None, false, true) {
        Err(UpdateError::EngineRunning) => {}
        other => panic!("expected a running-engine refusal, got {other:?}"),
    }
    assert_eq!(tree(&scene.profile), before);
    assert_eq!(scene.active_version(), "9.9.9");
}

/// §3.3's other version rule: 不兼容版本保持旧版本可用. A version that is not installed cannot be
/// returned to, and the refusal says which version and where it should have been.
#[test]
fn a_rollback_to_a_version_that_is_not_installed_is_refused() {
    let scene = RollbackScene::new("not-installed", "9.9.9", "9.9.10", Some("9.9.9"));

    match scene.rollback("9.9.8", None, true, true) {
        Err(UpdateError::VersionNotInstalled { version, program }) => {
            assert_eq!(version, "9.9.8");
            assert_eq!(program, scene.registry.program_of("9.9.8"));
        }
        other => panic!("expected a not-installed refusal, got {other:?}"),
    }
    assert_eq!(scene.active_version(), "9.9.9");
}
