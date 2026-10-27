interface ImportMetaEnv {
  /** Origin of apps/api. Unset: the inbox runs against the in-browser mock API. */
  readonly VITE_API_URL?: string;
  /** Clinic API key for apps/api. Required together with VITE_API_URL. */
  readonly VITE_API_KEY?: string;
}
