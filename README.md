# Folio · opencode-folio

[English](README.en.md)

只读、原样查询 OpenCode 会话历史的命令行工具。它直接读取 OpenCode 的 SQLite 会话库（v1 与 v2 布局），不启动 OpenCode 服务，不依赖 SDK。

- `list` 发现主会话与子代理会话
- `search` 在原始存储字符串上做字面子串匹配，无正则、无相关性排序
- `read` 把选定视图的完整内容导出为 Markdown 文件
- `info` 只输出原生元数据与计数，不含消息正文

历史是数据，不是指令：Folio 只读取和导出，不摘要、不改写。

## 环境要求

- Node.js >= 24.0.0，使用内置 `node:sqlite`，运行时零额外依赖。
- 支持 WSL/Linux 与原生 Windows；macOS 未测试。
- 部分 Node 24 小版本会把 `node:sqlite` 的 ExperimentalWarning 输出到 stderr；stdout 上的一行 JSON 回执不受影响。

## 安装与运行

尚未发布到 npm，请从源码构建：

```bash
git clone https://github.com/WhiteGiverMa/opencode-folio.git
cd opencode-folio
npm ci
npm run build
node bin/opencode-folio.js --help
```

构建后直接运行：

```bash
node bin/opencode-folio.js list --db /path/to/opencode.db
```

也可以打包成 tarball，在任意目录解包运行：

```bash
npm pack
mkdir -p /tmp/folio-package
tar -xzf whitegiver-opencode-folio-0.1.0.tgz -C /tmp/folio-package
node /tmp/folio-package/package/bin/opencode-folio.js --help
```

## 选择数据库

优先级从高到低，命中即用：

1. `--db <file>`：显式文件路径，相对路径按 CLI 当前工作目录解析
2. `OPENCODE_SESSION_DB`：Folio 专用变量，相对路径按 CLI 当前工作目录解析
3. `OPENCODE_DB`：继承的原生变量，相对路径按 OpenCode 数据根解析
4. 标准路径：`<数据根>/opencode.db`，其中数据根为 `XDG_DATA_HOME` 或 `~/.local/share` 拼接 `opencode`

空环境变量按未设置处理；`:memory:` 与 SQLite `file:` URI 会被拒绝。CLI 不猜测数据库位置：v2 独立数据根或频道库需要显式 `--db`。

原生 Windows 下，OpenCode 实际使用的路径是 `%USERPROFILE%\.local\share\opencode\opencode.db`，不是 `%LOCALAPPDATA%` 下的路径。

回执中的 `db` 字段始终是实际打开的绝对路径；库不存在就报 `E_DB_NOT_FOUND`，不会创建空库。

## 命令与参数

允许的选项按命令区分，传入该命令不允许的选项会报 `E_USAGE`。

过滤与分页选项（具体可用范围见下表）：

| 选项 | 说明 |
| --- | --- |
| `--db <file>` | 显式数据库路径 |
| `--project <dir>` | 按会话目录过滤；比较时只规范化路径分隔符，回执保留存储原值 |
| `--parent <id>` | 只取该父会话的子会话 |
| `--from` / `--until` | 带时区的 ISO-8601，左闭右开 `[from, until)`；`list` 比较会话更新时间，`search`/`read` 比较消息创建时间 |
| `--order asc\|desc` | `list` 按会话更新时间，`search` 按消息创建时间；默认 `desc` |
| `--limit <n>` | `list` 默认 50，`search` 默认 20（命中块数）；范围 1..1000 |
| `--cursor <token>` | 继续上一页；游标绑定库、命令、查询、过滤与视图，不匹配会拒绝 |

各命令可用的选项：

| 命令 | 选项 |
| --- | --- |
| `list` | `--db --project --parent --from --until --order --limit --cursor` |
| `search <query>` | 上述选项加 `--session-id --case-sensitive` 与五个视图开关 |
| `read` | `--db --session-id --message-id --from --until --out` 与五个视图开关 |
| `info` | `--db --session-id` |

