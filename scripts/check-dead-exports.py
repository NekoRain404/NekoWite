#!/usr/bin/env python3
"""Exported functions that nothing calls — not another module, and not their own.

`check-reachability.py` asks whether a *module* is reachable. This asks the next question down, and
it is the one that kept hiding in the noise: a module can be imported by the page and still export a
function that only its spec ever calls.

`retargetSvgInsertion` is the case that made this worth writing. §7.3 requires re-confirming an
insertion after the reader switches notes; the function implements it, its spec covers it, the
module it lives in is imported by the panel — and its only caller in the whole tree is its own
`.test.ts`. The feature has a design, an implementation, a test and no user.

The first pass at this asked the wrong question. It reported every exported name with no reader in
another production file and produced 846 hits, almost all of them the ordinary "exported so the
spec can reach it" idiom — a helper called three lines below its own declaration. Reading that list
as noise is what let the real cases sit in it. So this pass separates the two:

  * **used in its own file** — the definition is not the only mention. Ordinary, not reported.
  * **not used in its own file either** — the export is the only thing that ever names it. Reported.

Types and interfaces are excluded: an exported type is a contract, and TypeScript's `import type`
leaves no runtime caller to look for. Only `function` and arrow-function `const` are checked, and
only from files that are not specs themselves.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = [ROOT / 'apps/desktop/src', ROOT / 'packages']

# `export function name(`, `export async function name(`, `export const name = (…) =>`,
# `export const name = function`. Deliberately not `export const NAME = 3` — a constant is read by
# its own module as often as by another, and mixing them back in is how the first pass got noisy.
DECL = re.compile(
    r'^export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(<]'
    r'|^export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*=>'
    r'|^export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s+)?function\b',
    re.M,
)


def main() -> int:
    files = [
        p for root in SRC
        for p in root.rglob('*')
        if p.suffix in ('.ts', '.vue') and 'node_modules' not in p.parts and 'target' not in p.parts
    ]
    prod = [p for p in files if '.test.' not in p.name and '.spec.' not in p.name]
    texts = {p: p.read_text(encoding='utf-8', errors='replace') for p in files}

    # Controls. The first two are called from another production file and must NOT be reported; the
    # third is a known real instance and MUST be, so the run proves it can still fail. `diffRows`
    # was the first negative control and it was a bad choice: nothing outside its own module calls
    # it — it is exported so its spec can reach it, which is the ordinary idiom and the reason the
    # report separates `own` mentions instead of treating every hit as a finding.
    must_be_absent = {'applyAgentEvent', 'useAgentCommands'}
    must_be_present = {'retargetSvgInsertion'}

    dead: list[tuple[Path, str, int, int]] = []
    checked = 0
    for p in prod:
        text = texts[p]
        for m in DECL.finditer(text):
            name = next(g for g in m.groups() if g)
            checked += 1
            # Mentions anywhere in the tree except this file's own declaration line.
            elsewhere_prod = sum(
                1 for q, t in texts.items()
                if q != p and '.test.' not in q.name and '.spec.' not in q.name
                and re.search(r'\b' + re.escape(name) + r'\b', t)
            )
            if elsewhere_prod:
                continue
            own_mentions = len(re.findall(r'\b' + re.escape(name) + r'\b', text))
            tests_that_call = sorted(
                q.name for q, t in texts.items()
                if '.test.' in q.name or '.spec.' in q.name
                if re.search(r'\b' + re.escape(name) + r'\b', t)
            )
            dead.append((p, name, own_mentions, len(tests_that_call)))

    shown = {n for _p, n, _o, _t in dead}
    print('=== controls ===')
    blind = False
    for c in sorted(must_be_absent):
        ok = c not in shown
        blind |= not ok
        print(f'  {c:24} absent from the report: {ok}')
    for c in sorted(must_be_present):
        ok = c in shown
        blind |= not ok
        print(f'  {c:24} present in the report: {ok}')
    print(f'  exported functions checked: {checked}')
    if blind:
        print()
        print('  ** A CONTROL FAILED. This run is blind — fix the sweep before reading the list. **')
    print()

    # Only the ones their own file never calls. A function mentioned twice in its own file is called
    # three lines below its declaration, which is how this codebase exposes a helper to its spec.
    truly = [r for r in dead if r[2] == 1]
    print('=== exported functions nothing calls, anywhere ===')
    for p, name, own, tests in sorted(truly, key=lambda r: (str(r[0]), r[1])):
        print(f'  spec={tests:<2} {name:36} {p.relative_to(ROOT)}')
    print(f'  ({len(truly)} of {checked} exported functions; '
          f'{len(dead) - len(truly)} more are called inside their own file)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
