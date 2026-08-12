'use strict';

const app = require('./app');
const env = require('./config/env');
const { pool, healthCheck } = require('./db/pool');
const jobs = require('./jobs');
const mailer = require('./utils/mailer');

async function main() {
  const connected = await healthCheck().catch((error) => {
    console.error('Could not reach MySQL at %s:%s - %s', env.db.host, env.db.port, error.message);
    console.error('Check your .env settings and run `npm run db:migrate`.');
    return false;
  });
  if (!connected) process.exit(1);

  const server = app.listen(env.port, () => {
    console.log('Offers App API listening on http://localhost:%d%s', env.port, env.apiPrefix);
    console.log('Environment: %s | Database: %s', env.nodeEnv, env.db.database);
  });

  jobs.start();

  // Surfaces a broken SMTP password at boot rather than at the first reset.
  await mailer.verifyTransport();

  const shutdown = async (signal) => {
    console.log('\n%s received, shutting down...', signal);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to close.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
