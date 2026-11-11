/** Packs every add-on under `root` with the skill and license given: see `addons-pack.mjs`. */
export function packAddons(given: {
  root: string
  skill: string
  license: string
}): Record<string, { version: string; build: string; files: Record<string, string> }>
/** Where Codex's plugin is in its add-on. */
export const CODEX_PLUGIN_AT: string
/** The recorded fingerprint of Codex's plugin folder: see `addons-pack.mjs`. */
export const CODEX_PLUGIN: string
/** The fingerprint of the Codex plugin folder in add-ons packed by `packAddons`. */
export function codexPluginFingerprint(addons: Record<string, { files: Record<string, string> }>): string
