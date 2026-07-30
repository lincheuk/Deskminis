import Database from 'better-sqlite3';

/** schema 对齐 OpenMinis ChatStore（设计 §3.1）；M1 只建用到的表，同步表列先留出。 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
    model_id TEXT, category TEXT, model_binding TEXT, source TEXT,
    memory_enabled INTEGER NOT NULL DEFAULT 1,
    pinned_at REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
    last_synced_at REAL, remote_origin_device_id TEXT, remote_tombstoned_at REAL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    role TEXT NOT NULL, parts_json TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL, updated_at REAL NOT NULL,
    token_usage TEXT, sort_order INTEGER NOT NULL,
    reasoning_content TEXT, stream_interrupt_count INTEGER NOT NULL DEFAULT 0,
    error_info TEXT, part_flags TEXT
  );
  CREATE INDEX idx_messages_session ON messages(session_id, created_at, id);
  CREATE TABLE compact_markers (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    summary TEXT NOT NULL, last_compacted_message_id TEXT NOT NULL, created_at REAL NOT NULL
  );
  `,
  // [1] M2a 新增：compact_markers 按 (session_id, created_at DESC) 建索引
  //  必须是新迁移条目，不能追加进 MIGRATIONS[0]——已有用户库 user_version=1，
  //  db.ts 的迁移 runner 只对 user_version < N 的库跑 MIGRATIONS[0..N-1]，
  //  改 MIGRATIONS[0] 对已发布库是 no-op（迁移一经发布不可改）。
  //  IF NOT EXISTS 双保险：开发库（M1 时已建表但无索引）跑此迁移建索引；若已存在则跳过。
  `CREATE INDEX IF NOT EXISTS idx_compact_markers_session ON compact_markers(session_id, created_at DESC);`,
  // [2] M2c 技能系统（设计 §5.1）：元数据并入 minis.db；SKILL.md 正文永远在文件系统、原样不改写。
  //  迁移一经发布不可改、不可重排：已发布库 user_version=2，runner 只对 v<3 的库跑 MIGRATIONS[2]，
  //  改 [0]/[1] 对已发布库是 no-op。表结构与计划原案一致。
  `
  CREATE TABLE skills (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '',
    import_source TEXT NOT NULL DEFAULT '', is_enabled INTEGER NOT NULL DEFAULT 1,
    installed_at REAL NOT NULL, updated_at REAL NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE session_skill_overrides (
    session_id TEXT NOT NULL, skill_id TEXT NOT NULL, is_enabled INTEGER NOT NULL,
    PRIMARY KEY (session_id, skill_id)
  );
  `,
];

export function openDb(filePath: string): Database.Database {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  return db;
}
