import type { ChannelAdapter, ChannelCallbacks } from './types.js';

const adapters: ChannelAdapter[] = [];
const started:  ChannelAdapter[] = [];

export function registerAdapter(a: ChannelAdapter): void {
  adapters.push(a);
}

export function listRegistered(): ChannelAdapter[] {
  return [...adapters];
}

export function listStarted(): ChannelAdapter[] {
  return [...started];
}

export function getAdapterByName(name: string): ChannelAdapter | undefined {
  return started.find(a => a.name === name);
}

export function getAdapterByChannel(channelType: string): ChannelAdapter | undefined {
  return started.find(a => a.channelType === channelType);
}

export async function startAdapters(cb: ChannelCallbacks): Promise<ChannelAdapter[]> {
  for (const a of adapters) {
    try {
      await a.setup(cb);
      started.push(a);
      console.log(`Channel "${a.name}" (${a.channelType}) online`);
    } catch (e: any) {
      console.error(`Channel "${a.name}" failed: ${e?.message ?? e}`);
    }
  }
  return [...started];
}

export async function stopAdapters(): Promise<void> {
  await Promise.allSettled(started.map(a => a.teardown()));
  started.length = 0;
}

export function clearRegistry(): void {
  adapters.length = 0;
}
