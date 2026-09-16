//! R3 — recovery material: what can be put back, what must be refused, and what a refusal
//! proves.
//!
//! §7.2's recovery clause is 恢复前检查当前内容是否仍等于已记录结果；不一致则三方比较/人工合并，
//! 不能覆盖用户后续编辑, and the tests below are that sentence split into the moments it has to
//! hold at. Each refusal is asserted **together with the file it refused to touch**, because
//! "the call returned an error" and "the user's edit is still there" are two different facts
//! and only the second is the requirement.
//!
//! The clause the task is named for — 恢复拒绝新冲突, a recovery that refuses rather than
//! choosing a winner — is `a_recovery_is_checked_again_at_the_moment_of_the_write`: the plan is
//! made, the file moves, and the recovery is *still* refused. An implementation that trusted
//! its own earlier answer would pass every other test in this file.
//!
//! The write half goes through the app's REAL write path (`VaultFiles` implemented with
//! `nekowite_lib::storage::save_store::write_file`), for the same reason
//! `agent_fs_capability_test.rs` does: the property under test — that recovering a change keeps
//! the change in the note's history — is a property of that function, and a stub would prove
//! only that this file can call itself.
//!
//! Module inclusion: `agent_runtime/mod.rs` does not declare `recovery` — that registration is
//! the integrator's serialized change — so the tree is declared here by path, the convention
//! `agent_permission_ipc_test.rs`, `agent_registry_test.rs` and `desktop_pet_ipc_test.rs`
//! established. `fs_capability` is included beside it because `recovery.rs` reaches it through
//! `super::`, exactly as it does in the library.

#[path = "../src/agent_runtime"]
mod agent_runtime {
    // Included because `recovery.rs` names `ChangeRecord` and `VaultFiles` through `super::`, the
    // way it does in the library. This target reaches only that pair, so everything else the
    // module defines — the capability itself, its slice, its hashing — is reported as dead rather
    // than being dead.
    #[allow(dead_code)]
    pub mod fs_capability;
    // Included because `fs_capability`'s read arm names it through `super::`: what a read serves
    // and what it refuses to serve are one question now.
    #[allow(dead_code)]
    pub mod live_notes;
    pub mod recovery;
}

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};

use agent_runtime::fs_capability::{ChangeRecord, VaultFiles};
use agent_runtime::recovery::{Baseline, Recovery, RecoveryPlan, RecoveryRefusal};

/// The app's own file path, with no adapter of our own in between.
struct RealVault;

impl VaultFiles for RealVault {
    fn frontend_path(&self, vault_root: &str, path: &str) -> Result<String, String> {
        let (resolved, _relative) =
            nekowite_lib::domain::path_policy::resolve_within_rel(vault_root, path)?;
        Ok(nekowite_lib::domain::path_policy::ipc_path(&resolved))
    }
    fn read(&self, vault_root: &str, path: &str) -> Result<String, String> {
        nekowite_lib::storage::file_store::read_file(vault_root, path)
    }
    fn write(&self, vault_root: &str, path: &str, content: &str) -> Result<Option<String>, String> {
        nekowite_lib::storage::save_store::write_file(vault_root, path, content, None)
    }
}

/// A hash computed here, independently of both modules. It is what makes the two hashing
/// implementations' agreement a test result: if `recovery`'s and `fs_capability`'s ever drifted
/// apart, every comparison below would stop matching and say so.
fn sha256(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn temp_vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-recovery-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp vault");
    dir
}

/// One agent write, as the host records it after performing it: `fs_capability`'s own shape,
/// with the baseline hash `None` for a file that did not exist.
fn change(vault: &Path, path: &str, baseline: Option<&str>, result: &str) -> ChangeRecord {
    ChangeRecord {
        session_id: "ses_recovery_1".to_string(),
        vault_root: vault.to_string_lossy().into_owned(),
        path: path.to_string(),
        baseline_hash: baseline.map(sha256),
        result_hash: sha256(result),
        source: "agent",
        at: "2026-09-16T00:00:00Z".to_string(),
    }
}

