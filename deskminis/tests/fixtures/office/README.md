# tests/fixtures/office

真实 Word 存出来的二进制样本。用 `writeZip` 现造的包只有一种 ZIP 布局、也只有我们自己会写的那些部件；
「别的程序做的文档」到底长什么样，要有真实样本才知道。两份的内容都是脚本合成的，**不含任何用户文件**。

| 文件 | 是什么 | 怎么造的 |
|---|---|---|
| `foreign-word.docx` | 别的程序做的文档：一个标题、几段文字、一处软回车（段内换行）、三项编号列表、一条批注、一张图片、页眉文字、一张 2×2 表格 | 真实 Word 新建文档、逐项写入、另存为 docx |
| `deskminis-resaved.docx` | 本工具生成的文档在 Word 里**原样另存**了一次（一个字没改） | 真实 Word 打开 `legacy` 夹具的产物、直接另存为 docx |

- Word 版本：Microsoft Word 16.0.15128（Microsoft 365，zh-cn，x64）；系统 Windows 11 10.0.26200。
- 日期：2026-10-04。
- 脚本：`work\verify\F10A\make-foreign.ps1`（`-Mode foreign` / `-Mode resave -In <docx>`；验证附件，不在仓库里）。
  启动方式是 `WINWORD.EXE /safe /Automation -Embedding`，文档先存在临时目录，查过之后才复制出来。
- 个人信息：保存前设了 `RemovePersonalInformation`（批注作者变成「作者」，`dc:creator`、`cp:lastModifiedBy` 为空）；
  脚本在文件离开临时目录之前，在全部 `.xml` / `.rels` 部件里搜本机的 Windows 用户名、计算机名与 Office 用户名，命中 0 处才放行。

`foreign-word.docx` 里有什么（测试的断言对着这些数）：25 个部件，含 `word/media/image1.png`、`word/header1.xml`–`header3.xml`
（页眉文字「合成样本页眉」在 `header2.xml`）、`word/comments.xml`（1 条）、`word/numbering.xml`（decimal）；
正文里 3 个带 `w:numPr` 的段落、1 个 `<w:br/>`、1 个 `w:drawing`、1 张 2 行的表；`docProps/app.xml` 的 `Application` 是 `Microsoft Office Word`。

`deskminis-resaved.docx` 里有什么：14 个部件（Word 另存时加了 `word/theme/theme1.xml`、`word/webSettings.xml` 等，并重写了 `docProps/app.xml`：
`Application` 从 `DeskMinis` 变成 `Microsoft Office Word`）；正文仍是 `legacy` 夹具的内容（2 张表、7 个表格行）。
它证明的是「在 Word 里存过一次，就不再是本工具原样生成的文档」。源文件是取证存档 `out\20261004-194557\legacy\legacy.docx`
（sha256 `75ed54e72ca569fe132938f3acf9d37481fab75f41fa7bd841e14f36e9c44858`，就是 `tests/office-docx-fixtures.ts` 的 `legacy` 夹具当时的产物）。

sha256：

- `foreign-word.docx`：`45dd8a67e9307ce111ea136a85fcba453b9f5f75f139b4d2dc5432da6ee8b5b5`（25267 字节）
- `deskminis-resaved.docx`：`47214f002d9adae5298b8410500b45bede17c7e382ebba2d539e03cabbd1d55c`（16563 字节）