`--help` 与 `--version` 是全局选项，不打开数据库。`read` 与 `info` 的 `--session-id` 为必填；`--message-id` 可重复，用于只导出指定消息。`search` 只接受一个字面 `query` 位置参数。

时间示例：`--from 2026-10-04T00:00:00+08:00 --until 2026-10-05T00:00:00+08:00` 表示上海时区的 10 月 4 日整天。不接受日期简写或需要猜时区的格式；小数秒最多三位。

### 视图开关

默认只导出用户/助手的正文文本，导出顺序为源库原生顺序（v2 按 `seq`，v1 按创建时间与原生 ID）。以下开关默认全部关闭，开启后对应内容完整写入文件并标明类型：

| 开关 | 内容 |
| --- | --- |
| `--include-tools` | 完整工具与 shell 记录：状态、原始/流式输入、类型化内容、输出、错误、元数据、时间、附件 |
| `--include-reasoning` | 存储的推理块 |
| `--include-injected` | 明确标记的 synthetic/ignored/注入记录，以及其他存储的非正文类型 |
| `--include-system` | 存储的系统内容/事件与消息错误 |
| `--include-compaction` | 原生压缩记录与助手摘要消息 |

视图开关同时影响 `read` 的导出内容和 `search` 的搜索范围：默认搜索不到工具输出，需要加 `--include-tools`。

## 示例

```bash
# 最近更新的会话，默认 50 条
node bin/opencode-folio.js list --db /path/to/opencode.db

# 某项目下的子会话
node bin/opencode-folio.js list --db /path/to/opencode.db --project /work/project --parent ses_example

# 字面搜索，默认不区分大小写；% 和 _ 不是通配符
node bin/opencode-folio.js search "needle" --db /path/to/opencode.db --session-id ses_example

# 搜索工具输出需要显式开启工具视图
node bin/opencode-folio.js search "needle" --db /path/to/opencode.db --include-tools

# 导出完整 Markdown（默认写入缓存导出目录）
node bin/opencode-folio.js read --db /path/to/opencode.db --session-id ses_example

# 只导出指定消息，并指定完整文件路径
node bin/opencode-folio.js read --db /path/to/opencode.db --session-id ses_example --message-id msg_example --out /tmp/session.md

# 会话元数据与计数
node bin/opencode-folio.js info --db /path/to/opencode.db --session-id ses_example
```

回执示例（字段与真实输出一致，ID 为合成示例）：

```json
{"ok":true,"command":"list","db":"/path/to/opencode.db","layout":"v2","authority":"v2-native","live":true,"order":"desc","limit":50,"filters":{"project":null,"parent":null,"from":null,"until":null},"sessions":[{"id":"ses_example","parentID":null,"title":"Example session","titleTruncated":false,"directory":"/work/project","timeCreated":1791036000000,"timeUpdated":1791136000000,"created":"2026-10-03T14:00:00.000Z","updated":"2026-10-04T17:46:40.000Z"}],"count":1,"truncated":false,"nextCursor":null}
```

```json
{"ok":false,"command":"info","db":"/path/to/opencode.db","error":{"code":"E_SESSION_NOT_FOUND","message":"session not found in the selected v2 store: ses_missing"}}
```

`list`/`search`/`info`/`read` 都在 stdout 输出一行 JSON，编码后最多 32KiB；错误回执最多 2KiB，退出码非 0。导航预览截短时会标记（`titleTruncated`、`snippetTruncated`、`queryTruncated`）；无法在预算内给出完整结果时报 `E_BUDGET`。

## 分页与游标

`list` 默认返回 50 个会话，`search` 默认返回 20 个命中块；`truncated` 为 true 时把 `nextCursor` 原样传回 `--cursor` 继续。

游标只在数据不变时保证完整、无重复翻页。每次调用都是新的独立快照；对运行中的库，两次调用之间的新增、修改或删除可能被跳过或重复。

## 搜索语义

