import React from 'react';
import { render } from 'ink';
import { createRequire } from 'module';
import { ConfigManager } from '../config.js';
import { App } from './app.js';
import { dbg, dbgErr } from '../lib/debug.js';

const _req = createRequire(import.meta.url);
const _pkg = _req('../../package.json') as { version: string };
const VERSION = _pkg.version ?? '';

const AUTO_MODEL = '__auto__';

function isConfigured(config: ConfigManager): boolean {
  const cfg = config.getConfig();
  if (!cfg.activeProvider || !cfg.providers.length) return false;
  // AUTO_MODEL is valid for local providers (Ollama, LM Studio) with no model list.
  if (cfg.activeModel === AUTO_MODEL) return true;
  return !!(cfg.activeModel && cfg.models.length);
}

export async function launchTui(config: ConfigManager): Promise<void> {
  if (!isConfigured(config)) {
    console.log('No model configured. Run: agentnexus setup  or  agentnexus config');
    process.exit(0);
  }

  let running = true;
  while (running) {
    dbg('app.render.begin');
    const inst = render(
      <App
        config={config}
        version={VERSION}
        onMenu={() => {
          dbg('app.onMenu.unmount');
          try { inst.unmount(); }
          catch (e) { dbgErr('app.onMenu.unmount.error', e); }
        }}
      />,
      { exitOnCtrlC: false },
    );

    try {
      await inst.waitUntilExit();
      dbg('app.waitUntilExit.resolved');
    } catch (e) {
      dbgErr('app.waitUntilExit.threw', e);
    }

    // Reset stdin after Ink unmounts.
    dbg('stdin.reset.begin');
    if ((process.stdin as any).isTTY) {
      try { (process.stdin as any).setRawMode(false); } catch (e) { dbgErr('stdin.setRawMode', e); }
    }
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
    try { (process.stdin as any).ref?.(); } catch (e) { dbgErr('stdin.ref', e); }
    process.stdin.resume();
    // Restore terminal: show cursor, reset attrs, exit alt buffer.
    if ((process.stdout as any).isTTY) {
      process.stdout.write('\x1b[?25h\x1b[?1049l\x1b[0m');
    }
    dbg('stdin.reset.done');

    // Show config menu between sessions.
    dbg('cli.menu.begin');
    const { runConfigMenu } = await import('../lib/menu-cli.js');
    try {
      await runConfigMenu(config);
      dbg('cli.menu.done');
    } catch (e) {
      dbgErr('cli.menu.threw', e);
    }

    if (!isConfigured(config)) {
      console.log('No model configured. Exiting.');
      running = false;
    }

    // Prep stdin for next Ink render.
    if (running) {
      if ((process.stdin as any).isTTY) {
        try { (process.stdin as any).setRawMode(false); } catch (e) { dbgErr('stdin.postCli.setRawMode', e); }
      }
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('keypress');
      try { (process.stdin as any).ref?.(); } catch (e) { dbgErr('stdin.postCli.ref', e); }
      process.stdin.resume();
      dbg('stdin.postCli.done');
    }
  }
}
