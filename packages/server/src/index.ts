import { loadConfig, ConfigError } from './config.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  // .env 可选：存在就读，不存在不报错。Docker 里用真实环境变量。
  try {
    process.loadEnvFile('.env');
  } catch {
    // 没有 .env 是正常情况
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // 不许静默用默认值（实现计划 M0 硬性要求）
      console.error(`\n[启动失败] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const { app } = await buildApp({ config });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { host: config.host, port: config.port, env: config.nodeEnv },
    'agentlink server ready',
  );
}

await main();
