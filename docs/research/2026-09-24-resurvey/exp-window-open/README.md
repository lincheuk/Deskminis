# 实验：window.open 子窗口是否继承 preload

目的：核实报告 §4 第 20 条。主进程没有 setWindowOpenHandler，模型输出的链接带 target=_blank。
如果子窗口继承 preload，外部网页就能调用 preload 暴露的接口，拿到 minisd 的端口与令牌。

做法：父窗口带 preload，暴露 window.marker；页面里一个 target=_blank 的链接指向本地 http 页；
程序点击链接后，在子窗口里检查 window.marker 是否存在。

运行（在 deskminis/ 目录下，云端需要 xvfb）：

    xvfb-run -a node_modules/electron/dist/electron --no-sandbox <本目录>/main.js

2026-09-24 在 Electron 38.8.6 上的结果：

    PARENT has marker => object
    CHILD http://127.0.0.1:47811/evil.html => NO-PRELOAD

结论：子窗口不继承 preload，外部页面拿不到令牌。剩余风险是外部网页开在没有地址栏的应用窗口里，修法是交给系统浏览器。
