//! The field rules: whether one value may be used, what it becomes when it may not, and every
//! reason a submitted domain's values cannot be accepted (§5.3).
//!
//! The Rust half of `pet-settings-values.ts`, and a mirror rather than a second design. §5.3
//! requires the interface and the backend to validate by the same rule (「界面和后端使用同一规则」),
//! and one rule enforced twice only stays one rule if the two sides cannot drift — which is why the
//! schema itself is [`super::fields`], compared against `pet-contracts/config.ts` and this file's
//! TypeScript counterpart by `tests/desktop_pet_settings_test/schema.rs`.
//!
//! **Two directions, one predicate.** A *stored* value nobody can use takes the rule's fallback
//! and is reported ([`read_values`]); a *submitted* one is refused whole ([`problems`]), because
//! writing a fallback the user did not choose would be reporting success for a save that changed
//! their setting to something else. Both call [`judge`], which answers with the value a field keeps
//! or the reason it cannot — so a field cannot be accepted by one direction and rejected by the
//! other.
//!
//! The schema half is re-exported here so that a caller has one path to import from, the way
//! `pet-settings-policy.ts` re-exports `pet-settings-values.ts`'s surface: the field rules and the
//! fields they are about are one subject, and two import paths is how they come apart.

use serde_json::{Map, Value};

use super::fields::{default_of, number_value, KEY_MAX_LENGTH, TOKEN_MAX_LENGTH};
use super::PetSettingsDomain;

// The schema half, reachable through this module too: a caller deciding whether a value may be used
// needs the field's own rule and the fields themselves together, and one import path is how the
// two stay one subject. Nothing is re-exported that this file does not itself use, so the list
// cannot drift away from what is actually shared.
pub use super::fields::{defaults, fields, Field, Kind, MemberRule};

/// Why a field was not acceptable, as a code.
///
/// Codes and not sentences, for the reason `pet-settings-values.ts` gives: the numeric clauses of
/// §5.3 stay apart from each other because "not a number at all", "not finite" and "outside the
/// range" are three different defects, and a mirror that cannot tell them apart cannot report one.
/// [`ProblemKind::id`] is the TypeScript spelling, and the two are held together by
/// `the_problem_vocabulary_is_the_typescript_one`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProblemKind {
    /// A key of the submitted object that the schema does not declare.
    UnknownField,
    /// A field the schema declares that the submission does not carry.
    Missing,
    /// The wrong JSON type for the field.
    WrongType,
    /// A number that is not finite.
    NotFinite,
    /// A number outside the field's rule.
    OutOfRange,
    /// A number the field's rule requires to be whole.
    NotInteger,
    /// A string-union field holding a name that is not one of its members.
    UnknownMember,
    /// A structured field holding something that is not a value of its rule.
    WrongShape,
}

impl ProblemKind {
    /// The code this build reports, spelled as `pet-settings-values.ts` spells it.
    pub fn id(self) -> &'static str {
        match self {
            ProblemKind::UnknownField => "unknown-field",
            ProblemKind::Missing => "missing",
            ProblemKind::WrongType => "wrong-type",
            ProblemKind::NotFinite => "not-finite",
            ProblemKind::OutOfRange => "out-of-range",
            ProblemKind::NotInteger => "not-integer",
            ProblemKind::UnknownMember => "unknown-member",
            ProblemKind::WrongShape => "wrong-shape",
        }
    }
}

/// One field that is not acceptable, and why. `path` is `domain.field`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Problem {
    pub path: String,
    pub kind: ProblemKind,
}

/// What normalizing one domain's values produced.
#[derive(Clone, PartialEq, Debug)]
pub struct Readout {
    pub values: Map<String, Value>,
    /// The paths whose stored value could not be used and took its fallback. Reported rather than
    /// applied silently, so a value the user set can be *shown* to have been repaired instead of
    /// quietly reading as something they never chose.
    pub repaired: Vec<String>,
}

