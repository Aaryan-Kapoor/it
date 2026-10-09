// What is kept of a browser's console in a run (e2e/site.mjs), and what is looked for in it
// first. On a healthy run nothing a page or the site writes there holds a credential, so
// nothing else would show if the looking were done only after the credential had been taken out.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const dir = mkdtempSync(path.join(os.tmpdir(), 'it-site-test-'))
// Each of these is put together here, so that this file does not itself hold what the checks look for
const showing = `http://localhost:20001/s/${'s'.repeat(43)}/v/1/index.html`
const session = ['eyJ', '.eyJ', '.'].map((start, i) => start + 'abc'[i].repeat(24)).join('')
const noted = 'c0ffee'.repeat(8)
let site
let lib

beforeAll(async () => {
  // What this test notes is noted where no later check of a real run reads it
  process.env.IT_E2E_INVENTORY = path.join(dir, 'holds.jsonl')
  writeFileSync(process.env.IT_E2E_INVENTORY, '')
  lib = await import('./lib.mjs')
  site = await import('./site.mjs')
})
afterAll(() => {
  delete process.env.IT_E2E_INVENTORY
  rmSync(dir, { recursive: true, force: true })
})

describe('what a text holds that nothing written down may hold', () => {
  test('is nothing, for a text that holds nothing of the kind', () => {
    expect(site.heldIn('Failed to load resource: the server responded with a status of 404 (Not Found)')).toEqual([])
    expect(site.heldIn('[CONVEX Q(artifacts:get)] [Request ID: 2b3060ea99cea18f] Server Error')).toEqual([])
  })

  test('is each kind of credential in it, by its shape or because the run noted it, and never the credential', () => {
    lib.noteSecret('a connector’s token', noted)
    const held = site.heldIn(`at ${showing} with ${session} and ${noted}`)
    expect(held).toHaveLength(3)
    expect(held).toEqual(expect.arrayContaining([expect.stringMatching(/showing/), expect.stringMatching(/token/)]))
    // A credential the run noted is named by its kind alone, without the number that tells it from the others it noted
    expect(held).toContain('a connector’s token')
    for (const secret of ['s'.repeat(43), session, noted]) expect(JSON.stringify(held)).not.toContain(secret)
  })

  test('takes no words in brackets that the text itself had for a credential', () => {
    expect(site.heldIn('[CONVEX M(displays:register)] [Request ID: 2379f5b6acc30e69] Server Error')).toEqual([])
  })
})

describe('one thing a browser’s console was given', () => {
  test('that a page or the site wrote, and that names the address a page is shown at, is a leak, and what is kept of it does not hold the address', () => {
    const line = site.consoleLine({ type: 'log', text: showing, own: false })
    expect(line.leaked).toEqual([expect.stringMatching(/showing/)])
    expect(line.kept).toMatch(/^log: /)
    expect(line.kept).not.toContain('s'.repeat(43))
  })

  test('that the browser said by itself, naming a frame by the address its page is shown at, is no leak, and what is kept of it does not hold the address either', () => {
    const text = `Unsafe attempt to initiate navigation for frame with URL 'http://localhost:20000/p/plan' from frame with URL '${showing}'.`
    const line = site.consoleLine({ type: 'error', text, own: true })
    expect(line.leaked).toEqual([])
    expect(line.kept).toBe(
      "error: Unsafe attempt to initiate navigation for frame with URL 'http://localhost:20000/p/plan' from frame with URL 'http://localhost:20001/s/[a showing’s address]/v/1/index.html'.",
    )
  })

  test('that the browser said by itself and that holds any other credential is a leak all the same', () => {
    const line = site.consoleLine({ type: 'error', text: `Failed to load ${showing}?token=${session}`, own: true })
    expect(line.leaked).toEqual([expect.stringMatching(/token/)])
    for (const secret of ['s'.repeat(43), session]) expect(line.kept).not.toContain(secret)
  })

  test('that holds nothing of the kind is kept as it was written', () => {
    expect(site.consoleLine({ type: 'warning', text: 'a page said something of its own', own: false })).toEqual({
      kept: 'warning: a page said something of its own',
      leaked: [],
    })
  })
})

