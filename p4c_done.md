# P4c — Done

## Original intent

P4b shipped `full` mode: the entire agent loop runs inside a Docker container. The container persists for the duration of a turn. If the runner process hangs, the LLM stream stalls, or the `docker exec` / networking breaks, the container can wedge indefinitely — holding `state.isRunning = true`, blocking future turns, and leaking a container that never exits.

P4c closes that gap. Goal: **detect and reap stuck `full`-mode containers automatically**, without false-killing healthy long-running turns (extended thinking, 90s+ reasoning, large file operations).

The mechanism is file mtime. An RPC-based heartbeat would compete with the same stdio channel that may itself be wedged — useless if the channel is the problem. `docker exec stat` uses a separate code path through the Docker daemon, independent of the container's stdio, so it surfaces liveness even when the main channel is silent.

---

## What shipped

### `src/core/sweep.ts` *(new)*

The core sweep implementation. `Sweeper` class with:

- `start(cfg, dockerPath)` — starts a standalone `setInterval` tick (not coupled to the cron scheduler — see decisions below).
- `stop()` — clears the interval.
- `register(entry)` — adds a `SweepEntry` to the in-process registry.
- `unregister(containerId)` — removes entry (idempotent; safe to call twice).
- Per-tick logic:
  1. Skip entries younger than `startupGraceMs` — gives the container time to write its first heartbeat before being evaluated.
  2. `docker exec <id> stat -c %Y /heartbeat` with 5s timeout. Captures mtime as epoch seconds.
  3. If exec fails (container gone, stdio broken) → mark stuck.
  4. If `Date.now()/1000 - mtime > staleThresholdSec` → mark stuck.
  5. For each stuck entry: `unregister`, call `onStuck(reason)`, `docker kill <id>`.
- Exported singleton `sweeper` used by daemon and `run-turn.ts`.

```ts
export interface SweepEntry {
  containerId:    string;
  agentName:      string;
  startedAt:      number;
  lastSeenMtime?: number;
  onStuck:        (reason: string) => Promise<void>;
}

export interface SweepConfig {
  enabled:          boolean;
  intervalMs:       number;    // default 60_000
  staleThresholdMs: number;    // default 120_000 (4× heartbeat period)
  startupGraceMs:   number;    // default 30_000
}
```

### `container/Dockerfile`

```dockerfile
RUN touch /heartbeat && chmod 666 /heartbeat
```

Added before `ENTRYPOINT`. Creates the file at image build time so the sweep's first `stat` call always finds something to read — even if the runner process hasn't written a heartbeat yet.

### `src/runner.ts`

Container-side heartbeat writer. Two additions to `main()`:

1. **Startup touch** — `fs.utimesSync('/heartbeat', now, now)` called before reading the first `runTurn` message. Ensures the file's mtime reflects "container alive" from the earliest moment sweep might check.

2. **Background interval** — `setInterval(30_000)` calls `fs.utimes('/heartbeat', now, now, cb)`. Runs for the duration of the turn. Cleared (via `stopHeartbeat()`) before sending the `done` or `error` message, not on `process.exit` — so the sweep can distinguish "runner completed normally" from "runner is wedged".

### `src/core/container.ts`

Added `cidFile?: string` to `RunnerProcOptions`. When set, passes `--cidfile=<path>` to `docker run`. Docker writes the full container ID to this file as soon as the container is created (before the entrypoint runs).

### `src/core/runner-bridge.ts`

Container ID resolution via cidfile polling:

1. Generates a unique cidfile path (`os.tmpdir()/agentnexus-cid-<16hex>`).
2. Passes it to `spawnRunnerProc`.
3. Launches `waitForCidFile()` in the background — polls every 50ms for up to 10s until Docker writes a non-empty ID, then calls `args.onContainerSpawned(id)` and deletes the file.
4. If the container never starts (image pull failure, etc.) the poll times out and the cidfile is cleaned up; `onContainerSpawned` is never called and no sweep entry is registered.

Added `onContainerSpawned?: (containerId: string) => void` to `RunnerBridgeArgs`.

### `src/core/run-turn.ts`

Sweep wiring around the full-mode branch:

```ts
let sweptContainerId: string | null = null;

const result = await runTurnViaRunner({
  ...
  onContainerSpawned: (id) => {
    sweptContainerId = id;
    sweeper.register({
      containerId: id,
      agentName:   agent.name,
      startedAt:   Date.now(),
      onStuck: async (reason) => {
        await adapter.deliver(platformId, threadId, {
          text: `Agent turn killed: ${reason}`,
        }).catch(() => {});
        ac.abort();
      },
    });
  },
  ...
});
```

