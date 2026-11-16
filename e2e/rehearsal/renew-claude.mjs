// Writes a fresh sign-in into a running throwaway profile's Claude Code file, the harness's way
// (credentials.mjs: the owner's current access token alone, owner-only, in the ledger so that the
// run's end shreds it), for a run that outlives the token it began with. Prints only the expiry.
//   node e2e/rehearsal/renew-claude.mjs <profile>\.claude
import { claudeFile } from './credentials.mjs'

console.log(new Date(claudeFile(process.argv[2]).expiresAt).toISOString())
