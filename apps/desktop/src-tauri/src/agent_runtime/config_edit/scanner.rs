//! The JSONC scanner: the byte spans and member names an edit is built from.
//!
//! It changes when what the parser accepts changes — a comment form, a string escape, the shapes of
//! the values it will follow. It is split from the splice that consumes it because "what this host
//! can read" and "what an edit writes" are two answers, and only the first one is a grammar.

use std::path::Path;

use super::error::ConfigError;

/// A value's byte span, and — when it is an object — its members.
///
/// Arrays are scanned for their end and nothing else: an edit names member *names*, so there is no
/// path into an array for this module to represent, and not modelling them keeps the tree the size
/// of the question being asked.
///
/// The tree crosses into `splice` and `document` — they read these spans and keys — which is what
/// the `pub(super)` below is for, and why it is not `pub`: nothing outside `config_edit` may name it.
pub(super) struct Node {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) object: Option<Box<ObjectNode>>,
}

pub(super) struct ObjectNode {
    /// The `{`, which is where a member is added to an empty object.
    pub(super) open: usize,
    /// The `}`, which is where the object's own indentation is measured from.
    pub(super) close: usize,
    pub(super) entries: Vec<Entry>,
    /// Just past a comma that follows the *last* member, when the author writes one: a style JSONC
    /// files keep, and one an added member has to keep too rather than producing a document whose
    /// last two members are separated differently from the rest.
    pub(super) trailing_comma_at: Option<usize>,
}

pub(super) struct Entry {
    pub(super) key: String,
    /// Where the member's name starts, which is where its line's indentation starts.
    pub(super) key_start: usize,
    pub(super) value: Node,
}

/// One scan failure: the byte offset it was found at, and what was wrong with it.
type ScanError = (usize, String);

/// Scans a whole document, which is what every edit does before it changes anything.
///
/// The whole document and not only the path: an edit is refused when the file is not something this
/// scanner can follow anywhere in it, because the alternative — editing around a region we cannot
/// read — is how a hand-written file with a comment block in the middle gets half-rewritten.
pub(super) fn scan(text: &str, path: &Path) -> Result<Node, ConfigError> {
    let mut scanner = Scanner::new(text);
    let syntax = |(offset, message): ScanError| ConfigError::Syntax {
        path: path.to_path_buf(),
        offset,
        message,
    };
    scanner.skip_trivia().map_err(syntax)?;
    let node = scanner.parse_value().map_err(syntax)?;
    scanner.skip_trivia().map_err(syntax)?;
    if scanner.pos != text.len() {
        return Err(syntax((
            scanner.pos,
            "there is more than one root value".to_string(),
        )));
    }
    Ok(node)
}

