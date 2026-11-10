// A WebDriver client of the smallest kind, for e2e/safari.mjs: one request at a time, each with a
// deadline of its own that covers the answer's whole body as well as its headers, so that a driver
// which stops answering partway can never hold a wait longer than the wait says.

/**
 * A function that asks the driver at `address`. It resolves with the answer's `value`, and throws
 * with what was asked, the status and the driver's own words, or, after `ms` milliseconds, with
 * the deadline it missed. A session's id is left out of what it throws.
 */
export function webdriver(address) {
  return async (method, url, body, { ms = 30_000 } = {}) => {
    const asked = `${method} ${url.replace(/\/session\/[^/]+/, '/session/…')}`
    if (!(ms > 0)) throw new Error(`${asked}: no time was left to ask it in`)
    // The one signal is given to the request and read through to the end of its body: aborting
    // it ends the wait for the headers and the wait for the rest of the answer alike
    const signal = AbortSignal.timeout(ms)
    let r
    let text
    try {
      r = await fetch(address + url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
      text = await r.text()
    } catch (e) {
      if (signal.aborted) throw new Error(`${asked}: no whole answer within ${(ms / 1000).toFixed(1)} s`)
      throw new Error(`${asked}: ${e.cause?.code ?? e.message}`)
    }
    let answer
    try {
      answer = JSON.parse(text).value
    } catch {
      answer = text
    }
    if (!r.ok) throw new Error(`${asked}: ${r.status} ${JSON.stringify(answer).slice(0, 400)}`)
    return answer
  }
}