`onStuck` delivers the error to the channel then calls `ac.abort()`. The bridge's abort handler sends `{ type: 'abort' }` to the container and force-kills after 3s. The `catch` block in `run-turn.ts` checks `ac.signal.aborted` before delivering its own error — no double delivery. The sweeper also calls `docker kill` as a redundant force-kill (safe: `docker kill` on a stopped container is a no-op).

`finally` block: `sweeper.unregister(sweptContainerId)` — cleans up if the turn completed normally before a sweep tick could fire.

### `src/index.ts`

Daemon lifecycle wiring:

```ts
const swCfg = config.getSweepConfig();
sweeper.start(
  {
    enabled:          swCfg.enabled,
    intervalMs:       swCfg.intervalSec       * 1000,
    staleThresholdMs: swCfg.staleThresholdSec * 1000,
    startupGraceMs:   swCfg.startupGraceSec   * 1000,
  },
  config.getContainerDefaults().dockerPath,
);
```

`sweeper.stop()` called in the shutdown handler before `stopAdapters()`.

### `src/config.ts`

New `SweepConfig` interface:

```ts
export interface SweepConfig {
  enabled?:           boolean;   // default true
  intervalSec?:       number;    // default 60
  staleThresholdSec?: number;    // default 120
  startupGraceSec?:   number;    // default 30
}
```

`ContainerDefaults` gains `sweep?: SweepConfig`. `getContainerDefaults()` return type updated to omit `sweep` (handled via dedicated getter). New `getSweepConfig()` and `setSweepConfig()` on `ConfigManager`.

### `src/lib/menu-tree.ts`

`sweepNode()` added to the container defaults pane (item 4 in the menu). Exposes four knobs:

- Enabled toggle
- Interval (min 10s)
- Stale threshold (min 30s)
- Startup grace (min 0s)

All include "Restart daemon to apply." notice since `Sweeper.start()` is called once at daemon boot.

---

## Decisions made

| Decision | Choice | Reason |
|----------|--------|--------|
| Heartbeat mechanism | File mtime via `docker exec stat` | An RPC heartbeat uses the same stdio channel that may be wedged; `docker exec` routes through the Docker daemon independently |
| Sweep timing | Standalone `setInterval`, not the cron scheduler | Cron tick can spawn long agents itself; coupling sweep to that loop risks head-of-line blocking |
| Container ID resolution | `--cidfile` + 50ms poll | `docker run -i` doesn't return an ID on stdout (not detached); cidfile is written by Docker before the entrypoint runs — clean, no extra docker subprocess after spawn |
| `onStuck` action | Deliver error + `ac.abort()` | `ac.abort()` triggers the bridge's existing abort path (3s grace then SIGKILL); sweeper's `docker kill` is a belt-and-suspenders force-kill |
| Double error prevention | Check `ac.signal.aborted` in catch | Existing pattern in `run-turn.ts`; `onStuck` delivers the user-facing message, catch block is suppressed |
| False-kill protection | Startup grace (30s) + mtime staleness (120s) | Grace covers containers that haven't written their first heartbeat yet; 120s threshold = 4× the 30s heartbeat period, so two missed heartbeats before kill |
| Sweep enabled default | `true` | Opt-out rather than opt-in; sweep is a safety net and should be on unless the user has a reason to disable it |
| Tools-only containers | Not swept | Spawned and reaped within a single `runTurn` call; no persistent state to monitor |
| TOCTOU on kill | Accepted | `docker kill` on already-stopped container is a no-op; no harm if container exits between "stale detected" and "docker kill" |

---

## Verification checklist (from p4c.md)

- [x] `npm run typecheck` clean
- [x] `npm run build` clean
- [ ] **Healthy path**: spawn a `full`-mode agent, run a long (60s+) turn → container reaped normally; sweep never kills.
- [ ] **Stuck container**: `kill -STOP $$` inside runner → sweep kills within `staleThresholdSec + intervalSec` of last heartbeat; channel receives stuck-container error.
- [ ] **Stuck docker exec**: `docker pause <id>` from outside → stat mtime stops advancing → sweep kills after threshold.
- [ ] **Startup grace**: turn completes within `startupGraceSec` → no `stat` calls during that window.
- [ ] **Sweep disabled**: `container.sweep.enabled = false` → freeze runner → no kill (turn hangs until `/abort`).
- [ ] **Concurrent**: two full-mode turns, freeze one → sweep kills only the frozen one.
- [ ] **No zombie state**: after kill, `sweeper` registry empty for that id; `docker ps` shows no container.

Items marked `[ ]` require a live Docker environment and running daemon.

---

## What is NOT in P4c

- Auto-restart of stuck turns. Kill is final — user retries manually.
- Container resource metrics (CPU/mem trend monitoring). Sweep is liveness-only.
- Health checks during idle. Containers are turn-scoped; no idle state exists.
- Sweep for `tools-only` containers (P4a). They teardown synchronously inside `runTurn`.
