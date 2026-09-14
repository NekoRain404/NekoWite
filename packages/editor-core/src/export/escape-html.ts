/**
 * The escaping every dynamic string in an exported document goes through.
 *
 * The exported HTML is opened OUTSIDE the app, in a browser or a PDF viewer
 * where the app's CSP is not in force, and its text comes from a note the user
 * may have received from anywhere. So it is not enough to escape markup
 * characters: the text is placed inside elements AND inside quoted attributes
 * (`alt`, `href`, `id`, `data-target`, the document title), which need the two
 * quote characters too. `'` is escaped as `&#39;` rather than `&apos;` because
 * HTML 4 — the parsing mode some PDF and mail renderers still use — does not
 * define the named entity.
 *
 * It lives in its own module because four separate concerns (node rendering,
 * bibliography entries, the document frame and the URL-bearing attributes) all
 * need it, and none of them should have to import the others to get it.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
