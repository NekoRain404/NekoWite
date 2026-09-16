//! What the schema declares: every domain's fields, what each one holds, and what it falls back to
//! (§5.3).
//!
//! This is the Rust counterpart of `pet-contracts/config.ts`'s *declaration* half — the value
//! types, the explicit defaults, the numeric rules, the closed member sets and the structured caps
//! — and, like that file, it decides nothing. Which value may be used, and what a stored value
//! nobody can use becomes, is [`super::values`]: the other half of the same pair of TypeScript
//! files, and the split is theirs rather than a line count's (§13.1).
//!
//! **Why one table per domain.** The TypeScript half derives its field list from the mapped type
//! and keeps three tables keyed by `domain.field` (`PET_NUMBER_RULES`, `PET_FIELD_MEMBERS`,
//! `PET_STRUCTURED_RULES`). Rust has no runtime type to walk, so the field list and its rule have to
//! be written down anyway — and writing them down twice, once as a field name and once as a key
//! into three tables, is how a field ends up with a rule nothing applies. One table per domain is
//! the same three tables asked once, and [`fields`] is the only list: every rule in
//! `pet-settings-values.ts` and every default in `config.ts` is compared against these tables by
//! `tests/desktop_pet_settings_test/schema.rs`, so a field or a bound that moves on one side alone
//! fails a test rather than a save.

use serde_json::{Map, Number, Value};

use super::PetSettingsDomain;

/// A mood name or an agent id: short, but longer than any this build has heard of.
pub const KEY_MAX_LENGTH: usize = 64;
/// One bubble row field's name (`PET_BUBBLE_TOKENS` has seven, the longest six characters).
pub const TOKEN_MAX_LENGTH: usize = 32;

/// One member of a structured field, as `PetMemberRule` declares it.
///
/// Three, and each is a ledger row rather than a step towards a general schema language: a
/// spritesheet row (`ap_bind_<mood>`'s values and `ap_idle_clips`' members), one line of plain text
/// (a quick bubble, an agent id, an icon spec), and one bubble row field with its visibility.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MemberRule {
    /// A spritesheet row: whole, non-negative, finite. `animation-bindings.ts`'s `isRow` is the
    /// rule, and an out-of-grid row is the "arbitrary frame" §5.2 says must fall back rather than
    /// be read.
    Row,
    /// One line of plain text, at most `max_length` long.
    Line { max_length: usize },
    /// One bubble row field with its visibility.
    TokenItem,
}

/// What a field holds, what it falls back to, and — for a scalar — its default.
///
/// The three are one value on purpose: `pet-settings-values.ts` decides a field's rule from its own
/// default ("a boolean's type from its own default"), so a kind that did not carry the default
/// would be a rule with nothing to be derived from.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    /// A boolean, with its default.
    Bool(bool),
    /// A number, with the rule §5.3 requires it to satisfy and the value it falls back to.
    Number {
        min: f64,
        max: f64,
        integer: bool,
        fallback: f64,
    },
    /// One of a closed set of names, with the default member.
    Member {
        members: &'static [&'static str],
        default: &'static str,
    },
    /// The chosen character: a string or `null`, and `null` by default (§5.3 keeps identifiers in
    /// settings and the assets in a managed data directory).
    Ident,
    /// A list of members, with what they are and how many. Empty by default.
    List { member: MemberRule, max: usize },
    /// A map from a key to a member, with what a value is and how many entries. Empty by default.
    ///
    /// The keys are open, and deliberately: `character.bindings` is keyed by mood and
    /// `message.agentIcons` by agent id, and both vocabularies belong to something this module
    /// cannot see. A closed key set here would be this file inventing a vocabulary and then
    /// refusing the user's data for not being in it.
    Map { value: MemberRule, max: usize },
}

/// One field of one domain: its name, and everything that decides what a value of it may be.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Field {
    pub name: &'static str,
    pub kind: Kind,
}

/// The fields of `general`: §5.1's 启用 and the motion policy.
const GENERAL: &[Field] = &[
    // §5.1's 启用, and §4's rollback: turning this off stops the pet and cancels nothing else — no
    // agent task, no note save, and no character, care progress or history. It defaults on and
    // turns the feature *off*, for the reason `pet-contracts/config.ts` gives.
    Field {
        name: "enabled",
        kind: Kind::Bool(true),
    },
    // §5.2's Reduce-motion rule, and the reason there is no third value: the pet may follow the
    // host or reduce further, and never the reverse.
    Field {
        name: "motion",
        kind: Kind::Member {
            members: &["system", "reduced"],
            default: "system",
        },
    },
];

