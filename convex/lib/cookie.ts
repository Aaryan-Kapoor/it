// The cookie a browser holds a session in. Each session has a cookie of its own, named for the
// session: a browser keeps one set of cookies for all its tabs, and an answer about one session
// may reach it after the browser has been paired into another. Because no two sessions share a
// name, such an answer can set or clear only the cookie of the session it is about, and the
// one the browser holds by then is left as it is.

/** What the name of every session's cookie begins with. */
export const FAMILY = 'it_session_'

/**
 * The name of the cookie one session is held in: the family's, and then the session's id, which
 * is no secret. An id is letters and digits, and anything else in one is written as `_`, so
 * that the name is always one a cookie may have.
 */
export const cookieFor = (sessionId: string): string => `${FAMILY}${sessionId.replace(/[^A-Za-z0-9]/g, '_')}`
