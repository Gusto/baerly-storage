/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Client-visible mirror of `SHARED_SECRET`; set in `.env` (or via shell at build time). */
  readonly VITE_SHARED_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
