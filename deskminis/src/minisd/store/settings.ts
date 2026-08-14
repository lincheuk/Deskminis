import type Database from 'better-sqlite3';

// M6 R2 本端暂停（决策点 2-6）：key-value 全局设置落 settings 表，重启后仍生效。
// 现唯一用途是 R2 暂停标志 sync.paused；后续全局设置可复用同一表。

export const SYNC_PAUSE_KEY = 'sync.paused';
// 权限选择器档位（'ask'|'session'|'full'）持久化键：落 settings 表，重启后仍生效。
// 与 SYNC_PAUSE_KEY 同表同机制，不新增 schema。
export const PERMISSION_PRESET_KEY = 'permission.preset';

export class SettingsStore {
  constructor(private db: Database.Database) {}

  /** 读字符串值；不存在返回 undefined。 */
  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  /** 读布尔值（value 为 '1'/'true' 视为 true）；不存在返回默认值。 */
  getBool(key: string, fallback = false): boolean {
    const v = this.get(key);
    if (v === undefined) return fallback;
    return v === '1' || v === 'true';
  }

  /** 写/覆盖字符串值（UPSERT）。 */
  set(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    ).run(key, value, Date.now() / 1000);
  }

  /** 写布尔值（存 '1'/'0'）。 */
  setBool(key: string, value: boolean): void {
    this.set(key, value ? '1' : '0');
  }
}