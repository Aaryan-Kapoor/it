import { readFileSync } from 'node:fs'
import { PORTS } from '@it/protocol'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type ProxyOptions } from 'vite'

// The built site carries the terms it comes under and the notices of what it includes, at
// addresses of their own, and the two install scripts. Wherever the site is served, the
// license and the install commands are served with it.
const CARRIED = [
  ['../LICENSE.md', 'LICENSE.md'],
  ['../THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['../install/install.sh', 'install.sh'],
  ['../install/install.ps1', 'install.ps1'],
] as const
const carried = (): Plugin => ({
  name: 'it-carried-files',
  generateBundle() {
    for (const [from, fileName] of CARRIED) this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(from, import.meta.url)) })
  },
  // The same addresses answer while the site is being worked on
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const found = CARRIED.find(([, name]) => req.url === `/${name}`)
      if (!found) return next()
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(readFileSync(new URL(found[0], import.meta.url)))
    })
  },
})

// While the site is being worked on, everything it asks of the backend goes to an It that is
// running on this machine, as it would if that It were serving the site itself. The door takes
// a request about a session only from its own address, so each request is passed on as one
// made there.
const door = `http://127.0.0.1:${Number(process.env.IT_PORT) || PORTS.base}`
const toDoor: ProxyOptions = {
  target: door,
  changeOrigin: true,
  ws: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (onward, incoming) => {
      if (incoming.headers.origin) onward.setHeader('origin', door)
    })
    proxy.on('proxyReqWs', (onward, incoming) => {
      if (incoming.headers.origin) onward.setHeader('origin', door)
    })
  },
}

export default defineConfig({
  plugins: [react(), carried()],
  build: { target: 'es2022', sourcemap: true },
  server: {
    fs: { allow: ['..'] },
    // Each is a folder of the backend's own. The site's pages have addresses that begin the
    // same way as one of them (`/displays`), and those stay here
    proxy: { '^/(api|session|bridge|display|\\.well-known)/': toDoor },
  },
})
