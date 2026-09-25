/* W2b-7 真 fork 测试的注入件：只由 tests/crash-log-fork.test.ts 以 `-r` 预加载进 minisd 子进程，不进产品代码。
 *
 * 1. 仿 Electron utilityProcess 的 process.parentPort：真应用里主进程用 postMessage 发 shutdown，
 *    minisd 的 standalone 分支在 process.parentPort 上收；普通 Node 子进程没有这个对象，这里补一个，
 *    主进程一侧的 postMessage 经 stdin 的一行 {"parentPortMessage": …} 送进来。
 * 2. 测试经 stdin 发 {"inject":"reject"} / {"inject":"throw"}，在引擎进程里制造一次未处理拒绝 / 未捕获异常，
 *    看 minisd 自己装的崩溃钩子怎么收场（前者记一条后继续服务，后者记一条后以 1 退出）。
 * CommonJS 写法：`-r` 只收 CJS，本包 package.json 是 "type": "module"，所以扩展名是 .cjs。 */
'use strict';
const { EventEmitter } = require('node:events');

const port = new EventEmitter();
if (process.parentPort === undefined) Object.defineProperty(process, 'parentPort', { value: port, configurable: true });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg && msg.parentPortMessage !== undefined) {
      port.emit('message', { data: msg.parentPortMessage });
    } else if (msg && msg.inject === 'reject') {
      // 没有任何 .catch：这就是一次未处理拒绝
      Promise.reject(new Error('注入：引擎里的未处理拒绝'));
    } else if (msg && msg.inject === 'throw') {
      // 放到下一拍抛，离开 stdin 的回调栈：与真实的「某个定时器 / IO 回调里抛了」同形
      setImmediate(() => { throw new Error('注入：引擎里的未捕获异常'); });
    }
  }
});