struct Scanner<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    /// Whitespace and comments — the whole difference between JSONC and JSON, and the reason a
    /// stock parser cannot be used to find a span in one.
    fn skip_trivia(&mut self) -> Result<(), ScanError> {
        loop {
            while self.peek().is_some_and(|byte| byte.is_ascii_whitespace()) {
                self.pos += 1;
            }
            match (self.peek(), self.bytes.get(self.pos + 1).copied()) {
                (Some(b'/'), Some(b'/')) => {
                    self.pos += 2;
                    while self.peek().is_some_and(|byte| byte != b'\n') {
                        self.pos += 1;
                    }
                }
                (Some(b'/'), Some(b'*')) => {
                    let open = self.pos;
                    let rest = self.bytes.get(self.pos + 2..).unwrap_or_default();
                    let end = rest
                        .windows(2)
                        .position(|pair| pair[0] == b'*' && pair[1] == b'/');
                    match end {
                        Some(offset) => self.pos += 2 + offset + 2,
                        None => return Err((open, "a block comment is never closed".to_string())),
                    }
                }
                _ => return Ok(()),
            }
        }
    }

    fn parse_value(&mut self) -> Result<Node, ScanError> {
        let start = self.pos;
        let object = match self.peek() {
            Some(b'{') => Some(Box::new(self.parse_object(start)?)),
            Some(b'[') => {
                self.parse_array()?;
                None
            }
            Some(b'"') => {
                self.parse_string()?;
                None
            }
            Some(_) => {
                self.parse_primitive()?;
                None
            }
            None => return Err((start, "a value was expected".to_string())),
        };
        Ok(Node {
            start,
            end: self.pos,
            object,
        })
    }

    fn parse_object(&mut self, start: usize) -> Result<ObjectNode, ScanError> {
        self.pos += 1; // the `{`, already seen by the caller
        let mut entries = Vec::new();
        let mut trailing_comma_at = None;
        let close = loop {
            self.skip_trivia()?;
            match self.peek() {
                Some(b'}') => {
                    let close = self.pos;
                    self.pos += 1;
                    break close;
                }
                None => return Err((start, "an object is never closed".to_string())),
                Some(_) => {}
            }
            let key_start = self.pos;
            let key = self.parse_string()?;
            if key.contains('\\') {
                return Err((
                    key_start,
                    "a member name written with an escape cannot be matched".to_string(),
                ));
            }
            self.skip_trivia()?;
            if self.peek() != Some(b':') {
                return Err((self.pos, "expected a colon after a member name".to_string()));
            }
            self.pos += 1;
            self.skip_trivia()?;
            let value = self.parse_value()?;
            entries.push(Entry {
                key,
                key_start,
                value,
            });
            self.skip_trivia()?;
            // Recorded from this member's own comma, and left alone when the loop meets the `}`:
            // that is what makes it mean "the *last* member has one".
            trailing_comma_at = match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    Some(self.pos)
                }
                _ => None,
            };
        };
        Ok(ObjectNode {
            open: start,
            close,
            entries,
            trailing_comma_at,
        })
    }

    /// Scans an array and leaves the cursor just past its `]`.
    fn parse_array(&mut self) -> Result<(), ScanError> {
        let start = self.pos;
        self.pos += 1;
        loop {
            self.skip_trivia()?;
            match self.peek() {
                Some(b']') => {
                    self.pos += 1;
                    return Ok(());
                }
                None => return Err((start, "an array is never closed".to_string())),
                Some(_) => {}
            }
            self.parse_value()?;
            self.skip_trivia()?;
            if self.peek() == Some(b',') {
                self.pos += 1;
            }
        }
    }

    /// Reads one string token and answers with the text between its quotes, as written.
    ///
    /// Escapes are left as written rather than resolved, and a member *name* containing one is
    /// refused by the caller. A key is what a lookup compares, and a half-resolved key would let a
    /// document spelling a member `"apiKey"` be read as not having it and then be handed a
    /// second member of the same name — one object with two keys, which a JSONC reader may resolve
    /// either way. Values are never compared with anything, so their escapes cost nothing. What
    /// this does have to know is where the token ends, which is the whole of the loop below: the
    /// byte after a backslash cannot close the string, whatever it is.
    fn parse_string(&mut self) -> Result<String, ScanError> {
        let open = self.pos;
        if self.peek() != Some(b'"') {
            return Err((open, "expected a quoted string".to_string()));
        }
        let mut end = self.pos + 1;
        loop {
            match self.bytes.get(end) {
                None => return Err((open, "a string is never closed".to_string())),
                Some(b'\\') => end += 2,
                Some(b'"') => break,
                Some(_) => end += 1,
            }
        }
        let raw = std::str::from_utf8(&self.bytes[self.pos + 1..end])
            .map_err(|_| (open, "a string is not UTF-8".to_string()))?;
        self.pos = end + 1;
        Ok(raw.to_string())
    }

    /// Scans `true`, `false`, `null` or a number, and leaves the cursor just past it.
    ///
    /// The token is taken up to the first byte that could not be part of one and then checked,
    /// which is what refuses `tru` rather than editing around something the engine would reject.
    /// What it accepts is the shape of a number, not its value: this scanner locates spans and
    /// never reads numbers, and a document whose numbers are wrong is already the engine's problem.
    fn parse_primitive(&mut self) -> Result<(), ScanError> {
        let start = self.pos;
        while self.peek().is_some_and(|byte| {
            !matches!(
                byte,
                b',' | b'}' | b']' | b'/' | b' ' | b'\t' | b'\r' | b'\n'
            )
        }) {
            self.pos += 1;
        }
        let token = std::str::from_utf8(&self.bytes[start..self.pos]).unwrap_or("");
        let body = token.strip_prefix('-').unwrap_or(token);
        let numeric = !body.is_empty()
            && body.bytes().all(|byte| {
                byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-')
            });
        if matches!(token, "true" | "false" | "null") || numeric {
            Ok(())
        } else {
            Err((start, format!("`{token}` is not a value")))
        }
    }
}