fn recovery() -> Recovery {
    Recovery::new(Arc::new(RealVault))
}

/// The refusal a plan produced, or a panic naming the step it wrongly allowed.
fn refused(plan: RecoveryPlan) -> RecoveryRefusal {
    match plan {
        RecoveryPlan::Recoverable(step) => {
            panic!("expected a refusal, got a step for {}", step.baseline.path)
        }
        RecoveryPlan::Refused(refusal) => refusal,
    }
}

fn read(vault: &Path, path: &str) -> String {
    fs::read_to_string(vault.join(path)).expect("the file is there")
}

/// The history versions of a note, oldest first, read back through the app's own store.
fn history_texts(vault: &Path, path: &str) -> Vec<String> {
    let vault_root = vault.to_string_lossy().into_owned();
    let entries = nekowite_lib::storage::file_store::list_history(&vault_root, path)
        .expect("history listing");
    let mut texts: Vec<String> = entries
        .iter()
        .map(|entry| {
            nekowite_lib::storage::file_store::read_history(&vault_root, path, &entry.id)
                .expect("history content")
        })
        .collect();
    texts.sort();
    texts
}

// ---------------------------------------------------------------------------
// The recovery that is allowed
// ---------------------------------------------------------------------------

#[test]
fn a_change_the_host_can_put_back_rolls_the_file_back_and_keeps_the_version_it_replaced() {
    let vault = temp_vault("round-trip");
    fs::write(vault.join("note.md"), "before").expect("seed");
    let recovery = recovery();

    let baseline = recovery
        .baseline(&vault.to_string_lossy(), "note.md")
        .expect("baseline");
    assert_eq!(baseline.text, "before");
    assert_eq!(
        baseline.hash,
        sha256("before"),
        "the baseline's hash is the text's"
    );

    // What the agent left, and what the host recorded about the write it performed.
    fs::write(vault.join("note.md"), "after").expect("the agent's write");
    let written = change(&vault, "note.md", Some("before"), "after");

    match recovery.plan(&written) {
        RecoveryPlan::Recoverable(step) => assert_eq!(step.current_hash, sha256("after")),
        RecoveryPlan::Refused(refusal) => {
            panic!("expected a recoverable change, got {}", refusal.code())
        }
    }

    let outcome = recovery.recover(&written).expect("recovery");
    assert_eq!(outcome.vault_root, vault.to_string_lossy());
    assert_eq!(outcome.path, "note.md");
    assert_eq!(outcome.baseline_hash, sha256("before"));
    assert_eq!(outcome.replaced_hash, sha256("after"));
    assert!(
        outcome.warning.is_none(),
        "the history snapshot is the optional part of the save and it succeeded here: {:?}",
        outcome.warning
    );
    assert_eq!(read(&vault, "note.md"), "before");

    // The version the recovery replaced is in the note's history, which is what makes putting a
    // change back reversible in the other direction — the one property that keeps this from
    // being the review's destructive operation.
    assert!(
        history_texts(&vault, "note.md").contains(&"after".to_string()),
        "the agent's version must survive the recovery it was undone by"
    );
}

// ---------------------------------------------------------------------------
// The refusals: each is a different thing for the caller to do
// ---------------------------------------------------------------------------

