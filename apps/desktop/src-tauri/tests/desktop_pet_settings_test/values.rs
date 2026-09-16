//! The field rules: one predicate for both directions, and the schema's own defaults passing
//! through it unchanged.

use serde_json::{json, Map, Number, Value};

use nekowite_lib::desktop_pet::settings::values::{
    defaults, fields, problem_message, problems, read_values, Kind, Problem, ProblemKind,
};
use nekowite_lib::desktop_pet::settings::PetSettingsDomain;

use crate::support::values_contract;

/// The schema is the one list: every field of every domain defaults through the same walk, so a
/// field with no rule — or a rule no field reaches — is a normalization that cannot happen.
#[test]
fn every_field_defaults_and_every_default_passes_its_own_rule() {
    for domain in PetSettingsDomain::ALL {
        let defaults = defaults(domain);
        let read = read_values(domain, &json!({}));
        assert_eq!(read.values, defaults, "{domain:?} defaults through the walk");
        assert!(read.repaired.is_empty(), "{domain:?} repaired nothing");

        // The other direction, on the same values: what this build writes is what it reads back.
        let problems = problems(domain, &Value::Object(defaults));
        assert!(
            problems.is_empty(),
            "{domain:?} refuses its own defaults: {}",
            problem_message(&problems)
        );
    }
}

/// A stored value nobody can use takes the rule's fallback and is *reported*; a field that is
/// simply absent defaults quietly. Merging the two would make every migrated record look as though
/// it had repaired something.
#[test]
fn an_unusable_stored_value_is_repaired_and_an_absent_one_is_not() {
    let read = read_values(
        PetSettingsDomain::Character,
        &json!({ "size": 9000, "idleMode": "sideways", "characterId": 5 }),
    );
    assert_eq!(read.values["size"], json!(160));
    assert_eq!(read.values["idleMode"], json!("random"));
    assert_eq!(read.values["characterId"], Value::Null);
    // Schema order, which is the order the fields are walked in.
    assert_eq!(
        read.repaired,
        vec![
            "character.characterId".to_string(),
            "character.size".to_string(),
            "character.idleMode".to_string()
        ]
    );

    let untouched = read_values(PetSettingsDomain::Character, &json!({ "size": 200 }));
    assert_eq!(untouched.values["size"], json!(200));
    assert!(untouched.repaired.is_empty());

    // A key the schema does not declare is dropped from a *stored* record: a file may be ahead of
    // this build in ways a submission from this build's own form cannot be.
    let unknown = read_values(PetSettingsDomain::General, &json!({ "enabled": false, "new": 1 }));
    assert_eq!(unknown.values["enabled"], json!(false));
    assert!(!unknown.values.contains_key("new"));
    assert!(unknown.repaired.is_empty());
}

/// A write is the whole domain and never a patch. A submission that carries every field and one bad
/// value is refused with exactly that one problem — so the stored record cannot be quietly merged
/// into a submission one field at a time.
#[test]
fn a_submitted_write_is_refused_whole_and_every_problem_is_named() {
    let mut submitted = defaults(PetSettingsDomain::Character);
    submitted.insert("size".to_string(), json!(9000));
    let refused = problems(PetSettingsDomain::Character, &Value::Object(submitted));
    assert_eq!(
        refused,
        vec![Problem {
            path: "character.size".to_string(),
            kind: ProblemKind::OutOfRange,
        }]
    );
    assert_eq!(problem_message(&refused), "character.size:out-of-range");

    // Every arm of the vocabulary this side can reach, in one submission.
    let messy = problems(
        PetSettingsDomain::Message,
        &json!({
            "bubbleSeconds": "six",
            "fontSize": 99,
            "layoutMaxRows": 2.5,
            "grouping": "byKind",
            "tokens": "none",
            "extra": 1
        }),
    );
    let message = problem_message(&messy);
    for named in [
        "message.bubbleSeconds:wrong-type",
        "message.fontSize:out-of-range",
        "message.layoutMaxRows:not-integer",
        "message.grouping:unknown-member",
        "message.tokens:wrong-shape",
        "message.extra:unknown-field",
    ] {
        assert!(message.contains(named), "{named} is missing from {message}");
    }
    // The fields the submission did not carry are `missing` and not merged from the store.
    assert!(messy
        .iter()
        .any(|problem| problem.path == "message.theme" && problem.kind == ProblemKind::Missing));

    // Values that are not an object at all are refused as one problem naming the domain.
    assert_eq!(
        problems(PetSettingsDomain::Care, &json!("care")),
        vec![Problem {
            path: "care".to_string(),
            kind: ProblemKind::WrongType,
        }]
    );
}

