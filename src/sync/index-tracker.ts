import { SyncIndex } from '../types';

/**
 * Baseline bookkeeping.
 *
 * The index stores, for every tracked path, the *observed* state of both sides
 * right after the last successful transfer. Two rules matter:
 *
 * 1. Never copy one side's mtime into the other side's slot. Synology returns
 *    second-precision mtimes, Obsidian reports milliseconds, and a written file
 *    gets its mtime from the filesystem clock. Mixing them makes every cycle
 *    look like "both sides changed".
 * 2. Every handled path must get an entry - uploads, downloads, conflicts and
 *    skips alike. A missing entry falls back to a 2-way comparison, which is
 *    what made conflict copies reproduce themselves forever.
 */
export interface ObservedState {
  localMtime: number;
  localSize: number;
  remoteMtime: number;
  remoteSize: number;
  md5?: string;
}

export function recordBaseline(index: SyncIndex, path: string, o: ObservedState): void {
  index[path] = {
    localMtime: o.localMtime,
    remoteMtime: o.remoteMtime,
    size: o.localSize,
    remoteSize: o.remoteSize,
    md5: o.md5,
  };
}

/** Milliseconds -> seconds, matching the precision Synology returns. */
export function toSeconds(mtime: number): number {
  return Math.floor(mtime > 10000000000 ? mtime / 1000 : mtime);
}

export function toMillis(mtime: number): number {
  return mtime > 10000000000 ? mtime : mtime * 1000;
}

export const MTIME_TOLERANCE_SEC = 2;

export function sameMtime(a: number, b: number): boolean {
  return Math.abs(toSeconds(a) - toSeconds(b)) <= MTIME_TOLERANCE_SEC;
}
