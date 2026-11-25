import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lock, lockPathFor } from '../src/index.js';

let dir;
let target;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sfl-'));
  target = join(dir, 'data.txt');
  await writeFile(target, 'hello', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('lock creates a sibling .lock file and release removes it', async () => {
  const handle = await lock(target);
  const lockPath = lockPathFor(target);

  const raw = await readFile(lockPath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.pid, process.pid);
  assert.equal(typeof parsed.token, 'string');
  assert.ok(parsed.token.length > 0);

  await handle.release();
  await assert.rejects(access(lockPath), { code: 'ENOENT' });
});

test('a second lock on the same file fails while the first is held', async () => {
  const first = await lock(target, { maxRetries: 0 });
  await assert.rejects(lock(target, { maxRetries: 0 }), /could not acquire lock/);
  await first.release();
});

test('a lock whose pid is dead is reclaimed', async () => {
  const lockPath = lockPathFor(target);
  // A pid that cannot exist. The stale check should notice and take over.
  await writeFile(lockPath, JSON.stringify({ pid: 2 ** 30, token: 'ghost', acquiredAt: Date.now() }), 'utf8');

  const handle = await lock(target, { maxRetries: 2 });
  const raw = await readFile(lockPath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.pid, process.pid);
  assert.notEqual(parsed.token, 'ghost');
  await handle.release();
});

test('release from a different token leaves the lock alone', async () => {
  const first = await lock(target);
  const lockPath = lockPathFor(target);

  // Simulate a second process that re-acquired the lock after the first
  // process crashed: overwrite the payload with a different token.
  const raw = await readFile(lockPath, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.token = 'someone-else';
  await writeFile(lockPath, JSON.stringify(parsed), 'utf8');

  await first.release();
  // The lock file must still exist because the token did not match.
  const stillThere = await readFile(lockPath, 'utf8');
  assert.equal(JSON.parse(stillThere).token, 'someone-else');
});

test('a corrupt lock file is treated as stale', async () => {
  const lockPath = lockPathFor(target);
  await writeFile(lockPath, 'not json at all', 'utf8');

  const handle = await lock(target, { maxRetries: 2 });
  const raw = await readFile(lockPath, 'utf8');
  assert.equal(JSON.parse(raw).pid, process.pid);
  await handle.release();
});

test('a lock older than staleAfterMs is reclaimed even if the pid is alive', async () => {
  const lockPath = lockPathFor(target);
  // Use our own pid so the liveness probe says "alive", but backdate it.
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, token: 'old', acquiredAt: Date.now() - 60_000 }),
    'utf8',
  );

  const handle = await lock(target, { staleAfterMs: 1_000, maxRetries: 2 });
  const raw = await readFile(lockPath, 'utf8');
  assert.notEqual(JSON.parse(raw).token, 'old');
  await handle.release();
});

test('lockPathFor appends .lock', () => {
  assert.equal(lockPathFor('/tmp/x'), '/tmp/x.lock');
});
