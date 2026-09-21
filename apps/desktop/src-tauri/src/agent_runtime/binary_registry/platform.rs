//! `binary_registry`'s child: which machine this build is for.
//!
//! Split out of `binary_registry.rs` when it passed §13.1's 600-line default (docs/dev.md §5.4.2:
//! 超过 600 行应默认进入拆分 backlog). The seam is "changes when the architecture this release
//! claims changes": one target string, the question whether a release record names it, and the ELF
//! machine value that question is asked against. A second architecture is a second artifact and a
//! second compatibility verification, so it lands here rather than in the file that orders versions
//! or the one that refuses roots.

/// The `e_machine` value for [`SUPPORTED_TARGET`] — `EM_X86_64`, from the ELF specification.
///
/// `pub(super)`, and it was private before the split: a child module's private item is not reachable
/// from the module it was split out of (E0603), and the one reader is `elf.rs`'s `check_elf` — so
/// `pub(super)` is `binary_registry` and its descendants, the narrowest scope that compiles.
pub(super) const EM_X86_64: u16 = 62;

/// The only architecture this release claims to support (§3.2: 只声称支持实际验证的架构).
///
/// A second architecture is a second artifact and a second compatibility verification, so it is not
/// a matter of adding a name here.
pub const SUPPORTED_TARGET: &str = "x86_64-unknown-linux-gnu";

/// The target this host can install for.
pub fn supported_target() -> &'static str {
    SUPPORTED_TARGET
}

/// Whether this release claims to support `target`.
pub fn is_supported(target: &str) -> bool {
    target == SUPPORTED_TARGET
}
