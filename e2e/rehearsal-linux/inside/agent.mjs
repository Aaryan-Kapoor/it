// The person at the agent app's terminal: starting the app, answering the questions the app
// itself asks (its theme, trusting the folder, approving a command, trusting It's hooks), and
// reading what the agent says to decide what a person who wants It installed would do next.
import { history, key, screen, sleep, step, type } from './lib.mjs'

export const BUSY = /esc to interrupt|esc to cancel|Esc to interrupt/i
const MARK = /^\s*(?:│\s*)?[❯›>]\s*(?:\d+\.\s*)?(.*)$/

/** The option the cursor is on in a list the app shows, and every option's text. */
function options(s) {
  const lines = s.split('\n')
  let at = null
  const all = []
  for (const l of lines) {
    const m = /^\s*(?:│\s*)?([❯›>])?\s*(\d+)\.\s+(.+?)\s*(?:│\s*)?$/.exec(l)
    if (m) {
      all.push(m[3])
      if (m[1]) at = m[3]
    }
  }
  return { at, all }
}

/** Moves the cursor to the option that matches `want` and presses Enter. */
export async function choose(want, why) {
  for (let i = 0; i < 10; i++) {
    const { at, all } = options(screen())
    if (at && want.test(at)) {
      step(`chooses "${at.trim()}"`, { why })
      await key('Enter')
      return true
    }
    if (!all.some((o) => want.test(o))) break
    await key('Down')
  }
  step(`could not find the option ${want}`, { why, screen: screen().slice(-800) }, false)
  return false
}

const REFUSED_LOGIN = /Select login method|Sign in with ChatGPT|Please run \/login|Invalid API key|not logged in|Log in to use Codex/i

/**
 * Answers whatever question the app itself has put up on the screen. Resolves with what it did,
 * or null where nothing was asked. `it` commands are approved for the rest of the session where
 * the app offers that, as someone who has just asked for It would.
 */
