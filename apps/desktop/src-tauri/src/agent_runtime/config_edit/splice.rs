//! Turning one edit into text: a value's span replaced, or a member inserted in the document's own
//! style.
//!
//! It changes when the formatting-preservation rules change — where a new member goes, what
//! indentation it wears, whether it brings its own comma. Reading the document is `scanner`'s and
//! `document`'s; deciding whether the edit may be made at all is the caller's, and the refusals it
//! raises are only the ones the tree itself reports ([`ConfigError::Missing`] and its siblings).

use std::path::Path;

use super::error::ConfigError;
use super::scanner::{scan, ObjectNode};
use super::ConfigEdit;

/// The document an edit that read nothing is applied to: no members.
///
/// *No members* rather than no bytes, and the difference is not cosmetic — a file of zero bytes is
/// not JSONC this scanner can follow, so a create that wrote one would hand the engine a document
/// nothing can read (including this host, on the next read). A create is not a second kind of
/// splice either: it is the same [`splice`] against `{}`, so the members a create produces are the
/// ones the caller named and nothing else.
pub(super) const EMPTY_DOCUMENT: &str = "{}";

/// The text with one edit applied, or `None` when the edit had nothing to say.
///
/// `None` comes from one arm only — [`ConfigEdit::if_absent`] meeting a member that is already
/// there — and it is `None` rather than the unchanged text so that a submission can be spliced
/// without a copy per no-op, and so that "this edit wrote nothing" is a fact the loop can see.
pub(super) fn splice(
    text: &str,
    edit: &ConfigEdit,
    path: &Path,
) -> Result<Option<String>, ConfigError> {
    let value = edit.rendered_value();
    let root = scan(text, path)?;
    let (last, parents) = edit.path.split_last().expect("checked by ConfigEdit::set");
    let mut node = &root;
    // Every segment but the last names a container that must already exist. Only the last may be
    // added, and only to an object the document already has.
    for (depth, segment) in parents.iter().enumerate() {
        let here = || edit.path[..=depth].to_vec();
        let object = node
            .object
            .as_ref()
            .ok_or_else(|| ConfigError::NotAnObject { path: here() })?;
        let entry = object
            .entries
            .iter()
            .find(|entry| &entry.key == segment)
            .ok_or_else(|| ConfigError::Missing { path: here() })?;
        node = &entry.value;
    }
    let container = edit.path[..edit.path.len() - 1].to_vec();
    let object = node
        .object
        .as_ref()
        .ok_or(ConfigError::NotAnObject { path: container })?;
    match object.entries.iter().find(|entry| &entry.key == last) {
        // The span is the *value's*, so the member's name, its position, the comments around it and
        // every other byte of the document are untouched. The value itself is the caller's
        // serialization — that is what "set this member to this value" means.
        //
        // An edit that may only add returns here instead, leaving the member the document already
        // has — and every byte of it — alone. Not an error: the caller asked for the state that is
        // already on disk, which for the group a form has to be sure of is the ordinary case on
        // every run after the first one.
        Some(_) if edit.only_when_absent => Ok(None),
        Some(entry) => Ok(Some(splice_at(
            text,
            entry.value.start,
            entry.value.end,
            &value,
        ))),
        None => {
            let (at, insertion) = member_insertion(text, object, last, &value);
            Ok(Some(splice_at(text, at, at, &insertion)))
        }
    }
}

fn splice_at(text: &str, start: usize, end: usize, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len() + replacement.len());
    out.push_str(&text[..start]);
    out.push_str(replacement);
    out.push_str(&text[end..]);
    out
}

/// Where a new member goes, and the text that puts it there.
///
/// Never by replacing the whitespace between the last member and `}`: a comment can live there, and
/// adding a member by deleting a comment is the data loss this module exists to prevent. The text
/// is inserted at a position instead, and the document's own style decides what it looks like — the
/// indentation of its last member, and whether it writes a comma after one.
fn member_insertion(text: &str, object: &ObjectNode, key: &str, value: &str) -> (usize, String) {
    match object.entries.last() {
        None => {
            let close_indent = line_indent(text, object.close);
            (
                object.open + 1,
                format!("\n{close_indent}  \"{key}\": {value}\n{close_indent}"),
            )
        }
        Some(last) => {
            let indent = line_indent(text, last.key_start);
            match object.trailing_comma_at {
                // The author writes a comma after the last member. The new one goes *past* that
                // comma and brings its own, so the document keeps its style instead of ending up
                // with one member separated by a newline and the rest by commas.
                Some(after_comma) => (after_comma, format!("\n{indent}\"{key}\": {value},")),
                None => (last.value.end, format!(",\n{indent}\"{key}\": {value}")),
            }
        }
    }
}

/// The whitespace a line starts with: the indentation a member added beside `at` should wear.
///
/// A line whose content begins before the whitespace run ends — `{"a": 1}` written on one line —
/// has no indentation, and answers with the empty string rather than with the previous line's.
fn line_indent(text: &str, at: usize) -> String {
    let before = &text[..at];
    let line = match before.rfind('\n') {
        Some(newline) => &before[newline + 1..],
        None => before,
    };
    if !line.is_empty() && line.bytes().all(|byte| byte == b' ' || byte == b'\t') {
        line.to_string()
    } else {
        String::new()
    }
}
