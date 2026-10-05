# Contributing to It

Pull requests are welcome from anyone. A security problem is the one thing not to open a pull request or an issue for: [the security policy](SECURITY.md) says how to report one privately.

## The contributor agreement

The first time you open a pull request, a bot asks you to sign the [Contributor License Agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md), which is three sentences long. You sign it by posting one sentence as a comment on the pull request, and the bot's own comment gives you that sentence to copy. You sign once, and the signature covers your later pull requests as well. A pull request cannot be merged until every contributor with a commit in it has signed. The repository's owner and its dependency bot are not asked.

Read the agreement before you sign, because it is short and it gives a lot. You grant the licensor a license to your contribution that lasts for good and cannot be taken back, under copyright and patent, to use it, change it, pass it on, license it to others and sell it, under any terms the licensor chooses, now and later. You confirm that the work is yours to give, and you give it as it is, with no warranty. By its own words the agreement applies from the moment you submit a contribution in any form, and the comment is the record that you agreed. It is separate from [the license](../LICENSE.md), which says what anyone, you included, may do with It.

Three things the bot does are worth knowing beforehand. Your signature is kept in this repository, on the branch `cla-signatures`, as your account's name and id, the pull request and the time. A pull request is locked once it is merged, so a signature on it cannot be withdrawn by editing the comment. And the bot matches each commit to a GitHub account by its author address, so a commit whose address belongs to no account cannot be signed for, and the check stays red until the commit is rewritten with an address that does.

## What happens to a pull request from a fork

The workflow that builds and tests It runs on a pull request from a fork exactly as it does on a branch of this repository. Nothing It does needs an account, so that workflow is given no secret and a token that can only read, and none of its jobs is held back from a fork. Its last job, "It is ready to merge", passes only when every job of that workflow that blocks a merge has passed. One job does not block: the unit tests on Windows report, and a failure there does not fail it.

The agreement is a second check, "Contributor agreement", from a workflow of its own, and "It is ready to merge" does not wait for it. That workflow is the one that GitHub gives a token that can write, which it uses to keep a signature, to comment on the pull request and to lock it once it is merged. It runs as it is on `master`, checks nothing out, and runs none of the pull request's code. So there are two checks to watch, and a pull request is ready when both are green.

## Building It

Use Node 24, as CI does. Nothing here needs an account or a setting.

```sh
npm install
npm run generate        # everything the program carries, and then the program
```

The program carries the other parts inside it. `npm run generate` builds the script that is placed in every page, packs the add-ons, builds the site, bundles the backend's functions, and then builds the `it` command with all four in it, as `packages/cli/dist/it.mjs`. Run it again after changing any of the four.

The program as it is built for Node runs on Node 22.13 or a later Node 22, on Node 23.4 or a later Node 23, and on any Node after that: it uses `node:sqlite`, which those have without a flag. Run under another Node, it says in a sentence which one it needs, and does nothing else. The standalone programs that people install are built with `node packages/cli/release.mjs`, which takes the build of Bun 1.3.11 that the third-party notices describe, and refuses any other.

## Running It from a checkout

No `it` command is on your PATH in a checkout: the program is `node packages/cli/dist/it.mjs`. Give it a folder and a port of its own first, so that it never touches an It you use.

```sh
export IT_HOME=~/.it-dev IT_PORT=4800
node packages/cli/dist/it.mjs setup --none --no-service   # sets It up there, and connects no agent app
node packages/cli/dist/it.mjs serve                       # runs It until Ctrl-C
```

`serve` keeps that terminal. In another one, set the same two variables again, since a new terminal has neither, and open the site:

```sh
export IT_HOME=~/.it-dev IT_PORT=4800
node packages/cli/dist/it.mjs site                        # opens the site, paired
```

Run `it setup` with `--none` while you work on It. Run plainly, it installs add-ons into your own agent apps.

`npm run dev -w web` serves the site from its source at `http://localhost:5173`, and passes everything the site asks of the backend on to an It that is running on this machine, on the port `IT_PORT` names or else 4700. A browser paired with `it site` is paired there too. One thing does not work there: a page is not shown, because the site looks for pages on the port after its own, and beside the development server nothing listens there. To see pages shown, build with `npm run generate` and open the site that It serves.

## Before you open a pull request

```sh
npm run check:ci        # the lint, where a warning is a failure; `npm run format` fixes what it can
npm run typecheck
npm test                # the unit tests: backend, content service, command and service, site, add-ons
npm run test:hermes     # only if you touched the Hermes add-on, which is Python
npm run check:notices   # only if you changed what a part depends on; `npm run notices` rewrites the file
```

`npm run generate` comes first, since the tests import what it writes. Some tests need more than Node, and skip themselves where it is not there:

- The tests that start Convex's real backend program find it by `IT_BACKEND_BIN`. A first run in a folder of its own fetches it: `IT_HOME=/tmp/it-first-run node packages/cli/dist/it.mjs setup --none --no-service`, and then `export IT_BACKEND_BIN="$(find /tmp/it-first-run/backend/bin -type f -name 'convex-local-backend*')"`.
- The tests that run a page in a real browser need Playwright's browsers: `npx playwright install chromium firefox`.
- The door's, the service's and the content service's tests are run a second time under Bun, with `bun test ./packages/cli/door.test.ts ./packages/cli/push.test.ts ./packages/cli/direct.test.ts ./packages/cli/serve.test.ts` and `npm run test:bun -w @it/content`, since the standalone program runs under it.

The end-to-end suite runs everything together in a real browser. `node e2e/stack.mjs` starts It in a folder of its own, `node e2e/ready.mjs` waits for it, `node e2e/run.mjs --quick` runs the suite in about five minutes, and `node e2e/stop.mjs` stops the stack. CI runs all of this on every pull request, and `.github/workflows/it.yml` is what it runs.

## What makes a change easy to accept

- It keeps to what It is. It connects agents that people already run, and never runs one for them. It reaches each agent app as a plugin to the unmodified program, with the app's own official commands, and wraps nobody's command. It needs nothing but the person's own machine: no account, no key from anyone, and no service that someone else runs.
- It keeps what is private, private. Nothing is shown to a browser that has not been paired, a page cannot reach the site or another page, and nothing a page or a person sent ever reaches a log: logs carry ids, counts, codes and reasons.
- Where it moves a limit of what It protects, it changes the sentence in [What It protects, and what it does not](what-it-protects.md) with it.
- It comes with a test when it adds a code path, touches a boundary someone could attack, or fixes a fault that was really hit.
- Its commits are a single line each.
