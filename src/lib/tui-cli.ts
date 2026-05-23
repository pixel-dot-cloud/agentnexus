/**
 * Arrow-key TUI config screen for `agentnexus cli`.
 * Ported from opencc/src/cli.ts — adapted for agentnexus ConfigManager + providers.
 */
import * as readline from 'readline';
import { ConfigManager, AUTO_MODEL } from '../config.js';
import { ProviderFactory } from '../providers.js';

const KEY_DEBOUNCE_MS = 20;

function ensureCookedOnExit() {
  const restore = () => {
    if ((process.stdin as any).isTTY) {
      try { (process.stdin as any).setRawMode(false); } catch {}
    }
  };
  process.once('exit',  restore);
  process.once('SIGINT', () => { restore(); process.exit(130); });
  process.once('SIGTERM', () => { restore(); process.exit(143); });
}

export class AgentNexusTuiCLI {
  private rl: readline.Interface;
  private config: ConfigManager;

  constructor(config?: ConfigManager) {
    process.stdin.resume();
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    this.config = config || new ConfigManager();
    ensureCookedOnExit();
  }

  private ask(question: string): Promise<string> {
    return new Promise(resolve => this.rl.question(question, resolve));
  }

  private truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 3) + '...' : s;
  }

  private async selectFromList(items: string[]): Promise<string | null> {
    if (!items.length) return null;
    if (items.length === 1) return items[0];

    const maxWidth = Math.max(10, (process.stdout.columns || 80) - 10);
    let selected = 0;
    const isTTY = process.stdin.isTTY;

    if (!isTTY) {
      items.forEach((m, i) => console.log(`${i + 1}. ${this.truncate(m, maxWidth)}`));
      const choice = (await this.ask('Select: ')).trim();
      const idx = parseInt(choice) - 1;
      return (idx >= 0 && idx < items.length) ? items[idx] : null;
    }

    let lastSelected = -1;
    const showList = () => {
      if (lastSelected >= 0) {
        process.stdout.write('\x1b[' + items.length + 'A\x1b[J');
      }
      items.forEach((m, i) => {
        const label = this.truncate(m, maxWidth);
        if (i === selected) {
          console.log(`\x1b[7m  ${i + 1}. ${label}\x1b[27m`);
        } else {
          console.log(`  ${i + 1}. ${label}`);
        }
      });
      lastSelected = selected;
    };

    return new Promise(resolve => {
      showList();
      let lastKeyTime = 0;
      let isResolved = false;

      const cleanup = () => {
        (process.stdin as any).removeListener('keypress', handleKey);
        if ((process.stdin as any).isTTY) {
          try { (process.stdin as any).setRawMode(false); } catch {}
        }
      };

      const handleKey = (_ch: string, key: any) => {
        if (isResolved || !key) return;
        const now = Date.now();
        if (now - lastKeyTime < KEY_DEBOUNCE_MS) return;
        lastKeyTime = now;

        if (key.ctrl && key.name === 'c') {
          isResolved = true;
          cleanup();
          process.exit(130);
        } else if (key.name === 'down') {
          selected = (selected + 1) % items.length;
          showList();
        } else if (key.name === 'up') {
          selected = (selected - 1 + items.length) % items.length;
          showList();
        } else if (key.name === 'return') {
          isResolved = true;
          cleanup();
          resolve(items[selected]);
        } else if (key.name === 'escape') {
          isResolved = true;
          cleanup();
          resolve(null);
        }
      };

      try {
        (process.stdin as any).setRawMode(true);
        readline.emitKeypressEvents(process.stdin);
        (process.stdin as any).on('keypress', handleKey);
      } catch (e) {
        cleanup();
        isResolved = true;
        resolve(null);
      }
    });
  }

  private header(title: string) {
    console.clear();
    console.log(`\x1b[1mConfig > ${title}\x1b[0m\n`);
    console.log('\x1b[90mUP/DOWN navigate  |  ENTER select  |  ESC back  |  CTRL+C exit\x1b[0m\n');
  }

  async configureModels(): Promise<void> {
    while (true) {
      const cfg = this.config.getConfig();
      this.header('Models');

      if (cfg.models.length) {
        cfg.models.forEach(m => {
          const active = m.id === cfg.activeModel;
          const badge = active ? ' \x1b[32m✓ active\x1b[0m' : '';
          console.log(`  ${active ? '\x1b[32m' : ''}${m.name}\x1b[0m \x1b[90m[${m.provider}]\x1b[0m${badge}`);
        });
      } else {
        console.log('  \x1b[90mNo models configured.\x1b[0m');
      }
      console.log();

      const menuChoice = await this.selectFromList(['Select', 'Add', 'Remove', '← Back']);
      if (!menuChoice || menuChoice === '← Back') break;

      if (menuChoice === 'Select') {
        if (!cfg.models.length) continue;
        const items = cfg.models.map(m => {
          const active = m.id === cfg.activeModel ? ' \x1b[32m✓\x1b[0m' : '';
          return `${m.name} [${m.provider}]${active}`;
        });
        const selected = await this.selectFromList(items);
        if (selected) {
          const idx = items.indexOf(selected);
          this.config.setActiveModel(cfg.models[idx].id);
          console.log(`\x1b[32mActive: ${cfg.models[idx].name}\x1b[0m`);
          await this.ask('Enter to continue. ');
        }
        continue;
      }

      if (menuChoice === 'Add') {
        if (!cfg.providers.length) {
          console.log('\n\x1b[33mAdd a provider first.\x1b[0m');
          await this.ask('Enter to continue. ');
          continue;
        }
        const providerItems = cfg.providers.map(p => `${p.name} (${p.type})`);
        const selectedProvider = await this.selectFromList(providerItems);
        if (!selectedProvider) continue;
        const provider = cfg.providers[providerItems.indexOf(selectedProvider)];

        const isLocalLive = provider.type === 'ollama' || provider.type === 'lmstudio' ||
          (provider.type === 'custom' && provider.listModels);
        if (isLocalLive) {
          console.log('\n\x1b[32mLocal models auto-list in the /models picker — no add needed.\x1b[0m');
          console.log('\x1b[90mJust open the chat and use /models to pick from downloaded models.\x1b[0m');
          await this.ask('Enter to continue. ');
          continue;
        }

        let available: string[] = [];
        try {
          const tempProvider = ProviderFactory.create(provider.type, { model: '_', endpoint: provider.endpoint, apiKey: provider.apiKey });
          console.log('\nFetching available models...');
          available = await tempProvider.listModels();
        } catch (e: any) {
          console.log(`\x1b[33mProvider error: ${e.message}\x1b[0m`);
        }

        const isLocal = ['ollama', 'lmstudio', 'custom'].includes(provider.type);
        const AUTO_LABEL = 'Auto (use currently loaded model)';

        let id = '';
        if (available.length) {
          const choices = isLocal
            ? [AUTO_LABEL, ...available, 'Enter manually']
            : [...available, 'Enter manually'];
          const sel = await this.selectFromList(choices);
          if (sel === AUTO_LABEL) {
            id = AUTO_MODEL;
          } else if (sel === 'Enter manually') {
            id = (await this.ask('Model ID: ')).trim();
          } else {
            id = sel!;
          }
        } else {
          console.log('Could not fetch models. Enter manually.');
          if (isLocal) console.log(`  Or type "auto" to always use whatever model is currently loaded.`);
          const raw = (await this.ask('Model ID (e.g. gemma4:26b): ')).trim();
          id = raw === 'auto' ? AUTO_MODEL : raw;
        }

        if (!id) continue;
        const defaultName = id === AUTO_MODEL ? `Auto — ${provider.name}` : id;
        const name = (await this.ask(`Display name (blank to use "${defaultName}"): `)).trim();
        const ok = this.config.addModel({ id, name: name || defaultName, provider: provider.name });
        if (ok) console.log(`\x1b[32mAdded "${name || id}".\x1b[0m`);
        else    console.log(`\x1b[33mAlready exists (by id or name).\x1b[0m`);
        await this.ask('Enter to continue. ');
        continue;
      }

      if (menuChoice === 'Remove') {
        if (!cfg.models.length) continue;
        const items = cfg.models.map(m => `${m.name} [${m.provider}]`);
        const selected = await this.selectFromList(items);
        if (selected) {
          const idx = items.indexOf(selected);
          const { id, name } = cfg.models[idx];
          const confirm = (await this.ask(`\x1b[33mRemove "${name}"? [y/N] \x1b[0m`)).trim().toLowerCase();
          if (confirm === 'y') {
            this.config.removeModel(id, cfg.models[idx].provider);
            console.log(`\x1b[32mRemoved "${name}".\x1b[0m`);
          } else {
            console.log('Cancelled.');
          }
          await this.ask('Enter to continue. ');
        }
        continue;
      }
    }
  }

  async configureProviders(): Promise<void> {
    while (true) {
      const cfg = this.config.getConfig();
      this.header('Providers');

      if (cfg.providers.length) {
        cfg.providers.forEach(p => {
          const active = p.name === cfg.activeProvider;
          const badge = active ? ' \x1b[32m✓ active\x1b[0m' : '';
          console.log(`  ${active ? '\x1b[32m' : ''}${p.name}\x1b[0m \x1b[90m(${p.type})${p.endpoint ? ' — ' + p.endpoint : ''}\x1b[0m${badge}`);
        });
      } else {
        console.log('  \x1b[90mNo providers configured.\x1b[0m');
      }
      console.log();

      const menuChoice = await this.selectFromList(['Select', 'Add', 'Remove', '← Back']);
      if (!menuChoice || menuChoice === '← Back') break;

      if (menuChoice === 'Select') {
        if (!cfg.providers.length) continue;
        const items = cfg.providers.map(p => {
          const active = p.name === cfg.activeProvider ? ' \x1b[32m✓\x1b[0m' : '';
          return `${p.name} (${p.type})${active}`;
        });
        const selected = await this.selectFromList(items);
        if (selected) {
          const idx = items.indexOf(selected);
          this.config.setActiveProvider(cfg.providers[idx].name);
          console.log(`\x1b[32mActive: ${cfg.providers[idx].name}\x1b[0m`);
          await this.ask('Enter to continue. ');
        }
        continue;
      }

      if (menuChoice === 'Add') {
        const name = (await this.ask('Name: ')).trim();
        if (!name) continue;

        const typeOptions = ['Ollama', 'Google', 'Anthropic', 'LM Studio', 'Custom'];
        const typeSelected = await this.selectFromList(typeOptions);
        if (!typeSelected) continue;

        const typeMap: Record<string, 'ollama' | 'google' | 'anthropic' | 'lmstudio' | 'custom'> = {
          'Ollama': 'ollama', 'Google': 'google', 'Anthropic': 'anthropic',
          'LM Studio': 'lmstudio', 'Custom': 'custom',
        };
        const type = typeMap[typeSelected];
        if (!type) continue;

        let endpoint = '';
        let apiKey = '';

        if (type === 'ollama') {
          endpoint = (await this.ask('Endpoint (blank for http://localhost:11434): ')).trim();
          if (!endpoint) endpoint = 'http://localhost:11434';
        } else if (type === 'google') {
          apiKey = (await this.ask('API key: ')).trim();
          if (!apiKey) continue;
        } else if (type === 'anthropic') {
          apiKey = (await this.ask('API key: ')).trim();
          if (!apiKey) continue;
        } else if (type === 'lmstudio') {
          endpoint = (await this.ask('Endpoint (blank for http://localhost:1234): ')).trim();
          if (!endpoint) endpoint = 'http://localhost:1234';
          apiKey = (await this.ask('API key (blank if none): ')).trim();
        } else {
          endpoint = (await this.ask('Endpoint: ')).trim();
          if (!endpoint) continue;
          apiKey = (await this.ask('API key (blank if none): ')).trim();
        }

        let listModelsFlag: boolean | undefined;
        if (type === 'custom') {
          const ans = (await this.ask('List downloaded models from /v1/models endpoint? [y/N]: ')).trim().toLowerCase();
          listModelsFlag = ans === 'y';
        }

        this.config.addProvider({ name, type, endpoint: endpoint || undefined, apiKey: apiKey || undefined, listModels: listModelsFlag });
        console.log(`\x1b[32mAdded "${name}".\x1b[0m`);
        await this.ask('Enter to continue. ');
        continue;
      }

      if (menuChoice === 'Remove') {
        if (!cfg.providers.length) continue;
        const items = cfg.providers.map(p => `${p.name} (${p.type})`);
        const selected = await this.selectFromList(items);
        if (selected) {
          const idx = items.indexOf(selected);
          const name = cfg.providers[idx].name;
          const confirm = (await this.ask(`\x1b[33mRemove "${name}"? [y/N] \x1b[0m`)).trim().toLowerCase();
          if (confirm === 'y') {
            this.config.removeProvider(name);
            console.log(`\x1b[32mRemoved "${name}".\x1b[0m`);
          } else {
            console.log('Cancelled.');
          }
          await this.ask('Enter to continue. ');
        }
        continue;
      }
    }
  }

  async configureTools(): Promise<void> {
    while (true) {
      const cfg = this.config.getConfig();
      this.header('Tools');
      const toolItems = cfg.tools.map(t => {
        const status = t.enabled ? '\x1b[32m✓ on \x1b[0m' : '\x1b[90m✗ off\x1b[0m';
        return `[${status}] ${t.name}  —  ${t.description}`;
      });
      const items = [...toolItems, '← Back'];
      const selected = await this.selectFromList(items);
      if (!selected || selected === '← Back') break;
      const idx = items.indexOf(selected);
      if (idx < cfg.tools.length) {
        this.config.toggleTool(cfg.tools[idx].name);
      }
    }
  }

  async configureSettings(): Promise<void> {
    while (true) {
      const cfg = this.config.getConfig();
      const autoUnload = this.config.getAutoUnload();
      this.header('Settings');
      console.log(`  Scrollback lines             : \x1b[1m${this.config.getScrollback()}\x1b[0m`);
      console.log(`  Auto-unload on model switch  : \x1b[1m${autoUnload ? 'on' : 'off'}\x1b[0m \x1b[90m(LM Studio)\x1b[0m`);
      console.log('\n1. Set scrollback lines');
      console.log('2. Toggle auto-unload on model switch');
      console.log('0. Back\n');

      const choice = (await this.ask('> ')).trim();
      if (choice === '0') break;

      if (choice === '1') {
        const current = this.config.getScrollback();
        const val = (await this.ask(`Lines (current: ${current}, min 100): `)).trim();
        const n = parseInt(val);
        if (!isNaN(n) && n >= 100) {
          this.config.setScrollback(n);
          console.log(`\x1b[32mSet to ${n}.\x1b[0m`);
        } else {
          console.log('\x1b[33mInvalid value.\x1b[0m');
        }
        await this.ask('Enter to continue. ');
      } else if (choice === '2') {
        this.config.setAutoUnload(!autoUnload);
        console.log(`\x1b[32mAuto-unload: ${!autoUnload ? 'on' : 'off'}\x1b[0m`);
        await this.ask('Enter to continue. ');
      }
    }
  }

  async run(): Promise<void> {
    const menuItems = ['Models', 'Providers', 'Tools', 'Settings', 'Start chat', 'Exit'];
    while (true) {
      const provider = this.config.getActiveProvider();
      const model = this.config.getActiveModel();

      console.clear();
      console.log('\x1b[1mAgentNexus — Config\x1b[0m\n');
      console.log(`Provider : ${provider ? `\x1b[32m${provider.name}\x1b[0m \x1b[90m(${provider.type})\x1b[0m` : '\x1b[90mnone\x1b[0m'}`);
      console.log(`Model    : ${model ? `\x1b[32m${model.name}\x1b[0m` : '\x1b[90mnone\x1b[0m'}\n`);
      console.log('\x1b[90mUP/DOWN navigate  |  ENTER select  |  ESC back  |  CTRL+C exit\x1b[0m\n');

      const choice = await this.selectFromList(menuItems);
      if (!choice) continue;

      switch (choice) {
        case 'Models':     await this.configureModels(); break;
        case 'Providers':  await this.configureProviders(); break;
        case 'Tools':      await this.configureTools(); break;
        case 'Settings':   await this.configureSettings(); break;
        case 'Start chat': this.rl.close(); return;
        case 'Exit':       this.rl.close(); process.exit(0);
      }
    }
  }
}
