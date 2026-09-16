//! The one deletion this module performs, and what it may not become.
//!
//! §4's rollback is the feature switch, and switching the pet off cancels no agent task and
//! deletes no character. So the deletion here is not reachable from that path at all — it is what
//! the ✕ on a library row is — and the tests below are as much about the *shape* of the module as
//! about one call: there is no operation on a whole library, a whole vault or a whole desktop, so
//! a teardown that learned to erase would have to add one, and adding one is what the last case
//! refuses.

use std::path::Path;

use crate::desktop_pet::resources::ResourceRefusal;
use crate::support::{install_request, library, listing, pack_dir, png, write};

/// Two characters, so every case can show that a removal reached exactly one of them.
fn two_characters(label: &str) -> crate::desktop_pet::resources::CharacterLibrary {
    let (library, _data) = library(label);
    for (id, bytes) in [("cat", png(64, 64)), ("dog", png(32, 32))] {
        let source = pack_dir(&format!("{label}-{id}"));
        write(&source, "sheet.png", &bytes);
        library
            .install(&install_request(id, &source))
            .expect("a pack of one image");
    }
    library
}

#[test]
fn removing_a_character_takes_it_out_of_the_library_and_leaves_no_residue() {
    let library = two_characters("removal-one");
    let removal = library.remove("cat").expect("the user asked for it");
    assert_eq!(removal.character_id, "cat");
    assert_eq!(removal.debris, None, "nothing was left over");

    assert_eq!(listing(library.root()), vec!["dog"]);
    assert!(!library.root().join("cat").exists());
    assert!(!library.root().join("cat/sheet.png").exists());
    // The debris name is reserved and does not survive a clean removal: a `.removing-*` left in the
    // library is a directory the next listing would have to explain away.
    assert!(listing(library.root()).iter().all(|name| !name.starts_with('.')));
}

#[test]
fn removing_one_character_reaches_only_the_one_that_was_named() {
    let library = two_characters("removal-sibling");
    let dog_sheet = inventory(&library.root().join("dog"));
    let dog_digest = digest_of(&library.root().join("dog/sheet.png"));

    library.remove("cat").expect("the user asked for it");

    assert_eq!(inventory(&library.root().join("dog")), dog_sheet);
    assert_eq!(digest_of(&library.root().join("dog/sheet.png")), dog_digest);
    let entries = library.list().expect("readable");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].character_id, "dog");
}

#[test]
fn removing_something_that_is_not_there_is_refused_rather_than_reported_as_done() {
    let library = two_characters("removal-absent");
    assert_eq!(
        library.remove("ferret").expect_err("nothing is installed under that id"),
        ResourceRefusal::NotInstalled {
            character_id: "ferret".to_string()
        }
    );
    // And the refusal created nothing: a removal that staged an empty directory to remove would
    // leave one behind for the next listing to explain.
    assert_eq!(listing(library.root()), vec!["cat", "dog"]);
}

#[test]
fn a_removal_cannot_name_a_path_either() {
    let library = two_characters("removal-id");
    for id in ["..", ".", "../cat", "cat/..", ".hidden", ""] {
        let refusal = library.remove(id).expect_err("not a path component");
        assert!(
            matches!(refusal, ResourceRefusal::InvalidName { field: "characterId", .. }),
            "{id:?}"
        );
    }
    // The strongest form of the same statement: a removal of a directory *outside* the library
    // cannot be expressed, so nothing was deleted and nothing above the library was touched.
    assert_eq!(listing(library.root()), vec!["cat", "dog"]);
}

#[test]
fn the_module_offers_no_operation_on_a_whole_library() {
    // §4 read from the other side: switching the pet off must not be able to delete the user's
    // characters, and the way that is guaranteed is that no operation deletes more than the one
    // thing it was given. Asserting "no such call was made" against a mock would be asserting
    // about the mock, so what is checked is the *shape*: no public operation on this module is
    // named like one that reaches everything, and the single deletion takes an id.
    let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/desktop_pet/resources.rs");
    let mut sources = vec![module.clone()];
    let siblings = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/desktop_pet/resources");
    sources.extend(
        std::fs::read_dir(&siblings)
            .expect("the module's sibling files")
            .flatten()
            .map(|entry| entry.path()),
    );

    let forbidden = ["remove_all", "clear_all", "purge", "wipe", "erase", "reset_all", "uninstall"];
    for source in &sources {
        let text = std::fs::read_to_string(source).expect("a readable source file");
        for name in forbidden {
            assert!(
                !text.contains(&format!("fn {name}")),
                "{} declares {name}, which reaches more than the one thing it was given",
                source.display()
            );
        }
    }
    // And the deletion that does exist is `remove`, on one character, by id.
    let facade = std::fs::read_to_string(&module).expect("a readable source file");
    assert!(facade.contains("pub use library::CharacterLibrary;"));
    let library_source =
        std::fs::read_to_string(siblings.join("library.rs")).expect("a readable source file");
    assert!(library_source.contains("pub fn remove(&self, character_id: &str)"));
}

/// Every entry of a directory, with its size, so "nothing changed" is a statement about bytes.
fn inventory(dir: &Path) -> Vec<(String, u64)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(String, u64)> = entries
        .flatten()
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            )
        })
        .collect();
    found.sort();
    found
}

fn digest_of(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).expect("readable");
    bytes
        .iter()
        .fold(Sha256::new(), |mut hasher, byte| {
            hasher.update([*byte]);
            hasher
        })
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
