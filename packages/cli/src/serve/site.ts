// The site, served from inside the program: every file of it was packed in when the program
// was built (packages/cli/site.mjs), and nothing is read from disk or fetched.
import { createHash } from 'node:crypto'
import { contentPort, policyHost } from '@it/protocol'
import { SITE } from '../site.generated'

/** One file of the site: what a browser is told it is, and its bytes in base64. */
export interface SiteFile {
  type: string
  bytes: string
}
/** The site's files, each by its path inside the site. */
export type Site = Record<string, SiteFile>
/** The site that was built into this program. */
export const BUILT: Site = SITE

// What every answer for the site carries. Nobody may frame the site, which is said in both of
// the ways a browser looks for it. A file is only ever what its type says. Wherever someone
// goes from the site is not told that they came from it. The site uses none of the device's
// camera, microphone or position. Nothing here tells a browser to insist on https: the site is
// reached plainly on a home network, and a browser told so for a name such as localhost would
// hold every other program on this machine to it.
const CARRIED: Record<string, string> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
}

/** A name in a Host header in the one spelling it has here: lower case, and an IPv6 address the way a browser writes it. */
export function spelled(name: string): string {
  const lower = name.toLowerCase()
  if (!lower.startsWith('[')) return lower
  try {
    return new URL(`http://${lower}/`).hostname
  } catch {
    return lower
  }
}
/**
 * A Host header taken apart: the name and the port. With no port said, it is the one plain
 * http has, which a browser leaves out. The door holds a request to this machine's own names
 * by it, and the site's policy is written from it, so both read it the one way.
 */
export function hostOf(header: string | null): { name: string; port: number } | null {
  if (!header || header.length > 300) return null
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i.exec(header)
  return m ? { name: spelled(m[1]!), port: m[2] === undefined ? 80 : Number(m[2]) } : null
}

/**
 * What the site may load, said to the browser with every answer, so that nothing that got into
 * a page of the site could bring in or reach anything else. Scripts, styles and everything
 * else come from the site itself, and no script or style written into a page is run. The site
 * talks to the door it came from, by request and by its live connection, which is named
 * outright since not every browser takes the site's own address to cover it. The only thing
 * framed is a page being shown, at its own port of the same machine. It is worked out from the
 * name the site was reached by, which is the name the browser will reach the rest by, with the
 * port it was reached on: the door has already held both to this machine's own.
 *
 * A policy can name a host only in letters, digits, dots and hyphens. An IPv6 address is none
 * of those, and neither is a machine's name with an underscore in it: no browser takes either
 * as a source, and one that is written there is passed over, so that nothing at all may be
 * framed. Where the site was reached by such a name, the pages' port is named on every host
 * under the longest ending of the name that a policy can say, or on any host where it can say
 * none of it, which is as near as a policy comes to it. The live connection is then left to the
 * site's own address to cover.
 */
function policy(header: string | null): string {
  const host = hostOf(header)
  const said = host ? policyHost(host.name) : null
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src 'self'${host && said === host.name ? ` ws://${host.name}:${host.port}` : ''}`,
    `frame-src ${host ? `http://${said}:${contentPort(host.port)}` : "'none'"}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}
/**
 * That a window the site opens can do nothing to it. A browser takes that word only from an
 * address it counts as secure, which over plain http is this machine by its own name: sent
 * from any other, it is passed over and written into the browser's console as a fault, on every
 * load, on every screen of the home network. So it is said where it is taken.
 */
const AT_HOME = /^(localhost|[a-z0-9-]+\.localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/
const carried = (headers: Headers): Record<string, string> => ({
  ...CARRIED,
  'content-security-policy': policy(headers.get('host')),
  ...(AT_HOME.test(hostOf(headers.get('host'))?.name ?? '') ? { 'cross-origin-opener-policy': 'same-origin' } : {}),
})

// A file's bytes and the tag that says which bytes they are, worked out the first time it is asked for
const unpacked = new WeakMap<SiteFile, { bytes: Uint8Array<ArrayBuffer>; tag: string }>()
function unpack(file: SiteFile) {
  let known = unpacked.get(file)
  if (!known) {
    const bytes = new Uint8Array(Buffer.from(file.bytes, 'base64'))
    known = { bytes, tag: `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 22)}"` }
    unpacked.set(file, known)
  }
  return known
}

const nothing = (status: number, asked: Headers, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { ...carried(asked), 'cache-control': 'no-store', 'content-length': '0', ...headers } })

/**
 * Answers a request for the site. A path that names a file gets the file. Any other path that
 * a browser asks for as a page gets index.html, which works out what to show from the address:
 * the site's pages are addresses and not files. A page is told from a file that is missing by
 * what is asked for, since a page's name may end like a file's. A script, a picture or anything
 * under /assets/ that is not there is not found, and is never answered with a page.
 *
 * index.html is never kept by a browser, so that a newer program's site is seen at once. The
 * files under /assets/ are named after what is in them, and are kept for a year. Everything
 * else is asked about again each time, and sent again only when it has changed.
 */
export function answerSite(site: Site, method: string, path: string, headers: Headers): Response {
  if (method !== 'GET' && method !== 'HEAD') return nothing(405, headers, { allow: 'GET, HEAD' })
  let name: string
  try {
    name = decodeURIComponent(path.slice(1))
  } catch {
    return nothing(404, headers)
  }
  let file = Object.hasOwn(site, name) ? site[name] : undefined
  if (!file) {
    const page = !name.startsWith('assets/') && (name === '' || (headers.get('accept') ?? '').includes('text/html'))
    if (!page) return nothing(404, headers)
    name = 'index.html'
    file = Object.hasOwn(site, name) ? site[name] : undefined
    // A program built before the site was has none to show
    if (!file)
      return new Response('This copy of It was built without its site.\n', {
        status: 503,
        headers: { ...carried(headers), 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      })
  }
  const { bytes, tag } = unpack(file)
  const kept = name === 'index.html' ? 'no-store' : name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  const says: Record<string, string> = { ...carried(headers), 'content-type': file.type, 'cache-control': kept }
  if (kept !== 'no-store') {
    says.etag = tag
    if (headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers: says })
  }
  says['content-length'] = String(bytes.byteLength)
  return new Response(method === 'HEAD' ? null : bytes, { headers: says })
}
