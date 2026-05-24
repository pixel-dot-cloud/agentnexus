import type { ChatMessage } from '../providers.js';

export interface SubagentSession {
  id:         string;
  // Spawner's agentId; undefined if spawned by main.
  parentId?:  string;
  name?:      string;
  task:       string;
  kind:       'general' | 'explore' | 'fork';
  status:     'running' | 'done' | 'error' | 'aborted';
  inbox:         string[];
  userInbox:     string[];
  boundBotName?: string;
  lastReadAt: number;
  history:    ChatMessage[];
  result?:    string;
  error?:     string;
  startedAt:  number;
  endedAt?:   number;
  abort:      AbortController;
}

class SubagentRegistry {
  private sessions = new Map<string, SubagentSession>();
  private maxSessions = 50;
  private ttlMs = 30 * 60 * 1000;

  register(s: SubagentSession): void { this.prune(); this.sessions.set(s.id, s); }
  get(id: string): SubagentSession | undefined { return this.sessions.get(id); }
  list(): SubagentSession[] {
    this.prune();
    const all = [...this.sessions.values()];
    return all.sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
    });
  }
  unreadSummary(): { id: string; unread: number }[] {
    return this.list()
      .filter(s => s.inbox.length > 0)
      .map(s => ({ id: s.id, unread: s.inbox.length }));
  }
  runningCount(): number {
    return [...this.sessions.values()].filter(s => s.status === 'running').length;
  }

  /** Drain all non-running session inboxes. Called on conversation reset so
   *  stale pending messages don't pollute the next session's system prompt. */
  clearInboxes(): void {
    for (const s of this.sessions.values()) {
      if (s.status !== 'running') {
        s.inbox = [];
      }
    }
  }
  private prune(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.status !== 'running' && s.endedAt && now - s.endedAt > this.ttlMs) {
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size > this.maxSessions) {
      const sorted = [...this.sessions.entries()]
        .filter(([, s]) => s.status !== 'running')
        .sort((a, b) => (a[1].endedAt ?? 0) - (b[1].endedAt ?? 0));
      while (this.sessions.size > this.maxSessions && sorted.length) {
        const [id] = sorted.shift()!;
        this.sessions.delete(id);
      }
    }
  }
}

export const subagentRegistry = new SubagentRegistry();
export const MAX_RUNNING_SUBAGENTS = 8;
