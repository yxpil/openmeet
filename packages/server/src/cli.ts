import { startServer } from './index.js';

async function main(): Promise<void> {
  const running = await startServer();
  const displayHost = running.host === '::' ? 'localhost' : running.host;
  console.log(`OpenMeet server ready: http://${displayHost}:${running.port}`);
  if (running.config.publicUrl) console.log(`Public URL: ${running.config.publicUrl}`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, shutting down...`);
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();
    void running.close().then(
      () => process.exit(0),
      (error) => {
        console.error('Shutdown failed:', error);
        process.exit(1);
      }
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((error: unknown) => {
  console.error('OpenMeet server failed to start:', error);
  process.exit(1);
});
