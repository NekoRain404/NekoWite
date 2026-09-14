//! Deleting the same path twice inside one millisecond.
//!
//! `delete_file` moves the file to `<trash>/<encoded key>`, and appends a
//! `-<epoch ms>` stamp when that key is already taken. The stamp was probed
//! ONCE, while the sibling `move_trash_key` bumps in a loop for exactly this
//! hazard: `fs::rename` REPLACES an existing destination on unix, so a second
//! delete that computes the same stamped name destroys the copy already sitting
//! there — and reports success to both callers.
//!
//! The collision needs two deletes in the same millisecond, which is a coin
//! flip on a coarse clock, so each round deletes three times: the first takes
//! the plain key, and the second and third are the pair that must not collide.
//! Twenty rounds make a lost copy the only way to pass.

use std::path::{Path, PathBuf};

use nekowite_lib::storage::trash_store::delete_file;

fn temp_vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekowite-test-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Every body the trash currently holds, sorted.
fn trashed_bodies(vault: &Path) -> Vec<String> {
    let dir = vault.join(".nekowite-trash");
    let mut bodies: Vec<String> = std::fs::read_dir(&dir)
        .expect("the trash directory exists")
        .map(|entry| {
            std::fs::read_to_string(entry.expect("a readable entry").path())
                .expect("a readable trashed file")
        })
        .collect();
    bodies.sort();
    bodies
}

#[test]
fn deletes_in_the_same_millisecond_keep_every_copy() {
    let vault = temp_vault("trash-same-ms");
    let root = vault.to_str().unwrap().to_string();
    let trashed = vault.join(".nekowite-trash");

    for round in 0..20u32 {
        let mut keys = Vec::new();
        for copy in 0..3u32 {
            let body = format!("copy-{round}-{copy}");
            std::fs::write(vault.join("a.md"), &body).unwrap();
            keys.push(delete_file(&root, "a.md").unwrap());
        }

        assert_ne!(
            keys[0], keys[1],
            "round {round}: the second delete overlapped the first"
        );
        assert_ne!(
            keys[1], keys[2],
            "round {round}: two deletes computed the same trash key — the second rename replaced \
             the copy the first had just moved in"
        );

        let bodies = trashed_bodies(&vault);
        let mut expected = vec![
            format!("copy-{round}-0"),
            format!("copy-{round}-1"),
            format!("copy-{round}-2"),
        ];
        expected.sort();
        assert_eq!(
            bodies, expected,
            "round {round}: a trashed copy was destroyed by the next delete"
        );

        std::fs::remove_dir_all(&trashed).unwrap();
    }

    std::fs::remove_dir_all(&vault).unwrap();
}
