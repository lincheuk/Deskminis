import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { SettingsStore } from '../src/minisd/store/settings';
import type Database from 'better-sqlite3';

// M6 决策点 2-6：key-value 全局设置落 settings 表，重启后仍生效。
let db: Database.Database;
let store: SettingsStore;
beforeEach(() => {
  db = openDb(':memory:');
  store = new SettingsStore(db);
});

describe('SettingsStore（settings 表 get/set/布尔/持久化）', () => {
  it('set/get 往返', () => {
    store.set('k', 'v1');
    expect(store.get('k')).toBe('v1');
    store.set('k', 'v2');
    expect(store.get('k')).toBe('v2'); // UPSERT 覆盖
  });

  it('缺失 key 返回 undefined / 默认布尔', () => {
    expect(store.get('nope')).toBeUndefined();
    expect(store.getBool('nope')).toBe(false);
    expect(store.getBool('nope', true)).toBe(true);
  });

  it('setBool 存 1/0，getBool 还原', () => {
    store.setBool('sync.paused', true);
    expect(store.getBool('sync.paused')).toBe(true);
    store.setBool('sync.paused', false);
    expect(store.getBool('sync.paused')).toBe(false);
  });

  it('持久化：同一 db 连接重建 store 仍读到（落盘）', () => {
    store.setBool('sync.paused', true);
    const store2 = new SettingsStore(db);
    expect(store2.getBool('sync.paused')).toBe(true);
  });
});