import { createInterface } from 'node:readline';
import { once } from 'node:events';

// 只通过真实管道触发客户端上限；遵守背压，fixture 自己不积累大输出。
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n');
  } else if (request.method === 'tools/call') {
    void (async () => {
      const block = Buffer.alloc(65536, 'A');
      for (let i = 0; i < 257; i++) {
        if (!process.stdout.write(block)) await once(process.stdout, 'drain');
      }
    })();
  }
});
