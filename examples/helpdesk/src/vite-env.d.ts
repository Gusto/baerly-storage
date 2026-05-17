/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HELPDESK_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
