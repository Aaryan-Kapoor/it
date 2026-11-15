// Writes each run's result.json (from its session.json and the tester's verdict.json) and the
// results page, index.html, listing every run newest first with pass or fail, its scenario, who
// set It up and who played the person, a link to play its video, and the person's spoken log.
//   node e2e/rehearsal/report.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RESULTS } from './lib.mjs'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const runs = []
for (const name of readdirSync(RESULTS)) {
  const dir = path.join(RESULTS, name)
  const sessionFile = path.join(dir, 'session.json')
  const verdictFile = path.join(dir, 'verdict.json')
  if (!existsSync(sessionFile) || !existsSync(verdictFile)) continue
  const session = JSON.parse(readFileSync(sessionFile, 'utf8'))
  const verdict = JSON.parse(readFileSync(verdictFile, 'utf8'))
  if (verdict.listed === false) continue
  const result = {
    flow: verdict.flow ?? session.flow ?? `scenario ${session.scenario}`,
    agentApp: session.app,
    agentAppVersion: session.appVersion,
    model: session.model,
    browser: session.browser,
    account: session.account ?? session.user,
    setUpBy: session.setUpBy ?? 'the agent',
    person: verdict.person ?? session.person,
    build: session.build,
    start: session.start,
    end: session.end,
    pass: verdict.pass,
    failureKind: verdict.failureKind ?? null,
    reason: verdict.reason ?? null,
    summary: verdict.summary,
    harnessSteps: verdict.harnessSteps ?? [],
    confusions: verdict.confusions ?? [],
    findings: verdict.findings ?? [],
    steps: session.steps,
  }
  writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  const log = existsSync(path.join(dir, 'person-log.md')) ? readFileSync(path.join(dir, 'person-log.md'), 'utf8') : ''
  runs.push({ name, result, log, video: existsSync(path.join(dir, 'video.mp4')) })
}
runs.sort((a, b) => String(b.result.start).localeCompare(String(a.result.start)))
const rows = runs
  .map(
    ({ name, result: r, log, video }) => `
<section class="run ${r.pass ? 'pass' : 'fail'}">
  <h2><span class="tag">${r.pass ? 'PASS' : 'FAIL'}</span> ${esc(r.flow)} — ${esc(r.agentApp)} ${esc(r.agentAppVersion)} (${esc(r.model?.model)} at ${esc(r.model?.effort)}) in ${esc(r.browser === 'msedge' ? 'Edge' : 'Chrome')}</h2>
  <p class="meta">${esc(r.start?.slice(0, 16).replace('T', ' '))} UTC · build ${esc(r.build)} · account: ${esc(r.account)} · <b>set up by ${esc(r.setUpBy)}</b> · person played by ${esc(r.person)} · folder <code>${esc(name)}</code></p>
  ${video ? `<video controls preload="none" src="${esc(name)}/video.mp4"></video><p><a href="${esc(name)}/video.mp4">Play the video</a> · <a href="${esc(name)}/result.json">result.json</a> · <a href="${esc(name)}/terminal-plain.txt">terminal text</a> · <a href="${esc(name)}/steps.log">steps</a></p>` : '<p>No video.</p>'}
  <p>${esc(r.summary)}</p>
  ${r.pass ? '' : `<p><b>Why it failed${r.failureKind ? ` (${esc(r.failureKind)})` : ''}:</b> ${esc(r.reason)}</p>`}
  ${r.harnessSteps.length ? `<p><b>Done by the harness:</b></p><ul>${r.harnessSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
  ${r.confusions.length ? `<p><b>Where a person was confused or stuck:</b></p><ul>${r.confusions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
  ${r.findings.length ? `<p><b>Findings:</b></p><ul>${r.findings.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
  ${log ? `<details><summary>What the person thought (their spoken log)</summary><pre>${esc(log)}</pre></details>` : ''}
</section>`,
  )
  .join('\n')
writeFileSync(
  path.join(RESULTS, 'index.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>It rehearsal runs</title>
<style>
body{font:16px/1.5 system-ui,Segoe UI,sans-serif;margin:0;padding:16px;background:#f6f4ef;color:#1c1a16}
h1{font-size:24px;margin:0 0 4px}.lead{color:#555;margin:0 0 16px}
.run{background:#fff;border:1px solid #ddd;border-left:6px solid #999;border-radius:8px;padding:12px 16px;margin:0 0 16px}
.run.pass{border-left-color:#17805a}.run.fail{border-left-color:#c0392b}
h2{font-size:18px;margin:0 0 4px}.tag{display:inline-block;padding:1px 8px;border-radius:6px;color:#fff;font-size:13px;margin-right:6px}
.pass .tag{background:#17805a}.fail .tag{background:#c0392b}.meta{color:#555;font-size:14px;margin:0 0 8px}
video{width:100%;max-width:1100px;background:#000;border-radius:6px}pre{white-space:pre-wrap;background:#f3f3f3;padding:8px;border-radius:6px;font-size:13px}
code{font-size:13px}
</style></head><body>
<h1>It rehearsal on Windows, 2026-11-15</h1>
<p class="lead">Every recorded run, newest first. Each video shows the agent app's terminal on the left and the browser on the right. <a href="STATUS.md">STATUS.md</a> has what would hurt at the hackathon, the faults found, and every moment a person was confused.</p>
${rows || '<p>No runs yet.</p>'}
</body></html>
`,
)
console.log(`${runs.length} runs listed`)
