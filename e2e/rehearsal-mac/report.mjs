// Writes index.html (every run, newest first, with its video and the person's spoken log) and the
// run lines of STATUS.md in the results folder from each run's result.json. The sections of
// STATUS.md written by hand are kept as they are: only the part between the run markers is
// written again.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const BEGIN = '<!-- runs: written by report.mjs -->'
const END = '<!-- end of runs -->'

export function runs(folder) {
  return readdirSync(folder, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(folder, d.name, 'result.json')))
    .map((d) => {
      try {
        return { dir: d.name, ...JSON.parse(readFileSync(join(folder, d.name, 'result.json'), 'utf8')) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.start).localeCompare(String(a.start)))
}

const verdict = (r) => (r.ok ? 'PASS' : r.blame === 'harness' ? 'NOT COUNTED (harness)' : r.judgedAt ? 'FAIL' : 'NOT YET JUDGED')

export function writeReport(folder) {
  const all = runs(folder)
  const cards = all
    .map((r) => {
      const has = (f) => existsSync(join(folder, r.dir, f))
      const cls = r.ok ? 'pass' : r.blame === 'harness' ? 'skip' : 'fail'
      const video = has('video.mp4') ? `<video controls preload="metadata" src="${esc(r.dir)}/video.mp4"></video><a href="${esc(r.dir)}/video.mp4">play the video</a>` : `<p><i>${esc(r.video ?? 'no video')}</i></p>`
      const spoken = has('person-log.txt') ? `<details><summary>The person's spoken log</summary><pre>${esc(readFileSync(join(folder, r.dir, 'person-log.txt'), 'utf8'))}</pre></details>` : ''
      const account = has('person-account.txt') ? `<details open><summary>The person's closing account</summary><pre>${esc(readFileSync(join(folder, r.dir, 'person-account.txt'), 'utf8'))}</pre></details>` : ''
      const files = ['result.json', 'terminal.txt', 'terminal-screens.txt', 'it-logs.txt', 'it-status.txt'].filter(has).map((f) => `<a href="${esc(r.dir)}/${f}">${f}</a>`).join(' · ')
      return `<section class="run ${cls}"><h2><b>${esc(verdict(r))}</b> · ${esc(r.scenario)} · ${esc(r.app)} · ${esc(r.browser)}</h2>
<p class="meta">${esc(r.start?.slice(0, 16).replace('T', ' '))} UTC · ${esc(r.appVersion ?? r.app)} · ${esc(r.model)} · macOS ${esc(r.macos)} · build ${esc(String(r.build ?? '').slice(0, 8))} · ${esc(r.macMinutes ?? '?')} Mac-minutes · played by ${esc(r.person)}</p>
<p>${esc(r.reason ?? '')}${r.blame && !r.ok ? ` <i>(${esc(r.blame)})</i>` : ''}</p>
${video}${account}${spoken}<p class="files">${files}</p></section>`
    })
    .join('\n')
  writeFileSync(
    join(folder, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mac rehearsal runs</title>
<style>:root{--bg:#faf8f3;--fg:#1c1a16;--line:#ddd;--link:#0b5cad}@media(prefers-color-scheme:dark){:root{--bg:#141310;--fg:#f0ece3;--line:#333;--link:#7cc4ff}}body{font:15px/1.5 system-ui,sans-serif;margin:16px auto;max-width:1100px;padding:0 16px;color:var(--fg);background:var(--bg)}a{color:var(--link)}section.run{border-top:1px solid var(--line);padding:12px 0}h2{font-size:18px;margin:0 0 4px}.pass b{color:#17805a}.fail b{color:#c0392b}.skip b{color:#a07d00}.meta{opacity:.8;font-size:13px;margin:0 0 6px}video{width:100%;max-height:70vh;background:#000;display:block;margin:6px 0}pre{white-space:pre-wrap;font-size:13px;background:rgba(127,127,127,.1);padding:8px;border-radius:6px}.files{font-size:13px}</style></head>
<body>${existsSync(join(folder, 'final', 'index.html')) ? '<p style="font-size:17px"><b><a href="final/index.html">The final pass on build bba16ffc, the commit 0.1.42 is built from: its runs and STATUS.md</a></b></p>' : ''}<h1>${folder.endsWith('final') ? 'Mac rehearsal, final pass (build bba16ffc)' : 'Mac rehearsal runs'}</h1><p>Every run on a rented Mac (macOS 15, Apple silicon) with a real agent app and a real model, newest first. The video shows the Mac's own Terminal with the agent app on the left and the browser on the right. See <a href="STATUS.md">STATUS.md</a> for what would hurt at the hackathon, the faults found and every moment a person would have been confused or stuck, and <a href="${folder.endsWith('final') ? '../' : ''}ledger.md">ledger.md</a> for the Mac-minutes spent.${folder.endsWith('final') ? ' The earlier runs of the night are <a href="../index.html">here</a>.' : ''}</p>
${cards || '<p>No runs yet.</p>'}
</body></html>
`,
  )
  const lines = all.map((r) => `- ${r.start?.slice(0, 16).replace('T', ' ')} UTC · **${verdict(r)}** · ${r.scenario} · ${r.appVersion ?? r.app} · ${r.model} · ${r.browser} · macOS ${r.macos} · build ${String(r.build ?? '').slice(0, 8)} · ${r.macMinutes ?? '?'} Mac-minutes · \`${r.dir}\`${r.reason ? ` · ${r.reason}` : ''}`)
  const block = `${BEGIN}\n## Runs\n\n${lines.join('\n') || '(none yet)'}\n${END}`
  const path = join(folder, 'STATUS.md')
  let text = existsSync(path)
    ? readFileSync(path, 'utf8')
    : `# Mac rehearsal, 15 November 2026\n\n## What would hurt at the hackathon\n\n(none yet)\n\n${block}\n\n## Faults found\n\n(none yet)\n\n## Where a person was confused or stuck\n\n(none yet)\n`
  text = text.includes(BEGIN) ? text.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block) : `${text}\n${block}\n`
  writeFileSync(path, text)
}

if (import.meta.url === `file://${process.argv[1]}`) writeReport(process.argv[2])