#[test]
fn a_file_that_moved_since_the_change_is_refused_and_left_alone() {
    // §7.2's first check, and the acceptance clause: the user edited the note after the agent
    // did. Choosing a winner here is the failure, not the fix.
    let vault = temp_vault("moved");
    fs::write(vault.join("note.md"), "before").expect("seed");
    let recovery = recovery();
    recovery
        .baseline(&vault.to_string_lossy(), "note.md")
        .expect("baseline");

    fs::write(vault.join("note.md"), "after").expect("the agent's write");
    let written = change(&vault, "note.md", Some("before"), "after");
    fs::write(vault.join("note.md"), "mine, after the agent").expect("the user's edit");

    let refusal = refused(recovery.plan(&written));
    assert_eq!(refusal.code(), "changed-since-recorded");
    if let RecoveryRefusal::Changed {
        expected, found, ..
    } = &refusal
    {
        assert_eq!(expected, &sha256("after"));
        assert_eq!(found, &sha256("mine, after the agent"));
    }
    // Neither side was replaced: the user's text is still the file's.
    assert_eq!(read(&vault, "note.md"), "mine, after the agent");

    // …and the recovery call refuses for the same reason rather than racing past the plan.
    let error = recovery
        .recover(&written)
        .expect_err("recovery must refuse");
    assert_eq!(error.code(), "changed-since-recorded");
    assert_eq!(read(&vault, "note.md"), "mine, after the agent");
}

#[test]
fn a_recovery_is_checked_again_at_the_moment_of_the_write() {
    // The plan is an answer about a moment that has passed. This is the whole of the clause:
    // between the answer and the press, the file moves, and what was recoverable is not.
    let vault = temp_vault("recheck");
    fs::write(vault.join("note.md"), "before").expect("seed");
    let recovery = recovery();
    recovery
        .baseline(&vault.to_string_lossy(), "note.md")
        .expect("baseline");
    fs::write(vault.join("note.md"), "after").expect("the agent's write");
    let written = change(&vault, "note.md", Some("before"), "after");

    assert!(matches!(
        recovery.plan(&written),
        RecoveryPlan::Recoverable(_)
    ));
    fs::write(vault.join("note.md"), "typed in another window").expect("a later edit");

    let error = recovery
        .recover(&written)
        .expect_err("the stale plan must not be trusted");
    assert_eq!(error.code(), "changed-since-recorded");
    assert_eq!(read(&vault, "note.md"), "typed in another window");
    assert!(
        history_texts(&vault, "note.md").is_empty(),
        "a refused recovery must not spend a history version either"
    );
}

#[test]
fn a_change_with_no_baseline_is_marked_not_recoverable() {
    // §7.2: 「没有基线时标记不可直接恢复」. A creation is the ordinary way to arrive here — the
    // change says it replaced nothing — and a file the session touched without a baseline taken
    // is the other. Neither is guessed at.
    let vault = temp_vault("no-baseline");
    fs::write(vault.join("note.md"), "the agent made this").expect("the agent's write");
    let recovery = recovery();

    let created = change(&vault, "note.md", None, "the agent made this");
    let refusal = refused(recovery.plan(&created));
    assert_eq!(refusal.code(), "no-baseline");

    let error = recovery.recover(&created).expect_err("nothing to restore");
    assert_eq!(error.code(), "no-baseline");
    assert_eq!(read(&vault, "note.md"), "the agent made this");
}

#[test]
fn a_baseline_that_is_not_what_the_change_replaced_is_refused() {
    // §11.1's 保存与工具写入竞争: the user saved between the baseline being taken and the agent's
    // write, so the version the change replaced is the user's save — not the text this host
    // holds. Restoring the held text would undo an edit that was never part of the change.
    let vault = temp_vault("stale-baseline");
    let root = vault.to_string_lossy().into_owned();
    fs::write(vault.join("note.md"), "before").expect("seed");
    let recovery = recovery();
    recovery.baseline(&root, "note.md").expect("baseline");

    fs::write(vault.join("note.md"), "the user's save").expect("the user saved");
    fs::write(vault.join("note.md"), "after").expect("the agent's write");
    let written = change(&vault, "note.md", Some("the user's save"), "after");

    let refusal = refused(recovery.plan(&written));
    assert_eq!(refusal.code(), "baseline-stale");
    if let RecoveryRefusal::BaselineStale { held, recorded, .. } = &refusal {
        assert_eq!(held, &sha256("before"));
        assert_eq!(
            recorded.as_deref(),
            Some(sha256("the user's save").as_str())
        );
    }
    assert_eq!(read(&vault, "note.md"), "after");

    let error = recovery.recover(&written).expect_err("must refuse");
    assert_eq!(error.code(), "baseline-stale");
    assert_eq!(read(&vault, "note.md"), "after");
}

