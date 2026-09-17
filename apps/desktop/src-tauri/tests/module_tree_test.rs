//! Every `.rs` file under `src/` must be reachable from a crate root.
//!
//! `src/agent_runtime/recovery.rs` — 317 lines, 13 green tests — sat in this tree declared by
//! nothing: `agent_runtime/mod.rs` never named it, no lint reports a file that no `mod` reads, and
//! `cargo build` and `cargo test` both pass without it. The module was in no library and in no
//! binary, and a test target's `#[path]` include kept it compiling, so its tests were green about
//! code the application did not contain. Nothing detected that. This is the detector.
//!
//! That file is declared now — `agent_runtime/mod.rs` names it, and `agent_recover_change` is the
//! caller it never had — so the exemption below is gone with it, and this check can see the next
//! one. The paragraph under「What is not a declaration」 still explains why a test target's include
//! is not a declaration; the example is left as it was written, because it is what the check was
//! written for.
//!
//! **How it enumerates.** From the filesystem: every `.rs` under `CARGO_MANIFEST_DIR/src`. It then
//! replays rustc's own name resolution — start at `src/lib.rs` and `src/main.rs`, and for each
//! `mod name;` follow the file rustc would read, for as long as declarations keep leading somewhere
//! new. Whatever the walk never reaches is the failure. There is deliberately no list of files or
//! modules in here to fall out of date, because a list short one entry is the very defect this
//! catches: `tests/agent_settings_ipc_test.rs` broke exactly that way, and the hand list that broke
//! it is the same shape as a hand list of ``src`` files would have been.
//!
//! **What is not a declaration.** A `#[path]` include in a *test target* is not one. Every target
//! that compiles library sources reaches them that way, and `recovery.rs` was included by
//! `tests/agent_recovery_test.rs` — counting it would have hidden the one file this check was
//! written for, and would hide the next one the same way. Only declarations written in files under
//! `src/` are followed. A `#[path]` written *there* is honoured — `agent_runtime/skills.rs`
//! declares its three children that way, so that the same source resolves identically when a test
//! target includes that file directly — with rustc's resolution: relative to the directory of the
//! file carrying the attribute.
//!
//! **Where it runs.** `cargo test` builds and runs every `tests/*.rs` target, and CI's `rust` job
//! runs `cargo test --locked`. A new target in `tests/` is therefore in the gate the moment the
//! file exists: no workflow edit, no registration to forget. That is the same list-free property
//! that makes `cargo check --tests` the right gate for the other direction of module drift — a
//! hand-declared tree missing a module that a file inside it names — which the compiler already
//! catches there.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Files under `src/` that are in no crate's module tree today, and why that is a decision rather
/// than a repair to make here.
///
/// Empty, and it is meant to stay that way: the one entry it ever held was `agent_runtime/
/// recovery.rs`, and the change that declared that module (and gave it its caller) deleted the
/// entry in the same commit, as the entry itself asked. It is kept as a list rather than removed
/// because the *mechanism* is the point — a future orphan with a real reason has somewhere to go
/// that still fails the moment the reason stops being true.
///
/// Both directions are compared, so an entry cannot rot into a blanket exemption: a file that is
/// an orphan and is not listed here fails, and an entry here that is no longer an orphan also
/// fails, asking to be deleted. An exemption that outlives its reason is how a check stops seeing.
const KNOWN_ORPHANS: &[(&str, &str)] = &[];

/// The walk must find at least this many files, or it is the enumeration that is broken and not
/// the tree. `src/` holds a little over 120 `.rs` files, and a floor of half that leaves room for
/// real additions and deletions while still making an empty or truncated walk impossible to pass.
const MIN_FILES: usize = 60;