/// A structured field is all or nothing. A list whose fourth member is unusable takes the field's
/// whole fallback rather than being trimmed to its usable prefix, and a member is *copied* — which
/// is where a third key of a token item is dropped.
#[test]
fn structured_values_are_copied_and_bounded_whole() {
    let read = |raw: Value| read_values(PetSettingsDomain::Message, &raw);

    // A third key is dropped, and the two named keys survive.
    let kept = read(json!({ "tokens": [{ "token": "state", "visible": true, "extra": 1 }] }));
    assert_eq!(kept.values["tokens"], json!([{ "token": "state", "visible": true }]));
    assert!(kept.repaired.is_empty());

    // A member that cannot be used takes the whole field.
    for (label, value) in [
        ("tokens", json!([{ "token": "state" }])),
        ("tokens", json!([{ "token": "", "visible": true }])),
        ("quickBubbles", json!(["fine", "two\nlines"])),
        ("hiddenAgents", json!([""])),
        ("hiddenAgents", json!(["ok", 7])),
        ("agentIcons", json!({ "": "sym:cat" })),
        ("agentIcons", json!({ "claude": "" })),
    ] {
        let read = read(json!({ (label): value }));
        assert!(
            read.repaired.contains(&format!("message.{label}")),
            "{label} should have been repaired: {read:?}"
        );
    }
    // ... and a map key that is fine is kept.
    let icons = read(json!({ "agentIcons": { "claude": "sym:cat", "other": "brand:x" } }));
    assert_eq!(
        icons.values["agentIcons"],
        json!({ "claude": "sym:cat", "other": "brand:x" })
    );

    // The caps are on stored data and not on a layout: 73 clips is a playlist nobody can play.
    let over = read_values(
        PetSettingsDomain::Character,
        &json!({ "idleClips": (0..73).collect::<Vec<i64>>() }),
    );
    assert_eq!(over.values["idleClips"], json!([]));
    assert_eq!(over.repaired, vec!["character.idleClips".to_string()]);
    let rows = read_values(
        PetSettingsDomain::Character,
        &json!({ "bindings": { "idle": 0, "working": -1 } }),
    );
    assert_eq!(rows.values["bindings"], json!({}));
}

/// A line is measured in UTF-16 code units, which is what `raw.length` counts on the other side:
/// a mirror that counted scalar values would accept a bubble this side writes and the other side
/// refuses.
#[test]
fn a_line_is_measured_the_way_the_typescript_half_measures_it() {
    let bubble = |count: usize| json!({ "quickBubbles": ["😀".repeat(count)] });
    let sixty = read_values(PetSettingsDomain::Message, &bubble(60));
    assert_eq!(sixty.values["quickBubbles"], json!(["😀".repeat(60)]));
    assert!(sixty.repaired.is_empty(), "120 UTF-16 units is inside the cap");

    let sixty_one = read_values(PetSettingsDomain::Message, &bubble(61));
    assert_eq!(sixty_one.values["quickBubbles"], json!([]));
    assert_eq!(
        sixty_one.repaired,
        vec!["message.quickBubbles".to_string()],
        "122 units is past it"
    );
}

