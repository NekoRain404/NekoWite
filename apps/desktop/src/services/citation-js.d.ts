declare module '@citation-js/core' {
  export class Cite {
    data: Array<Record<string, unknown>>
    constructor(data: string | object, options?: { forceType?: string })
  }
}

declare module '@citation-js/plugin-bibtex'
declare module '@citation-js/plugin-ris'
declare module '@citation-js/plugin-csl'
