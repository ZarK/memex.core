import { acquireAppLock, appLockPath, type AppLock, type AppLockOptions } from "@tjalve/memex-storage";

interface Holder {
  count: number;
  lock: Promise<AppLock>;
}

const held = new Map<string, Holder>();
const releasing = new Map<string, Promise<void>>();

/**
 * Takes the app lock of the storage library for this process, or shares the lock that this process holds already.
 * The lock keeps other processes out of the database. Calls in one process share it, so that parallel calls (an MCP
 * client sends them all the time) do not lock each other out. Returns the release: the lock file goes when the last
 * holder in this process releases it. Throws AppLockedError when another process holds the lock.
 */
export async function holdAppLock(options: AppLockOptions): Promise<() => Promise<void>> {
  const key = appLockPath(options);
  let holder = held.get(key);
  if (!holder) {
    // A release that is still removing the lock file finishes first, else this process would find its own lock.
    const before = releasing.get(key) ?? Promise.resolve();
    const created: Holder = { count: 0, lock: before.catch(() => {}).then(() => acquireAppLock(options)) };
    held.set(key, created);
    created.lock.catch(() => {
      if (held.get(key) === created) held.delete(key);
    });
    holder = created;
  }
  const current = holder;
  current.count += 1;
  try {
    await current.lock;
  } catch (error) {
    current.count -= 1;
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    current.count -= 1;
    if (current.count > 0) return;
    if (held.get(key) === current) held.delete(key);
    const done = current.lock.then((lock) => lock.release());
    releasing.set(key, done);
    try {
      await done;
    } finally {
      if (releasing.get(key) === done) releasing.delete(key);
    }
  };
}
