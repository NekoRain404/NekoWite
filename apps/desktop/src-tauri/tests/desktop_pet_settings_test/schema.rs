//! The mirror, checked against the file it mirrors: the schema version, the domains, every field
//! with its default, every numeric rule and every structured rule, read out of
//! `platform/gateways/pet-contracts/config.ts`.
//!
//! §5.3 requires the interface and the backend to validate by the same rule (「界面和后端使用同一规则」),
//! and two files that agree by review agree until the day they do not. This is the day it fails
//! instead: a field added, renamed, defaulted differently or re-ruled on one side alone leaves one
//! of these assertions without its counterpart, and the mirror is not a mirror any more.
//!
//! The reading is deliberately dumb — slice the declaration out of the source and compare it with
//! the table — because a clever parser would be a second implementation of the schema, and a second
//! implementation is the thing this test exists to rule out.

use nekowite_lib::desktop_pet::settings::values::{fields, Kind, MemberRule};
use nekowite_lib::desktop_pet::settings::{PetSettingsDomain, PET_SETTINGS_SCHEMA_VERSION};

use crate::support::{config_contract, is_comment, quoted, slice_between, values_contract};

/// The object literal of a `const` declaration: everything between the `= {` after `marker` and the
/// first `\n}` after it. Every table under test is one object literal at one level of indentation.
///
/// The marker is the declaration and not the bare name: `PET_STRUCTURED_RULES` is named in the
/// file's own module comment, and searching for the name would find that mention and then compare
/// this table against whichever literal came next.
fn object_literal<'a>(text: &'a str, marker: &str) -> &'a str {
    let at = text
        .find(marker)
        .unwrap_or_else(|| panic!("{marker} is not declared"));
    let after = &text[at..];
    let open = after
        .find("= {")
        .unwrap_or_else(|| panic!("{marker} has no initializer"))
        + 3;
    let rest = &after[open..];
    let end = rest
        .find("\n}")
        .unwrap_or_else(|| panic!("{marker}'s object literal never closes"));
    &rest[..end]
}

