/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_SHOW_ENERGY_TAB?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
