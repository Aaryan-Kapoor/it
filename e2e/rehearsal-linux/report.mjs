// Writes index.html (every run, newest first, with its video) and the run lines of STATUS.md in
// the results folder from each run's result.json. The sections of STATUS.md written by hand
// ("Faults found", "Where a person was confused or stuck", and any other) are kept as they are:
// only the part between the run markers is written again.
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

/** A scenario's name as the owner reads it. */
const flowName = (r) => (r.flow === 'S1guide' ? 'S1, corrected guide' : r.flow === 'SOAK' ? 'Soak (2 h)' : r.flow) + (String(r.person ?? '').startsWith('a script') ? ' (script)' : '')
const mins = (r) => (r.start && r.end ? Math.round((Date.parse(r.end) - Date.parse(r.start)) / 60000) : '?')
const verdict = (r) => (r.ok ? 'PASS' : r.blame === 'harness' ? 'NOT COUNTED (harness)' : 'FAIL')

export function writeReport(folder) {
  const all = runs(folder)
  const rows = all
    .map((r) => {
      const video = existsSync(join(folder, r.dir, 'video.mp4')) ? `<a href="${esc(r.dir)}/video.mp4">play</a>` : 'no video'
      const cls = r.ok ? 'pass' : r.blame === 'harness' ? 'skip' : 'fail'
      return `<tr class="${cls}"><td>${esc(r.start?.slice(0, 16).replace('T', ' '))}</td><td><b>${esc(verdict(r))}</b></td><td>${esc(flowName(r))}</td><td>${esc(r.appVersion ?? r.app)}</td><td>${esc(r.model ?? '')}</td><td>${esc(r.browser)}</td><td>Ubuntu ${esc(r.ubuntu)}</td><td>${esc(String(r.build ?? '').slice(0, 8))}</td><td>${mins(r)} min</td><td>${video} · <a href="${esc(r.dir)}/result.json">result</a> · <a href="${esc(r.dir)}/terminal.txt">terminal</a></td><td>${esc(r.reason ?? '')}${r.blame && !r.ok ? ` <i>(${esc(r.blame)})</i>` : ''}</td></tr>`
    })
    .join('\n')
  writeFileSync(
    join(folder, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Linux rehearsal runs</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:16px;color:#1c1a16;background:#faf8f3}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}tr.pass b{color:#17805a}tr.fail b{color:#b3261e}tr.skip b{color:#8a6d00}@media(prefers-color-scheme:dark){body{background:#141310;color:#f0ece3}td,th{border-color:#333}a{color:#7cc4ff}}</style></head>
<body><h1>${folder.endsWith('final') ? 'Final pass on 0.1.42 (bba16ffc), Linux' : 'Linux rehearsal runs'}</h1>${existsSync(join(folder, 'final', 'index.html')) ? '<p><b><a href="final/index.html">The final pass on 0.1.42 (bba16ffc), evening of 15 November: start here</a></b></p>' : ''}<p>Every run with a real agent app and a real model, newest first. See <a href="STATUS.md">STATUS.md</a> for the faults found and every moment a person would have been confused or stuck.</p>
<table><thead><tr><th>Started (UTC)</th><th>Verdict</th><th>Flow</th><th>Agent app</th><th>Model</th><th>Browser</th><th>System</th><th>Build</th><th>Took</th><th>Files</th><th>Why</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>
`,
  )
  const lines = all.map((r) => `- ${r.start?.slice(0, 16).replace('T', ' ')} UTC · **${verdict(r)}** · ${flowName(r)} · ${r.appVersion ?? r.app} · ${r.model ?? 'model not read'} · ${r.browser} · Ubuntu ${r.ubuntu} · build ${String(r.build ?? '').slice(0, 8)} · ${mins(r)} min · \`${r.dir}\`${r.reason ? ` · ${r.reason}` : ''}`)
  const block = `${BEGIN}\n## Runs\n\n${lines.join('\n') || '(none yet)'}\n${END}`
  const path = join(folder, 'STATUS.md')
  let text = existsSync(path)
    ? readFileSync(path, 'utf8')
    : `# Linux rehearsal, 15 November 2026\n\nEvery run is on a fresh Ubuntu container with systemd, an ordinary user \`ana\`, a virtual display, the real agent app signed in with a copy of the owner's access token, and the build under test served to the install script through a stand-in for the releases (\`IT_INSTALL_BASE=http://127.0.0.1:8765\`, set in the machine's environment before the video starts).\n\n${block}\n\n## Faults found\n\n(none yet)\n\n## Where a person was confused or stuck\n\n(none yet)\n`
  text = text.includes(BEGIN) ? text.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block) : `${text}\n${block}\n`
  writeFileSync(path, text)
}

if (import.meta.url === `file://${process.argv[1]}`) writeReport(process.argv[2])
