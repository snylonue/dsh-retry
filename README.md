# dsh-retry-button

A manual **Retry** button for a turn that ended without answering your request.

When a model request exhausts automatic retries, or when you press **stop**
mid-turn, the retry button re-sends that turn's original message as a new turn
— so you no longer have to type `继续` by hand.

## What it does

- Detects the terminal reason of a turn and offers a retry exactly when the
  request was never answered.
- Replaces the shipped `turn-error` row renderer (keyed slot
  `conversation.chat.node`) to add the button to request failures.
- Contributes its own `turn-cancelled` Conversation Definition and Chat node
  kind for user cancellations, which the shipped UI does not present.
- On click, puts the recovered original message back into the composer and
  submits it through `inputActions` — the **same submit path a typed message
  takes**. The result is an ordinary, fully replayable turn in the session log.

## Coverage

Which terminal reasons offer a retry, and why:

| `turn/end` reason | Retry | Why |
|---|---|---|
| `error` | ✅ | The request failed (provider error, exhausted auto-retries). The prompt was never processed. |
| `aborted` / cause `user` | ✅ | You pressed stop. The prompt was not completed. |
| `aborted` / cause `parent` | ❌ | A parent agent tore this one down (subagent teardown). User retry is not the remedy. |
| `aborted` / cause `hook` | ❌ | Another plugin aborted. Includes the `deepseek-account/signed-out` case shown by the shipped error row, where re-sending would only fail again until you sign in. |
| `aborted` / cause `disposed` | ❌ | Host or plugin shutdown. Nothing to re-run. |
| `aborted` / cause `legacy` | ❌ | Imported history with no recorded cause; we cannot tell who cancelled, so we do not guess. |
| `completed` | ❌ | The turn succeeded. |
| `max-tokens` | ❌ | The model answered but hit its cap. The right follow-up is "keep going", not "redo" — different intent. |
| `blocked` | ❌ | A policy/hook refused the turn; re-sending cannot change that. |
| `interrupted` | ❌ | A crash closed an already-dead turn. Resuming the session continues it; there is no live request to re-issue. |
| `forked` | ❌ | Only fork-seed construction writes this. Not a failure. |

## What it deliberately does not do

- **It does not replay a synthetic message.** A `user/message` event is not
  always human text: `agent.inject()` context (file-change notices, subdir
  `AGENTS.md`, skill catalogs, cron notifications) and goal continuation rounds
  are also `user/message`. Only a genuine human prompt
  (`source.kind === 'user'`) from the retried turn is ever replayed, because
  resending loop-internal context as user intent would fabricate a prompt.
- **It does not re-run the single failed step.** That requires returning
  `{ kind: 'retry' }` from the agent loop's `agent/request-error` waterfall,
  which is not reachable from a client plugin. This starts a new turn instead.
- **It offers nothing for attachment-only prompts.** Text is required to
  recover a replayable message; re-sending an image-only prompt would need the
  full composer attachment path.

The button is disabled while a turn is running, and hidden when no retry is
possible — a signed-out failure, or no replayable human text in the turn.

## Install

The plugin is a normal DSH bundle package. Add it to the profile that runs the
Web GUI (`$DSH_HOME/profiles/web` for the default `web` profile):

```jsonc
// package.json
{
  "dsh": {
    "profile": {
      "bundles": [
        // ...existing bundles...
        "dsh-retry-button"
      ]
    }
  },
  "dependencies": {
    // ...existing dependencies...
    "dsh-retry-button": "github:snylonue/dsh-retry"
  }
}
```

Then allow the package's build script and install. pnpm 12 refuses a git
package whose build script is not allowlisted, and that refusal is a **hard
install error**, so the entry is required:

```yaml
# ${DSH_HOME}/profiles/web/pnpm-workspace.yaml
allowBuilds:
  'dsh-direnv@git+https://github.com/snylonue/dsh-direnv.git': true
  'dsh-retry-button@https://codeload.github.com/snylonue/dsh-retry/tar.gz/<rev>': true
```

Replace `<rev>` with the resolved tarball revision pnpm prints in its error
message — the key identifies one exact revision, so it changes when you move the
dependency to a new commit.

```bash
cd "${DSH_HOME:?}/profiles/web"
pnpm install
```

### Nothing prebuilt is published

