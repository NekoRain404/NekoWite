# NekoWite Agent Instructions

本文件是仓库级开发规范，优先级高于个人习惯。所有 agent、子代理和自动化任务都必须遵守。`NekoWite_win` 不属于本项目的扫描、重构、测试和发布范围。

## Shell

- Use the Linux shell available in the execution environment.
- Prefer POSIX commands: `&&`, `||`, `for`, `export`, `test`, `rg`, `sed`, `find`, `git`.
- Use `bash` for repository scripts and avoid shell-specific quoting tricks.
- Never use commands that modify files outside the repository.
- Before destructive operations, resolve the exact target with `pwd`, `git status` and a read-only listing.

## Python

- Use `python` only for analysis or scripts that are already part of the repository.
- Prefer `pathlib` for precise path handling; do not use Python as an ad-hoc replacement for `apply_patch`.

## pnpm

- Use `npx --yes pnpm <command>` from the repository root when `pnpm` is unavailable.
- Do not change lockfiles unless dependency changes are explicitly requested.

## Platform and repository scope

- Target platform is Linux. Validate AppImage, deb and rpm workflows only.
- Exclude `NekoWite_win`, `node_modules`, `target`, `release`, `test-results` and `.worktrees` from source scans and refactors.
- Preserve the existing light/dark theme base and accent colors unless the task explicitly changes them.
- Use Chinese-language mirrors when network access is needed and the project permits it.

## Code quality

- Keep business source files under 500 lines. At 300 lines, plan a split; at 400 lines, split in the current change; at 500 lines, stop adding code.
- Tests may be larger, but split them by behavior domain when they exceed 800 lines.
- Prefer vertical feature slices over generic `utils`, `helpers`, `common`, `manager` or `misc` modules.
- UI components orchestrate props, events and rendering; they do not contain filesystem transactions, path policy or provider logic.
- Stores own reactive state and public actions; services own testable business logic; platform owns Tauri and system adapters.
- Use dependency injection for filesystem, clock, randomness, network, clipboard and notifications.
- Use explicit result/error types for expected failures. Do not swallow exceptions or leave unhandled promises.
- Avoid implicit global state and hidden reads of the active tab or active vault.

## Naming

- Vue components: `PascalCase.vue`.
- TypeScript files: `kebab-case.ts`.
- Rust files: `snake_case.rs`.
- Pinia stores: `useXxxStore`.
- Types: `PascalCase`; constants: `UPPER_SNAKE_CASE`.
- Use precise names instead of `utils`, `helpers`, `data`, `manager` or `common`.
- Keep verbs consistent: `open`, `load`, `read`, `save`, `rename`, `delete`, `remove`, `close`.
- `delete` means persistent deletion; `remove` means removing an in-memory item; `close` means ending a UI session.

## Comments

- Comments must explain why: security boundaries, locking, rollback order, platform differences and compatibility behavior.
- Do not write comments that merely repeat the next line of code.
- Add a short orienting comment before complex transactions or non-obvious workarounds.
- Security and recovery invariants require comments next to the enforcement point.

## Testing and verification

- For bug fixes, write a regression test that reproduces the original symptom before changing implementation.
- Run the smallest relevant test first, then typecheck, lint, full tests and build.
- Never claim a fix or completion without fresh command output and exit code 0.
- Security tests must cover IPC boundaries, not only internal helper functions.
- Tests must cover failure paths, cancellation, concurrency and stale state where the feature performs IO.

Required Linux verification before release:

```bash
npx --yes pnpm typecheck
npx --yes pnpm lint
npx --yes pnpm test
npx --yes pnpm build
```

## Project management

- Read the relevant design/plan document before changing code.
- Break work into tasks of one independently testable behavior.
- Each task states files, acceptance criteria, test command and rollback risk.
- Keep commits small and single-purpose, using `feat:`, `fix:`, `refactor:`, `test:` or `docs:` prefixes.
- Do not mix formatting-only changes with behavior changes.
- Check `git status --short` before and after each task; preserve unrelated user changes.
- Use a design review before implementation for new behavior and a code review before merge.
- Update architecture or migration documentation only through the primary agent; implementation subagents must not overwrite project specifications.

## Subagent rules

- The primary agent assigns narrow, independent tasks and reviews every diff.
- Subagents may modify only files explicitly listed in their task.
- Subagents must not modify, overwrite, rename, move or delete `AGENTS.md`, `docs/development/DEVELOPMENT-ROADMAP.md`, design specs or implementation plans.
- Subagents must not use `git reset`, `git checkout`, `git restore` or destructive cleanup to erase user work.
- A subagent report must include changed files, tests run, failures and remaining risks.
- The primary agent independently verifies the report before claiming completion.

## Change checklist

Before handoff, confirm:

- Scope excludes `NekoWite_win` and generated artifacts.
- No source file exceeds the line budget without a documented exception.
- Names and imports follow the conventions above.
- Complex logic has reason-focused comments.
- Regression and failure-path tests exist.
- Typecheck, lint, tests and Linux build have fresh passing output.
- Documentation was not modified by implementation subagents.
