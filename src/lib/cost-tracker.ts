export interface TokenUsage {
  inputTokens:          number;
  outputTokens:         number;
  cacheReadTokens?:     number;
  cacheCreationTokens?: number;
}

interface ModelPrice {
  input:         number;
  output:        number;
  cacheRead:     number;
  cacheCreation: number;
}

const MODEL_PRICES: [string, ModelPrice][] = [
  ['claude-opus-4-7',    { input: 15.0,  output: 75.0,  cacheRead: 1.50,  cacheCreation: 18.75 }],
  ['claude-opus-4-6',    { input: 15.0,  output: 75.0,  cacheRead: 1.50,  cacheCreation: 18.75 }],
  ['claude-opus-4',      { input: 15.0,  output: 75.0,  cacheRead: 1.50,  cacheCreation: 18.75 }],
  ['claude-opus-3',      { input: 15.0,  output: 75.0,  cacheRead: 1.50,  cacheCreation: 18.75 }],
  ['claude-sonnet-4-6',  { input: 3.0,   output: 15.0,  cacheRead: 0.30,  cacheCreation: 3.75 }],
  ['claude-sonnet-4',    { input: 3.0,   output: 15.0,  cacheRead: 0.30,  cacheCreation: 3.75 }],
  ['claude-haiku-4-5',   { input: 1.0,   output: 5.0,   cacheRead: 0.10,  cacheCreation: 1.25 }],
  ['claude-haiku-4',     { input: 1.0,   output: 5.0,   cacheRead: 0.10,  cacheCreation: 1.25 }],
  ['claude-3-5-sonnet',  { input: 3.0,   output: 15.0,  cacheRead: 0.30,  cacheCreation: 3.75 }],
  ['claude-3-5-haiku',   { input: 0.80,  output: 4.0,   cacheRead: 0.08,  cacheCreation: 1.00 }],
  ['claude-3-haiku',     { input: 0.25,  output: 1.25,  cacheRead: 0.03,  cacheCreation: 0.30 }],
  ['claude-3-opus',      { input: 15.0,  output: 75.0,  cacheRead: 1.50,  cacheCreation: 18.75 }],
];

function priceFor(modelId: string): ModelPrice | null {
  const n = modelId.toLowerCase();
  for (const [key, price] of MODEL_PRICES) {
    if (n.includes(key)) return price;
  }
  return null;
}

export interface UsageStats {
  inputTokens:         number;
  outputTokens:        number;
  cacheReadTokens:     number;
  cacheCreationTokens: number;
  totalCostUsd:        number;
  apiCalls:            number;
}

const emptyStats = (): UsageStats => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalCostUsd: 0, apiCalls: 0,
});

export class CostTracker {
  private s: UsageStats = emptyStats();

  update(usage: TokenUsage, modelId: string): void {
    this.s.inputTokens         += usage.inputTokens;
    this.s.outputTokens        += usage.outputTokens;
    this.s.cacheReadTokens     += usage.cacheReadTokens     ?? 0;
    this.s.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
    this.s.apiCalls++;
    const p = priceFor(modelId);
    if (p) {
      this.s.totalCostUsd +=
        (usage.inputTokens * p.input +
         usage.outputTokens * p.output +
         (usage.cacheReadTokens ?? 0) * p.cacheRead +
         (usage.cacheCreationTokens ?? 0) * p.cacheCreation) / 1_000_000;
    }
  }

  getStats(): UsageStats { return { ...this.s }; }

  reset(): void { this.s = emptyStats(); }

  formatCost(): string {
    const c = this.s.totalCostUsd;
    if (c === 0) return '';
    return c < 0.001 ? '<$0.001' : `$${c.toFixed(4)}`;
  }

  formatTokens(): string {
    const t = this.s.inputTokens + this.s.outputTokens;
    if (t === 0) return '';
    return t >= 1000 ? `${(t / 1000).toFixed(1)}k tok` : `${t} tok`;
  }
}