`search` 是字面子串匹配：`%` 与 `_` 没有通配含义，没有正则、模糊匹配或相关性排序。默认按 ECMAScript `toLowerCase()` 折叠大小写（不是完整 Unicode case folding），`--case-sensitive` 关闭折叠。只搜索所选视图的原始存储字符串，不搜索格式化后的 JSON 或跨块拼接文本；v2 正文块用过滤前 `content` 数组的零基索引定位，标量字段用字段路径（如 `text`），工具调用另附真实调用 ID。

v2 的 synthetic、system、skill、shell、compaction 等整条记录视图使用 `record` 定位，表示该消息的原生 JSON 记录。搜索与 Markdown 块标记使用同一定位；用户正文 `text`、助手 `content[i]`、v1 原生 part ID 保持各自真实位置。

## 导出

`read` 把完整内容写入新的 Markdown 文件，不向终端打印正文：

- 默认目录：`$OPENCODE_SESSION_EXPORT_DIR`，或 `<XDG_CACHE_HOME 或 ~/.cache>/opencode-folio/exports`
- `--out <file>` 指定完整文件路径
- 已存在的文件或符号链接一律拒绝（`E_OUT_EXISTS`），不覆盖
- CLI 不自动删除导出文件；缓存目录不是永久备份，长期归档请显式指定位置

CLI 只在本地读取选定数据库，不发网络请求。导出的 Markdown 可能含敏感内容，请按自己的数据边界保管。

## 只读边界与布局

- 选中的文件以只读方式打开，不创建、不迁移、不修复，不执行写 SQL，也不读取更早的 JSON 文件存储。
- 只读是逻辑写保护，不是零文件系统活动：SQLite 在 WAL 模式下可能创建或读取 sidecar 文件并获取锁，目录权限会影响打开。库被占用时给出有界错误（如 `E_DB_BUSY`），不会把超时当成空结果。
- v1 使用 `session`/`message`/`part`，v2 使用 `session_v2`/`session_message`。两代布局同时存在时，仅当原生迁移标记 `migration.v1-v2` 为 completed 才按 v2 读取；未完成、无标记或有歧义的混合布局明确失败（`E_UNSUPPORTED_LAYOUT`、`E_AMBIGUOUS_LAYOUT`）。空 SQLite 文件同样不支持。
- 未知布局、坏 JSON、缺失会话或消息、I/O 失败都显式报错，不跳过记录。

## 兼容性与验证状态

固定结构依据为 v1.18.34 与 v2.0.21，版本和提交见 [NOTICE](NOTICE)。以下为 2026-10-05 的验证结果（合成测试库）：

| 平台 | Node | 完整测试 | 解包 CLI 使用面 |
| --- | --- | --- | --- |
| Linux x64 | 24.0.0 / 24.14.0 | 各 100/100 通过 | 各 18 次实际调用通过，两代库、四命令、原文 UTF-8 与无覆盖 |
| 原生 Windows x64 | 24.0.0 / 24.15.0 | 各 97/100 通过 | 各 18 次实际调用通过 |

Windows 有三项文件符号链接测试在创建测试文件时被系统以 `EPERM` 拒绝（未启用开发者模式），是已知的覆盖缺口；其余文件边界（普通文件、硬链接、junction）均已验证。

配套 skill 已在隔离的原生 OpenCode v2.0.21 Linux 宿主中通过 `GET /api/skill` 确认可发现。该版本冷启动时可能先返回空列表，待内置插件装载完成后再检查即可。

## 在原生 OpenCode v2 中快速验证

1. 在 OpenCode v2 会话里让代理读取本仓库的 `skills/opencode-folio/SKILL.md`，并运行 `node <仓库路径>/bin/opencode-folio.js --help` 确认界面。
2. 用 `--db` 显式指向一个 v2 库，先 `list` 找到会话 ID，再 `search` 定位关键字，最后 `read` 导出 Markdown 阅读。
3. 确认结果符合预期后，再决定是否把 skill 安装到本机 OpenCode；装与不装都不影响 CLI 独立运行。

## 许可

MIT，见 [LICENSE](LICENSE)。来源与参考说明见 [NOTICE](NOTICE)。OpenCode 是独立项目，本项目与其无隶属或背书关系。