#[test]
fn every_source_file_is_reachable_from_a_crate_root() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");

    let mut all = BTreeSet::new();
    collect_rust_files(&src, &mut all);

    let roots: Vec<PathBuf> = ["lib.rs", "main.rs"]
        .iter()
        .map(|name| src.join(name))
        .filter(|path| path.is_file())
        .collect();
    assert_eq!(
        roots.len(),
        2,
        "expected {} and {} to exist; without both roots there is nothing to walk from, and this \
         check could pass while testing nothing",
        src.join("lib.rs").display(),
        src.join("main.rs").display(),
    );
    assert!(
        all.len() >= MIN_FILES,
        "the walk found {} `.rs` files under {}, fewer than the floor of {MIN_FILES} — the \
         enumeration is broken rather than the tree",
        all.len(),
        src.display(),
    );

    let reachable = reachable_from(&roots, &src);

    let orphans: BTreeSet<String> = all
        .difference(&reachable)
        .map(|path| relative_to(&src, path))
        .collect();
    let known: BTreeSet<String> = KNOWN_ORPHANS
        .iter()
        .map(|(path, _reason)| (*path).to_string())
        .collect();

    let mut problems: Vec<String> = Vec::new();
    for path in orphans.difference(&known) {
        problems.push(format!(
            "src/{path} is reachable from neither src/lib.rs nor src/main.rs: no `mod` declaration \
             under src/ names it, so rustc never reads it and it is in no library and no binary. \
             Declare it in its parent module — or, if it is genuinely not meant to be in the crate, \
             add it to KNOWN_ORPHANS with the reason."
        ));
    }
    for path in known.difference(&orphans) {
        problems.push(format!(
            "KNOWN_ORPHANS lists src/{path}, but it is declared now and is no longer an orphan. \
             Delete the entry: a stale exemption is how this check stops seeing."
        ));
    }
    for problem in &problems {
        eprintln!("{problem}\n");
    }
    assert!(
        problems.is_empty(),
        "{} file(s) under src/ are missing from the module tree, or are listed there but no \
         longer are, out of {}",
        problems.len(),
        all.len(),
    );

    // Printed so a run says what it actually looked at rather than only that it passed.
    println!(
        "module tree: {} `.rs` files under src/, {} reachable from the crate roots, {} known orphan(s)",
        all.len(),
        reachable.len(),
        orphans.len(),
    );
}

