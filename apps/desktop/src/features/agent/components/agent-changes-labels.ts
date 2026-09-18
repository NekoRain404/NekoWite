/**
 * The change view's copy, handed in rather than reached for.
 *
 * The same arrangement as `AgentPanelLabels`, and for the same reason: this component does not own
 * `src/i18n/namespaces/agent.ts`, so a sentence printed from a catalogue key that does not exist
 * would ship as an English string in a Chinese window. The caller supplies the words, and a
 * missing one is a compile error at the composition site instead of a surprise on screen.
 *
 * It lives beside `AgentChangesView.vue` rather than in it for the reason `agent-skills-labels.ts`
 * gives next to its own caller: this is the view's *interface with its caller*. One entry per
 * sentence on screen is a table that changes when a sentence changes and never when a behaviour
 * does, and the two callers — `AgentChangedFiles.vue`, which assembles it from the catalogue, and
 * the e2e fixture, which hands a mounted component a literal one — both need it and neither needs
 * the view. The component re-exports it, so the specifier they already name is unchanged.
 *
 * There is no builder here as there is in the settings label files: this feature's copy is still
 * assembled by the caller that owns the catalogue keys, and nothing in this file reads one.
 */

export interface AgentChangesLabels {
  title: string
  /** Nothing has changed yet: said, rather than left as an empty box. */
  empty: string
  /** One line for the whole list, counts and all — what the header still reads when collapsed. */
  summary: string
  collapse: string
  expand: string
  /**
   * What the row claims about who changed the file — §7.2's three states, each its own sentence
   * because they are three different facts and the user is owed the difference.
   */
  attribution: {
    /** A write-kind tool call of this session named the file. */
    agent: string
    /** The file changed on disk and nothing in this session claims it. */
    external: string
    /** The engine named the path; no tool call and no disk change confirmed it. */
    reported: string
  }
  /** What this window holds for the file, when a tab holds it at all. */
  verdict: {
    followsDisk: string
    unsavedEdits: string
  }
  /** The three answers, in the order the row draws them: look at it, keep it, put it back. */
  offer: {
    view: string
    keep: string
    recover: string
  }
  /** Why an action is not on the row. Codes in, sentences out — see `AgentChangeRefusal`. */
  refused: {
    notAgentChange: string
    writeInFlight: string
    noBaseline: string
    vaultMismatch: string
    unsavedEdits: string
    resultUnstated: string
    changedSince: string
  }
  /** What the user answered, said on the row that is no longer asking. */
  decision: {
    kept: string
    rejected: string
  }
  /** What a rejection did, in the three facts §7.2 keeps apart — the editor's own write. */
  written: {
    saved: string
    saveFailed: string
    unavailable: string
  }
  /**
   * What the host's own recovery did, and why it did not.
   *
   * `recovered` is the file put back, and `recoveredWarning` is drawn under it when the app could
   * not keep the version it replaced — "the file is back, but the previous version is gone" is a
   * fact the reader has to be told. `refused` is keyed by the host's own six codes, one sentence
   * each, for the same reason the review's refusals are: each names a different thing to do.
   */
  recovered: {
    recovered: string
    recoveredWarning: string
    refused: {
      noBaseline: string
      baselineStale: string
      unavailable: string
      changedSinceRecorded: string
      alreadyAtBaseline: string
      writeRefused: string
    }
    /** The call itself did not complete; the host's own sentence says which fact it was. */
    unreachable: string
  }
  /** The two texts of a note in conflict, labelled so a merge view cannot show one as the other. */
  unsavedBuffer: string
  agentVersion: string
  diskUnread: string
}
