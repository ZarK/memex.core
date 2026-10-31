# @tjalve/memex-node-ui

The settings of Memex.Node as custom elements for any Memex app (MIT): no framework, no styles to load.

| Element | Shows |
|---|---|
| `<memex-node-packs>` | The packs of Node: state, size, license. Install, read and accept a license, remove. `app` is the app id recorded with an acceptance. `only` limits the list to pack ids, with commas. |
| `<memex-node-backends>` | The model servers that the user adds, how many calls each takes at once and where that number comes from, and where each function runs: automatic, or a server, a model, and a limit. |
| `<memex-node-location>` | Where the pack store is, a move to another folder with its progress, and the sync warning. |

## Use

A browser cannot reach the pipe or socket of Node, so the app's own server passes the calls on. Mount this behind the app's session check:

```ts
import { ensureNode } from "@tjalve/memex-node-client";
import { nodeUiCall } from "@tjalve/memex-node-ui/server";

const node = await ensureNode();

// In the app's server: `path` without the mount path and the query, `body` the raw bytes of the request.
const answer = await nodeUiCall(node, { method, path, body });
// Answer with answer.status, answer.contentType, and answer.body.
```

`nodeUiCall` passes only the settings routes of Node; work, leases, and drain answer 404. It follows Node after an idle stop or a drain, and answers 503 with an error body when Node does not answer.

In the page:

```ts
import { defineMemexNodeElements } from "@tjalve/memex-node-ui";

defineMemexNodeElements();
```

```html
<memex-node-packs app="photos"></memex-node-packs>
<memex-node-location></memex-node-location>
<memex-node-backends base="/api/node"></memex-node-backends>
```

The elements take the theme's `--ink`, `--ink-2`, `--ink-3`, `--line`, `--line-2`, `--accent`, `--card`, and `--sans`, and have their own fallbacks. They are in a shadow root; rows and progress bars have the parts `row` and `progress`.

## License

MIT.
