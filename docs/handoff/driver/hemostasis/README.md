# 止血波的实拍剧本与步骤工作流（2026-09-24～25 归档）

这些文件原在会话草稿区，草稿区随会话消失，所以挑有代表性的归档到这里。
剧本里写死了当时的草稿区路径（常量 `S`）和工作树路径（`APP` / `APP_DIR`），复用前先改这两处。

## 怎么跑

```
npm run build                       # 在应用目录 deskminis/ 下
NODE_PATH=<装了 playwright-core 的目录>/node_modules xvfb-run -a node <剧本>
```

- 数据根一律用 mkdtemp 临时目录，经 `DESKMINIS_DATA_DIR` 注入；假模型用 `DESKMINIS_FAKE_PROVIDER=1`
  （首条用户文本写成 `__tool__ <工具名> <inputJSON>` 就会发起一次工具调用）。
- Linux 上桥的命名管道按相对路径落进 cwd，跑完应用目录里会留下 `\\.\pipe\deskminis-*` 套接字文件：
  git 不收，可用 `find . -maxdepth 1 -type s -delete` 清掉。
- 模拟「已打包」：Electron 按可执行文件名判 `app.isPackaged`（Linux 上不叫 electron 就算打包）。
  把 `node_modules/electron/dist` 硬链接复制一份（`cp -al`），把里面的 `electron` 改名成 `deskminis`，
  用它起同一份 `out/` 产物，主进程里 `app.isPackaged` 就为真（见 W2b-6c-menu.mjs 的 pkg 模式）。
- 未打包且设了 `DESKMINIS_DATA_DIR=X` 时，Electron 的 userData 在 `X/electron`（`src/main/app-dirs.ts`）。单实例锁按 userData 算，
  所以不同的临时数据根可以各开一个实例；**同一个数据根同时只能开一个应用**（第二个当成第二实例秒退，引擎侧还有数据根锁 `minisd.lock`）。
- 模拟打包形态时 userData 保持 Electron 默认（Linux 上是 `~/.config/deskminis`），单实例锁不随数据根分开：
  同一时刻只能有一个打包形态的实例，前一个没退干净，下一个会被当成第二实例秒退。

## 剧本

| 文件 | 验什么 |
|---|---|
| W2b-2-permscope.mjs | 权限卡按会话区分：别的会话在等时有提示行与盾牌标，点提示切过去卡在（midRun 路径）、批得了 |
| W2b-3-disconnect.mjs | 杀掉 minisd 后 2 秒内出现断线横幅、发送置灰、别的窗口请求重启被拒、点「重启应用」真的重启 |
| W2b-3b-open-after-lost.mjs | 断线后点左栏别的会话，当前视图原样不动 |
| W2b-11a-dangling.mjs | 历史回合里没有结果的工具标「已中断 · 结果未知」，运行中的回合不误标 |
| W2b-11a-shell.mjs | 托盘「切换右栏」「打开设置」两条通道、定时与设备页文案 |
| W2b-6-fix-guards.mjs | 窗口导航守卫：新窗口一律拒绝、外链交给系统浏览器、非本应用导航被拦、剪贴板白名单 |
| W2b-6b-osc8.mjs | 终端 OSC 8 超链接经中文确认框交给系统浏览器（x11 真点击） |
| W2b-6c-menu.mjs | 打包形态的最小菜单：缩放可用，Ctrl+R 不重载、Ctrl+Shift+I 不开开发者工具；开发形态保留默认菜单 |
| W2b-7-crashlog.mjs（+ W2b-7-engine-inject.cjs） | 引擎崩溃与主进程异常写进 crashes.json 与按天日志 |
| W1b-2h-perm.mjs | 设置页权限一节三档副标题 |
| W1b-3-gui.mjs（参数 locked 或 single） | 「DeskMinis 已在运行」原生框（配 W1a-8-x11.py 真点按钮）、第二实例唤回窗口、陈旧锁接管 |
| W1b-5-quit.mjs | 运行中带权限卡退出：5 秒内全部进程退出、MCP 不留孤儿、数据根锁释放、库里补上「已取消」的结果 |
| W2b-4b-r5-welcome.mjs | 欢迎页选助手：真 provider 配剧本内置的假 OpenAI 端点，四条路由核请求体里的预设与模型 |
| W2b-11d-changes.mjs | 右栏「改动」清单按工具结果判：成功、失败、中断各一个写工具，只列成功的那个 |
| W2b-6b-x11.py、W1a-8-x11.py | 用 XTest 发真实按键、点击与截整屏（playwright 的合成事件触发不了菜单快捷键与原生对话框） |

## 步骤工作流

`hemostasis-steps.workflow.js` 是这一波每一步用的工作流脚本：实现者按 TDD 先红、本地提交；独立审查者对抗式复核；
修正者 amend；最多三轮审查、两轮修正，第三轮遗留由主会话补修或定为已知边界。参数形如
`{chains:[{name,dir,branch,steps:[{id,scout,items,cross,title,notes}]}]}`，一条链一个 worktree，链内按顺序、链间并行。
审查提示里写着设计稿 §1 第 8 条：源码守卫只防现实中会发生的回退，刻意混淆的写法只列 nit。