/// A stored domain's values, normalized field by field.
///
/// Absent and unusable are told apart deliberately: a field the record does not carry at all was
/// never set (an older schema's field, or a fresh install) and defaults quietly, while a field that
/// *is* there and cannot be used is defaulted **and reported**. Merging the two would make every
/// migrated record look as though it had repaired something. An unknown key of a stored object is
/// dropped rather than refused: a record on disk may be ahead of this build in ways a submission
/// from this build's own form cannot be.
pub fn read_values(domain: PetSettingsDomain, raw: &Value) -> Readout {
    let stored = raw.as_object();
    let mut values = Map::new();
    let mut repaired = Vec::new();
    for field in fields(domain) {
        let kept = match stored.and_then(|object| object.get(field.name)) {
            None => default_of(field.kind),
            Some(candidate) => match judge(field, candidate) {
                Ok(value) => value,
                Err(_) => {
                    repaired.push(path_of(domain, field.name));
                    default_of(field.kind)
                }
            },
        };
        values.insert(field.name.to_string(), kept);
    }
    Readout { values, repaired }
}

/// The values blob of a stored record, or `None` when it is not a blob at all.
///
/// The distinction the caller needs is between "this object has no values" and "these values are a
/// string": the first is an empty record to fill with defaults, the second is a record that cannot
/// be read as one, and reporting the second as the first is how a corrupt file gets quietly
/// replaced by defaults.
pub fn read_stored_values(domain: PetSettingsDomain, raw: &Value) -> Option<Readout> {
    raw.is_object().then(|| read_values(domain, raw))
}

/// Every reason a submitted domain's values cannot be accepted.
///
/// A write is the *whole* domain and never a patch: a field that is missing is refused rather than
/// merged from the stored record, because merging a submission into what is stored is the silent
/// merge §5.3 forbids, one field at a time. A key the schema does not declare is refused too —
/// dropping it would report "saved" for a submission this build did not fully understand.
pub fn problems(domain: PetSettingsDomain, values: &Value) -> Vec<Problem> {
    let Some(object) = values.as_object() else {
        return vec![Problem {
            path: domain.id().to_string(),
            kind: ProblemKind::WrongType,
        }];
    };
    let mut problems = Vec::new();
    for field in fields(domain) {
        match object.get(field.name) {
            None => problems.push(Problem {
                path: path_of(domain, field.name),
                kind: ProblemKind::Missing,
            }),
            Some(candidate) => {
                if let Err(kind) = judge(field, candidate) {
                    problems.push(Problem {
                        path: path_of(domain, field.name),
                        kind,
                    });
                }
            }
        }
    }
    for key in object.keys() {
        if !fields(domain).iter().any(|field| field.name == key) {
            problems.push(Problem {
                path: format!("{}.{key}", domain.id()),
                kind: ProblemKind::UnknownField,
            });
        }
    }
    problems
}

