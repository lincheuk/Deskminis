// W2b-7 取证用注入件：经 NODE_OPTIONS=--require 同时进主进程与 utility 进程，只在引擎（utility + standalone）里动手。
// 剧本往 W2B7_TRIGGER_DIR 里建 inject-reject / inject-throw 两个空文件，引擎里就各制造一次未处理拒绝 / 未捕获异常。
// 不碰 process.parentPort（真 utility 进程里 Electron 稍后自己装上它，这里定义了反而会挡住真的 shutdown 消息）。
if (process.type === 'utility' && process.env.DESKMINIS_STANDALONE === '1' && process.env.W2B7_TRIGGER_DIR) {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = process.env.W2B7_TRIGGER_DIR;
  const done = new Set();
  const t = setInterval(() => {
    for (const k of ['reject', 'throw']) {
      if (done.has(k) || !fs.existsSync(path.join(dir, 'inject-' + k))) continue;
      done.add(k);
      if (k === 'reject') Promise.reject(new Error('W2b-7 取证：引擎里的未处理拒绝'));
      else setImmediate(() => { throw new Error('W2b-7 取证：引擎里的未捕获异常'); });
    }
  }, 100);
  t.unref();
}
