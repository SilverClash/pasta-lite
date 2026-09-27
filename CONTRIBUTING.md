# Contributing to Pasta Lite

Thanks for your interest in Pasta Lite. It is a small, alpha-stage Electron git client that runs
from source. It has no framework and no bundler. Bug reports, fixes and focused features are
welcome.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, do not
open an issue: follow [SECURITY.md](SECURITY.md) instead.

## Requirements

- **Node.js 22.12 or newer** (Electron's installer needs it; CI runs 22 and 24). `npm run lint`
  needs 22.13 or newer, because ESLint 10 requires it.
- **git 2.51 or newer.** The app checks this at startup (`src/gitcheck.js`) and refuses to run
  with an older git, because undo relies on `git reflog write`. The tests need it too. Apple's
  bundled git is usually older, so install git with Homebrew or your package manager.
- **OS:** the app is developed and tested on macOS. Windows and Linux are untested, though CI runs
  the test suite on Ubuntu. Reports and fixes for other platforms are welcome.

## Setup

```sh
npm ci
npm start                    # launch the app
npm start -- /path/to/repo   # launch it with a repository open
```

To try the app on a realistic repository, build a demo one. It has branches, merges, an octopus
merge, tags, stashes, a bare "origin" and a dirty working tree:

```sh
node scripts/demo-repo.js /tmp/demo   # creates /tmp/demo and /tmp/demo.origin.git next to it
npm start -- /tmp/demo
```

With no argument, the script creates `./demo-repo` and `./demo-repo.origin.git`. Both are
git-ignored. It refuses to write into a folder that is not empty.

## Tests

```sh
npm test                           # the whole suite: node --test test/*.test.js
node --test test/hunks.test.js     # one file
node --test --test-name-pattern="stage" test/hunks.test.js   # matching tests in one file
```

The whole suite takes about a minute on a recent Mac and several minutes on slower machines or CI
runners. The tests use Node's built-in test runner and don't start Electron. They load `src/`,
`main/` and the renderer scripts under plain Node (`test/renderer-harness.js` supplies a fake
`window`). They create throwaway repositories under the OS temp folder. `test/helpers.js` isolates
them from your `~/.gitconfig` and sets their own author, so no git identity setup is needed.

### Smoke run

To check the real app, the `--smoke` harness renders a view without ever showing a window, saves
it to a PNG, prints one JSON line and exits (0 on success, 1 on failure):

```sh
npx electron . --smoke /path/to/repo out.png   # a repository view
npx electron . --smoke out.png                 # the start screen (no repository)
```

It uses a throwaway `userData` folder, so your recent list and tabs are left alone, and it times
out after 30 seconds. Packaged builds ignore `--smoke`. `main/smoke.js` documents the `PL_SMOKE_*`
environment variables. `PL_SMOKE_JS` runs a script in the page, for example, which can drive the
real controls through DOM events to check a flow end to end.

## Lint

```sh
npm run lint
```

ESLint is not a dependency. The script runs a pinned version through `npx`, so the first run
downloads it. `eslint.config.js` enables the recommended rules only, with no formatting rules and
no Prettier. The editor settings are in `.editorconfig`: 2 spaces, LF, UTF-8 and a final newline.
Please don't add new lint findings. Fixes for existing ones are welcome as separate PRs.

## Architecture

Git runs in the Electron main process; the pages talk to it over IPC and never touch Node.

- **`src/`** is the git layer and the app's logic, free of Electron: nothing in it requires
  `electron`, so all of it runs and is tested under plain Node (dialogs, windows and `spawn` are
  passed in). It runs the `git` CLI through `src/git-process.js` with fixed `-c` overrides and an
  env allowlist, and messages and path lists go on stdin. `src/git.js` is the git facade,
  `src/ops.js` the registry of operations and `src/runner.js` their queue (one write at a time per
  repository, reads don't wait).
- **`main.js` and `main/`** are the main process. `main.js` is the composition root; `main/` holds
  the window, the tabs (one `WebContentsView` and one `src/tab-session.js` per tab), the menu,
  IPC registration, the Help and crash UI, and the `--smoke` harness.
- **IPC** is one table, `src/ipc-contract.js`. Git operations go through a single `op` channel
  that accepts only the names in `ops.OPS`; main injects the tab's repository and checks the sender.
- **`preload.js` and `preload-tabs.js`** are sandboxed preloads that can require only `electron`.
  They expose `window.api` to a tab's page (`renderer/index.html`) and `window.tabsApi` to the tab
  strip (`renderer/tabs.html`).
- **`renderer/`** is plain JavaScript and CSS with no framework and no build step: window-global
  modules loaded by `<script>` tags (see below), a store, components in `renderer/components/` and
  the user-facing flows in `renderer/flows-*.js`.
- **`test/`** has one `node:test` file per area. Git-layer tests run against throwaway repos
  (`test/helpers.js`); renderer tests load the scripts with a fake `window` and DOM
  (`test/renderer-harness.js`).

### Conventions

- **Plain-script renderer.** `renderer/index.html` loads each file with a `<script>` tag, in
  dependency order. Each file is an IIFE that publishes one window global, such as `window.Store`,
  `window.PLFlows`, `window.PLPolicy` or `window.Components`. It reads its dependencies from
  `window`, and there are no ES modules or imports. Files that tests need also export through
  `module.exports` when `module` exists (the "CommonJS-or-window" idiom). If you add a file, add
  its `<script>` tag in the right place and its global to `RENDERER_GLOBALS` in
  `eslint.config.js`.
- **Components** register with `Components.register(name, { mount(rootEl, store) })`. They read
  `store.state`, subscribe to keys, and change state only through `store.actions.*`. The contract
  is at the top of `renderer/store.js`. Writes go through the flows (`renderer/flows-*.js`), which
  share one lock and the busy and bare-repository guards.
- **Git-derived text is never HTML.** Branch names, commit messages, paths and diffs are rendered
  with `textContent` or `createTextNode`, never `innerHTML`. The pages run under a strict Content
  Security Policy with no inline scripts.
- **IPC is allowlisted.** Every channel is listed in the table in `src/ipc-contract.js`, and
  `main/ipc.js` registers exactly those channels. Git operations go through a single `op` channel,
  and only the names in `ops.OPS` (the descriptors in `src/ops.js`) are accepted. Each op
  validates its arguments (`src/op-validators.js`). The renderer never passes a repository path:
  main injects the sending tab's repository. To add an operation, add its descriptor, its
  validation and tests. `test/ipc-contract.test.js` checks that the preloads' channel literals
  match the table.
- **Errors carry a kind.** Failures are errors with an `err.kind` from the catalogue in
  `src/error-kinds.js`, which the renderer shares. Use an existing kind where one fits.
- **Tests come with changes.** Each area has a test file under `test/`. Git-layer tests run
  against real throwaway repositories rather than mocks of git.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a scope naming
the area:

```
feat(renderer): search field in the toolbar branch switcher
fix(rebase): friendlier pushed-commits warning
refactor(src): status and pull modules; no lazy requires left in the git layer
docs: architecture overview in CONTRIBUTING
test(main): guard the helpers both sandboxed preloads duplicate
chore: relicense under Apache 2.0
```

- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore` and `ci`.
- Common scopes: `src`, `main`, `renderer`, `ops`, `rebase`, `bare`, `tabs`, `graph` and `plan`.
- Write the subject in lower case, in the imperative or as a noun phrase, with no trailing period.
  Use the body to explain why.

## License of contributions

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project (inbound = outbound, per §5 of the
license). There is no CLA.

## Pull requests

- **Keep PRs focused**: one feature or fix per PR. Put unrelated clean-ups in their own PR.
- **Add or update tests** for every behaviour change, and run `npm test` before you push. CI runs
  it on macOS and Ubuntu.
- **Run `npm run lint`** and don't add findings.
- For UI changes, include a screenshot. A smoke-run PNG is fine.
- If the change alters how a part works, update its header comment, and the Architecture section
  above if the change moves responsibilities between parts.
- Fill in the pull request template. Say how you tested the change and which OS and git version
  you used.