/// The object literal that follows `key:` inside a block, by brace matching.
fn object_of(block: &str, key: &str) -> String {
    let needle = format!("{key}: {{");
    let start = block
        .find(&needle)
        .unwrap_or_else(|| panic!("{key} is not in the block"))
        + needle.len();
    let mut depth = 1;
    for (index, character) in block[start..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return block[start..start + index].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("{key}'s object literal is never closed");
}

/// The `key: value` pairs of a block, in the order they are written, with comment lines dropped.
///
/// Every value in the tables this reads is a scalar, `[]` or `{}`, so splitting on commas at all
/// is enough; a table that needed more would fail loudly here rather than compare the wrong thing.
fn pairs(block: &str) -> Vec<(String, String)> {
    let cleaned: String = block
        .lines()
        .filter(|line| !is_comment(line))
        .collect::<Vec<_>>()
        .join("\n");
    cleaned
        .split(',')
        .filter_map(|part| {
            let (key, value) = part.split_once(':')?;
            Some((key.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

/// The number written after `name:` in `text`, up to the next comma or closing brace.
fn number_after(text: &str, name: &str) -> f64 {
    let marker = format!("{name}:");
    let start = text
        .find(&marker)
        .unwrap_or_else(|| panic!("{name} is not in {text}"))
        + marker.len();
    let rest = &text[start..];
    let end = rest
        .find(|character| character == ',' || character == '}')
        .unwrap_or(rest.len());
    rest[..end]
        .trim()
        .parse()
        .unwrap_or_else(|error| panic!("{name} in {text} is not a number: {error}"))
}

/// The value of a `const NAME = <number>` declaration.
fn const_number(text: &str, name: &str) -> f64 {
    let marker = format!("const {name} = ");
    let start = text
        .find(&marker)
        .unwrap_or_else(|| panic!("{name} is not declared"))
        + marker.len();
    let rest = &text[start..];
    // To the end of the line, or to a semicolon when the declaration writes one — this file's
    // constants are written without.
    let end = rest
        .find(|character| character == ';' || character == '\n')
        .unwrap_or(rest.len());
    rest[..end]
        .trim()
        .parse()
        .unwrap_or_else(|error| panic!("{name} is not a number: {error}"))
}

/// A rule table in path order, which is unique — so the comparison is about the rules and not
/// about the order each side happened to write them in. (`f64` is not `Ord`, hence keying on the
/// path rather than on the row.)
fn by_path<T>(rows: &[T], path: impl Fn(&T) -> &str) -> Vec<&T> {
    let mut sorted: Vec<&T> = rows.iter().collect();
    sorted.sort_by(|left, right| path(left).cmp(path(right)));
    sorted
}

/// One field's default, spelled the way the schema file spells it.
fn as_typescript(kind: Kind) -> String {
    match kind {
        Kind::Bool(value) => value.to_string(),
        Kind::Number { fallback, .. } => format!("{fallback}"),
        Kind::Member { default, .. } => format!("'{default}'"),
        Kind::Ident => "null".to_string(),
        Kind::List { .. } => "[]".to_string(),
        Kind::Map { .. } => "{}".to_string(),
    }
}

/// The member rule as the other half names it.
fn member_name(rule: MemberRule) -> &'static str {
    match rule {
        MemberRule::Row => "row",
        MemberRule::Line { .. } => "line",
        MemberRule::TokenItem => "token-item",
    }
}

#[test]
fn the_schema_version_is_the_typescript_one() {
    let text = config_contract();
    let declared = slice_between(&text, "PET_SETTINGS_SCHEMA_VERSION = ", "\n");
    assert_eq!(
        declared.trim().parse::<i64>().expect("a version number"),
        PET_SETTINGS_SCHEMA_VERSION
    );
}

#[test]
fn the_domains_are_the_typescript_ones_and_in_the_same_order() {
    let text = config_contract();
    let declared = slice_between(&text, "PET_SETTINGS_DOMAINS = [", "] as const");
    assert_eq!(quoted(declared), PetSettingsDomain::ids().to_vec());
}

/// Every field of every domain, with the default it carries: the names in the schema's own order,
/// and the value the schema gives each one.
#[test]
fn every_field_and_default_is_the_typescript_one() {
    let text = config_contract();
    let defaults = object_literal(&text, "const PET_SETTINGS_DEFAULTS");
    for domain in PetSettingsDomain::ALL {
        let block = object_of(defaults, domain.id());
        let declared = pairs(&block);
        let mine: Vec<(String, String)> = fields(domain)
            .iter()
            .map(|field| (field.name.to_string(), as_typescript(field.kind)))
            .collect();
        assert_eq!(declared, mine, "{domain:?}");
    }
}

/// Every numeric field's rule, and no rule for a field that is not one: the bounds, whether the
/// number has to be whole, and the fallback a stored value outside the rule takes.
#[test]
fn every_number_rule_is_the_typescript_one() {
    let text = config_contract();
    let rules = object_literal(&text, "const PET_NUMBER_RULES");
    // Sorted, because a rule table's order is its author's and not a contract: the *defaults*
    // block above is compared in order, since that one is the schema's own field order.
    let declared: Vec<(String, f64, f64, bool, f64)> = rules
        .lines()
        .filter(|line| !is_comment(line))
        .filter_map(|line| {
            let path = quoted(line).into_iter().next()?;
            Some((
                path,
                number_after(line, "min"),
                number_after(line, "max"),
                line.contains("integer: true"),
                number_after(line, "fallback"),
            ))
        })
        .collect();

    let mine: Vec<(String, f64, f64, bool, f64)> = PetSettingsDomain::ALL
        .into_iter()
        .flat_map(|domain| {
            fields(domain)
                .iter()
                .filter_map(move |field| match field.kind {
                    Kind::Number {
                        min,
                        max,
                        integer,
                        fallback,
                    } => Some((
                        format!("{}.{}", domain.id(), field.name),
                        min,
                        max,
                        integer,
                        fallback,
                    )),
                    _ => None,
                })
        })
        .collect();
    assert_eq!(
        by_path(&declared, |row| row.0.as_str()),
        by_path(&mine, |row| row.0.as_str())
    );
}

/// Every structured field's rule: which container, what a member is, how long a line may be, and
/// how many members the field may hold — the caps that keep a stored file from costing whatever it
/// says it costs.
#[test]
fn every_structured_rule_is_the_typescript_one() {
    // The values file and not the schema one: the structured rules live beside the walker that
    // reads them, which is the same split this side makes between `values.rs` and `settings.rs`.
    let text = values_contract();
    let rules = object_literal(&text, "const PET_STRUCTURED_RULES");
    let declared: Vec<(String, String, String, Option<f64>, f64)> = rules
        .lines()
        .filter(|line| !is_comment(line))
        .filter_map(|line| {
            let names = quoted(line);
            if names.len() < 3 {
                return None;
            }
            // A named constant is resolved from its own declaration rather than assumed, so a cap
            // changed on that side alone fails here instead of matching a number this test made up.
            let length = if line.contains("maxLength: KEY_MAX_LENGTH") {
                Some(const_number(&text, "KEY_MAX_LENGTH"))
            } else if line.contains("maxLength: TOKEN_MAX_LENGTH") {
                Some(const_number(&text, "TOKEN_MAX_LENGTH"))
            } else if line.contains("maxLength:") {
                Some(number_after(line, "maxLength"))
            } else {
                None
            };
            Some((
                names[0].clone(),
                names[1].clone(),
                names[2].clone(),
                length,
                number_after(line, "max"),
            ))
        })
        .collect();

    let mine: Vec<(String, String, String, Option<f64>, f64)> = PetSettingsDomain::ALL
        .into_iter()
        .flat_map(|domain| {
            fields(domain).iter().filter_map(move |field| {
                let path = format!("{}.{}", domain.id(), field.name);
                let (container, member, max) = match field.kind {
                    Kind::List { member, max } => ("list", member, max),
                    Kind::Map { value, max } => ("map", value, max),
                    _ => return None,
                };
                let length = match member {
                    MemberRule::Line { max_length } => Some(max_length as f64),
                    _ => None,
                };
                Some((
                    path,
                    container.to_string(),
                    member_name(member).to_string(),
                    length,
                    max as f64,
                ))
            })
        })
        .collect();
    // In path order for the reason the number rules are: the table's order is not the schema's.
    assert_eq!(
        by_path(&declared, |row| row.0.as_str()),
        by_path(&mine, |row| row.0.as_str())
    );
}
