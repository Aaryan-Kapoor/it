/** Packs every add-on under `root` with the skill and license given: see `addons-pack.mjs`. */
export function packAddons(given: {
  root: string
  skill: string
  license: string
}): Record<string, { version: string; build: string; files: Record<string, string> }>
