import { open, unlink, writeFile, readFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * The lock file is a JSON document so that a reader can tell who holds the
 * lock and when it was taken. The holder token is random; it is what we
 * compare on release so that a stale release from a crashed process cannot
 * steal a lock that has since been re-acquired by someone else.
 */

/**
 * Acquire a lock on `filePath`.
 *
 * The lock is represented by a sibling file named `<filePath>.lock`. The
 * sibling file is created with `O_CREAT | O_EXCL`, which is the only portable
 * way on POSIX to get an atomic "create if not exists" and therefore the only
 * way two processes can race safely.
 *
 * If the lock file already exists we check whether the process that created it
 * is still alive. If it is not, we remove the stale lock and try again. This is
 * what lets a crashed process "let go": the OS reclaims its pid, and the next
 * caller notices the pid is gone.
 *
 * @param {string} filePath path to the file being locked
 * @param {{ staleAfterMs?: number, retryDelayMs?: number, maxRetries?: number }} [options]
 * @returns {Promise<{ release: () => Promise<void> }>}
 */
export async function lock(filePath, options = {}) {
  const {
    staleAfterMs = 30_000,
    retryDelayMs = 25,
    maxRetries = 40,
  } = options;

  const lockPath = lockPathFor(filePath);
  const token = randomBytes(16).toString('hex');
  const payload = JSON.stringify({
    pid: process.pid,
    token,
    acquiredAt: Date.now(),
  });

  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      try {
        await handle.writeFile(payload, 'utf8');
      } finally {
        await handle.close();
      }
      return { release: () => releaseLock(lockPath, token) };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const stale = await isStale(lockPath, staleAfterMs);
      if (stale) {
        // Best-effort: another process may have removed it already, in which
        // case the next open() will simply succeed.
        await unlink(lockPath).catch(() => {});
        continue;
      }

      if (attempt >= maxRetries) {
        throw new Error(`could not acquire lock on ${filePath}`);
      }
      await sleep(retryDelayMs);
    }
  }
}

/**
 * Release a lock previously returned by `lock`.
 *
 * We read the file back and only delete it if the token matches. This avoids
 * the classic bug where a slow holder deletes a lock that a different process
 * has already re-acquired.
 *
 * @param {string} lockPath
 * @param {string} token
 */
async function releaseLock(lockPath, token) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt lock file is not ours; leave it for the stale check.
    return;
  }

  if (parsed && parsed.token === token) {
    await unlink(lockPath).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

/**
 * A lock is stale when either:
 *  - the recorded pid is no longer running, or
 *  - the lock is older than `staleAfterMs`.
 *
 * The pid check is what makes crash recovery work on a normal machine; the age
 * check is a backstop for the case where the pid has been recycled by an
 * unrelated process. We accept that a very long-running holder can have its
 * lock stolen after `staleAfterMs`; callers that need longer holds should pass
 * a larger value.
 *
 * @param {string} lockPath
 * @param {number} staleAfterMs
 * @returns {Promise<boolean>}
 */
async function isStale(lockPath, staleAfterMs) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unreadable lock file: treat as stale so we can make progress.
    return true;
  }

  if (typeof parsed.pid === 'number' && !isProcessAlive(parsed.pid)) {
    return true;
  }

  if (typeof parsed.acquiredAt === 'number') {
    return Date.now() - parsed.acquiredAt > staleAfterMs;
  }

  return true;
}

/**
 * `process.kill(pid, 0)` is the portable liveness probe: it throws ESRCH when
 * the pid does not exist, and EPERM when it exists but we may not signal it
 * (which still means alive).
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function lockPathFor(filePath) {
  return `${filePath}.lock`;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
