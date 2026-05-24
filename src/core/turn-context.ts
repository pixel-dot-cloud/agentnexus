import type { ChannelAdapter } from '../channels/types.js';

export interface TurnContext {
  adapter:    ChannelAdapter;
  platformId: string;
  threadId:   string | null;
  agentName:  string;
}

const stack: TurnContext[] = [];

export function pushTurnContext(c: TurnContext): void {
  stack.push(c);
}

export function popTurnContext(): void {
  stack.pop();
}

export function currentTurnContext(): TurnContext | undefined {
  return stack[stack.length - 1];
}
