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
///
/// **Every member is a scalar, and that is the limit this vocabulary has today.** One container, one
/// scalar inside it: a field whose value nests a second container is not expressible, and the one
/// setting the port wants that would need it is the per-engine × per-state phrase pools upstream
/// stores across `ap_msg_<agent|all>_<mood>` keys
/// (`references/desktop-pet/windows/src/activity.ts:198-208`) — which
/// `features/desktop-pet/services/pet-message-template.ts`'s `PetMessagePhrases` types and no field
/// of this schema can hold. A nested kind added here, and to `pet-settings-values.ts`'s
/// `PetMemberRule` which moves with this one, is what would make such a field declarable.
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

/// The fields of `general`: §5.1's 启用, the two per-window switches, the ball's size, and the
/// motion policy.
const GENERAL: &[Field] = &[
    // §5.1's 启用, and §4's rollback — **derived, and no longer a control.**
    //
    // It is on exactly while `characterWindow` or `ball` is on, and nothing may set it to anything
    // else: [`super::values::read_values`] recomputes it on every read and every write, so the file
    // on disk never holds a contradiction and the host never has to ask which of the three wins.
    // While it *was* a control it was the defect this pair exists to end — with it off both child
    // rows were drawn disabled, so a user who wanted only the ball could not say so (「我希望桌宠和
    // 悬浮球可以分别打开分别关闭，不是强绑定的」), and it was a second answer to a question the
    // runtime state already answers by observation (`PetFeatureState::of` reads "a character window
    // or a ball is open").
    //
    // It defaults on and turns the feature *off*, for the reason `pet-contracts/config.ts` gives,
    // and that is consistent with the derivation: both switches default on. §4's rollback is what it
    // always was, said with the two switches instead of one — turning both off stops the pet and
    // cancels nothing else: no agent task, no note save, and no character, care progress or history.
    //
    // A record written by a build that had the master (schema 3) means what it said there, and the
    // migration to 4 is where that is honoured (`super::migrate`): `enabled: false` in such a record
    // was "no pet window at all", and it turns both switches off rather than letting a window the
    // user had switched off come back.
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
    // §5.1's 悬浮球, which upstream stores on its own (`read_ball_visible`, on by default,
    // `references/.../src-tauri/src/lib.rs:334-339`) and this build had no field for: the ball
    // followed the master switch, so a user who wanted the character and not the ball could not say
    // so. On by default because that is what upstream's `unwrap_or(true)` means and what this build
    // already did — the field makes the existing behaviour a choice rather than changing it.
    //
    // It is *preference about one of the pet's windows*, not a second master switch: the ball exists
    // when this is on, and nothing above it decides otherwise — `enabled` is derived *from* this
    // field and its peer, so the two can never disagree.
    Field {
        name: "ball",
        kind: Kind::Bool(true),
    },
    // §5.1's 显示角色窗口 — the plan's 「主角色显示」, which is upstream's 「Show main pet」
    // (`references/desktop-pet/windows/settings.html:69-71`, applied by `set_pet_visible`,
    // `windows/src-tauri/src/lib.rs:613-623`). A port and not an addition: upstream can show its
    // ball without the character, and that row is how.
    //
    // The second of the two per-window switches beside `ball`, and the reason the pair exists: these
    // two govern the windows, and off-with-`ball`-on is 「只开悬浮球」. On by default because that is
    // what upstream's own `checked` means and what this build did before the field existed, so no
    // stored record gains or loses a window by being read here.
    Field {
        name: "characterWindow",
        kind: Kind::Bool(true),
    },
    // The floating ball's diameter in CSS pixels: upstream's `--ball-size` (`styles.css:227-236`,
    // 56 px inside an 80 px window with a 12 px margin for the shadow and the hover scale).
    //
    // Filed here, beside the ball's own switch, and not in `character`: the ball wears a character's
    // face when there is one, but it is a window of its own that is on the desktop with no character
    // chosen at all — so this is not a property of the character, and `character.size` cannot be a
    // second control for it. A domain of the ball's own was the alternative and was not taken: the
    // domains are §5.3's, a new one would have to move `PET_SETTINGS_DOMAINS` and every reader of
    // it, and 悬浮球 already has its home here (§5.1's 常规与交互 draws both of its rows).
    //
    // It is the *orb's* diameter and not the window's: the window is `ball + 2 * BALL_MARGIN`
    // (`desktop_pet::ball`), which is the same 80 px at this default. One stored number, read by the
    // host for the window and by the ball's page for the orb — see `ball.rs` for why the margin is
    // the only constant left between them, and `tests/desktop_pet_settings_test/geometry.rs` for the
    // test that fails if the two drift.
    Field {
        name: "ballSize",
        kind: Kind::Number {
            min: 32.0,
            max: 128.0,
            integer: true,
            fallback: 56.0,
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

/// The fields of `view`: the window's behaviour and the roaming mode.
const VIEW: &[Field] = &[
    // §7.2 verifies this per desktop; the setting may hold `true` where the capability cannot
    // deliver it.
    //
    // Not a migrated upstream setting: upstream hardcodes `.always_on_top(true)` at each of its
    // four builders (`references/desktop-pet/windows/src-tauri/src/lib.rs:295,368,463,557`) and
    // its settings page has no row for one. It is this port's own §7.2 gate around a preference,
    // and `window_host` is what applies it to the windows that preference governs.
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
    // The bubble's *background* alpha (`ap_opacity`), which upstream feeds straight into
    // `--bubble-bg`'s `rgba(…, op)` (`references/desktop-pet/windows/src/main.ts:88-100`, control
    // at `settings.html:172-173` on the Bubble page). It is not a window opacity: upstream never
    // had one, and no crate in this build's tree exposes a window-opacity call to port one with.
    //
    // The ends and the default are upstream's own slider — 60 to 100 percent, opening on 92 —
    // because the floor is what keeps a stored value from leaving a bubble whose text cannot be
    // read, which is the one thing the surface exists to avoid.
    Field {
        name: "opacity",
        kind: Kind::Number {
            min: 0.6,
            max: 1.0,
            integer: false,
            fallback: 0.92,
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
    // §5.2 requires the list to be built 「从当前 Agent 注册表」 rather than from upstream's fixed
    // names, and the settings dialog has no registry to read — so this is the one field of the
    // domain with no control, and the one the page states in words. It stays because the control is
    // a later piece of work and this is what it will write.
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
