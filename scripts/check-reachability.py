#!/usr/bin/env python3
"""Walk the real import graph from the three pages Vite builds, and name what the walk never enters.

This answers the question the name-level sweep could not. `diffRows` is exported, is called from its
own module, and is imported by its own spec — that is the ordinary "exported for the test" idiom and
it is fine, because the production path through its module is intact. What is *not* fine is a whole
module that only a spec imports: `AgentCommandMenu.vue` was covered by a passing test and mounted by
no page, so the `/` command menu existed everywhere except in front of the user.

That distinction is why this walker exists. It starts where the browser starts — the `<script
type="module">` of `index.html`, `desktop-pet.html`, `desktop-pet-ball.html`, the same three inputs
`vite.config.ts` names — and follows static imports, side-effect imports, re-exports and dynamic
`import()` through relative and `/src/` specifiers. Spec files are never followed *from*: a test that
imports a module does not make that module reachable from a page, and counting it is the exact error
that makes this sweep answer "all clear" about the thing it was written to find.

Controls are printed first and must all read True. If a control reads False the run is blind, not
clean — say so rather than reporting the orphan list.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'apps/desktop'
ENTRIES = [
    APP / 'src/main.ts',
    APP / 'src/app/desktop-pet-entry.ts',
    APP / 'src/app/desktop-pet-ball-entry.ts',
]
# `path.resolve()`, not `Path.resolve()` — Path would hit the filesystem, and these files are only
# ever asked for as keys in a dict, so a pure string normalisation is both faster and safe here.
SCAN_ROOTS = [APP / 'src', ROOT / 'packages']

SPECIFIER = re.compile(
    r"""(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]"""
    r"""|(?:^|\n)\s*import\s*['"]([^'"]+)['"]"""
    r"""|import\s*\(\s*['"]([^'"]+)['"]\s*\)"""
    # A worker is reached by a URL, not by an import: `new Worker(new URL('./x.ts', import.meta.url))`
    # is a real edge that no import statement spells. Leaving it out cost a finding here — the graph
    # layout worker read as dead code when `graph-layout-client.ts` starts it on every open.
    r"""|new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)""",
    re.M,
)
EXTENSIONS = ('', '.ts', '.tsx', '.vue', '.js', '.mts', '.json')


def is_spec(path: Path) -> bool:
    return '.test.' in path.name or '.spec.' in path.name


# The two workspace packages the app imports by name. Leaving these unresolved is not a small gap:
# `@nekowite/editor-core` is the editor, so a resolver that skips bare specifiers never enters
# `packages/` at all and reports all 500-odd files under it as unreachable. The first version of
# this walker did exactly that. Every one of those files was reachable.
WORKSPACE = {
    '@nekowite/editor-core': ROOT / 'packages/editor-core/src/index.ts',
    '@nekowite/plugin-host': ROOT / 'packages/plugin-host/src/index.ts',
}


def resolve(spec: str, importer: Path) -> Path | None:
    spec = re.split(r'[?#]', spec)[0]
    if spec in WORKSPACE:
        return WORKSPACE[spec].resolve()
    if spec.startswith('/src/'):
        base = APP / spec.lstrip('/')
    elif spec.startswith('.'):
        base = (importer.parent / spec)
    else:
        return None  # a third-party package: not part of this tree
    for ext in EXTENSIONS:
        cand = base.with_suffix(base.suffix + ext) if ext else base
        if cand.is_file():
            return cand.resolve()
    for index in ('index.ts', 'index.vue'):
        cand = base / index
        if cand.is_file():
            return cand.resolve()
    return None


def main() -> int:
    files = [
        p.resolve()
        for root in SCAN_ROOTS
        for p in root.rglob('*')
        if p.suffix in ('.ts', '.vue') and 'node_modules' not in p.parts and 'target' not in p.parts
    ]
    texts = {p: p.read_text(encoding='utf-8', errors='replace') for p in files}

    reachable: set[Path] = set()
    queue = [e.resolve() for e in ENTRIES]
    # Which file first dragged each module in. Kept because "is it reachable" is not a yes/no the
    # reader can act on: when a component is reported reachable and the reader can find no importer,
    # the edge that said otherwise is the only thing worth printing. The walker has already been
    # wrong twice in this session and both times the answer was in this map.
    parent: dict[Path, tuple[Path, str]] = {}
    dangling: list[tuple[Path, str]] = []
    while queue:
        path = queue.pop()
        if path in reachable:
            continue
        reachable.add(path)
        text = texts.get(path)
        if text is None:
            if not path.is_file():
                continue
            text = path.read_text(encoding='utf-8', errors='replace')
        if is_spec(path):
            continue  # a spec never carries reachability onward
        for groups in SPECIFIER.findall(text):
            spec = next((g for g in groups if g), None)
            if spec is None:
                continue
            target = resolve(spec, path)
            if target is None:
                if spec.startswith('.') or spec.startswith('/src/'):
                    dangling.append((path, spec))
                continue
            parent.setdefault(target, (path, spec))
            queue.append(target)

    print('=== controls (must all be True, or this run is blind) ===')
    for name in ('main.ts', 'desktop-pet-entry.ts', 'desktop-pet-ball-entry.ts',
                 'AppShell.vue', 'AgentPanel.vue', 'SettingsPanel.vue', 'AgentComposer.vue'):
        hit = any(p.name == name and p in reachable for p in files)
        print(f'  {name:28} reachable: {hit}')
    print(f'  modules walked: {len(reachable)}  of {len(files)} source files')
    print()

    if len(sys.argv) > 2 and sys.argv[1] == '--why':
        print(f'=== why is {sys.argv[2]} reachable? ===')
        chain: list[str] = []
        node = next((p for p in files if sys.argv[2] in str(p)), None)
        if node is None:
            print('  no such file')
        elif node not in reachable:
            print('  it is not reachable at all')
        else:
            while node in parent:
                prev, spec = parent[node]
                chain.append(f'{spec}   ({prev.relative_to(ROOT)})')
                node = prev
            for step in reversed(chain) or ['<entry>']:
                print(f'  {step}')
        print()

    print('=== source files no page can reach ===')
    orphans = [p for p in sorted(files) if p not in reachable]
    for p in orphans:
        specs = sorted({q.name for q in files if is_spec(q) and p.stem in texts.get(q, '')})
        note = f'   (its spec: {specs[0]})' if specs else ''
        print(f'  {p.relative_to(ROOT)}{note}')
    print(f'  ({len(orphans)} files)')
    print()

    if dangling:
        print('=== specifiers that resolve to nothing (typos, deleted files) ===')
        for p, spec in dangling[:30]:
            print(f'  {spec:52} from {p.relative_to(ROOT)}')
        print(f'  ({len(dangling)} specifiers)')
    else:
        print('=== specifiers that resolve to nothing: none ===')
    return 0


if __name__ == '__main__':
    sys.exit(main())
