/**
 * F09 最小重现与取证（不是测试；vite-node 运行）：
 *
 *   dm.ps1 node node_modules/vite-node/vite-node.mjs tests/proc-lifecycle-probe.ts
 *     --host engine|gui|packaged [--app <exe>]
 *     --scenario shutdown|cancel|engine-kill|main-kill|timeout|shutdown-kill|all  --entry shell|terminal|mcp-abs|mcp-bare|all
 *     --evidence <目录>  --expect record|clean  [--stdio file|pipe]  [--ownership off]
 *
 * 每格一个引擎、一棵「根 → 子 → 孙」进程树，外加一组无关的同名进程；证据（PID、父子关系、创建 / 退出时刻、
 * 是否在作业里、心跳）落成 JSON。
 * 宿主：
 *  - engine（缺省）：main-kill 用替身主进程（H2），其余用 standalone 引擎（H1）。经 vite-node 跑源码。
 *  - gui：开发态图形应用（electron.exe . ，要先 dm.ps1 build），引擎是真实的 utilityProcess（H3）。会弹出一个窗口与托盘图标。
 *  - packaged：--app 指向打包目录里的 DeskMinis.exe（electron-builder --dir 的 win-unpacked，或安装后的目录）。
 *    脚本给它带 --user-data-dir=<临时>、DESKMINIS_DATA_DIR=<临时>、DESKMINIS_E2E=1，不碰正式的 userData、数据根、单实例锁与凭据库。
 *  gui / packaged 下 all 只含 cancel、engine-kill、main-kill、timeout（没有 parentPort 可发 shutdown）。
 * 退出码：0 = 与 --expect 一致；1 = 不一致（clean 而有残留，或误伤了无关进程）；2 = 环境不满足或没有结论。record 只记录不判定。
 *
 * 只动自己起的进程；从不按进程名结束任何东西（见 proc-lifecycle-fixture.ts 的约定）。
 */
import { ENTRIES, EnvNotReady, runCell, summary, writeEvidence, appendLog, type Entry, type Scenario } from './proc-lifecycle-fixture';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const SCENARIOS: readonly Scenario[] = ['shutdown', 'cancel', 'engine-kill', 'main-kill', 'timeout', 'shutdown-kill'];
/** 真实应用宿主跑得了的情形。 */
const APP_SCENARIOS: readonly Scenario[] = ['cancel', 'engine-kill', 'main-kill', 'timeout'];

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

async function main(): Promise<number> {
  if (process.platform !== 'win32') { console.log('只在 Windows 上有意义：未运行'); return 2; }
  const sc = arg('scenario', 'all')!; const en = arg('entry', 'all')!;
  const evidence = arg('evidence'); const expect = arg('expect', 'record')!;
  const stdio = arg('stdio', 'file') === 'pipe' ? 'pipe' : 'file';
  const host = arg('host', 'engine')!;
  const app = arg('app');
  const extraEnv: Record<string, string> = arg('ownership') === 'off' ? { DESKMINIS_PROC_OWNERSHIP: 'off' } : {};
  if (!evidence) { console.log('缺 --evidence <目录>'); return 2; }
  if (!['engine', 'gui', 'packaged'].includes(host)) { console.log('不认识的 --host（engine | gui | packaged）'); return 2; }
  if (host === 'packaged' && (!app || !existsSync(app))) { console.log('--host packaged 需要 --app <打包目录里的 exe>，且文件存在'); return 2; }
  if (host !== 'engine' && Object.keys(extraEnv).length > 0) { console.log('--ownership off 只对 --host engine 生效（真实应用的环境由主进程下发）'); return 2; }
  mkdirSync(evidence, { recursive: true });
  const pool = host === 'engine' ? SCENARIOS : APP_SCENARIOS;
  const scenarios = sc === 'all' ? pool.filter(s => s !== 'shutdown-kill') : pool.filter(s => s === sc);
  const entries = en === 'all' ? ENTRIES : ENTRIES.filter(e => e === en);
  if (scenarios.length === 0 || entries.length === 0) { console.log('不认识的 --scenario / --entry（或这个宿主跑不了这个情形）'); return 2; }
  const log = join(evidence, 'summary.log');
  let leak = 0; let inconclusive = 0; let bystanderHit = 0;
  for (const scenario of scenarios) {
    for (const entry of entries as readonly Entry[]) {
      if (scenario === 'timeout' && entry === 'terminal') continue; // 终端没有超时
      const head = `[${new Date().toISOString()}] ${host} ${scenario} ${entry}`;
      try {
        const ev = await runCell({ scenario, entry, stdio, extraEnv, ...(host === 'engine' ? {} : { host: 'gui' as const, app: host === 'packaged' ? app : undefined }) });
        const file = writeEvidence(evidence, ev, (scenario === 'main-kill' && stdio === 'pipe' ? '-pipe' : '') + (host === 'packaged' ? '-packaged' : ''));
        const line = `${head} → ${summary(ev)} 引擎=${ev.engine.engineEnd}(code=${ev.engine.exitCode}, inJob=${ev.engine.inJob}) 根 inJob=${ev.tree[0]?.inJob} 回收路径=${ev.rootReapedBy} 证据=${file}`;
        console.log(line); appendLog(log, line);
        if (ev.verdict === 'leak') leak++; else if (ev.verdict === 'inconclusive') inconclusive++;
        if (!ev.bystanders.every(b => b.aliveAfter)) bystanderHit++;
      } catch (e) {
        inconclusive++;
        const line = `${head} → ${e instanceof EnvNotReady ? e.message : '执行失败: ' + String((e as Error)?.stack ?? e)}`;
        console.log(line); appendLog(log, line);
      }
    }
  }
  const tail = `合计：残留 ${leak} 格、没有结论 ${inconclusive} 格、误伤无关进程 ${bystanderHit} 格（expect=${expect}）`;
  console.log(tail); appendLog(log, tail);
  if (bystanderHit > 0) return 1;
  if (expect === 'record') return 0;
  if (leak > 0) return 1;
  return inconclusive > 0 ? 2 : 0;
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(2); });
