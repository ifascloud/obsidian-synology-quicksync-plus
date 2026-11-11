import { describe, it, expect } from 'vitest';
import { computeDiff } from '../src/sync/diff-engine';
import { SyncManager, type VaultAdapter, type RemoteRefresh } from '../src/sync/sync-manager';
import type { LocalFileItem, RemoteFileItem, SyncIndex } from '../src/types';

/**
 * Regression tests for the "conflict copy storm":
 * a 5-minute sync interval used to turn N conflict copies into 2N, then 4N...
 * because conflicts never updated the sync index.
 */

let clock = 1_760_000_000_000; // ms, monotonic fake time
const tick = (sec = 10) => {
  clock += sec * 1000;
};
const nowMs = () => clock;
const nowSec = () => Math.floor(clock / 1000);

class FakeVault implements VaultAdapter {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();

  seed(path: string, text: string, mtime = clock) {
    this.files.set(path, { bytes: new TextEncoder().encode(text), mtime });
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(path);
    if (!f) throw new Error(`missing ${path}`);
    return f.bytes.buffer.slice(0) as ArrayBuffer;
  }

  async writeBinaryAtomic(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, { bytes: new Uint8Array(content.slice(0)), mtime: nowMs() });
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async stat(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`missing ${path}`);
    return { mtime: f.mtime, size: f.bytes.byteLength };
  }

  list(): LocalFileItem[] {
    return [...this.files.entries()].map(([path, f]) => ({
      path,
      mtime: f.mtime,
      size: f.bytes.byteLength,
    }));
  }

  /** Files that are conflict side-copies created by the plugin. */
  conflictCopies(): string[] {
    return [...this.files.keys()].filter((p) => p.includes('(conflict-syno-'));
  }
}

class FakeNas {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();

  seed(path: string, text: string, mtime = clock) {
    this.files.set(path, { bytes: new TextEncoder().encode(text), mtime });
  }

  async listFiles(): Promise<RemoteFileItem[]> {
    return [...this.files.entries()].map(([path, f]) => ({
      path,
      fullRemotePath: `/vault/${path}`,
      isdir: false,
      mtime: Math.floor(f.mtime / 1000),
      size: f.bytes.byteLength,
    }));
  }

  async uploadFile(folder: string, fileName: string, content: ArrayBuffer, _mtime?: number): Promise<void> {
    // Synology stamps its own mtime on upload instead of keeping the client's.
    const rel = folder.replace(/^\/vault\/?/, '');
    const path = rel ? `${rel}/${fileName}` : fileName;
    this.files.set(path, { bytes: new Uint8Array(content.slice(0)), mtime: nowMs() });
    tick();
  }

