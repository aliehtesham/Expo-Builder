/// <reference path="../../lib/types.d.ts" />

declare global {
  interface Window {
    /** Exposed by preload.ts via contextBridge. */
    builder: BuilderApi;
    /** Set by countries.ts. */
    COUNTRIES: Array<[string, string]>;
    flagOf: (cc: string) => string;
    countryName: (cc: string) => string | null;
    /** Demo hooks for the smoke-test screenshots (only set with ?demo). */
    __demo?: Record<string, (...args: never[]) => unknown>;
  }
}

export {};
