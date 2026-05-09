/**
 * Manual kill-switch helpers backed by a filesystem flag (/tmp/svx-paused).
 * The presence of this file halts new trade submissions within one loop
 * iteration; absence allows resumption (subject to in-DB state).
 */
import fs from 'node:fs';

export const DEFAULT_KILL_FLAG = '/tmp/svx-paused';

export function setKillFlag(path = DEFAULT_KILL_FLAG, reason = 'manual pause'): void {
  fs.writeFileSync(path, `${new Date().toISOString()} ${reason}\n`);
}

export function clearKillFlag(path = DEFAULT_KILL_FLAG): void {
  if (fs.existsSync(path)) fs.rmSync(path);
}

export function isKilled(path = DEFAULT_KILL_FLAG): boolean {
  return fs.existsSync(path);
}
