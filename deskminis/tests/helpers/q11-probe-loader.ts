import { readFileSync, mkdtempSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { parse, compileScript } from 'vue/compiler-sfc';

let shared: Promise<any> | undefined;
// sfc-setup 的静态 SSR 会把 .vue 子组件置为空壳；这里需要真实 Markdown/思考子树和 Vue 更新计数。
export function q11ComponentProbe(): Promise<any> {
  return shared ??= run();
}
async function run() {
  const appRoot = resolve(__dirname, '../..');
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(join(parent, 'dm-q11-component-'));
  try {
    const outfile = join(dir, 'probe.cjs');
    await build({ entryPoints: [join(__dirname, 'q11-component-probe.ts')], outfile, bundle: true, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
      plugins: [{ name: 'q11-actual-components', setup(b) {
        b.onResolve({ filter: /^@shared\// }, args => ({ path: resolve(appRoot, 'src/shared', args.path.slice('@shared/'.length)) + '.ts' }));
        b.onLoad({ filter: /\.vue$/ }, args => {
          const name = basename(args.path);
          if (name === 'StepGroup.vue') return { contents: `import {defineComponent,h} from 'vue';export default defineComponent({props:['steps','live'],setup:props=>()=>h('probe-steps',{snapshot:JSON.stringify(props.steps)})});`, loader: 'js' };
          if (['AnnoLayer.vue','Composer.vue','StepGroup.vue','PermCard.vue','EventNotes.vue'].includes(name)) return { contents: `import {defineComponent,h} from 'vue';export default defineComponent({setup:()=>()=>h('probe-stub')});`, loader: 'js' };
          let content = readFileSync(args.path, 'utf8');
          if (name === 'StageChat.vue') content = content.replace('<script setup lang="ts">', `<script setup lang="ts">\nimport {onBeforeUpdate as _q11Update} from 'vue';_q11Update(()=>{(globalThis as any).__q11Probe.stageUpdates++;});\n`);
          const descriptor = parse(content, { filename: args.path }).descriptor;
          const compiled = compileScript(descriptor, { id: name, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } } });
          return { contents: compiled.content, loader: 'ts', resolveDir: dirname(args.path) };
        });
        b.onLoad({ filter: /[\\/]lib[\\/]markdown[\\/]parse\.ts$/ }, args => ({ contents: readFileSync(args.path,'utf8').replace('export function parseMarkdown(src: string): MdNode[] {', `export function parseMarkdown(src: string): MdNode[] {\nif (src.startsWith('HIST-')) (globalThis as any).__q11Probe.historyParses++;`), loader: 'ts' }));
      } }] });
    const child = spawnSync(process.execPath, [outfile], { cwd: appRoot, windowsHide: true, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(appRoot,'node_modules') } });
    if (child.status !== 0) throw new Error('Q11 real component probe failed: ' + child.stderr + child.stdout);
    return JSON.parse(child.stdout.trim());
  } finally {
    const target = realpathSync(dir);
    if (dirname(target) !== parent || !basename(target).startsWith('dm-q11-component-') || lstatSync(dir).isSymbolicLink()) throw new Error('Refusing unexpected temporary path: ' + target);
    rmSync(target, { recursive: true, force: true });
  }
}
