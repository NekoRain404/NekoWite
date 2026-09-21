//! What a caller reads back: the instance an open produced, the refusal that stopped one, and the
//! report a teardown returns.
//!
//! Split out of `window_host.rs` when that file passed the line budget `docs/dev.md:286` puts on a
//! business source file. These are the shapes the IPC surface and the settings page consume — their
//! `serde` attributes are the wire form — and they change for reasons the host's logic does not: a
//! failure that has to be explainable, a field a report has to carry. §4's 「关闭不影响 Agent 工作、
//! 笔记保存与原设置页」 is enforced as much by what [`TeardownReport`] *cannot* hold as by what it
//! does: there is nowhere in it to record a cancelled run, a deleted character or a cleared ledger.
//! The host produces these values; nothing here can produce a window.

use serde::Serialize;

use super::identity::PetWindowLabel;

/// Which window operation failed, so a refusal reads as a sentence rather than as "it broke".
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowAction {
    Open,
    Close,
    Show,
    Hide,
    ClickThrough,
    /// Changing which stack a window sits in (`view.alwaysOnTop`). A window operation and not a
    /// settings one: the setting is stored whether or not it can be delivered, and this is what a
    /// compositor refusing the change is reported under.
    AlwaysOnTop,
    /// Giving an open window a new size (`character.size`, `general.ballSize`). The same shape as
    /// [`Self::AlwaysOnTop`]: the setting is stored whether or not the compositor honours it, and
    /// §7.2's 「asked for」 is what a refusal here means.
    Resize,
}

/// Why the host refused.
///
/// `UnrecognizedCaller` carries the label it saw rather than being a unit, because the two cases
/// that reach it — the main window, and a label from a pet window that has since closed — are
/// told apart by exactly that string, and a refusal that names what it refused is the difference
/// between a diagnosable report and "the pet stopped working".
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "reason", rename_all = "kebab-case")]
pub enum HostRefusal {
    UnrecognizedCaller {
        observed: String,
    },
    CapReached {
        cap: usize,
        open: usize,
    },
    Window {
        action: WindowAction,
        detail: String,
    },
}

/// One character window.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetInstance {
    /// Host-assigned, and the only identifier a caller ever sees.
    pub id: u32,
    pub label: PetWindowLabel,
    pub character_id: String,
}

/// What one close did.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Closed {
    pub label: PetWindowLabel,
    pub character_id: String,
}

/// What tearing the pet down did.
///
/// Both fields describe a *window*, which is the claim (§7.1: 「禁用桌宠销毁动画/监听/计时器，不
/// 取消后台 Agent 任务」; §4: 「关闭不影响 Agent 工作、笔记保存与原设置页」 and 「不删除已导入的
/// 角色与养成数据」). There is nowhere in this type to record a cancelled run, a deleted character
/// or a cleared ledger, and nowhere in this module to obtain one: the alternatives are not merely
/// unhandled, they are unrepresentable. `failed` exists so that a window the compositor would not
/// close is neither swallowed nor mistaken for a success — it stays in the registry and a later
/// teardown retries it.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeardownReport {
    pub closed: Vec<Closed>,
    pub failed: Vec<HostRefusal>,
}
