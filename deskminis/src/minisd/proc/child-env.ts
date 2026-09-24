/**
 * shell、终端、MCP 子进程的环境（W1b-1 · 止血波设计稿 §3 第 10 条；cross.md missing「子进程环境变量没有收窄」）。
 *
 * 为什么剥 DESKMINIS_*：主进程 fork minisd 时下发 DESKMINIS_STANDALONE、DESKMINIS_DATA_DIR、DESKMINIS_KEYRING_SERVICE、
 * DESKMINIS_LOG_DIR（W1a-9），这些是 DeskMinis 给自己的引擎用的。原先子进程直接拿 minisd 的整份 process.env，
 * agent 在 shell 里跑 DeskMinis 自己的 npm run dev 或 e2e 脚本时，子进程会被导向这一份数据根与凭据服务名，
 * dev 隔离随之失效；standalone 标志也会让被拉起的引擎走错启动分支。
 *
 * 为什么连显式传入的也剥：DESKMINIS_ 前缀是 DeskMinis 自己的命名空间，子进程一律不该看见（§3 第 10 条「剥掉这组变量」）。
 * 会话级的 MINIS_*（桥三件套、MINIS_CHAT_SESSION_ID）不带这个前缀，不受影响。
 * 前缀比较不分大小写：Windows 的环境变量名不分大小写，DeskMinis_Data_Dir 与 DESKMINIS_DATA_DIR 是同一个变量。
 */
const APP_ENV_PREFIX = 'DESKMINIS_';

const isAppVar = (name: string): boolean => name.toUpperCase().startsWith(APP_ENV_PREFIX);

/** base（通常是 process.env）叠上 extra（会话级变量，同名覆盖；值为 undefined 的跳过），再剥掉 DESKMINIS_*。返回新对象，不改入参。 */
export function childEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const src of [base, extra ?? {}]) {
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined && !isAppVar(k)) out[k] = v;
    }
  }
  return out;
}