/// The fields of `character`: which character, how big, and which clip plays when.
const CHARACTER: &[Field] = &[
    Field {
        name: "characterId",
        kind: Kind::Ident,
    },
    // Upstream's unclamped `160 * size` (`main.ts:115-117`) is why this is a rule with a floor.
    Field {
        name: "size",
        kind: Kind::Number {
            min: 64.0,
            max: 320.0,
            integer: true,
            fallback: 160.0,
        },
    },
    // The sheet's own default mapping lives in `animation-bindings.ts`; a binding map that repeated
    // it here would be a second copy of the spritesheet layout to keep in step.
    Field {
        name: "bindings",
        kind: Kind::Map {
            value: MemberRule::Row,
            max: 32,
        },
    },
    // A playlist longer than the sheet has frames cannot be played: 8 columns by 9 rows is 72
    // frames, and a clip is at least one frame. Empty is a real value and not a missing one — the
    // playlist is off.
    Field {
        name: "idleClips",
        kind: Kind::List {
            member: MemberRule::Row,
            max: 72,
        },
    },
    Field {
        name: "idleMode",
        kind: Kind::Member {
            members: &["random", "sequential"],
            default: "random",
        },
    },
    // Seconds and not milliseconds, because that is the unit the control counts in; upstream's own
    // floor and default (`MIN_IDLE_INTERVAL_MS`, `DEFAULT_IDLE_INTERVAL`), with the ceiling a
    // minute: a clip that changes less often than that is a still image with a timer attached.
    Field {
        name: "idleIntervalSeconds",
        kind: Kind::Number {
            min: 1.0,
            max: 60.0,
            integer: true,
            fallback: 5.0,
        },
    },
];

/// The fields of `view`: the window's appearance and the roaming mode.
const VIEW: &[Field] = &[
    // Upstream feeds a stored value straight into an `rgba` alpha (`main.ts:93`); the floor is what
    // keeps a stored `0` from making the pet invisible rather than transparent.
    Field {
        name: "opacity",
        kind: Kind::Number {
            min: 0.15,
            max: 1.0,
            integer: false,
            fallback: 1.0,
        },
    },
    // §7.2 verifies this per desktop; the setting may hold `true` where the capability cannot
    // deliver it.
    Field {
        name: "alwaysOnTop",
        kind: Kind::Bool(true),
    },
    // Kept representable even where the capability is not: a profile follows the user between
    // machines, and §5.2 disables the *modes* the platform cannot do rather than rewriting the
    // user's setting behind their back.
    //
    // D11a's open gap is that this set has no `wander`; the member list is the schema's and the
    // gap is the motion matrix's (D13's), so nothing here closes it and nothing here may widen it.
    Field {
        name: "roam",
        kind: Kind::Member {
            members: &["off", "stay", "follow-pointer", "climb"],
            default: "off",
        },
    },
];

/// The fields of `message`: the bubble's life, its arrangement, and the words in it.
const MESSAGE: &[Field] = &[
    // §6.3's suggested bubble life.
    Field {
        name: "bubbleSeconds",
        kind: Kind::Number {
            min: 1.0,
            max: 60.0,
            integer: true,
            fallback: 6.0,
        },
    },
    Field {
        name: "theme",
        kind: Kind::Member {
            members: &["system", "light", "dark"],
            default: "system",
        },
    },
    // Upstream's three buttons are 10/12/14 and it accepts any parsed integer
    // (`settings.ts:1051`); the rule keeps upstream's span and refuses everything outside it.
    Field {
        name: "fontSize",
        kind: Kind::Number {
            min: 10.0,
            max: 14.0,
            integer: true,
            fallback: 12.0,
        },
    },
    // Upstream's 「Show idle message」, filed here rather than on `character` where the ledger's
    // table puts it: the row is a bubble-behaviour switch, and the page that draws it is 气泡与消息.
    Field {
        name: "idle",
        kind: Kind::Bool(true),
    },
    // The renderer's own member names, not upstream's `byKind`/`all`: the control and the surface
    // have to spell the same choice the same way.
    Field {
        name: "layoutMode",
        kind: Kind::Member {
            members: &["list", "compact", "carousel"],
            default: "list",
        },
    },
    // Upstream's slider is 1–10 with a default of 5 (`settings.html:380`, `settings.ts:957`).
    Field {
        name: "layoutMaxRows",
        kind: Kind::Number {
            min: 1.0,
            max: 10.0,
            integer: true,
            fallback: 5.0,
        },
    },
    Field {
        name: "grouping",
        kind: Kind::Member {
            members: &["by-agent", "flat"],
            default: "by-agent",
        },
    },
    Field {
        name: "sortByKind",
        kind: Kind::Bool(false),
    },
    // These name what the filter does to a row's alert, so a state added to the contract's union
    // does not leave a filter that quietly means something else.
    Field {
        name: "filter",
        kind: Kind::Member {
            members: &["all", "attention", "active", "working"],
            default: "all",
        },
    },
    // A closed set of *names* rather than the four characters themselves: upstream's fourth button
    // is a single space, and a stored space is a separator no reader can tell from a value that was
    // trimmed away.
    Field {
        name: "separator",
        kind: Kind::Member {
            members: &["dot", "arrow", "bar", "space"],
            default: "dot",
        },
    },
    Field {
        name: "dot",
        kind: Kind::Member {
            members: &["plain", "claude"],
            default: "plain",
        },
    },
    Field {
        name: "phraseTheme",
        kind: Kind::Member {
            members: &["chef", "engineer", "wizard", "explorer", "scientist"],
            default: "chef",
        },
    },
    Field {
        name: "leftClick",
        kind: Kind::Member {
            members: &["none", "self", "all"],
            default: "none",
        },
    },
    // §5.2 requires the list to be built 「从当前 Agent 注册表」 rather than from upstream's fixed
    // names; what is stored is the *choice*, so an id stays meaningful after the engine it names is
    // installed again — which is why an unknown id is kept and not repaired away.
    Field {
        name: "hiddenAgents",
        kind: Kind::List {
            member: MemberRule::Line {
                max_length: KEY_MAX_LENGTH,
            },
            max: 64,
        },
    },
    // The row's fields and their order. Empty means the renderer's own preset (§5.2's 预设).
    Field {
        name: "tokens",
        kind: Kind::List {
            member: MemberRule::TokenItem,
            max: 16,
        },
    },
    // Empty by default where upstream seeds five English lines (`QUICK_DEFAULTS`): those are words
    // the *pet* would say, and putting them in the user's mouth before they asked is not a default
    // this schema should decide.
    Field {
        name: "quickBubbles",
        kind: Kind::List {
            member: MemberRule::Line { max_length: 120 },
            max: 50,
        },
    },
    Field {
        name: "agentIcons",
        kind: Kind::Map {
            value: MemberRule::Line {
                max_length: KEY_MAX_LENGTH,
            },
            max: 64,
        },
    },
];