/// Every `.rs` file under `dir`, from the filesystem — never from a list.
fn collect_rust_files(dir: &Path, out: &mut BTreeSet<PathBuf>) {
    let entries =
        fs::read_dir(dir).unwrap_or_else(|error| panic!("cannot read {}: {error}", dir.display()));
    for entry in entries {
        let path = entry
            .unwrap_or_else(|error| panic!("cannot read an entry of {}: {error}", dir.display()))
            .path();
        if path.is_dir() {
            collect_rust_files(&path, out);
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("rs") {
            out.insert(path);
        }
    }
}

/// Every file rustc would read, walking out from `roots` through `mod name;` declarations.
fn reachable_from(roots: &[PathBuf], src: &Path) -> BTreeSet<PathBuf> {
    let mut reachable: BTreeSet<PathBuf> = roots.iter().cloned().collect();
    let mut queue: Vec<PathBuf> = roots.to_vec();
    while let Some(parent) = queue.pop() {
        for declaration in declarations(&parent) {
            for candidate in declaration.candidates(&parent, src) {
                // A declaration may name a file that does not exist — a `#[cfg]`-gated sibling on
                // another target, or a typo rustc reports on its own. Only a file that exists
                // under `src/` is one this walk can follow into.
                if candidate.starts_with(src)
                    && candidate.is_file()
                    && reachable.insert(candidate.clone())
                {
                    queue.push(candidate);
                }
            }
        }
    }
    reachable
}

/// One out-of-line `mod name;`.
struct Declaration {
    /// The name as written after `mod`.
    name: String,
    /// The `#[path = "..."]` written above it, if there was one.
    path: Option<String>,
}

impl Declaration {
    /// Every file rustc would accept for this declaration. More than one is correct: the two
    /// spellings of a module file (`name.rs` and `name/mod.rs`) are both legal, and a `#[path]`
    /// names a file outright.
    fn candidates(&self, parent: &Path, src: &Path) -> Vec<PathBuf> {
        let dir = module_dir(parent, src);
        let mut candidates = vec![
            dir.join(format!("{}.rs", self.name)),
            dir.join(&self.name).join("mod.rs"),
        ];
        if let Some(explicit) = &self.path {
            // rustc resolves a `#[path]` against the directory of the file that carries it:
            // `src/agent_runtime/skills.rs` writes `skills/discover.rs` and means
            // `src/agent_runtime/skills/discover.rs`.
            candidates.push(
                parent
                    .parent()
                    .expect("a module file always has a directory")
                    .join(explicit),
            );
            // A `#[path]` inside an inline `mod { }` block resolves against that module's own
            // directory instead. No such attribute exists under `src/` today; accepting both
            // readings keeps a future one from failing this test over a file that is declared.
            candidates.push(dir.join(explicit));
        }
        candidates
    }
}

/// The directory in which `mod name;` written in `parent` looks for `name.rs` or `name/mod.rs`.
///
/// Both of rustc's layouts are in this tree: `src/state.rs` beside `src/state/`, and
/// `src/domain/mod.rs` inside its own directory. A crate root is the one file whose children do
/// not live in a directory named after it — `src/lib.rs` declares `src/errors.rs`, not
/// `src/lib/errors.rs`.
fn module_dir(parent: &Path, src: &Path) -> PathBuf {
    let dir = parent
        .parent()
        .expect("a module file always has a directory")
        .to_path_buf();
    let name = parent
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let is_crate_root = dir == src && matches!(name, "lib.rs" | "main.rs");
    if name == "mod.rs" || is_crate_root {
        dir
    } else {
        dir.join(parent.file_stem().expect("a `.rs` file always has a stem"))
    }
}

/// Every out-of-line `mod name;` in `file`, with the `#[path]` that precedes it if there is one.
///
/// `mod name { ... }` — an inline module — is not a file and does not match; only the `;` form
/// does. Comments are stripped first, because a `mod`-shaped line inside one is not a declaration
/// and the doc comments under `src/` are long enough for that not to be worth guessing about.
fn declarations(file: &Path) -> Vec<Declaration> {
    let text = fs::read_to_string(file)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", file.display()));
    let mut declarations = Vec::new();
    let mut pending_path: Option<String> = None;
    for line in strip_comments(&text).lines() {
        let line = line.trim();
        if line.is_empty() {
            // Blank and comment-only lines sit *inside* an attribute run: `#[path]`, a doc line
            // and the `mod` under it are still one item.
            continue;
        }
        if let Some(path) = path_attribute(line) {
            pending_path = Some(path);
        } else if let Some(name) = module_declaration(line) {
            declarations.push(Declaration {
                name,
                path: pending_path.take(),
            });
        } else if !line.starts_with("#[") {
            // Any other item ends the run, so an unrelated `#[path]` cannot reach a later `mod`.
            pending_path = None;
        }
    }
    declarations
}

/// The path in a `#[path = "..."]` line, if that is what the line is.
fn path_attribute(line: &str) -> Option<String> {
    let rest = line.strip_prefix("#[")?.strip_prefix("path")?.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

/// The module name in a `mod name;` line, if that is what the line is.
fn module_declaration(line: &str) -> Option<String> {
    let mut rest = line;
    if let Some(after_pub) = rest.strip_prefix("pub") {
        let after_pub = after_pub.trim_start();
        rest = match after_pub.strip_prefix('(') {
            // `pub(crate)`, `pub(super)`, `pub(in path)`: the visibility is skipped rather than
            // interpreted, because it never changes which file rustc reads.
            Some(after_paren) => after_paren[after_paren.find(')')? + 1..].trim_start(),
            None => after_pub,
        };
    }
    let name = rest.strip_prefix("mod ")?.trim_start();
    let name = name[..name.find(';')?].trim();
    let mut characters = name.chars();
    let first = characters.next()?;
    let is_identifier = (first.is_alphabetic() || first == '_')
        && characters.all(|character| character.is_alphanumeric() || character == '_');
    is_identifier.then(|| name.to_string())
}

/// `text` with `//` line comments and `/* */` block comments removed, so a `mod`-shaped line
/// inside either one does not read as a declaration.
///
/// Strings and char literals are skipped rather than stripped, because a quote before a `//`
/// changes what the `//` is: `"https://…"` is not a comment, and a `'/'` is not the start of one.
/// Erring the other way — swallowing real code — would fail this test over files that are fine,
/// which is the failure that would get a check like this switched off.
///
/// Bytes rather than `str` slices throughout, so that scanning through the Chinese prose in these
/// doc comments can never land mid-character.
fn strip_comments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"//") {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
        } else if bytes[index..].starts_with(b"/*") {
            // Rust block comments nest.
            let mut depth = 0;
            while index < bytes.len() {
                if bytes[index..].starts_with(b"/*") {
                    depth += 1;
                    index += 2;
                } else if bytes[index..].starts_with(b"*/") {
                    depth -= 1;
                    index += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    index += 1;
                }
            }
        } else if bytes[index] == b'"' {
            index += string_literal_len(bytes, index, 0);
        } else if let Some(length) = raw_string_len(bytes, index) {
            index += length;
        } else if bytes[index] == b'\'' {
            index += char_literal_len(bytes, index);
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The length of the string literal whose opening quote is at `bytes[quote_start]`, where `hashes`
/// is how many `#` separate that quote from the `r` of a raw string. `bytes.len() - quote_start`
/// when it never closes, which `strip_comments` treats as "the rest of the file".
fn string_literal_len(bytes: &[u8], quote_start: usize, hashes: usize) -> usize {
    let mut index = quote_start + 1 + hashes;
    while index < bytes.len() {
        if hashes == 0 && bytes[index] == b'\\' {
            // An escape cannot end the literal, and `\"` is the reason this matters.
            index += 2;
            continue;
        }
        if bytes[index] == b'"' {
            let closing = &bytes[index + 1..];
            if closing.len() >= hashes && closing[..hashes].iter().all(|byte| *byte == b'#') {
                return index + 1 + hashes - quote_start;
            }
        }
        index += 1;
    }
    bytes.len() - quote_start
}

/// The length of the raw string literal starting at `bytes[start]` — `r"…"`, `r#"…"#`,
/// `r##"…"##` — or `None` when `bytes[start]` is not one.
fn raw_string_len(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'r') {
        return None;
    }
    let mut hashes = 0;
    while bytes.get(start + 1 + hashes) == Some(&b'#') {
        hashes += 1;
    }
    let quote = start + 1 + hashes;
    if bytes.get(quote) != Some(&b'"') {
        return None;
    }
    Some(quote - start + string_literal_len(bytes, quote, hashes))
}

/// The length of the char literal starting at `bytes[start]`, or `1` when it is a lifetime
/// instead — the `'a` in `&'a str` has no closing quote and must not be read as one.
fn char_literal_len(bytes: &[u8], start: usize) -> usize {
    if bytes.get(start + 1) == Some(&b'\\') {
        let mut index = start + 2;
        while index < bytes.len() && bytes[index] != b'\'' {
            index += 1;
        }
        return (index + 1 - start).min(bytes.len() - start);
    }
    let character_len = std::str::from_utf8(&bytes[start + 1..])
        .ok()
        .and_then(|rest| rest.chars().next())
        .map(char::len_utf8)
        .unwrap_or(0);
    if bytes.get(start + 1 + character_len) == Some(&b'\'') {
        character_len + 2
    } else {
        1
    }
}

/// `path` as it is spelled after `src/` in this file's messages.
fn relative_to(src: &Path, path: &Path) -> String {
    path.strip_prefix(src)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}
