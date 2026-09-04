// Minimal NekoWite plugin ("hello").
//
// It demonstrates the stable public plugin SDK: the definition is built with
// `definePlugin` from the public barrel `@nekowite/plugin-host` (never a deep
// path into the package), declares an optional permission, registers a toolbar
// item, and leans on the lifecycle hooks. The host activates it, wires the
// toolbar/commands, and isolates hook failures.
//
// Running environment: the host loads the plugin with `import(main)` and calls
// `activatePlugin` after integrity + consent checks, so the toolbar item and
// hooks are registered through the host's capability gateway, never the plugin
// reaching Tauri IPC directly.

import { definePlugin, getActiveEditor } from '@nekowite/plugin-host'

// Toolbar items run with no arguments (the host gives them no editor). To act
// on the live document, read the active editor from the plugin-host singleton.
function insertGreeting() {
  const editor = getActiveEditor()
  if (!editor?.insertMarkdownAtCursor) return
  void editor.insertMarkdownAtCursor('Hello from the hello plugin!\n')
}

export default definePlugin({
  name: 'hello',

  // Declared capabilities the host surfaces to the user before activation. Only
  // `ai`, `fs`, and `network` are treated as dangerous (gated behind consent);
  // `clipboard` is currently not in the dangerous set, but declaring it makes
  // the plugin's intent explicit. A plugin reaches full IPC/fs powers only by
  // declaring the corresponding dangerous permission — and even then only by
  // user consent, not true capability isolation (see docs/PLUGIN_SDK.md).
  permissions: ['clipboard'],

  toolbar: [
    {
      id: 'hello.insert-greeting',
      label: 'Insert greeting',
      run: insertGreeting,
    },
  ],

  onLoad(ctx) {
    console.log(`[hello] plugin "${ctx.name}" loaded`)
    // Returning a function makes it the unload cleanup; the host runs it exactly
    // once on deactivate.
    return () => console.log(`[hello] plugin "${ctx.name}" unloaded`)
  },

  onEditorReady() {
    console.log('[hello] editor ready')
  },

  onDocChange(_ctx, e) {
    console.log('[hello] document changed', e.doc.length)
  },
})
