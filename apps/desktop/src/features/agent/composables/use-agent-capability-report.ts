/**
 * The engine's own account of what it answers, read once for the panel's runtime.
 *
 * The whole report is kept as it arrived, for the surfaces that need a fact the panel does not read
 * itself. The composer is handed the *report* rather than two more booleans, because a boolean
 * cannot carry the third state: `unavailable` and `unverified` are different facts about an engine,
 * and a surface that showed them alike would be telling a reader their engine refuses something
 * nobody ever asked it. The history surface reads its own two gates off the same report — an engine
 * may answer `session/close` without answering `session/list`, and each control is drawn on its own
 * answer rather than on the pair.
 *
 * `null` is a state of its own and not an empty report — a report this window cannot read is
 * rejected rather than shortened (`tauri-agent.ts`), so no surface may answer a reader with "names
 * no such feature" for a report nobody holds. The two part company in a *sentence* and in nothing
 * else: the controls either withholds are the session-history ones and no others — the composer's
 * are drawn on neither, as `AgentComposer.vue`'s `capabilities` prop now says — and what a `null`
 * decides about an attachment is what the reader is *told* (`attachmentStanding`). This paragraph
 * said "both leave every control un-drawn", which was the same overstatement in a third file.
 *
 * The report belongs to the runtime the session belongs to and is read once, on mount: a panel is
 * mounted per session, and a runtime the host has replaced has no answer left to give. It was the
 * panel's own state and this is that state, moved out when `AgentPanel.vue` was split — the read
 * moved and the doctrine travelled with it, because a second reader of this report is exactly the
 * mistake the two paragraphs above are written against.
 */
import { onMounted, ref, type Ref } from 'vue'
import type {
  AgentCapabilityReport,
  AgentGateway,
  AgentSession,
} from '../../../platform/gateways/agent-contracts'

export interface UseAgentCapabilityReportOptions {
  /** The adapter behind the session, chosen at the composition site (§6.1). */
  gateway: AgentGateway
  /** The session whose runtime is being asked. Read once — a panel is mounted per session. */
  session: AgentSession
}

/**
 * The engine's report for this session's runtime, as it arrived: `null` until it does, and `null`
 * again if it never does. What the three states mean is stated in this file's header.
 */
export function useAgentCapabilityReport(
  options: UseAgentCapabilityReportOptions,
): Ref<readonly AgentCapabilityReport[] | null> {
  const reports = ref<readonly AgentCapabilityReport[] | null>(null)

  onMounted(async () => {
    try {
      reports.value = await options.gateway.capabilities(options.session)
    } catch {
      // Nothing arrived, so nothing is offered — and the ref stays `null` rather than being folded
      // into an empty report. The two are different states: see the note above for the sentence they
      // part company in.
      reports.value = null
    }
  })

  return reports
}
