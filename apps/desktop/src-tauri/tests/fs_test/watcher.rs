//! The fs-change watcher's filter. A vault that lives inside a dot-directory (`~/.notes`) is the
//! case that matters: the hidden-component check has to run on the path RELATIVE to the vault root,
//! or every event the watcher would ever see is discarded. The watcher loop's coalescing and its
//! registration are not covered by this target.

use nekowite_lib::domain::path_policy::has_hidden_component;
use std::path::Path;

/// The watcher's fs-change filter drops paths under hidden components
/// (history, trash, .git) and hidden files.
#[test]
fn watcher_filter_skips_hidden_components() {
    use nekowite_lib::domain::path_policy::has_hidden_component;

    assert!(has_hidden_component(Path::new(
        "/vault/.nekowite/history/docs%2Fa.md/1.md"
    )));
    assert!(has_hidden_component(Path::new(
        "/vault/.nekowite-trash/x.md"
    )));
    assert!(has_hidden_component(Path::new("/vault/.git/index")));
    assert!(has_hidden_component(Path::new("/vault/.tmp.md")));
    assert!(!has_hidden_component(Path::new("/vault/docs/note.md")));
    assert!(!has_hidden_component(Path::new("/vault/a..b/note.md")));
}

/// The hidden-component filter must be applied RELATIVE to the watcher root.
///
/// It used to run on the absolute event path, so a vault inside a dot-directory
/// (`~/.notes`) had a hidden component in every event it would ever produce and
/// every external change was discarded. The app then believed it was watching
/// the vault while nothing ever arrived: an external edit was not noticed, and
/// the next save overwrote it. Only the paths BELOW the vault can be hidden.
#[test]
fn watcher_filter_is_relative_to_the_vault_root() {
    use std::path::Path;

    let root = Path::new("/home/u/.notes");
    let inside = Path::new("/home/u/.notes/note.md");
    let hidden = Path::new("/home/u/.notes/.nekowite/index/a.bin");

    let rel_inside = inside.strip_prefix(root).unwrap();
    let rel_hidden = hidden.strip_prefix(root).unwrap();
    assert!(
        !has_hidden_component(rel_inside),
        "an ordinary note is not hidden"
    );
    assert!(has_hidden_component(rel_hidden), "internal trees still are");

    // The old behaviour, kept here as the counter-example: the absolute path
    // carries the dot-directory and matches, hiding the whole vault.
    assert!(has_hidden_component(inside));
}
