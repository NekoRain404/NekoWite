//! Closing, hiding, and what a teardown may not reach (§7.1 and §4).
//!
//! 「关闭/重开无泄漏」 is the acceptance this domain is built around, and "no leak" is not something
//! a window looks like: it is what is left in the registry and in the window system after a
//! hundred operations. So the cycles are counted, the report is read, and the module's own source
//! is read as well — because the third claim here, that tearing the pet down touches no agent run,
//! no note and no character, cannot be observed from outside at all. A mock would answer whatever
//! it was written to answer; what is checkable is that this code has no way to reach them.

use std::fs;
use std::path::Path;

use crate::desktop_pet::window_host::{HostRefusal, TeardownReport, WindowAction};
use crate::support::{caller, with_host};

#[test]
fn fifty_open_and_close_cycles_leave_nothing_behind() {
    let (mut host, surfaces) = with_host();
    let mut labels = Vec::new();

    for _ in 0..50 {
        let instance = host.open("cat").expect("opens");
        labels.push(instance.label.as_str().to_string());
        host.close_own(&caller(instance.label.as_str()))
            .expect("closes");
    }

    assert!(host.instances().is_empty(), "the registry kept something");
    assert!(surfaces.live().is_empty(), "a window outlived its close");
    assert_eq!(surfaces.state().closed.len(), 50);

    let mut unique = labels.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), labels.len(), "a label was reused");
}

#[test]
fn disabling_closes_every_window_and_reports_them() {
    let (mut host, surfaces) = with_host();
    let one = host.open("one").expect("opens");
    let two = host.open("two").expect("opens");

    let TeardownReport { closed, failed } = host.disable();

    assert!(failed.is_empty(), "{failed:?}");
    assert_eq!(closed.len(), 2);
    assert_eq!(closed[0].label, one.label);
    assert_eq!(closed[1].label, two.label);
    assert!(host.instances().is_empty());
    assert!(surfaces.live().is_empty());
}

#[test]
fn a_window_that_will_not_close_stays_in_the_registry_instead_of_leaking() {
    let (mut host, surfaces) = with_host();
    let stubborn = host.open("one").expect("opens");
    host.open("two").expect("opens");
    surfaces
        .state()
        .refuse_close
        .push(stubborn.label.as_str().to_string());

    let report = host.disable();

    assert_eq!(report.closed.len(), 1);
    assert_eq!(
        report.failed,
        [HostRefusal::Window {
            action: WindowAction::Close,
            detail: "the compositor declined".to_string(),
        }]
    );
    // Forgetting a window that is still open would leak the very thing this call exists to clean
    // up, so it stays and the next teardown retries.
    assert_eq!(host.instances(), [stubborn]);
}

#[test]
fn hide_keeps_the_windows_and_the_registry_and_show_brings_them_back() {
    let (mut host, surfaces) = with_host();
    let instance = host.open("cat").expect("opens");

    host.set_visible(false).expect("hides");
    assert!(!host.is_visible());
    // Hide is not disable: §7.1 stops the drawing and keeps the backend reminder, and a teardown
    // here would turn "not now" into "never" — with the way back being a settings page the user
    // would have to find.
    assert_eq!(host.instances(), [instance.clone()]);
    assert_eq!(surfaces.live(), vec![instance.label.as_str().to_string()]);
    assert_eq!(
        surfaces.state().hidden.get(instance.label.as_str()),
        Some(&true)
    );

    host.set_visible(true).expect("shows");
    assert!(host.is_visible());
    assert_eq!(
        surfaces.state().hidden.get(instance.label.as_str()),
        Some(&false)
    );
    assert_eq!(host.instances(), [instance]);
}

#[test]
fn the_teardown_report_cannot_describe_an_erasure() {
    let (mut host, _) = with_host();
    host.open("one").expect("opens");
    let report = host.disable();

    // Serialised, so this is what a caller can actually see: two fields, both of them windows.
    // A teardown that learned to delete a character, cancel a run or reset a ledger would have to
    // add a field here, and this assertion is where that shows up.
    let json = serde_json::to_value(&report).expect("the report serialises");
    let object = json.as_object().expect("an object");
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, ["closed", "failed"]);
    assert_eq!(
        object["closed"][0].as_object().map(|entry| {
            let mut keys: Vec<&str> = entry.keys().map(String::as_str).collect();
            keys.sort();
            keys
        }),
        Some(vec!["characterId", "label"])
    );
}

#[test]
fn the_module_has_no_path_to_an_agent_a_note_or_the_vault() {
    // §7.1's isolation and §4's 「关闭不影响 Agent 工作、笔记保存与原设置页」, expressed where a later
    // edit would break it. A window host that could name any of these could reach them from a
    // teardown; this one cannot name them at all, and the fields of `TeardownReport` are the second
    // half of the same statement.
    const FORBIDDEN: [&str; 7] = [
        "agent_runtime",
        "crate::storage",
        "crate::state",
        "VaultRegistry",
        "remove_file",
        "remove_dir_all",
        "fs::",
    ];

    for file in ["mod.rs", "window_host.rs", "linux_capabilities.rs"] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/desktop_pet")
            .join(file);
        let text = fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"));
        for token in FORBIDDEN {
            assert!(
                !text.contains(token),
                "{file} names {token}; the pet's backend must not be able to reach it"
            );
        }
    }
}