/// The fields of `notification`: which endings are worth a notice, and how one is written.
const NOTIFICATION: &[Field] = &[
    Field {
        name: "onTurnFinished",
        kind: Kind::Bool(true),
    },
    Field {
        name: "onStopped",
        kind: Kind::Bool(true),
    },
    Field {
        name: "onFailed",
        kind: Kind::Bool(true),
    },
    Field {
        name: "onWaitingInput",
        kind: Kind::Bool(true),
    },
    Field {
        name: "sound",
        kind: Kind::Bool(true),
    },
    Field {
        name: "doNotDisturb",
        kind: Kind::Bool(false),
    },
    // Off by default because §6.3 requires titles to carry no note content and no paths unless the
    // user asks for them — a default is the only place that rule can be enforced for users who
    // never open the settings page.
    Field {
        name: "showTaskTitle",
        kind: Kind::Bool(false),
    },
];

/// The fields of `care`: whether the pet keeps progress, and whether it may interrupt a session.
const CARE: &[Field] = &[
    Field {
        name: "enabled",
        kind: Kind::Bool(true),
    },
    // §8: rest reminders are switchable on their own.
    Field {
        name: "restReminders",
        kind: Kind::Bool(true),
    },
];

/// The fields of `project`: §7.1's cap, three by default and five by explicit configuration.
const PROJECT: &[Field] = &[Field {
    name: "maxCharacters",
    kind: Kind::Number {
        min: 1.0,
        max: 5.0,
        integer: true,
        fallback: 3.0,
    },
}];

/// Every field of one domain, in the schema's own order.
pub fn fields(domain: PetSettingsDomain) -> &'static [Field] {
    match domain {
        PetSettingsDomain::General => GENERAL,
        PetSettingsDomain::Character => CHARACTER,
        PetSettingsDomain::View => VIEW,
        PetSettingsDomain::Message => MESSAGE,
        PetSettingsDomain::Notification => NOTIFICATION,
        PetSettingsDomain::Care => CARE,
        PetSettingsDomain::Project => PROJECT,
    }
}

/// One domain's defaults, as the blob a record's `values` holds.
pub fn defaults(domain: PetSettingsDomain) -> Map<String, Value> {
    fields(domain)
        .iter()
        .map(|field| (field.name.to_string(), default_of(field.kind)))
        .collect()
}

/// The value a field takes when it has none, from the rule's own default.
///
/// A structured default is built fresh on every call, which is what keeps the schema's constants
/// from being handed out: the TypeScript half makes the same point about `PET_SETTINGS_DEFAULTS` —
/// a caller's draft is a reactive object it keeps editing, so a shared array would let one page's
/// edit rewrite the default every other page reads.
pub fn default_of(kind: Kind) -> Value {
    match kind {
        Kind::Bool(value) => Value::Bool(value),
        Kind::Number {
            fallback, integer, ..
        } => number_value(fallback, integer),
        Kind::Member { default, .. } => Value::String(default.to_string()),
        Kind::Ident => Value::Null,
        Kind::List { .. } => Value::Array(Vec::new()),
        Kind::Map { .. } => Value::Object(Map::new()),
    }
}

/// A number as the JSON this build writes.
///
/// Whole for a rule that requires whole numbers, and the number itself otherwise. `from_f64`
/// answers `None` only for a value that is not finite, and every value that reaches here has passed
/// the finiteness check in `values::judge` — or is a literal from the table above.
pub fn number_value(value: f64, integer: bool) -> Value {
    if integer {
        Value::from(value as i64)
    } else {
        let number = Number::from_f64(value).expect("a checked, finite number is a JSON number");
        Value::Number(number)
    }
}
