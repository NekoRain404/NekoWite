/**
 * Why a change could not be put back — the host's own refusal vocabulary, arm for arm with
 * `agent_runtime::recovery::RecoveryRefusal`, and the answer that carries one.
 *
 * Kept apart from the calls because a refusal is data the host produces and a surface renders rather
 * than a property of any one call: the codes change when the recovery path learns a new reason to
 * stop, and the gateway's `recoverChange` merely hands one back.
 */

/**
 * Why a change could not be put back — the host's own vocabulary, arm for arm with
 * `agent_runtime::recovery::RecoveryRefusal`.
 *
 * A refusal is data rather than a failure, exactly as the settings pages' refusals are: each of
 * these is a different thing for the reader to do, and a surface renders the code through its
 * copy tree. The list is a runtime value because the host's answer is validated against it — a
 * code this window does not know is refused rather than passed to a renderer with no sentence.
 */
export const AGENT_RECOVERY_REFUSALS = [
  /** Nothing was recorded for this path: a file the engine created, or one it changed with its
   *  own tools rather than through this host. §7.2's 「没有基线时标记不可直接恢复」. */
  'no-baseline',
  /** The version the change replaced is not the one this host holds — the file moved between the
   *  baseline and the write. Putting the held text back would undo an edit that was never part
   *  of the change. */
  'baseline-stale',
  /** The file could not be read where the change's result should be: deleted, renamed, or not
   *  text this app can read. Neither is claimed. */
  'unavailable',
  /** The file is not what the change left — somebody edited it since. §7.2's 「不一致则三方比较/
   *  人工合并，不能覆盖用户后续编辑」: the reader is owed a comparison, not a decision. */
  'changed-since-recorded',
  /** The file already holds the baseline, so there is nothing to put back — and reporting a
   *  recovery would be the fabricated undo §7.2 forbids. */
  'already-at-baseline',
  /** The app's own write path refused it: a read-only destination, a path that left the vault,
   *  a file that is not text. The change is untouched. */
  'write-refused',
] as const

export type AgentRecoveryRefusalCode = (typeof AGENT_RECOVERY_REFUSALS)[number]

/**
 * What a recovery did, or why it did not.
 *
 * `kind` is the arm and `code` is the condition, and both are needed: a surface renders the code
 * while a caller branches on the arm before reading either.
 */
export type AgentChangeRecovery =
  | {
      readonly kind: 'recovered'
      readonly path: string
      /** The version that was put back, and the one it replaced — both hashes, so a surface can
       *  say what moved without holding either text. */
      readonly baselineHash: string
      readonly replacedHash: string
      /**
       * The app's own warning about the optional part of the save — the history snapshot — or
       * null. Carried rather than dropped: "recovered, but the previous version could not be
       * kept" is something the reader has to be told.
       */
      readonly warning: string | null
    }
  | {
      readonly kind: 'refused'
      readonly path: string
      readonly code: AgentRecoveryRefusalCode
    }