#[test]
fn a_file_that_cannot_be_read_is_refused_rather_than_recreated() {
    // Deleted or renamed arrives here, and the read cannot tell them apart — so neither is
    // claimed. §7.2 requires both to be shown explicitly, which is what this refusal is.
    let vault = temp_vault("missing");
    let root = vault.to_string_lossy().into_owned();
    fs::write(vault.join("note.md"), "before").expect("seed");
    let recovery = recovery();
    recovery.baseline(&root, "note.md").expect("baseline");
    fs::write(vault.join("note.md"), "after").expect("the agent's write");
    let written = change(&vault, "note.md", Some("before"), "after");

    fs::remove_file(vault.join("note.md")).expect("the user deleted it");

    let refusal = refused(recovery.plan(&written));
    assert_eq!(refusal.code(), "unavailable");
    let error = recovery.recover(&written).expect_err("must refuse");
    assert_eq!(error.code(), "unavailable");
    assert!(
        !vault.join("note.md").exists(),
        "a refusal must not put a file back that somebody removed"
    );
}

#[test]
fn a_file_already_at_its_baseline_is_not_written_again() {
    // A change whose result hash equals the baseline's is a write that changed nothing. There is
    // nothing to restore, and reporting a recovery would be the fabricated undo §7.2 forbids —
    // the file would look recovered and nothing would have happened.
    let vault = temp_vault("no-op");
    let root = vault.to_string_lossy().into_owned();
    fs::write(vault.join("note.md"), "same").expect("seed");
    let recovery = recovery();
    recovery.baseline(&root, "note.md").expect("baseline");
    let written = change(&vault, "note.md", Some("same"), "same");

    let error = recovery.recover(&written).expect_err("nothing to restore");
    assert_eq!(error.code(), "already-at-baseline");
    assert_eq!(read(&vault, "note.md"), "same");
    assert!(
        history_texts(&vault, "note.md").is_empty(),
        "a refused recovery must leave the note's history alone"
    );
}

#[test]
fn a_second_recovery_of_the_same_change_is_refused() {
    // The file now holds the baseline, so it is no longer the file the change left. Nothing
    // tracks "already recovered" as a flag: the check that refused the first stale press refuses
    // this one too, which is why there is no state here that can disagree with the disk.
    let vault = temp_vault("twice");
    let root = vault.to_string_lossy().into_owned();
    fs::write(vault.join("note.md"), "before").expect("seed");
    let recovery = recovery();
    recovery.baseline(&root, "note.md").expect("baseline");
    fs::write(vault.join("note.md"), "after").expect("the agent's write");
    let written = change(&vault, "note.md", Some("before"), "after");

    recovery.recover(&written).expect("the first recovery");
    let error = recovery
        .recover(&written)
        .expect_err("the second must be refused");
    assert_eq!(error.code(), "changed-since-recorded");
    assert_eq!(read(&vault, "note.md"), "before");
}

#[cfg(unix)]
#[test]
fn the_apps_own_write_path_refuses_a_read_only_destination_and_the_change_survives() {
    // The proof that the recovery goes through the app's write path rather than around it: the
    // app refuses a destination the user made read-only, and the file is left byte for byte.
    use std::os::unix::fs::PermissionsExt;

    let vault = temp_vault("read-only");
    let root = vault.to_string_lossy().into_owned();
    let note = vault.join("note.md");
    fs::write(&note, "before").expect("seed");
    let recovery = recovery();
    recovery.baseline(&root, "note.md").expect("baseline");
    fs::write(&note, "after").expect("the agent's write");
    let written = change(&vault, "note.md", Some("before"), "after");

    fs::set_permissions(&note, fs::Permissions::from_mode(0o444)).expect("make it read-only");

    let error = recovery
        .recover(&written)
        .expect_err("the app's path refuses this");
    assert_eq!(error.code(), "write-refused");
    assert_eq!(read(&vault, "note.md"), "after");

    fs::set_permissions(&note, fs::Permissions::from_mode(0o644)).expect("restore the mode");
}

