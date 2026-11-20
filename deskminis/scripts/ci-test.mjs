// CI 用的测试分组，本地也可以用它复现 CI 的结果：
//   node scripts/ci-test.mjs stable          全量，排除下面的负载敏感文件（CI 主检查，失败即阻塞）
//   node scripts/ci-test.mjs load-sensitive  只跑负载敏感文件，并且逐个文件串行（CI 中不阻塞，只留证）
// 其余参数原样传给 vitest，例如 --reporter=json --outputFile.json=report.json。
// 清单与 docs/TESTING.md「已知受高负载影响的用例」保持一致；按那里的约定，这些用例不设置自动重试。
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const LOAD_SENSITIVE = [
  'tests/run-recovery-process.test.ts',
  'tests/crash-log-fork.test.ts',
  'tests/search-tools.test.ts',
  'tests/walk-scan.test.ts',
  'tests/convergence-pause.test.ts',
  'tests/skill-zip-bomb.test.ts',
  'tests/outbound-client.test.ts',
  'tests/sync-delete-e2e.test.ts',
];

const [group, ...rest] = process.argv.slice(2);
const args = ['node_modules/vitest/vitest.mjs', 'run'];
if (group === 'stable') {
  for (const file of LOAD_SENSITIVE) args.push('--exclude', file);
} else if (group === 'load-sensitive') {
  args.push(...LOAD_SENSITIVE, '--no-file-parallelism');
} else {
  console.error('Usage: node scripts/ci-test.mjs <stable|load-sensitive> [vitest args...]');
  process.exit(2);
}
args.push(...rest);

// 与 npm test 相同：用项目自己的 Electron 以 Node 模式运行 vitest，原生模块才与 Electron ABI 一致。
const electron = createRequire(import.meta.url)('electron');
const result = spawnSync(electron, args, { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
