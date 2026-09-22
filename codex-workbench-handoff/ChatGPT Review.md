I’ve now caught myself up on the actual repository rather than just the handoff plan. I inspected `workbench/main`, the feature branches, the verification ledger, the VS Code implementation, the Rust TUI patch, packaging/CI, the pinned App Server schema, and the current upstream delta.

The overall direction is still sound. The **CLI track is in much better shape than I expected at this stage**: it has stayed narrow, the large-MCP-payload behavior is tested through the real stdio transport, and it has Windows/Linux evidence. The **VS Code track has successfully crossed the important “real Codex backend actually works” threshold**, but the three live runs have exposed that the fake-server tests are abstracting away some important details of the real App Server protocol.

There are several issues I would fix before letting the agent keep adding features. A few are genuine bugs rather than unfinished polish.

| Priority         | Finding                                                                                           | Why I care                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Critical**     | Real App Server `ThreadItem` objects are not being normalized correctly                           | Likely explains the duplicate/raw `userMessage` issue and will break rich tool rendering                 |
| **Critical**     | Webview/session restoration appears not to actually persist                                       | Reloading VS Code can lose the panel→thread restoration path despite the implementation claiming support |
| **High**         | Tool rendering uses simplified/wrong protocol shapes, including `mcpCall` vs actual `mcpToolCall` | Current UI can never become the Claude-style tool timeline cleanly until this is corrected               |
| **High**         | Approval UI exposes “Approve” for requests it cannot actually approve                             | Permissions/user-input flows can silently turn an apparent approval into a denial                        |
| **High**         | Workspace Trust claim is stronger than the implementation                                         | The extension launches an agent backend in an untrusted workspace                                        |
| **High**         | VSIX release packaging is Linux-broken                                                            | The release workflow invokes `powershell.exe` on an Ubuntu runner                                        |
| **Medium**       | Multiple visible chat panes are not correctly focus-aware                                         | Exactly your desired split-screen workflow can attach context/rename the wrong chat                      |
| **Medium**       | Official-Codex fallback accepts far too much protocol drift for writes                            | A handshake succeeds, then mutation APIs may be incompatible                                             |
| **Medium**       | Release/tag workflow can build the wrong commit                                                   | `main` is pristine upstream while the actual product lives on `workbench/main`                           |
| **Medium**       | Current fork is already 6 upstream commits behind, including App Server protocol changes          | Not alarming yet, but demonstrates how rapidly the integration surface is moving                         |
| **Medium**       | `chatgpt/src/lib.rs` recursion-limit patch is unrelated fork surface                              | It exists because of a local Rust 1.98 build rather than our feature requirements                        |
| **Expected gap** | UI still isn’t really Claude-like yet                                                             | M4 is explicitly incomplete, so I regard this as unfinished rather than a regression                     |

Here are the important ones in detail.

### 1. The biggest problem: the frontend is not consuming the real `ThreadItem` schema correctly

This is the one I would stop and fix **before doing more UI work**.

The pinned App Server schema defines `ThreadItem` roughly like this:

* `userMessage` → `content: UserInput[]`
* `agentMessage` → `text`
* `reasoning` → `summary: string[]`, `content: string[]`
* `commandExecution` → `command`, `cwd`, `aggregatedOutput`, `status`, etc.
* `fileChange` → `changes[]`, containing path/kind/diff
* `mcpToolCall` → `server`, `tool`, `arguments`, `result`, `error`, status

See the pinned generated schema at:

`codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts`