describe('what a run foresees of its browsers', () => {
  const REFUSED = 'Failed to load resource: the server responded with a status of 401 (Unauthorized)'
  const REDEEM = 'http://localhost:20000/session/redeem'
  /** A browser as `launch` gives one, as far as its problems go, and something it says by itself now. */
  const browser = () => ({ problems: [] })
  const says = (words, more = {}) => ({ at: Date.now(), says: words, own: true, of: '', ...more })

  test('what a browser says by itself is its own error unless it was foreseen of that browser, at that time, in those words, about that address', () => {
    const { foresee, heldToAccount } = site.expectations()
    const [one, two] = [browser(), browser()]
    const before = says(REFUSED, { of: REDEEM, at: Date.now() - 60_000 })
    const over = foresee(one, { says: site.refusedWith(401), of: site.exactly(REDEEM), because: 'a wrong code was typed' })
    one.problems.push(says(REFUSED, { of: REDEEM }))
    expect(heldToAccount([one, two])).toEqual({ own: [], neverSaid: [] })
    // The same words about another address, in another browser, with another status, before it was foreseen, and long after it was over
    one.problems.push(says(REFUSED, { of: 'http://localhost:20000/assets/site.js' }))
    two.problems.push(says(REFUSED, { of: REDEEM }))
    one.problems.push(says(REFUSED.replace('401 (Unauthorized)', '404 (Not Found)'), { of: REDEEM }))
    one.problems.push(before)
    over()
    one.problems.push(says(REFUSED, { of: REDEEM, at: Date.now() + 3001 }))
    const { own, neverSaid } = heldToAccount([one, two])
    // Each thing once: the one said before it was foreseen and the one said long after are the same words about the same address
    expect(own).toEqual([
      `browser 1 said: ${REFUSED} (asked of http://localhost:20000/assets/site.js)`,
      `browser 1 said: ${REFUSED.replace('401 (Unauthorized)', '404 (Not Found)')} (asked of ${REDEEM})`,
      `browser 1 said: ${REFUSED} (asked of ${REDEEM}), 2 times`,
      `browser 2 said: ${REFUSED} (asked of ${REDEEM})`,
    ])
    expect(neverSaid).toEqual([])
  })

  test('what is said a moment after what provoked it was over is foreseen still, and what is said long after is not', () => {
    const { foresee, heldToAccount } = site.expectations()
    const one = browser()
    foresee(one, { says: site.refusedWith(401), of: site.exactly(REDEEM), times: 2, because: 'two wrong codes were typed' })()
    one.problems.push(says(REFUSED, { of: REDEEM, at: Date.now() + 1000 }), says(REFUSED, { of: REDEEM, at: Date.now() + 3500 }))
    expect(heldToAccount([one])).toEqual({ own: [`browser 1 said: ${REFUSED} (asked of ${REDEEM})`], neverSaid: [] })
  })

  test('an error a script wrote or threw is an error of the browser’s own whatever was foreseen', () => {
    const { foresee, heldToAccount } = site.expectations()
    const one = browser()
    foresee(one, { says: /./, may: true, because: 'anything at all' })
    one.problems.push({ ...says('ConvexError: something was refused'), own: false })
    expect(heldToAccount([one]).own).toEqual(['browser 1 had a script write or throw: ConvexError: something was refused'])
  })

  test('what was foreseen for sure and never said is told of by what was to provoke it, and what a browser only may say is not', () => {
    const { foresee, heldToAccount } = site.expectations()
    const one = browser()
    foresee(one, { says: site.notLetRead('http://localhost:20000/session/token'), because: 'a page asked the site for the session' })()
    foresee(one, { says: site.noConnectionTo('http://localhost:20000'), may: true, because: 'the door was closed and opened' })()
    expect(heldToAccount([one])).toEqual({ own: [], neverSaid: ['a page asked the site for the session'] })
  })

  test('where two things foreseen fit, the browser is taken to speak of the one foreseen last, so that neither goes unsaid for the other', () => {
    const { foresee, heldToAccount } = site.expectations()
    const one = browser()
    const framed = 'Framing \'http://localhost:20001/\' violates the following Content Security Policy directive: "frame-ancestors http://localhost:20000".'
    const framing = site.againstPolicy("Framing 'http://localhost:20001/'", 'frame-ancestors http://localhost:20000')
    const first = foresee(one, { says: framing, because: 'another site framed a page' })
    one.problems.push(says(framed))
    first()
    // The second is provoked while the first is foreseen a moment longer
    const second = foresee(one, { says: framing, because: 'another site framed the page again' })
    one.problems.push(says(framed))
    second()
    expect(heldToAccount([one])).toEqual({ own: [], neverSaid: [] })
  })

  test('a thing is foreseen once unless it is told how often, and whatever is said oftener than that is the browser’s own error', () => {
    const { foresee, heldToAccount } = site.expectations()
    const TOKEN = 'http://localhost:20000/session/token'
    const [one, two] = [browser(), browser()]
    foresee(one, { says: site.refusedWith(401), of: site.exactly(TOKEN), because: 'a browser that is not paired asked for a token' })
    // How often may be a number, or what gives the number when the run is done: how many requests were seen to be made, say
    let asked = 0
    foresee(two, { says: site.refusedWith(429), of: site.exactly(TOKEN), times: () => asked, because: 'many tabs asked for tokens at once' })
    for (let n = 0; n < 20; n++) one.problems.push(says(REFUSED, { of: TOKEN }))
    for (let n = 0; n < 5; n++) two.problems.push(says(REFUSED.replace('401 (Unauthorized)', '429 (Too Many Requests)'), { of: TOKEN }))
    asked = 3
    expect(heldToAccount([one, two])).toEqual({
      own: [
        `browser 1 said: ${REFUSED} (asked of ${TOKEN}), 19 times`,
        `browser 2 said: ${REFUSED.replace('401 (Unauthorized)', '429 (Too Many Requests)')} (asked of ${TOKEN}), 2 times`,
      ],
      neverSaid: [],
    })
  })

  test('a file that was asked for on purpose is foreseen by its own address and its own showing, and no other file of that showing or of another passes for it', () => {
    const { foresee, heldToAccount } = site.expectations()
    const one = browser()
    const NOT_THERE = 'Failed to load resource: the server responded with a status of 404 (Not Found)'
    const at = (token, file) => `http://localhost:20001/s/${token}/v/${file}`
    const [shown, another] = ['s'.repeat(43), 't'.repeat(43)]
    // As a browser's report is kept: the address without the showing's own part, and the showing by an id that is no secret
    const reported = (token, file) =>
      says(NOT_THERE, { of: `http://localhost:20001/s/[a showing’s address]/v/${file}`, showing: site.showingOf(at(token, file)) })
    foresee(one, {
      says: site.refusedWith(404),
      of: site.exactly('http://localhost:20001/s/[a showing’s address]/v/2/index.html'),
      showing: site.showingOf(at(shown, '2/index.html')),
      because: 'a page asked for a file of another version',
    })
    one.problems.push(reported(shown, '2/index.html'), reported(shown, '1/required.css'), reported(another, '2/index.html'))
    expect(heldToAccount([one]).own).toEqual([
      `browser 1 said: ${NOT_THERE} (asked of http://localhost:20001/s/[a showing’s address]/v/1/required.css)`,
      `browser 1 said: ${NOT_THERE} (asked of http://localhost:20001/s/[a showing’s address]/v/2/index.html)`,
    ])
    // The id tells two showings apart, says nothing of either, and is nothing for an address that is no showing’s
    expect(site.showingOf(at(shown, '1/a.js'))).toMatch(/^[0-9a-f]{8}$/)
    expect(site.showingOf(at(shown, '1/a.js'))).toBe(site.showingOf(at(shown, '2/b.js')))
    expect(site.showingOf(at(shown, '1/a.js'))).not.toBe(site.showingOf(at(another, '1/a.js')))
    expect(site.showingOf('http://localhost:20000/p/plan')).toBeUndefined()
  })

  test('nothing is foreseen of every browser at once, and what is done while something is foreseen gives back what it did', async () => {
    const { foresee, provoking, heldToAccount } = site.expectations()
    const two = browser()
    expect(() => foresee(null, { says: site.refusedWith(401), because: 'a browser that is not paired asked for a token' })).toThrow(/of one browser/)
    const did = await provoking(
      two,
      [{ says: site.mayNotLeave('http://localhost:20000/p/plan'), because: 'a page tried to take its tab elsewhere' }],
      async () => {
        two.problems.push(
          says("Unsafe attempt to initiate navigation for frame with URL 'http://localhost:20000/p/plan' from frame with URL 'http://localhost:20001/'."),
        )
        return 'done'
      },
    )
    expect(did).toBe('done')
    expect(heldToAccount([two])).toEqual({ own: [], neverSaid: [] })
  })

  test('whoever waits for a browser to have spoken is told once it has said everything foreseen of it for sure, and is told that it has not when the time is up', async () => {
    const { during } = site.expectations()
    const one = browser()
    const over = during(one, [
      { says: site.refusedWith(401), of: site.exactly(REDEEM), because: 'a wrong code was typed' },
      { says: site.noConnectionTo('http://localhost:20000'), may: true, because: 'the door may have been closed' },
    ])
    // Nothing yet, then the same words about another address, which are not what was foreseen
    expect(await over.said(60)).toBe(false)
    one.problems.push(says(REFUSED, { of: 'http://localhost:20000/assets/site.js' }), { ...says(REFUSED, { of: REDEEM }), own: false })
    expect(await over.said(60)).toBe(false)
    // It speaks while it is waited for, and what it only may say is not waited for
    setTimeout(() => one.problems.push(says(REFUSED, { of: REDEEM })), 40)
    expect(await over.said(5000)).toBe(true)
    over()
  })

  test('each kind of thing a browser says is known by its own words: which request, which connection, which tab, which rule', () => {
    expect(site.notMade('ERR_FAILED').test('Failed to load resource: net::ERR_FAILED')).toBe(true)
    expect(site.notMade('ERR_FAILED').test('Failed to load resource: net::ERR_CONNECTION_REFUSED')).toBe(false)
    expect(
      site
        .notLetRead('http://localhost:20000/api/query')
        .test("Access to fetch at 'http://localhost:20000/api/query' from origin 'null' has been blocked by CORS policy: …"),
    ).toBe(true)
    expect(
      site
        .notLetRead('http://localhost:20000/api/query')
        .test("Access to fetch at 'http://localhost:20000/api/mutation' from origin 'null' has been blocked by CORS policy: …"),
    ).toBe(false)
    expect(site.noConnectionTo('http://localhost:20000').test("WebSocket connection to 'ws://localhost:20000/api/1.46.0/sync' failed: …")).toBe(true)
    expect(site.noConnectionTo('http://localhost:20000').test("WebSocket connection to 'ws://localhost:20001/api/1.46.0/sync' failed: …")).toBe(false)
    expect(
      site
        .againstPolicy('Executing inline script', "script-src 'self'")
        .test("Executing inline script violates the following Content Security Policy directive 'script-src 'self''. …"),
    ).toBe(true)
    expect(
      site
        .againstPolicy('Executing inline script', "script-src 'self'")
        .test("Loading the script 'http://x/' violates the following Content Security Policy directive: \"script-src 'self'\". …"),
    ).toBe(false)
    const fromText =
      "Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: \"script-src 'self'\". …"
    expect(site.againstPolicy('Evaluating a string as JavaScript', "script-src 'self'").test(fromText)).toBe(true)
    // The whole directive, and no other that only begins as it does
    const framedByTwo = 'Framing \'http://x/\' violates the following Content Security Policy directive: "frame-ancestors http://localhost:20000 http://y". …'
    expect(site.againstPolicy("Framing 'http://x/'", 'frame-ancestors http://localhost:20000').test(framedByTwo)).toBe(false)
    const refused = (asked) => `Fetch API cannot load ${asked}. Refused to connect because it violates the document's Content Security Policy.`
    expect(site.notAsked('http://x/answer').test(refused('http://x/answer'))).toBe(true)
    expect(site.notAsked('http://x/answer').test(refused('http://x/other'))).toBe(false)
    // A dot in an address is a dot, and no other letter
    expect(site.exactly('http://127.0.0.1:20000/session/token').test('http://127x0y0z1:20000/session/token')).toBe(false)
  })
})