/// The diagnostic form of a refusal, as `pet-settings-values.ts` writes it: `path:kind`, in the
/// order the fields were checked.
pub fn problem_message(problems: &[Problem]) -> String {
    problems
        .iter()
        .map(|problem| format!("{}:{}", problem.path, problem.kind.id()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn path_of(domain: PetSettingsDomain, field: &str) -> String {
    format!("{}.{field}", domain.id())
}

/// Whether one field's value may be used — and the value it keeps when it may.
///
/// The single predicate both directions read from: [`read_values`] replaces what this rejects with
/// the rule's own fallback, [`problems`] refuses the submission whole. For a structured value the
/// answer is this build's own copy rather than the caller's object, which is what keeps a page's
/// draft edit from reaching back into the record it was read from.
fn judge(field: &Field, raw: &Value) -> Result<Value, ProblemKind> {
    match field.kind {
        Kind::Bool(_) => raw.as_bool().map(Value::Bool).ok_or(ProblemKind::WrongType),
        Kind::Number {
            min, max, integer, ..
        } => {
            let number = raw.as_f64().ok_or(ProblemKind::WrongType)?;
            // Finiteness before the range, and the range before integer-ness: three separate
            // requirements, and upstream's two numeric defects are one of each — a `parseInt` with
            // no finiteness guard (`roam/types.ts:112`), and a range clamp that then reads the
            // clamped value as a number. The finiteness clause is unreachable from a document or a
            // submission, because `serde_json::Number` cannot be built from a non-finite `f64`; it
            // is kept because the vocabulary is the TypeScript file's and a mirror with an arm
            // missing is a mirror that cannot report what the other side reports.
            if !number.is_finite() {
                return Err(ProblemKind::NotFinite);
            }
            if number < min || number > max {
                return Err(ProblemKind::OutOfRange);
            }
            if integer && number.fract() != 0.0 {
                return Err(ProblemKind::NotInteger);
            }
            Ok(number_value(number, integer))
        }
        Kind::Member { members, .. } => raw
            .as_str()
            .filter(|name| members.contains(name))
            .map(|name| Value::String(name.to_string()))
            .ok_or(ProblemKind::UnknownMember),
        Kind::Ident => match raw {
            Value::Null => Ok(Value::Null),
            Value::String(name) => Ok(Value::String(name.clone())),
            _ => Err(ProblemKind::WrongType),
        },
        Kind::List { member, max } => read_list(member, max, raw).ok_or(ProblemKind::WrongShape),
        Kind::Map { value, max } => read_map(value, max, raw).ok_or(ProblemKind::WrongShape),
    }
}

/// One list as this build may keep it, or `None` when it may not be used at all.
///
/// All or nothing: a list whose fourth member is not a row takes the field's whole fallback rather
/// than being trimmed to its usable prefix, because a playlist the build silently shortened is a
/// playlist the user did not write.
fn read_list(member: MemberRule, max: usize, raw: &Value) -> Option<Value> {
    let Value::Array(items) = raw else {
        return None;
    };
    if items.len() > max {
        return None;
    }
    let mut kept = Vec::with_capacity(items.len());
    for item in items {
        kept.push(read_member(member, item)?);
    }
    Some(Value::Array(kept))
}

/// One map as this build may keep it, or `None`.
///
/// The keys are checked as lines of text and the values against the member rule; a key that is not
/// one is refused rather than repaired, because a map's key *is* the user's data here (a mood, an
/// agent id) and there is nothing to fall back to that would keep the entry.
fn read_map(member: MemberRule, max: usize, raw: &Value) -> Option<Value> {
    let Value::Object(entries) = raw else {
        return None;
    };
    if entries.len() > max {
        return None;
    }
    let mut kept = Map::new();
    for (key, item) in entries {
        if !is_line(key, KEY_MAX_LENGTH) {
            return None;
        }
        kept.insert(key.clone(), read_member(member, item)?);
    }
    Some(Value::Object(kept))
}

/// One member as this build may keep it, or `None`.
///
/// A `token-item` is rebuilt from its two named keys rather than copied, which is where a third key
/// is dropped — a member this build did not write, from a record a future build made or a file
/// somebody edited.
fn read_member(rule: MemberRule, raw: &Value) -> Option<Value> {
    match rule {
        MemberRule::Row => is_row(raw).then(|| raw.clone()),
        MemberRule::Line { max_length } => raw
            .as_str()
            .filter(|line| is_line(line, max_length))
            .map(|line| Value::String(line.to_string())),
        MemberRule::TokenItem => {
            let object = raw.as_object()?;
            let token = object.get("token")?.as_str()?;
            if !is_line(token, TOKEN_MAX_LENGTH) {
                return None;
            }
            let visible = object.get("visible")?.as_bool()?;
            let mut kept = Map::new();
            kept.insert("token".to_string(), Value::String(token.to_string()));
            kept.insert("visible".to_string(), Value::Bool(visible));
            Some(Value::Object(kept))
        }
    }
}

/// A spritesheet row: whole, non-negative, finite.
fn is_row(raw: &Value) -> bool {
    raw.as_f64()
        .is_some_and(|row| row.is_finite() && row.fract() == 0.0 && row >= 0.0)
}

/// One line of stored text: not blank, carrying no control character, and inside its cap.
///
/// The length is counted in UTF-16 code units because that is what `pet-settings-values.ts` measures
/// with `raw.length`, and a mirror that counted scalar values would accept a 90-emoji bubble from
/// this side and refuse it from the other. Leading and trailing spaces are kept as written —
/// upstream trims on the way in (`settings.ts:1797`), and a validator that trimmed on the way out
/// would be a second editor of the user's words.
fn is_line(line: &str, max_length: usize) -> bool {
    !line.is_empty()
        && line.encode_utf16().count() <= max_length
        && !line.trim().is_empty()
        && !line.chars().any(is_control)
}

/// Unicode's `Cc` — the C0 and C1 control characters, DEL included — which is what the TypeScript
/// half tests with `\p{Cc}`.
///
/// Spelled as ranges rather than as a property escape, because Rust's standard library has no
/// Unicode property matching and a crate for one would be a dependency this task may not add. The
/// two ranges are the whole category, so the mirror is exact and not an approximation.
fn is_control(character: char) -> bool {
    matches!(character, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}