But our current [`extension.ts`](https://github.com/Dacilla/codex-workbench-fork/blob/workbench/main/workbench/vscode/src/extension.ts) effectively does:

```ts
text: item["text"] ?? itemSummary(item)
```

For a real `userMessage`, there **is no `text` field**. Its actual text is inside:

```ts
content: [
  {
    type: "text",
    text: "..."
  }
]
```

So the backend item turns into:

```text
userMessage
```

because `itemSummary()` just falls back to the item type.

That is extremely interesting because your third live test recorded exactly:

> backend echo appears as a second card labelled `userMessage`

The latest fix tries to deduplicate the optimistic local message by matching the local text against the backend text:

```ts
if (
    item.kind === "userMessage" &&
    item.text === finalized.text
)
```

But the unit test feeds it a synthetic event with:

```ts
{
    kind: "userMessage",
    text: "Test"
}
```

which isn't the shape the actual App Server provides.

So I suspect **the new duplicate-message fix may still fail in the fourth real test**.

This is an important pattern: the fake server is testing our own simplified representation rather than sufficiently testing the actual generated protocol representation.

I would introduce one explicit boundary:

```text
App Server ThreadItem
        ↓
normalizeThreadItem()
        ↓
Workbench ViewItem
        ↓
Reducer / renderer
```

Then put all protocol-specific interpretation there.

For example:

```ts
userMessage
→ concatenate text UserInput entries

reasoning
→ summary/content

commandExecution
→ command + status + output

fileChange
→ files + diffs

mcpToolCall
→ server.tool + bounded argument/result representation
```

And tests should construct objects matching the actual generated `ThreadItem` types.

This one change will clean up a lot of apparently separate frontend bugs.

---

### 2. Session restoration looks implemented on paper, but the persistence chain is incomplete

This is the next thing I would fix.

The extension correctly registers:

```ts
vscode.window.registerWebviewPanelSerializer(...)
```

and `restorePanel()` expects state containing:

```ts
{
    panelId,
    threadId
}
```

But I cannot find anywhere in the webview that calls:

```ts
vscode.setState(...)
```

The webview API is declared with `getState()` and `setState()`, but neither is used.

Separately, `persistBindings()` writes to:

```ts
extensionContext.workspaceState
```

under:

```ts
codexWorkbench.panelBindings
```

but I cannot find anywhere that **reads that key back**.

And `ThreadRegistry` is created with its default:

```ts
new InMemoryStorage()
```

rather than an `ExtensionContext.workspaceState` adapter.

So there are currently three persistence concepts:

```text
VS Code webview serializer state
workspaceState panel bindings
ThreadRegistry storage
```

but they aren't actually connected into one restoration path.

That means a window reload/restart is very likely to produce an undefined serializer state or an empty registry, despite the comments claiming:

> serializer restores panel→thread bindings

I would fix this with both:

```ts
vscode.setState({
    panelId,
    threadId,
    draft
})
```

inside the webview, and a real `RegistryStorage` implementation backed by VS Code `workspaceState`.

The stored `workspaceKey` should also be checked before resuming anything, which matters particularly for Remote SSH.

---

### 3. Tool rendering is currently built around a simplified model that diverges from Codex

This is related to #1 but significant enough to treat separately.

Current [`ToolActivity.ts`](https://github.com/Dacilla/codex-workbench-fork/blob/workbench/main/workbench/vscode/src/webview/ToolActivity.ts) has:

```ts
case "mcpCall":
    return "Tool";
```

The actual Codex type is:

```text
mcpToolCall
```

Likewise, `isCollapsibleKind()` in `state.ts` looks for:

```text
mcpCall
```

not `mcpToolCall`.

So real MCP calls won't receive the intended Tool presentation.

More generally, `reasoning`, commands and edits don't have a generic `text` property either, so the current renderer is discarding most useful structured information.

That means the extension is currently doing this:

```text
Rich Codex event
      ↓
throw away structure
      ↓
generic string
      ↓
generic card
```

Whereas for the Claude-style experience we actually want:

```text
commandExecution
▸ Read src/foo.ts

fileChange
▸ Edit src/foo.ts
  +12 −3

mcpToolCall
▸ Confluence · updateConfluencePage
  pageId: 123... · body: 18,420 chars hidden

reasoning
▸ Thinking
  Checking the protocol implementation…
```

The structured protocol gives us enough information to do this very well. We just aren't using it yet.

This isn't merely visual polish; **the proper ViewItem normalization layer should become a core part of the extension architecture.**

---

### 4. Approval handling is secure, but functionally incomplete in a misleading way

The fail-closed implementation in [`Approvals.ts`](https://github.com/Dacilla/codex-workbench-fork/blob/workbench/main/workbench/vscode/src/sessions/Approvals.ts) is actually quite careful.

It handles:

* exactly-once responses,
* connection loss,
* approval timeout,
* orphaned requests,
* disposed tabs,
* unknown request kinds conservatively.

That's good.

But the graphical approval UI always presents:

```text
Approve    Deny
```

even when Workbench cannot construct a valid approval response.

For example:

```ts
case "permissions":
    return null;

case "userInput":
    return null;

case "dynamicTool":
    return null;
```

So clicking **Approve** on a permissions request without an explicit permission profile causes this logic to **fail closed and deny it**.

Similarly, `item/tool/requestUserInput` really needs an interactive questionnaire, not Approve/Deny.

This could be extremely confusing:

```text
User: Approve
Workbench: internally denies
Agent: operation refused
```

Before everyday use, I would make the frontend request-specific:

```text
commandExecution → Approve / Deny

fileChange       → Approve / Deny

permissions      → show requested permissions + grant choices

requestUserInput → render questions/options/text inputs

elicitation      → render requested content/form

dynamicTool      → unsupported message, no fake Approve button
```

This matters because your work usage includes fairly sophisticated tool integrations. Basic chat succeeding isn't enough.

---

### 5. Multiple visible editor tabs aren't actually focus-aware yet

This directly conflicts with the Claude layout you showed me.

For example, `attachSelection()` currently finds:

```ts
[...livePanels.values()].find(entry => entry.panel.visible)
```

Likewise for rename.

But if you have:

```text
┌──────── Chat A ────────┬──────── Chat B ────────┐
│                        │                         │
└────────────────────────┴─────────────────────────┘
```

both panels are `visible`.

Whichever happens to appear first in the map wins.

So:

> Attach Selection

could attach your code to **Chat A while you're actually interacting with Chat B**.

There is already a `panel/focus` protocol entry, but it isn't wired through into a proper active-panel concept.

We should track:

```ts
activePanelId
```

using `WebviewPanel.onDidChangeViewState` / webview focus events, then make all context-sensitive commands operate against that explicit panel.

---

### 6. There's also an approval ownership bug if the same thread is opened twice

This is subtler.

`EventRouter.routeServerRequest()` tries to choose one owning sink.

But the actual approval display callback later uses:

```ts
findPanelForThread(threadId)
```

which simply returns the first matching panel.

So the router can theoretically choose panel B while the approval UI gets shown in panel A.

Worse, closing **one** panel calls:

```ts
failClosedForThread(threadId)
```

which denies all pending approvals for the thread, even if the same thread remains open in another panel.

Two reasonable fixes exist:

```text
A. Forbid the same thread being live in multiple panels.

or

B. Make approval ownership explicitly panel-specific.
```

For our use case, I'd initially choose A. We need multiple **independent conversations**, not necessarily two graphical views of the same Codex thread.

---

### 7. The Workspace Trust declaration should be changed

Current `package.json` says:

```json
"untrustedWorkspaces": {
  "supported": true,
  "description": "Reads only untrusted workspace metadata..."
}
```

But on activation, the extension can launch:

```text
codex app-server
```

with the workspace directory as its cwd.

And then it can start coding-agent turns.

That is materially more than “reads only untrusted workspace metadata”.

I wouldn't ship that declaration.

For an early release I'd either declare untrusted workspaces unsupported, or implement a limited-trust mode where Workbench won't spawn/start the agent until the workspace is trusted.

This becomes even more relevant with Remote SSH and repositories you haven't vetted.

---

### 8. The VSIX release pipeline has a concrete cross-platform bug

This one should be easy to fix.

[`package-vsix.js`](https://github.com/Dacilla/codex-workbench-fork/blob/workbench/main/workbench/vscode/scripts/package-vsix.js) executes commands with:

```js
shell: "powershell.exe"
```

But [`workbench-release.yml`](https://github.com/Dacilla/codex-workbench-fork/blob/workbench/main/.github/workflows/workbench-release.yml) packages the VSIX on:

```yaml
runs-on: ubuntu-24.04
```

Ubuntu GitHub runners use `pwsh`, not `powershell.exe`.

So the first actual release run is very likely to fail at:

```text
npm run package
```

even though ordinary Windows/Linux extension CI is green.

I'd remove the shell dependency entirely and execute `npx`/`vsce` directly using Node's `execFileSync`/`spawnSync`.

---

### 9. Release tags aren't sufficiently guarded

There is an architectural oddity here:

```text
main
    pristine upstream

upstream-main
    pristine upstream

workbench/main
    actual product
```

That's workable for development.

But the release workflow triggers on:

```yaml
workbench-v*
```

and builds **whatever commit that tag points at**.

It doesn't currently verify that the tagged commit:

* belongs to `workbench/main`,
* contains the expected `UPSTREAM_SHA`,
* passed Workbench CI,
* contains the custom patches at all.

Someone could accidentally create:

```text
workbench-v0.1.0+upstream.639d247
```

while checked out on pristine `main`, and GitHub would happily package vanilla Codex.

Before we use releases, I'd add a guard that verifies the tag commit is a descendant of the integration branch and that the pin/patch metadata matches.

---

### 10. The official-backend fallback is useful, but it's too optimistic about compatibility

I like the fallback concept:

```text
codex-workbench
↓ if absent
official codex
```

But right now [`ProtocolVersion.ts`](https://github.com/Dacilla/codex-workbench-fork/blob/workbench/main/workbench/vscode/src/backend/ProtocolVersion.ts) considers a backend compatible if `initialize` contains four strings.

Then the UI warns:

> protocol drift is tolerated for reads; unsupported methods will error honestly.

Yet it still allows:

```text
thread/start
turn/start
approvals
interrupts
```

against that server.

That's a bigger compatibility promise than the handshake establishes.

You've already documented schema drift between the pinned source and official `0.155.1`.

And since we pinned the fork this morning, upstream is already **six commits ahead**, including an App Server protocol addition for explicit gateway OAuth.

Current upstream is:

```text
b58b05e062...
```

Our pinned base is:

```text
639d2478cc...
```

The upstream delta includes:

```text
#47207 Add explicit gateway OAuth sign-in to app-server
#47212 Preserve MCP request trace context
#47235 multi-agent spawn changes
...
```

So this protocol is actively evolving.

I'd make fallback compatibility explicit:

```text
Known-compatible official backend:
    full operation

Unknown/newer backend:
    read/resume allowed
    mutation disabled or requires explicit "try anyway"
```

Or define a small capabilities probe before enabling writes.

---

### 11. The fork has one unrelated Rust modification I would remove if possible

There is a custom change:

```text
codex-rs/chatgpt/src/lib.rs
```

adding a recursion-limit workaround.

The ledger explains this came from compiling the pinned source with local:

```text
rustc 1.98.1
```

while upstream itself pins:

```text
1.95.0
```

Your Linux validation with the pinned toolchain is already succeeding.

One of our original maintenance goals was:

> keep modifications to upstream Codex extremely narrow.

A build workaround required only because the local machine used a newer Rust compiler doesn't belong in the long-term patch stack if we can avoid it.

I'd standardize local/CI development on the repo's `rust-toolchain.toml` and test whether `153a588` can be reverted.

Less upstream code touched = much easier rebasing.

---

### 12. Our persistence docs are currently ahead of the implementation

A related housekeeping issue: `workbench/docs/architecture.md` references:

```text
codex-workbench-handoff/01-architecture-and-implementation.md
codex-workbench-handoff/02-agent-brief-cli.md
...
```

but that handoff directory isn't actually in the repository.

Those were files I generated for you here, so I know where the references came from.

We either need to add the canonical design docs to the repository or remove those dead paths and turn the `workbench/docs` files into the source of truth.

For an AI-agent-maintained project, keeping the actual specification in-repo is especially valuable.

---

## Where the project actually stands

I would describe the tracks differently now.

**Track A — CLI:** approximately where we wanted it to be after the first real prototype. The implementation is display-only, configurable, has a legacy/full mode, and most importantly has a real stdio transport test proving a **1 MiB and 25 MiB MCP argument survives byte-identically**. That's much stronger evidence than simply asserting the renderer doesn't mutate the JSON.

The remaining CLI work is mostly distribution validation: assembled Windows/Linux packages, real sandbox/login/MCP smoke tests, side-by-side npm installation, and the release process. The current TUI CI jobs for `f7232b8` are still running as I check this; VS Code Windows/Linux, secret scanning, and npm-pack checks are green.

**Track B — VS Code:** we have proven the central architectural gamble. A graphical WebviewPanel client can connect to the real Codex App Server, create a real thread, and complete a real model turn. That's the hard foundational result.

But we're now at the stage where **the protocol adapter needs to mature before more frontend polish is layered on top**. The live failures aren't random CSS bugs; they are showing that our internal simplified `ChatItem` abstraction isn't being populated correctly from real Codex `ThreadItem`s.

So I would alter the immediate implementation order.

The next coding-agent pass should be entirely about **protocol correctness and state lifecycle**, not adding more UI features:

1. Introduce a schema-aware `ThreadItem → Workbench ViewItem` normalization layer and fix real user-message/MCP/reasoning/command/file-change handling.
2. Replace mocks in key tests with fixtures matching the actual generated Codex types.
3. Repair panel/thread/draft restoration and add a restart test.
4. Fix focused-panel tracking and duplicate-thread approval ownership.
5. Make approval components method-specific.
6. Tighten Workspace Trust and official-backend compatibility.
7. Fix cross-platform VSIX packaging/release guards.
8. Only then continue M4 graphical refinement and Remote SSH validation.

After that, the extension work goes back onto a very clean trajectory.

The important point is that **I don't see evidence that the fundamental architecture was a mistake**. Quite the opposite: the real backend turn succeeding vindicates the App Server + editor-webview approach. What I see is the normal point where a prototype that worked against a fake backend needs a proper protocol adaptation layer before it grows into a production client.

And I would definitely fix the `ThreadItem` normalization issue **before your next live test**, because I think it is likely to explain at least one problem that the latest “duplicate user message” commit believes it has already solved.