/// Finiteness, then the range, then integer-ness — three requirements, in the order §5.3 states
/// them, and the order is what decides which defect gets named.
#[test]
fn the_number_rules_read_the_range_before_integer_ness() {
    // By path and not by position: a submission of one field is still a submission missing the
    // rest, so the first problem reported is never the one this test is about.
    let kind_of = |raw: Value, field: &str| {
        problems(PetSettingsDomain::Character, &raw)
            .into_iter()
            .find(|problem| problem.path == format!("character.{field}"))
            .unwrap_or_else(|| panic!("{field} was not judged"))
            .kind
    };

    assert_eq!(kind_of(json!({ "size": "160" }), "size"), ProblemKind::WrongType);
    assert_eq!(kind_of(json!({ "size": 1000 }), "size"), ProblemKind::OutOfRange);
    // Inside the rule's range and not whole, so this is the integer clause and not the range one.
    assert_eq!(kind_of(json!({ "size": 200.5 }), "size"), ProblemKind::NotInteger);
    // A rule that does not require whole numbers takes the value between the two.
    let mut opacity = defaults(PetSettingsDomain::View);
    opacity.insert("opacity".to_string(), json!(0.5));
    assert!(problems(PetSettingsDomain::View, &Value::Object(opacity)).is_empty());

    // The one arm JSON cannot carry. `NotFinite` is in the vocabulary because the TypeScript half's
    // numbers include `NaN` and `Infinity`; a `serde_json::Number` cannot be built from either, so
    // a document and a submission both cannot produce one — which is the claim, asserted rather
    // than left in a comment.
    assert!(Number::from_f64(f64::NAN).is_none());
    assert!(Number::from_f64(f64::INFINITY).is_none());
}

/// The problem vocabulary is the TypeScript file's, read off disk: a code added on one side alone
/// is a refusal the other half cannot report.
#[test]
fn the_problem_vocabulary_is_the_typescript_one() {
    let text = values_contract();
    let union = crate::support::slice_between(
        &text,
        "export type PetSettingsProblemKind =",
        "\n\n",
    );
    // One member per `| 'name'` line rather than every quoted string in the slice: the union
    // carries a doc comment of its own, and a comment is prose with apostrophes in it.
    let reported: Vec<String> = union
        .lines()
        .filter(|line| line.trim_start().starts_with("| '"))
        .filter_map(|line| crate::support::quoted(line).into_iter().next())
        .collect();
    let mine: Vec<String> = [
        ProblemKind::UnknownField,
        ProblemKind::Missing,
        ProblemKind::WrongType,
        ProblemKind::NotFinite,
        ProblemKind::OutOfRange,
        ProblemKind::NotInteger,
        ProblemKind::UnknownMember,
        ProblemKind::WrongShape,
    ]
    .iter()
    .map(|kind| kind.id().to_string())
    .collect();
    assert_eq!(reported, mine);

    // And the members are the closed sets this side validates against, so a control that offers a
    // new name cannot be saved by one half and refused by the other.
    let members = crate::support::slice_between(&text, "const PET_FIELD_MEMBERS", "\n}");
    for line in members.lines().filter(|line| !crate::support::is_comment(line)) {
        let Some((path, rest)) = line.split_once(':') else {
            continue;
        };
        let path = path.trim().trim_matches('\'').to_string();
        let offered = crate::support::quoted(rest);
        if offered.is_empty() {
            continue;
        }
        let (domain, field) = path.split_once('.').expect("a domain.field path");
        let domain = PetSettingsDomain::parse(domain).expect("a domain the schema declares");
        let schema = fields(domain)
            .iter()
            .find(|candidate| candidate.name == field)
            .unwrap_or_else(|| panic!("{path} is not a field of {domain:?}"));
        let Kind::Member { members, .. } = schema.kind else {
            panic!("{path} is not a member field");
        };
        assert_eq!(offered, members, "{path}");
    }
}

/// The defaults a caller reads out are this build's own objects: mutating one cannot reach the
/// schema the next caller reads. The TypeScript half makes the same point about handing out
/// `PET_SETTINGS_DEFAULTS` itself.
#[test]
fn a_default_is_a_copy() {
    let mut first: Map<String, Value> = defaults(PetSettingsDomain::Message);
    first
        .get_mut("quickBubbles")
        .expect("a declared field")
        .as_array_mut()
        .expect("a list")
        .push(json!("mine"));
    assert_eq!(defaults(PetSettingsDomain::Message)["quickBubbles"], json!([]));
}
