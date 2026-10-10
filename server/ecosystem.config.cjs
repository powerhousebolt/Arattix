/**
 * PM2 process file.
 *
 *   npm run build
 *   pm2 start ecosystem.config.cjs                 # split: clustered API + one worker (needs Redis)
 *   pm2 start ecosystem.config.cjs --only arattix-all   # single process, no Redis
 *
 * Why two apps: an Arattai account is one cookie session. Exactly one process may own it
 * (the worker, guarded by a Redis lease). The API tier holds no session state, so it can be
 * clustered freely. Never run the worker in cluster mode or with instances > 1 for the same
 * SESSION_ID: extra workers only sit on standby waiting for the lease.
 *
 * Secrets come from .env (see .env.example) via Node's --env-file.
 */
const common = {
  cwd: __dirname,
  script: 'dist/index.js',
  node_args: ['--env-file=.env', '--enable-source-maps'],
  // Wait for process.send('ready') before routing traffic / considering the start successful.
  wait_ready: true,
  listen_timeout: 30_000,
  // SIGTERM → graceful shutdown (drain HTTP, finish active jobs, persist session). Must exceed SHUTDOWN_TIMEOUT_MS.
  kill_timeout: 30_000,
  max_memory_restart: '512M',
  // Crash loops back off instead of hammering Arattai with fresh logins.
  exp_backoff_restart_delay: 1_000,
  merge_logs: true,
  time: false, // the app's logs already carry timestamps
  env: { NODE_ENV: 'production', LOG_FORMAT: 'json' },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'arattix-api',
      exec_mode: 'cluster',
      instances: process.env.API_INSTANCES || 'max',
      env: { ...common.env, ROLE: 'api', QUEUE_DRIVER: 'bullmq', STORE_DRIVER: 'redis' },
    },
    {
      ...common,
      name: 'arattix-worker',
      exec_mode: 'fork',
      instances: 1,
      env: { ...common.env, ROLE: 'worker', QUEUE_DRIVER: 'bullmq', STORE_DRIVER: 'redis' },
    },
    {
      ...common,
      name: 'arattix-all',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      env: { ...common.env, ROLE: 'all' },
    },
  ],
};
