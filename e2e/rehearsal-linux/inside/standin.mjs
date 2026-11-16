// A stand-in for Claude Code's model on the rehearsal machine, as CI's app check has it
// (e2e/apps/claude-code/model.mjs): fixed turns, no account. The person's message makes a page
// with one button; each click, a turn of its own, patches the page with how many clicks it has
// had. Every turn is logged by its kind, its session and when, for the flow to read.
//   STANDIN_PORT=8899 node standin.mjs
import { appendFileSync } from 'node:fs'
import { runs, standInModel, words } from './standin-model.mjs'

let clicks = 0
const log = (what) => appendFileSync('/tmp/standin.log', `${new Date().toISOString()} ${what}\n`)
const model = await standInModel((turn) => {
  const result = turn.results[0]
  if (!result && /^Make a page with one button/.test(turn.text)) {
    log(`turn make session=${turn.session}`)
    return runs(
      `it create "One button" --id onebutton --state '{"pressed":"none yet"}' --open --html '<p>Pressed: <b id="seen" data-it-bind="pressed">none yet</b></p><button id="go">Press</button><script>document.getElementById("go").onclick = () => It.action("press")</script>'`,
      'Making the page.',
    )
  }
  if (!result && turn.text.startsWith('[It]')) {
    clicks++
    log(`turn click ${clicks} session=${turn.session}`)
    return runs(`it patch onebutton '{"pressed":"answer ${clicks}"}'`, 'Marking the page as pressed.')
  }
  if (result) {
    log(`turn result session=${turn.session} error=${!!result.is_error}`)
    return words(result.is_error ? 'The command failed.' : 'Done.')
  }
  log(`turn other session=${turn.session} text=${JSON.stringify(turn.text.slice(0, 60))}`)
  return words('Nothing to do.')
})
log(`listening at ${model.url}`)