// ---------------------------------------------------------------------------
// The baselines themselves: one per file, per vault, and bounded
// ---------------------------------------------------------------------------

#[test]
fn a_second_baseline_for_one_path_replaces_the_first() {
    // Two entries for one note would make a recovery depend on which one the lookup found. The
    // newer text is the one any change is about to sit on.
    let vault = temp_vault("replace");
    let root = vault.to_string_lossy().into_owned();
    fs::write(vault.join("note.md"), "first").expect("seed");
    let recovery = recovery();
    recovery.baseline(&root, "note.md").expect("first baseline");
    fs::write(vault.join("note.md"), "second").expect("the user edited");
    recovery
        .baseline(&root, "note.md")
        .expect("second baseline");

    // The change on the second baseline is recoverable, which it would not be if the first were
    // still the one being compared against.
    fs::write(vault.join("note.md"), "third").expect("the agent's write");
    let written = change(&vault, "note.md", Some("second"), "third");
    let outcome = recovery
        .recover(&written)
        .expect("the newer baseline is the one used");
    assert_eq!(outcome.baseline_hash, sha256("second"));
}

#[test]
fn a_baseline_in_one_vault_is_never_used_for_a_change_in_another() {
    // The same relative path in two vaults is two files. A lookup by path alone would restore
    // one vault's text into the other.
    let vault_a = temp_vault("vault-a");
    let vault_b = temp_vault("vault-b");
    fs::write(vault_a.join("note.md"), "a").expect("seed a");
    fs::write(vault_b.join("note.md"), "b").expect("seed b");
    let recovery = recovery();
    recovery
        .baseline(&vault_a.to_string_lossy(), "note.md")
        .expect("baseline in a");

    fs::write(vault_b.join("note.md"), "b'").expect("the agent wrote in b");
    let in_b = change(&vault_b, "note.md", Some("b"), "b'");

    assert_eq!(refused(recovery.plan(&in_b)).code(), "no-baseline");
    assert_eq!(read(&vault_b, "note.md"), "b'");
    assert_eq!(read(&vault_a, "note.md"), "a");
}

#[test]
fn baselines_are_bounded_and_the_oldest_is_the_one_dropped() {
    // Bounded material: the oldest baseline is dropped when the list overflows, and a change
    // against it is then refused rather than recovered from memory that was never released.
    let vault = temp_vault("bounded");
    let root = vault.to_string_lossy().into_owned();
    let recovery = recovery();
    let count = 80;

    for index in 0..count {
        let path = format!("note-{index}.md");
        fs::write(vault.join(&path), format!("text {index}")).expect("seed");
        recovery.baseline(&root, &path).expect("baseline");
    }

    let oldest = change(&vault, "note-0.md", Some("text 0"), "text 0");
    assert_eq!(refused(recovery.plan(&oldest)).code(), "no-baseline");

    // …and the newest is still held, so what was dropped is the far end of the list rather than
    // the whole of it.
    fs::write(vault.join("note-79.md"), "written").expect("the agent's write");
    let newest = change(&vault, "note-79.md", Some("text 79"), "written");
    assert!(matches!(
        recovery.plan(&newest),
        RecoveryPlan::Recoverable(_)
    ));
}

/// The baseline a caller gets back is the material, not a label: the text is what a recovery
/// writes, and a host that returned hashes alone could not perform one at all.
#[test]
fn a_baseline_carries_the_text_it_hashes() {
    let vault = temp_vault("material");
    fs::write(vault.join("note.md"), "the whole note\nsecond line\n").expect("seed");

    let baseline: Baseline = recovery()
        .baseline(&vault.to_string_lossy(), "note.md")
        .expect("baseline");

    assert_eq!(baseline.path, "note.md");
    assert_eq!(baseline.text, "the whole note\nsecond line\n");
    assert_eq!(baseline.hash, sha256(&baseline.text));
}
