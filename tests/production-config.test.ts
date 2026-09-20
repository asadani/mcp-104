import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Runs the real entry point in production mode with the given environment.
const boot = (env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60000,
  env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: '', TOKEN_SECRET: '', PUBLIC_ORIGIN: '', PORT: '0', ...env },
});

test('production refuses to start without its required settings, and says which is missing', () => {
  const none = boot({});
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /DATABASE_URL is required when NODE_ENV=production/);
  const noSecret = boot({ DATABASE_URL: 'postgres://user:pw@127.0.0.1:1/none' });
  assert.notEqual(noSecret.status, 0);
  assert.match(noSecret.stderr, /TOKEN_SECRET is required when NODE_ENV=production/);
  const noOrigin = boot({ DATABASE_URL: 'postgres://user:pw@127.0.0.1:1/none', TOKEN_SECRET: 'x'.repeat(32) });
  assert.notEqual(noOrigin.status, 0);
  assert.match(noOrigin.stderr, /PUBLIC_ORIGIN is required when NODE_ENV=production/);
});
