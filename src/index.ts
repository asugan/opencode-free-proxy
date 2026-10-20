import { createProxy, loadConfig } from './proxy.js';

try {
  const config = loadConfig(process.env);
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be between 1 and 65535.');
  }
  const server = createProxy(config);
  server.on('error', (error) => {
    console.error(`Server error: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`OpenCode proxy listening on http://${host}:${port}`);
    console.log(`${config.models.length} configured models; upstream access rules still apply.`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
      const timer = setTimeout(() => server.closeAllConnections(), 5_000);
      timer.unref();
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Startup failed.');
  process.exitCode = 1;
}
