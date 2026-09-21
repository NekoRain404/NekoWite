//! Why a document could not be read, scanned or written.
//!
//! It changes when the vocabulary of refusals changes. Its own file because both halves of the
//! module name it — the reader that fails and the splicer that refuses — and neither owns it.

use std::path::PathBuf;

/// Why a document could not be read, scanned or written.
///
/// Data only, like `registry::RegistryError`: the sentence a user reads is built at the IPC boundary,
/// and it is built there because it names a field of a form rather than a fact about a file.
#[derive(Debug)]
pub enum ConfigError {
    /// The filesystem refused, or the file is not text this host can hold as a `String`.
    Io { path: PathBuf, message: String },
    /// The text is not JSONC this scanner can follow, at a byte offset. The edit is refused:
    /// rewriting a file we cannot read is how comments and unknown fields are lost.
    Syntax {
        path: PathBuf,
        offset: usize,
        message: String,
    },
    /// The edit names a key the document does not have there. Intermediate objects are *not*
    /// invented: creating a chain of parents would be this host deciding what an engine's
    /// configuration should look like, which §3.4.5 leaves to a verified adapter.
    Missing { path: Vec<String> },
    /// The path descends through a value that is not an object (an array, a string, a number).
    NotAnObject { path: Vec<String> },
    /// An empty path, or a path with an empty segment — what an unfilled form field produces.
    BlankPath,
}