  async downloadFile(fullPath: string): Promise<ArrayBuffer> {
    const rel = fullPath.replace(/^\/vault\//, '');
    const f = this.files.get(rel);
    if (!f) throw new Error(`missing remote ${fullPath}`);
    return f.bytes.buffer.slice(0) as ArrayBuffer;
  }

  async deleteFile(fullPath: string): Promise<void> {
    this.files.delete(fullPath.replace(/^\/vault\//, ''));
  }

  list(): RemoteFileItem[] {
    return [...this.files.entries()].map(([path, f]) => ({
      path,
      fullRemotePath: `/vault/${path}`,
      isdir: false,
      mtime: Math.floor(f.mtime / 1000),
      size: f.bytes.byteLength,
    }));
  }
}

async function cycle(vault: FakeVault, nas: FakeNas, index: SyncIndex) {
  const remote = await nas.listFiles();
  const diff = computeDiff(vault.list(), remote, ['.obsidian/**'], index);
  const refresh: RemoteRefresh = async () => {
    const snapshot = new Map<string, RemoteFileItem>();
    for (const f of await nas.listFiles()) snapshot.set(f.path, f);
    return snapshot;
  };
  const manager = new SyncManager(nas as any, vault, '/vault', index, refresh);
  const report = await manager.executeSync(diff);
  // Mirrors main.ts: the manager returns a new index object, the plugin persists it.
  for (const key of Object.keys(index)) delete index[key];
  Object.assign(index, report.updatedIndex ?? {});
  return { diff, report };
}

describe('sync loop', () => {
  it('first sync never creates conflict copies and converges to skips', async () => {
    const vault = new FakeVault();
    const nas = new FakeNas();
    const index: SyncIndex = {};

    // Same files on both sides, different mtimes: the old 2-way fallback called
    // every one of these a conflict.
    for (const name of ['a.md', 'b.md', 'folder/c.md']) {
      vault.seed(name, `# ${name}`);
      nas.seed(name, `# ${name}`, clock - 500_000);
    }

    const r1 = await cycle(vault, nas, index);
    expect(r1.report.conflictCount).toBe(0);
    expect(vault.conflictCopies()).toHaveLength(0);

    const r2 = await cycle(vault, nas, index);
    expect(r2.diff.uploads).toHaveLength(0);
    expect(r2.diff.downloads).toHaveLength(0);
    expect(r2.diff.conflicts).toHaveLength(0);
    expect(r2.diff.skips).toHaveLength(3);

    const r3 = await cycle(vault, nas, index);
    expect(r3.diff.skips).toHaveLength(3);
    expect(vault.conflictCopies()).toHaveLength(0);
  });

  it('a real two-sided edit makes exactly one copy and then stops', async () => {
    const vault = new FakeVault();
    const nas = new FakeNas();
    const index: SyncIndex = {};

    vault.seed('note.md', 'local v1');
    nas.seed('note.md', 'local v1', clock - 500_000);
    await cycle(vault, nas, index);
    await cycle(vault, nas, index);

    // Both sides edited independently.
    tick(60);
    vault.seed('note.md', 'local v2 edited');
    tick(60);
    nas.seed('note.md', 'remote v2 edited');

    const r1 = await cycle(vault, nas, index);
    expect(r1.report.conflictCount).toBe(1);
    expect(vault.conflictCopies()).toHaveLength(1);

    // The regression: the next cycles used to produce a copy of the copy, forever.
    for (let i = 0; i < 4; i++) {
      const r = await cycle(vault, nas, index);
      expect(r.report.conflictCount).toBe(0);
    }
    expect(vault.conflictCopies()).toHaveLength(1);
    expect(vault.files.size).toBe(2); // note.md + one conflict copy (uploaded copy lives remotely)
  });

  it('propagates deletions in both directions', async () => {
    const vault = new FakeVault();
    const nas = new FakeNas();
    const index: SyncIndex = {};

    vault.seed('keep.md', 'keep');
    vault.seed('gone-local.md', 'x');
    vault.seed('gone-remote.md', 'y');
    nas.seed('keep.md', 'keep', clock - 500_000);
    nas.seed('gone-local.md', 'x', clock - 500_000);
    nas.seed('gone-remote.md', 'y', clock - 500_000);
    await cycle(vault, nas, index);
    await cycle(vault, nas, index);

    vault.files.delete('gone-local.md');
    nas.files.delete('gone-remote.md');

    const r = await cycle(vault, nas, index);
    expect(r.report.deletedRemoteCount).toBe(1);
    expect(r.report.deletedLocalCount).toBe(1);
    expect(nas.files.has('gone-local.md')).toBe(false);
    expect(vault.files.has('gone-remote.md')).toBe(false);
    expect(vault.conflictCopies()).toHaveLength(0);
  });

  it('does not re-upload an unchanged vault on every cycle', async () => {
    const vault = new FakeVault();
    const nas = new FakeNas();
    const index: SyncIndex = {};

    for (let i = 0; i < 20; i++) {
      vault.seed(`n${i}.md`, `content ${i}`);
    }
    await cycle(vault, nas, index); // first sync: uploads

    const reports = [];
    for (let i = 0; i < 5; i++) reports.push(await cycle(vault, nas, index));

    for (const r of reports) {
      expect(r.report.uploadedCount).toBe(0);
      expect(r.report.downloadedCount).toBe(0);
      expect(r.report.conflictCount).toBe(0);
    }
  });
});
