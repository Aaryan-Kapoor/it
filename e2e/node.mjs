// What the suite's own scripts need put right in the Node that runs them, done by importing
// this before anything asks the network for anything.
//
// The `fetch` that Node 24 carries marks each connection it writes a request on, by a call that
// Node lets fail by throwing: `setTypeOfService`. On a Mac it fails with EINVAL on a connection
// the other end has just reset, and what is thrown is thrown inside an event handler, where no
// `catch` around the `fetch` is ever reached, so the script ends there with its stack printed.
// A script that asks something that has just been ended on purpose, as the service's test does,
// meets exactly that. The mark is a hint and nothing rests on it, so a failure to set it is let
// pass, as the program lets it pass in itself (packages/cli/src/node.ts).
import net from 'node:net'

const set = net.Socket.prototype.setTypeOfService
if (typeof set === 'function')
  net.Socket.prototype.setTypeOfService = function (tos) {
    try {
      return set.call(this, tos)
    } catch (err) {
      if (err?.syscall !== 'setTypeOfService') throw err
      return this
    }
  }
