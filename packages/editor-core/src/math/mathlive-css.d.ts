// MathLive ships no type for its stylesheet, but the math editor loads it
// lazily (see atoms.ts loadMathLive) only when the math dialog is opened, so
// it never enters the startup import graph. This declaration lets the
// on-demand `import('mathlive/static.css')` type-check with the project's
// `types: []` tsconfig (no `*.css` wildcard, unlike the desktop app).
declare module 'mathlive/static.css'
