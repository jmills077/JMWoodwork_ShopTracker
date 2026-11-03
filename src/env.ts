// Bindings and secrets the Worker is given (see wrangler.jsonc).
export interface Env {
  DB: D1Database;        // projects, settings, supplier prices
  ASSETS: Fetcher;       // public/: the stylesheet and browser script
  APP_PASSWORD?: string; // secret: the password for signing in
  TODOIST_TOKEN?: string; // secret: Todoist API token; Todoist features are off without it
}
export type App = { Bindings: Env };
