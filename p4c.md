# P4c — Sweep loop (stuck-container detection)

## Goal

Detect and reap stuck `full`-mode containers. Tools-only containers (P4a) are short-lived (one `docker exec` per call) and don't need sweeping. `full` mode containers persist for the duration of a turn and can wedge if the runner process hangs, the LLM stream stalls, or `docker exec`/networking breaks.

**Depends on P4b** (`full` mode + cred-proxy). Do not start before P4b lands.

## Hard constraints

- **Sweep is a safety net, not a substitute for proper timeouts.** Each RPC and provider call must already have its own deadline. Sweep catches what timeouts miss.
- **No false kills.** A long but healthy LLM call (e.g. extended thinking, 90s reasoning) must not be sweep-killed. Heartbeat owns liveness, not wall-clock.
- **Sweep only touches containers it spawned.** Track ids in an in-process registry. Never `docker ps` and kill arbitrary containers.
- **Toggleable.** `container.sweep.enabled` defaults true; interval and stale threshold are knobs.
- **No new daemon process.** Reuse the existing 60s tick in `src/core/scheduler.ts` if its lifecycle hooks make sense, else inline `setInterval` in the daemon.
- **Caveman naming.** No "claude-sweep" / "anthropic-sweep". Just `sweep`.

## Heartbeat protocol

Runner process inside the container writes (`utimes`) to `/heartbeat` (path in container) every 30s while a turn is in progress. Host checks via `docker exec <id> stat -c %Y /heartbeat`.

Why mtime rather than RPC: an RPC-based heartbeat fights the host's own JSON-RPC channel for stdout — if that channel is wedged, the RPC heartbeat is wedged too. File mtime + `docker exec` uses an independent code path through the Docker daemon, so a stuck stdio stream still surfaces a healthy filesystem heartbeat.

## Components

### 1. Sweep loop — `src/core/sweep.ts` *(new)*

```ts
export interface SweepEntry {
  containerId:    string;
  agentName:      string;
  startedAt:      number;    // epoch ms
  lastSeenMtime?: number;    // /heartbeat mtime, epoch s
  onStuck:        (reason: string) => Promise<void>;  // called once on kill
}

export interface SweepConfig {
  enabled:           boolean;
  intervalMs:        number;   // default 60_000
  staleThresholdMs:  number;   // default 120_000 (4x heartbeat period)
  startupGraceMs:    number;   // default 30_000 — don't sweep until first heartbeat opportunity
}

export class Sweeper {
  start(cfg: SweepConfig): void;
  stop(): void;
  register(entry: SweepEntry): void;
  unregister(containerId: string): void;
}
```

Per-tick (every `intervalMs`):
1. For each registered entry:
   - Skip if `Date.now() - startedAt < startupGraceMs`.
   - Run `docker exec <id> stat -c %Y /heartbeat` with 5s timeout. Capture mtime.
   - If `Date.now()/1000 - mtime > staleThresholdMs/1000`, mark stuck.
   - If `stat` itself fails (exec broken, container gone), mark stuck.
2. For each stuck entry: call `onStuck(reason)`, then `docker kill <id>`, then `unregister`.

### 2. Hook into runner spawn — `src/core/run-turn.ts`

When `mode === 'full'`:
- After `spawnRunner`, call `sweeper.register({ containerId, agentName, startedAt: Date.now(), onStuck })`.
- In the `finally` block, call `sweeper.unregister(containerId)`.
- `onStuck` deliver an error message to the channel ("Agent turn killed: container heartbeat stale") and reject the in-flight turn promise.

### 3. Runner-side heartbeat — `src/runner.ts`

Container-side. Background `setInterval(30_000)` calls `fs.utimes('/heartbeat', now, now)` while a turn is processing. Stop interval on `done` RPC.

`/heartbeat` is touched once at runner startup so the file exists before sweep first checks.

### 4. Config — `src/config.ts`

```ts
container?: {
  // ... existing P4a/P4b fields ...
  sweep?: {
    enabled?:          boolean;     // default true
    intervalSec?:      number;      // default 60
    staleThresholdSec?: number;     // default 120
    startupGraceSec?:  number;      // default 30
  };
};
```

Getter `getSweepConfig()` returns a fully-defaulted object. Menu pane in `src/lib/menu-tree.ts`.

## Files

New:
- `src/core/sweep.ts`

Modified:
- `src/core/container.ts` — `spawnRunner` ensures `/heartbeat` is created in the image (Dockerfile: `RUN touch /heartbeat`) — or container-side runner creates it on boot.
- `src/runner.ts` (created in P4b) — add heartbeat interval.
- `src/core/run-turn.ts` — wire register/unregister around the `full`-mode branch.
- `src/index.ts` — start/stop `Sweeper` in daemon lifecycle.
- `src/config.ts` — sweep config block + getter.
- `src/lib/menu-tree.ts` — sweep pane.
- `container/Dockerfile` — `RUN touch /heartbeat && chmod 666 /heartbeat`.

## Verification

1. `npm run typecheck` + `npm run build` clean.
2. **Healthy path**: spawn a `full`-mode agent, run a long (60s+) turn → container reaped normally; sweep never kills.
3. **Stuck container**: inside runner, `kill -STOP $$` to freeze the process. Sweep should kill the container within `staleThresholdSec + intervalSec` of the last heartbeat. Channel receives a stuck-container error message.
4. **Stuck docker exec**: simulate by pausing the container (`docker pause <id>` from outside). Heartbeat check `stat` will succeed but mtime won't advance — sweep kills after threshold.
5. **Startup grace**: turn that completes within `startupGraceMs` is never checked; verify no spurious "stat" calls during that window.
6. **Sweep disabled**: set `container.sweep.enabled = false`; freeze runner → no kill happens (turn hangs indefinitely, only abortable via `/abort`). Confirms toggle works.
7. **Concurrent**: two `full`-mode turns; freeze one, leave the other healthy. Sweep kills only the frozen one.
8. **No zombie state**: after every kill, `sweeper` registry is empty for that id; `docker ps` shows no container.

## Risk notes

- **Don't merge sweep into the cron scheduler.** Scheduler's tick fires user jobs which can themselves spawn long agents — coupling sweep timing to that loop creates head-of-line blocking. Standalone `setInterval`.
- **Clock skew between host and container** doesn't matter because both `Date.now()` and the heartbeat mtime are observed from the host. Don't trust container-reported timestamps.
- **`docker exec` itself can hang.** Use a 5s timeout on the stat call (`dockerExec(..., { timeoutMs: 5000 })` from P4a's helper). Two consecutive timeouts = stuck.
- **TOCTOU on kill**: between "stat says stale" and "kill" the container might exit normally. `docker kill` on a stopped container is a no-op — safe.
- **Don't sweep tools-only containers.** They are spawned and reaped synchronously inside one `runTurn` call; sweep would race with normal teardown. Restrict registration to `mode === 'full'` only.

## Out of scope for P4c

- Auto-restart of stuck turns. Once killed, the turn fails and the channel is notified — user retries manually.
- Container resource metrics (cpu/mem trends). Sweep is liveness-only.
- Health-check during idle (no in-flight turn). Containers are spawned per-turn; no idle state to monitor.
