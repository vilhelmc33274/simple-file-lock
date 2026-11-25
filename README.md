# simple-file-lock

A single-process-safe file lock for Node.js that is released automatically when the process that took it dies.

```js
import { lock } from './src/index.js';

const handle = await lock('/var/tmp/report.csv');
try {
  // ... do work on /var/tmp/report.csv ...
} finally {
  await handle.release();
}
```

The lock is a sibling file at `<path>.lock`. `lock(path)` returns a handle with a single method, `release()`. `lockPathFor(path)` is exported so callers can inspect or pre-create the lock location if they need to.

## Why this exists

File locking on POSIX is process-scoped: `flock` and `fcntl` locks vanish when the file descriptor closes, which is what you want for crash safety, but they are advisory and do not survive a copy of the file. A lock file created with `O_CREAT | O_EXCL` is portable and visible to any other process that knows the convention, but it has the opposite problem: if the holder crashes, the lock file stays behind forever.

This library combines the two. The lock file records the holder's pid and the time it was taken. A waiter that finds an existing lock checks whether that pid is still alive, and reclaims the lock if it is not. The trade-off is that a long-running holder can have its lock stolen after `staleAfterMs` (default 30 seconds); callers that need longer holds must pass a larger value. The pid check is the primary mechanism, and the age check is a backstop for pid reuse.

## The awkward edge

Reclaiming a stale lock is inherently racy. Two waiters can both see the dead pid, both decide the lock is stale, and both try to remove it. The library handles this by re-attempting the `O_EXCL` create after any removal: only one of them will win the create, and the loser loops. The `release()` method is also token-checked, so a slow holder that finally wakes up cannot delete a lock that has since been re-acquired by someone else.
