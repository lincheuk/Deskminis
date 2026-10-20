/* F09 fixture（不是测试）：H2（替身主进程）的引擎多预加载的自限件（第二个 `-r`，不改 F05 的注入件）。
 * 目录经 DESKMINIS_F09_SELFLIMIT=<fx> 传入（DESKMINIS_* 不进引擎起的子进程）。
 * <fx>\stop 出现，或存活满 15 分钟，就往 <fx>\engine-selflimit.log 留一行 self-exit 并以 86 退出：
 * base 上、去掉属主轮询的变异下，主进程被结束后引擎不会自己退出，靠它收尾，不留孤儿。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const fx = process.env.DESKMINIS_F09_SELFLIMIT;
if (fx) {
  const born = Date.now();
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(fx, 'stop')) || Date.now() - born > 15 * 60_000) {
      try { fs.appendFileSync(path.join(fx, 'engine-selflimit.log'), `self-exit ${process.pid} ${Date.now()}\n`); } catch { /* 留不下就算了 */ }
      process.exit(86);
    }
  }, 200);
  timer.unref();
}