export async function answerApp(app, counts = {}) {
  const s = screen()
  const tail = s.split('\n').slice(-40).join('\n')
  if (REFUSED_LOGIN.test(tail)) return 'login'
  if (app === 'claude') {
    if (/Choose the text style|text style that looks best/i.test(tail)) {
      step('the app asks for a text style; keeps the first')
      await key('Enter')
      return 'theme'
    }
    if (/Security notes|Press Enter to continue/i.test(tail) && !/Do you want/i.test(tail)) {
      step('the app shows its notes; presses Enter')
      await key('Enter')
      return 'notes'
    }
    if (/trust the files in this folder|Do you trust|Is this a project you created|Quick safety check|Yes, I trust this folder|Accessing workspace/i.test(tail) && /1\./.test(tail)) {
      await choose(/Yes|trust/i, 'Claude Code asks whether to trust the folder')
      return 'trust'
    }
    if (/Do you want to (proceed|make this edit|create|allow)|Allow this|Do you want to run/i.test(tail) && /1\.\s*Yes/.test(tail)) {
      counts.approvals = (counts.approvals ?? 0) + 1
      const cmd = tail.match(/(?:Bash command|Bash\()([\s\S]{0,300}?)(?:Do you want|\n\s*\n)/i)?.[1]?.replace(/\s+/g, ' ').trim()
      step('Claude Code asks to approve a command; approves it', { command: cmd?.slice(0, 200) })
      const { all } = options(s)
      const always = all.find((o) => /don.t ask again/i.test(o) && /\bit\b|\.it\/bin/i.test(o))
      if (always) await choose(new RegExp(always.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'for it commands')
      else await choose(/^Yes\b/i, 'approve once')
      return 'approve'
    }
    return null
  }
  if (app === 'codex') {
    if (/Trust all and continue/i.test(tail)) {
      step("Codex says It's hooks need review; chooses Trust all and continue")
      await choose(/Trust all and continue/i, 'hooks')
      return 'hooks'
    }
    if (/Update available|new version of Codex|Update now/i.test(tail) && /Skip/i.test(tail)) {
      step('Codex offers an update; skips it')
      await choose(/^Skip\b(?! until)/i, 'update')
      return 'update'
    }
    if (/(trust the contents|allow Codex to work in this folder|Do you trust|working in a folder|not version controlled)/i.test(tail) && /1\./.test(tail)) {
      await choose(/Yes|Allow|trust|continue/i, 'Codex asks about the folder')
      return 'trust'
    }
    if (/Would you like to (run|make|allow)|Allow command|approve|Run this command\?|Proceed\?|wants to run/i.test(tail) && /1\.\s*Yes|Yes, proceed|›\s*1\./i.test(tail)) {
      counts.approvals = (counts.approvals ?? 0) + 1
      const cmd = tail.match(/\$ ([^\n]{1,300})/)?.[1]
      step('Codex asks to approve a command; approves it', { command: cmd?.slice(0, 200) })
      const { all } = options(s)
      const always = all.find((o) => /don.t ask again|always/i.test(o) && /\bit\b|\.it\/bin|this command|commands that start/i.test(o))
      if (always && /\.it\/bin\/it|\bit (tour|patch|set|create|wait|save|say|ack|site|status)/.test(cmd ?? '')) await choose(new RegExp(always.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'for it commands')
      else await choose(/^Yes\b/i, 'approve once')
      return 'approve'
    }
    return null
  }
  return null
}

/** Whether the app is working on a turn. */
export const busy = () => BUSY.test(screen().split('\n').slice(-12).join('\n'))

/**
 * Waits until the app is still: not working, nothing asked, and the screen the same for a few
 * seconds. Answers the app's own questions on the way. Resolves with 'idle', 'login' or 'timeout'.
 */
export async function settle(app, counts, ms = 600_000, quiet = 5000) {
  const until = Date.now() + ms
  let last = ''
  let still = Date.now()
  while (Date.now() < until) {
    const did = await answerApp(app, counts)
    if (did === 'login') return 'login'
    if (did) {
      still = Date.now()
      continue
    }
    const s = screen()
    if (s !== last || busy()) {
      last = s
      still = Date.now()
    } else if (Date.now() - still > quiet) return 'idle'
    await sleep(700)
  }
  return 'timeout'
}

/** Starts the app in the terminal, in the folder it is in, and waits for its prompt. */
export async function startApp(app, counts, args = '') {
  const cmd = app === 'claude' ? `claude${args ? ` ${args}` : ''}` : `codex${args ? ` ${args}` : ''}`
  step(`types ${cmd} in the terminal`)
  await type(cmd)
  await sleep(4000)
  return settle(app, counts, 120_000, 4000)
}

/** Leaves the app, as a person does, and waits for the shell. */
export async function quitApp(app) {
  step(`leaves ${app === 'claude' ? 'Claude Code' : 'Codex'}`)
  if (app === 'claude') await type('/exit')
  else await type('/quit')
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    const last = screen().trimEnd().split('\n').pop() ?? ''
    if (/\$\s*$/.test(last)) return true
  }
  await key('C-c')
  await sleep(800)
  await key('C-c')
  await sleep(1500)
  return /\$\s*$/.test(screen().trimEnd().split('\n').pop() ?? '')
}

/** What the agent has written since `marker`, the last thing the person typed. */
export function since(marker) {
  const h = history()
  const at = h.lastIndexOf(marker)
  return at === -1 ? h.slice(-6000) : h.slice(at + marker.length)
}

/** The pairing or page links in `text`, with a link that the terminal wrapped joined back up. */
export function links(text, cols = 104) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const re = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s)>\]`'"]*/g
    for (const m of lines[i].matchAll(re)) {
      let url = m[0]
      // A link that runs to the edge of the terminal goes on at the start of the next line
      let j = i
      while (m.index + m[0].length >= Math.min(lines[j].length, cols) - 2 && j + 1 < lines.length) {
        const more = /^\s*([A-Za-z0-9#?=&%._~\/+-]+)\s*$/.exec(lines[j + 1])
        if (!more) break
        url += more[1]
        j++
        if (lines[j].length < cols - 4) break
      }
      out.push(url.replace(/[.,;:]+$/, ''))
    }
  }
  return [...new Set(out)]
}

/** What a person who asked for It would do on reading `text`, the agent's newest words. */
export function decide(app, text) {
  const t = text.replace(/\s+/g, ' ')
  if (/\/reload-plugins/.test(t)) return { type: '/reload-plugins', why: 'the agent says to type /reload-plugins' }
  const bang = /(?:^|\s)(! ?~\/\.it\/bin\/it [a-z][^\n`]*)/.exec(text)
  if (app === 'claude' && bang) return { type: bang[1].trim(), why: 'the agent asks the person to run setup at its prompt with !' }
  if (/(restart|quit and (re)?open|close and (re)?open|exit and (re)?start|start a new (conversation|session|chat)|open a new (conversation|session)|relaunch)/i.test(t)) {
    const say = /say[,:]?\s*["“']([^"”']{6,80})["”']/i.exec(t)?.[1]
    return { restart: true, then: say, why: 'the agent says to restart the app' }
  }
  if (/\?\s*$/.test(text.trim()) || /(shall I|should I|want me to|would you like|do you want|okay to|ok to|may I|can I go ahead|go ahead\?|let me know|confirm|your (yes|go-ahead|approval|ok))/i.test(t)) {
    return { type: 'Yes, please go ahead.', why: 'the agent asks whether to go on' }
  }
  return null
}
