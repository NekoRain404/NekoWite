/**
 * Types shared inside the settings feature (§13.9).
 *
 * `SettingsSectionId` is the contract between the navigation rail and the panel
 * that switches sections: the rail owns the table of sections it renders, and
 * the panel owns the `v-if` that shows one, so the union is the one place the
 * two are checked against each other.
 */
export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'editor'
  | 'export'
  | 'ai'
  | 'plugins'
  // The agent surface (ACP plan §8's 「运行时、供应商/模型、Skills、命令/Agents、MCP、权限、诊断」).
  // One member for the whole tree rather than one per page: the tree has seven pages of its own
  // and a navigation rail that grew by seven rows would be a different control. `agents` is
  // last, which is where a section with no control that changes the document belongs.
  | 'agents'