describe('what a browser may name a session for', () => {
  const SITE = 'http://localhost:20000'
  const [FIRST, SECOND] = ['jd7first0000000000000000000000001', 'jd7second000000000000000000000002']
  const [tabOne, tabTwo] = [{ tab: 1 }, { tab: 2 }]
  let clock = 1000
  /** Something a tab sent the site about its session, a moment after the last, and what came of it. */
  const sent = (tab, path, status, { named = null, sets = [], clears = [] } = {}) => {
    clock += 10
    return {
      tab,
      origin: SITE,
      path,
      sent: clock,
      answered: clock + 5,
      status,
      named,
      cookies: [
        ...sets.map((session) => ({ name: site.cookieOf(session), set: true })),
        ...clears.map((session) => ({ name: site.cookieOf(session), set: false })),
      ],
    }
  }
  const paired = (tab, session) => sent(tab, '/session/redeem', 200, { sets: [session] })
  const token = (tab, status, more) => sent(tab, '/session/token', status, more)
  const names = (tab, session, status, more) => sent(tab, '/session/end', status, { named: session, ...more })
  const from = (exchanges) => ({ from: exchanges[0].sent, until: Number.POSITIVE_INFINITY })

  test('signing out names the session twice in the tab that was asked, to end it and to have its cookie cleared again, and once in the other tab: none of it is wrong, and two of the three are refusals', () => {
    const before = [paired(tabOne, FIRST), token(tabOne, 200), token(tabTwo, 200)]
    const signingOut = [
      names(tabTwo, FIRST, 200, { clears: [FIRST] }),
      token(tabTwo, 401),
      names(tabTwo, FIRST, 401, { clears: [FIRST] }),
      token(tabOne, 401),
      names(tabOne, FIRST, 401, { clears: [FIRST] }),
    ]
    const held = site.namingsHeld([...before, ...signingOut], [from(signingOut)])
    expect(held.wrong).toEqual([])
    expect([held.refused(SITE, 401), held.refused(SITE, 409), held.refused('http://localhost:20002', 401)]).toEqual([2, 0, 0])
    expect(held.held).toEqual([site.cookieOf(FIRST)])
  })

  test('a browser that is paired again names the session that is over once in each tab that finds it paired, and is told that it holds another', () => {
    const before = [paired(tabOne, FIRST), token(tabOne, 200)]
    const signingOut = [names(tabOne, FIRST, 200, { clears: [FIRST] }), token(tabOne, 401), names(tabOne, FIRST, 401)]
    const until = clock + 10
    const pairedAgain = [paired(tabOne, SECOND), token(tabOne, 200), names(tabOne, FIRST, 409), token(tabTwo, 200), names(tabTwo, FIRST, 409)]
    const held = site.namingsHeld([...before, ...signingOut, ...pairedAgain], [{ from: signingOut[0].sent, until }])
    expect(held.wrong).toEqual([])
    expect([held.refused(SITE, 401), held.refused(SITE, 409)]).toEqual([1, 2])
  })

  test('a session the run knows to be over, while the answer that says so is kept from the browser, is held to what one that is over is held to', () => {
    // Signed out in the first tab, whose answer is kept back: no answer the browser has had clears the cookie
    const before = [paired(tabOne, FIRST), token(tabOne, 200), token(tabTwo, 200)]
    const signsOut = names(tabOne, FIRST, 200)
    const knownOver = { session: FIRST, from: signsOut.sent + 1 }
    // Paired again in the second tab, and then the first, answered about its token, names the session it held to have its cookie cleared
    const pairedAgain = [paired(tabTwo, SECOND), token(tabTwo, 200)]
    const until = clock + 1
    const late = [token(tabOne, 200), names(tabOne, FIRST, 409)]
    const exchanges = [...before, signsOut, ...pairedAgain, ...late]
    const whiles = [{ from: signsOut.sent, until }]
    // Not told, the check takes the session for the browser's own still, and the naming for an ending nothing called for
    expect(site.namingsHeld(exchanges, whiles).wrong).toEqual(['the session the browser holds was named while nothing had ended its pairing (jd7fir…)'])
    const held = site.namingsHeld(exchanges, whiles, [knownOver])
    expect(held.wrong).toEqual([])
    expect(held.refused(SITE, 409)).toBe(1)
    // And it is still held to that: named once more than the tab's askings account for, or answered as if there were nothing at all, it is wrong
    expect(site.namingsHeld([...exchanges, names(tabOne, FIRST, 409)], whiles, [knownOver]).wrong).toEqual([
      'a session that is over was named oftener than the tab’s askings account for (jd7fir…)',
    ])
    expect(site.namingsHeld([...before, signsOut, ...pairedAgain, token(tabOne, 200), names(tabOne, FIRST, 401)], whiles, [knownOver]).wrong).toEqual([
      'naming a session that is over was answered 401 (jd7fir…)',
    ])
  })

  test('what is wrong is said: the session a paired browser holds named with nothing having ended its pairing, a session that is over named oftener than the tab’s askings account for or told that there is nothing to end while the browser is paired, a session the browser never held, and any other answer', () => {
    const wrongOf = (exchanges, whiles = []) => site.namingsHeld(exchanges, whiles).wrong
    // Its own, named while the run takes it to be paired
    expect(wrongOf([paired(tabOne, FIRST), token(tabOne, 200), names(tabOne, FIRST, 200, { clears: [FIRST] })])).toEqual([
      'the session the browser holds was named while nothing had ended its pairing (jd7fir…)',
    ])
    // And where such a naming stood is said with it: in which tab, how long after a while, and what was seen of its cookie
    const again = [paired(tabOne, FIRST), token(tabOne, 200), names(tabOne, FIRST, 200), token(tabTwo, 401, { clears: [FIRST] })]
    const late = names(tabTwo, FIRST, 409)
    // The answer that cleared the cookie is taken to have come a moment after the naming it led to, and one before it could not be read
    Object.assign(again[3], { answered: late.sent + 3 })
    Object.assign(again[1], { unread: true })
    const stood = site.namingsHeld([...again, late], [{ from: again[2].sent, until: late.sent - 7 }])
    expect(stood.wrong).toEqual(['the session the browser holds was named while nothing had ended its pairing (jd7fir…)'])
    expect(stood.about).toEqual([
      'tab 2 of 2, 7 ms after such a while ended, its cookie was not seen cleared before, and was seen cleared 3 ms after, 1 answers before it could not be read for their cookies',
    ])
    const over = [paired(tabOne, FIRST), token(tabOne, 200), names(tabOne, FIRST, 200, { clears: [FIRST] }), token(tabOne, 401), names(tabOne, FIRST, 401)]
    const whilst = [{ from: over[2].sent, until: over.at(-1).answered }]
    expect(wrongOf([...over, names(tabOne, FIRST, 401)], [{ from: over[2].sent, until: Number.POSITIVE_INFINITY }])).toEqual([
      'a session that is over was named oftener than the tab’s askings account for (jd7fir…)',
    ])
    expect(wrongOf([...over, paired(tabOne, SECOND), token(tabOne, 200), names(tabOne, FIRST, 401)], whilst)).toEqual([
      'naming a session that is over was answered 401 (jd7fir…)',
    ])
    // One it never held, none at all, and an answer that is no answer to a naming
    expect(wrongOf([paired(tabOne, FIRST), token(tabOne, 200), names(tabOne, SECOND, 409), names(tabOne, null, 400)])).toEqual([
      'a session the browser never held was named (jd7sec…)',
      'a session the browser never held was named (none at all)',
    ])
    const troubled = [paired(tabOne, FIRST), token(tabOne, 200), names(tabOne, FIRST, 500)]
    expect(wrongOf(troubled, [from(troubled.slice(2))])).toEqual(['naming the session the browser holds was answered 500 (jd7fir…)'])
  })

  test('a naming that was never answered is held to what it named, and counts as no refusal', () => {
    const before = [paired(tabOne, FIRST), token(tabOne, 200)]
    const unanswered = { ...names(tabOne, FIRST, null), answered: null }
    const held = site.namingsHeld([...before, unanswered], [{ from: unanswered.sent, until: Number.POSITIVE_INFINITY }])
    expect(held.wrong).toEqual([])
    expect(held.refused(SITE, 401)).toBe(0)
  })
})
