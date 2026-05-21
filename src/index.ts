import * as readline from 'readline';
import { ConfigManager, CONFIG_DIR, AUTO_MODEL } from './config.js';
import { startBot } from './telegram/bot.js';

const args = process.argv.slice(2);

if (args.includes('--setup') || args.includes('setup')) {
  await runSetup();
} else {
  await runDaemon();
}

async function runDaemon(): Promise<void> {
  const config = new ConfigManager();
  const tgCfg = config.getTelegramConfig();

  if (!tgCfg?.botToken) {
    console.error('No Telegram config found. Run: agentnexus --setup');
    process.exit(1);
  }

  console.log('Starting AgentNexus daemon...');
  await startBot(config);
}

async function runSetup(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (question: string): Promise<string> =>
    new Promise(resolve => rl.question(question, resolve));

  console.log('\n=== AgentNexus Setup ===\n');

  const config = new ConfigManager();
  const cfg = config.getConfig();

  // Bot token
  const existingToken = config.getTelegramConfig()?.botToken || '';
  const tokenPrompt = existingToken
    ? `Telegram bot token [${existingToken.slice(0, 10)}...]: `
    : 'Telegram bot token (from @BotFather): ';
  const botToken = (await ask(tokenPrompt)).trim() || existingToken;

  if (!botToken) {
    console.error('Bot token required. Get one from @BotFather on Telegram.');
    rl.close();
    process.exit(1);
  }

  // Allowed users
  const existingUsers = config.getTelegramConfig()?.allowedUsers || [];
  const usersStr = existingUsers.length ? existingUsers.join(',') : '';
  const usersPrompt = existingUsers.length
    ? `Allowed Telegram user IDs (comma-separated) [${usersStr}]: `
    : 'Your Telegram user ID (get from @userinfobot): ';
  const usersInput = (await ask(usersPrompt)).trim() || usersStr;
  const allowedUsers = usersInput
    .split(',')
    .map(s => parseInt(s.trim()))
    .filter(n => !isNaN(n) && n > 0);

  if (!allowedUsers.length) {
    console.error('At least one allowed user ID required.');
    rl.close();
    process.exit(1);
  }

  // Provider setup
  let runProviderFlow = false;
  if (cfg.providers.length === 0) {
    runProviderFlow = true;
  } else {
    console.log('\n--- Configured providers ---');
    cfg.providers.forEach((p, i) => {
      const active = p.name === cfg.activeProvider ? '  <- active' : '';
      console.log(`${i + 1}. ${p.name} (${p.type})${active}`);
    });
    const addAnother = (await ask('Add another provider? [y/N]: ')).trim().toLowerCase();
    if (addAnother === 'y' || addAnother === 'yes') {
      runProviderFlow = true;
    }
  }

  if (runProviderFlow) {
    console.log('\n--- LLM Provider ---');
    console.log('1. Anthropic (Claude)');
    console.log('2. Ollama (local)');
    console.log('3. LM Studio (local)');
    console.log('4. Google AI');
    console.log('5. OpenAI-compatible (custom)');

    const provChoice = (await ask('Provider [1-5]: ')).trim();
    const provMap: Record<string, string> = {
      '1': 'anthropic',
      '2': 'ollama',
      '3': 'lmstudio',
      '4': 'google',
      '5': 'custom',
    };
    const provType = provMap[provChoice];

    if (provType) {
      let apiKey = '';
      let endpoint = '';
      let modelId = '';
      let modelName = '';

      if (provType === 'anthropic') {
        apiKey    = (await ask('Anthropic API key: ')).trim();
        modelId   = (await ask('Model ID [claude-opus-4-7]: ')).trim() || 'claude-opus-4-7';
        modelName = modelId;
      } else if (provType === 'ollama') {
        endpoint  = (await ask('Ollama endpoint [http://localhost:11434]: ')).trim() || 'http://localhost:11434';
        // Local: skip model ID prompt — /models picker auto-discovers from the live endpoint.
      } else if (provType === 'lmstudio') {
        endpoint  = (await ask('LM Studio endpoint [http://localhost:1234]: ')).trim() || 'http://localhost:1234';
        apiKey    = (await ask('LM Studio API key (optional, leave blank for local): ')).trim();
        // Local: skip model ID prompt — /models picker auto-discovers from the live endpoint.
      } else if (provType === 'google') {
        apiKey    = (await ask('Google AI API key: ')).trim();
        modelId   = (await ask('Model ID [gemini-2.0-flash]: ')).trim() || 'gemini-2.0-flash';
        modelName = modelId;
      } else if (provType === 'custom') {
        endpoint  = (await ask('API endpoint: ')).trim();
        apiKey    = (await ask('API key (optional): ')).trim();
        modelId   = (await ask('Model ID: ')).trim();
        modelName = modelId;
      }

      const provName = `${provType}-${cfg.providers.length + 1}`;
      const isLocal = provType === 'ollama' || provType === 'lmstudio';
      config.addProvider({ name: provName, type: provType as any, endpoint: endpoint || undefined, apiKey: apiKey || undefined });
      if (modelId) {
        config.addModel({ id: modelId, name: modelName, provider: provName });
      }
      if (!cfg.activeProvider) {
        config.setActiveProvider(provName);
        if (modelId)       config.setActiveModel(modelId);
        else if (isLocal)  config.setActiveModel(AUTO_MODEL);
      }
    }
  }

  config.setTelegramConfig({
    botToken,
    allowedUsers,
    permissionMode: 'default',
  });

  rl.close();

  console.log(`\nConfig saved to ${CONFIG_DIR}/config.json`);
  console.log('\nRun: agentnexus');
  console.log('Then message your bot on Telegram!');
}