`dist/` (the host half) and `lib/client.js` (the browser bundle) are both
build outputs, both gitignored, and neither is committed. The package's
`prepare` script produces them during install, so the checkout stays source-only
and the artifacts can never drift from the sources they came from.

The trade-off is the `allowBuilds` entry above: without it pnpm downloads the
package and then fails, because the host cannot import a `main` that does not
exist yet. If you would rather avoid build scripts entirely, use `link:` below.

The build asserts that every manifest-promised path exists, so a missing host
half fails the install loudly rather than surfacing later at activation as:

```
retry-button (dsh-retry-button): failed to import
```

### Local development

`link:` consumes this directory directly and needs no `allowBuilds` entry —
pnpm does not run build scripts for linked directories. Run `pnpm run build`
after editing sources, then refresh the page:

```jsonc
"dsh-retry-button": "link:/home/snylonue/tmp/dsh-retry-button"
```

## Build

```bash
pnpm install
pnpm run build     # tsc + esbuild, emits dist/ and lib/client.js
pnpm test          # unit tests for classification and message recovery
pnpm run typecheck
```

`lib/client.js` is the browser bundle, committed to the package's `files` list.
It is **not** a plain ES module: the Web client loads a plugin by executing a
script that calls `window.__ModuleLoader__.load({ id, factory })`, where
`factory(require)` resolves against the shell's frozen module table. React is
resolved from that table and must stay external — a bundled second copy would
break hooks. `scripts/build.mjs` produces that envelope with esbuild.

## Compatibility

Built and typechecked against DSH `0.2.0-rc.2`. The plugin depends on these
public contracts, which must be re-checked when upgrading DSH:

| Contract | Used for |
|---|---|
| `conversation.chat.node` keyed slot | replacing the `turn-error` renderer, and contributing the `turn-cancelled` one |
| `ctx.uiConversation.events.register` | the `turn-cancelled` Conversation Definition |
| Chat's public `ChatNodeDataMap` merge surface | declaring the `turn-cancelled` payload |
| Session standard props (`inputActions`, `sessionId`, `useSession`) | submitting the retry, gating on a live turn |
| `ctx.sessions.binding(id).eventSource` | reading the turn's events |
| `ctx.locale.register`, `ctx.slots.inject` | copy and slot registration |
| `dsh.client` package manifest | serving `lib/client.js` under `/plugins` |

Four implementation details are deliberate responses to the shipped code and
are worth re-checking on upgrade:

- **Both rows register at `priority: -1`.** A keyed slot rejects a second entry
  for the same `key` at the same `priority`, and the default rank is `0` —
  which is what the shipped `turn-error` renderer holds. Registering a
  replacement without an explicit lower rank throws out of `slots.inject`,
  fails the plugin's `apply`, and surfaces only in the browser as
  `web boot: 1 entry did not activate` / `dsh-retry-button: failed`. The lower
  rank wins because the lowest rank renders. `tests/slot-registration.test.ts`
  asserts this against the real registry.
- `anchorSeq` for the contributed row is `turn/end` seq **minus** a small
  offset, placing it before the `turn-tail` footer so the footer stays the
  turn's last row and keeps its own actions enabled.
- The chat package exports `ChatNodeDataMap` for third-party payloads, but not
  its internal `chatNode` builder or `CHAT_SYNTHETIC_SEQ_OFFSETS`. This plugin
  therefore constructs the node object itself, matching the
  `ChatConversationViewNode` shape the chat target requires.
- `dsh.client.inject` names packages that must load first. It must **not** name
  a baseline module (React, Cordis, `dsh-client-store`, `dsh-client-ui-slots`,
  `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`): the shell seeds those
  into the frozen module table, so they are not graph rows, and naming one asks
  for a supplier that cannot exist. `ctx.slots` is declared by
  `dsh-client-ui-renderer`, which is what this plugin injects instead. The build
  enforces this rule.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Host half: empty `apply`, so the package is a Loader entry |
| `src/client.tsx` | Browser half: both row renderers and the `turn-cancelled` Definition |
| `src/turn-outcome.ts` | Turn-end classification and replayable-message recovery |
| `src/locale.ts` | `en` / `zh` copy and the locale namespace declaration |
| `scripts/build.mjs` | esbuild + `__ModuleLoader__` envelope |
| `tests/` | Unit tests for the classification and recovery rules |
| `cordis.patch.yml` | The Loader entry that makes the bundle discoverable |

## License

MIT