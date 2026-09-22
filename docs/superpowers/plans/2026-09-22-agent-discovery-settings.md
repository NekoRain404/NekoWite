# Agent Discovery and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linux known-agent discovery, explicit ACP/native-terminal launch entry points, and a clearer modal Agents settings workflow.

**Architecture:** A Rust discovery service scans a closed Linux command catalog and returns redacted candidates. A thin gateway exposes discovery to Vue; the Agents settings section presents overview, installed, discover, permissions, and terminal pages without moving filesystem or process logic into components. CLI parsing lives at the Tauri entry boundary and delegates to the same registry/lifecycle ports.

**Tech Stack:** Rust/Tauri 2, Vue 3, TypeScript, Vitest, Rust integration tests.

---

### Task 1: Linux discovery service

**Files:**
- Create: `apps/desktop/src-tauri/src/agent_runtime/discovery.rs`
- Modify: `apps/desktop/src-tauri/src/agent_runtime/mod.rs`
- Test: `apps/desktop/src-tauri/src/agent_runtime/discovery.rs` tests

- [ ] Add an injected filesystem/process probe and a closed catalog for `codex`, `claude`, `cursor-agent`, `gemini`, `qwen`, and `opencode`.
- [ ] Return absolute path, display name, adapter id, args, version, and availability without environment values.
- [ ] Deduplicate by resolved executable path and sort by catalog order.
- [ ] Test PATH lookup, duplicate PATH entries, missing programs, and failed version probes.

### Task 2: Discovery IPC

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/agent_registry.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/build.rs`
- Modify: `apps/desktop/src/platform/gateways/tauri-agent/registry.ts`
- Modify: `apps/desktop/src/features/agent-settings/services/agent-registry-ipc.ts`
- Test: existing registry IPC tests and a discovery regression test

- [ ] Add `agent_registry_discover` with a typed wire shape and explicit retry-safe errors.
- [ ] Keep discovery read-only; candidate insertion must call the existing add transaction.
- [ ] Validate the wire response and reject malformed candidates without rendering them.
- [ ] Verify ACL/schema registration and IPC failure paths.

### Task 3: Modal Agents hierarchy

**Files:**
- Modify: `apps/desktop/src/features/settings/components/AgentSettingsSection.vue`
- Modify: `apps/desktop/src/features/settings/components/AgentSettingsNavigation.vue`
- Create: `apps/desktop/src/features/agent-settings/components/AgentDiscoverySettings.vue`
- Test: `apps/desktop/src/features/settings/components/SettingsPanel.agents.discovery.test.ts`

- [ ] Split the current Agents page into overview, installed/registry, discover, permissions, and terminal pages while preserving existing page ids and selectors.
- [ ] Add a discover page with scan, retry, candidate state, and explicit Add action.
- [ ] Make the active page heading and one primary action visually dominant; keep secondary facts subdued.
- [ ] Test scan success, scan failure/retry, add success, duplicate refusal, and narrow modal layout.

### Task 4: Native terminal launch entry point

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/src/cli.rs`
- Test: `apps/desktop/src-tauri/src/cli.rs` tests

- [ ] Parse `agent <id>` and `terminal <command> [args...]` without shell string splitting.
- [ ] Delegate ACP launch to the registered lifecycle path and terminal launch to the existing terminal/session gateway.
- [ ] Return stable non-zero errors for missing, unknown, or empty commands.
- [ ] Test valid and invalid argument vectors without spawning real external programs.

### Task 5: Verification and release

**Files:**
- Modify: `docs/superpowers/plans/2026-09-22-agent-discovery-settings.md`

- [ ] Run focused Rust and desktop tests.
- [ ] Run `npx --yes pnpm typecheck`, `npx --yes pnpm lint`, `npx --yes pnpm test`, and `npx --yes pnpm build`.
- [ ] Run `npx --yes pnpm --dir apps/desktop tauri build` for AppImage, deb, and rpm.
- [ ] Copy verified Linux artifacts into `release/` and record checksums.
- [ ] Commit each independently testable task with `feat:` or `test:` prefixes.

