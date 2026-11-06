<div align="center">

#  Pi Find Master

### 让编程代理找到工具、记住要求、交付可核对的结果

**按需发现与执行工程工具，保留可核对的证据，让代理自行组织工作。**

本地记录 · 项目配置 · 按需检查 · 证据驱动

<br />

![Version](https://img.shields.io/badge/version-0.3.0-6366f1?style=flat-square)
![Stage](https://img.shields.io/badge/status-preview-f59e0b?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat-square&logo=nodedotjs&logoColor=white)
[![License](https://img.shields.io/badge/license-MIT-14b8a6?style=flat-square)](LICENSE)
![Dependencies](https://img.shields.io/badge/runtime_dependencies-0-64748b?style=flat-square)

<br />

**[快速开始](#quick-start)** · [核心能力](#features) · [使用流程](#workflow) · [配置说明](#configuration) · [能力边界](#boundaries) · [开发验证](#development)

<br />

**默认提供发现与执行；记录、交接和计划按需使用。**

</div>

> **当前版本：0.3.0 预览版。** 还在不断验证和改进当中

---

## 为什么需要 Pi Find Master？

模型能写代码，工程任务还需要持续回答三个问题：

**项目已有的工具在哪里？这项任务必须满足什么？哪些结果真正经过了验证？**

长任务、多仓库和子代理协作，会让这些信息分散在上下文、命令输出和历史报告中。Pi Find Master 把它们整理成可查询的工程入口、可恢复的任务记录和与源码关联的验收证据。

| 开发中的常见问题                           | 插件如何帮助                             |
| ------------------------------------------ | ---------------------------------------- |
| 重复寻找命令，忽略已有环境、脚本与缓存     | 扫描项目声明，提供可查询的工具入口       |
| 进入子项目后遗漏规则，压缩上下文后忘记约束 | 启动加载当前规则，其他目录按需查询读取 |
| 长任务丢失要求、决策和未解决事项           | 按需保存与查询任务资料，不自动设为当前目标   |
| 子代理收到的任务过于模糊，回报缺少依据     | 派发前整理范围、文件、规则与验收要求     |
| 局部测试通过，却被当成整体完成             | 分开核对命令、测试和交付门禁             |
| 修改代码后继续使用旧报告                   | 输入、配置、环境或报告变化时使旧证据失效 |
| 检查的是工作区版本，推送的是另一份代码     | 交付门禁核对相关受测输入与当前 HEAD      |

<div align="center">

**完成，不止是一句回复。还应有明确的范围、当前的源码和实际执行的检查。**

</div>

---

<a id="features"></a>

## 核心能力

<table>
<tr>
<td width="33%" valign="top">
<h3> 工程工具发现</h3>
<p>查询已有脚本、环境、规则和缓存位置，优先复用项目入口。</p>
<p><strong>先发现，再执行。</strong></p>
</td>
<td width="33%" valign="top">
<h3> 持久任务记录</h3>
<p>保存目标、验收要求、决策与阻塞事项，为后续工作恢复必要依据。</p>
<p><strong>要求留在项目里。</strong></p>
</td>
<td width="33%" valign="top">
<h3> 验收证据核对</h3>
<p>关联源码、执行配置、日志和测试报告，区分局部检查与交付通过。</p>
<p><strong>结果有据可查。</strong></p>
</td>
</tr>
<tr>
<td width="33%" valign="top">
<h3> 按变更制定计划</h3>
<p>从 Git 变更选择相关检查项；无法识别影响范围时保守回退。</p>
<p>计划只读，不自动执行。</p>
</td>
<td width="33%" valign="top">
<h3> 子代理交接</h3>
<p>准备包含工作范围、规则、文件和需求 ID 的交接正文。</p>
<p>复用现有调度工具，不另建调度器。</p>
</td>
<td width="33%" valign="top">
<h3> 交付门禁</h3>
<p>按项目配置核对推送、发布和部署前所需的验收证据。</p>
<p>检查门禁，不自动执行交付动作。</p>
</td>
</tr>
</table>

---

<a id="workflow"></a>

## 从任务到交付

```mermaid
flowchart LR
    A[发现已有入口] --> B[执行并读取真实结果]
    B --> C[按需核对证据]
    C --> D[明确启用的交付入口核对门禁]
    E[可选任务记录／交接／计划] -. 提供参考 .-> B
```

这不是必经调用顺序。普通读取、修改和原生 Task/SessionTask 不受插件流程拦截；记录缺失、blocker 未解除、旧交接或过期证据不阻止普通工作。进入其他目录前仍需读取适用规则；插件不解析 Bash 路径，也不保证在每次工具调用前透明注入规则。

任务与证据各有自己的职责：

- **任务记录**：保存要做什么、已作出的决定，以及尚未解决的问题。
- **验收项**：声明检查范围、执行命令和报告要求。
- **交付门禁**：检查对应动作需要的完整验收集合，并核对相关内容与 HEAD。

Git 仓库尚无首次提交也可执行普通验收（head 为空），无 HEAD 的影响计划返回完整候选；非 Git 目录可用普通执行入口，但不能形成 Git 绑定证明。代码可以在未提交时接受检查；交付前仍需证明检查结果对应待交付的内容。

---

<a id="quick-start"></a>

## 快速开始

### 方式一：在 PI-Desktop 中使用

<table>
<tr>
<td width="33%" valign="top">
<h3>01 · 加载插件</h3>
<p>获取源码，在插件页面选择<strong>加载开发插件</strong>，选中项目根目录。</p>
</td>
<td width="33%" valign="top">
<h3>02 · 配置验收</h3>
<p>在目标项目中声明检查命令、输入范围、测试报告和交付门禁。</p>
</td>
<td width="33%" valign="top">
<h3>03 · 开始工作</h3>
<p>让代理查询工具、记录要求、执行检查，并核对当前验收结果。</p>
</td>
</tr>
</table>

可以从这样的任务开始：

> 查询项目已有的检查入口，记录本次任务的验收要求。先生成验收计划，再执行已配置的相关检查，最后说明哪些通过、哪些未运行、哪些仍被阻塞。

新增验收能力需要项目配置。没有配置时会明确返回未配置，不能据此认定任务通过。

<details>
<summary><strong>可选：通过安装辅助加载开发插件</strong></summary>

<br />

安装辅助针对支持 protocol 11 的 Desktop host。先手动关闭桌面，再运行：

```sh
python tools/install-desktop.py --help
python tools/install-desktop.py --desktop-root /path/to/desktop --plugin-root /path/to/pi-find-master
```

脚本备份现有数据库后调用 `plugins.loadDev`，不自动关闭桌面、安装依赖或修改全局设置。源码更新后需要重载插件或重启宿主。

</details>

### 方式二：使用独立 CLI

需要 **Node.js ≥22、Git，以及目标项目自身的检查环境**。在插件源码目录运行：

```sh
# 1. 查看命令并初始化目标项目配置
node src/cli.mjs --help
node src/cli.mjs init --root /path/to/project
```

在目标项目的 `.gitignore` 中加入 `/.local/`。随后参考 [配置示例](examples/pi-find.example.json)，编辑生成的 `.pi-find.json`，登记真实入口。

```sh
# 2. 按 Git 变更生成检查计划
node src/cli.mjs plan --root /path/to/project --json

# 3. 运行项目配置中的验收项
node src/cli.mjs run quality --root /path/to/project
node src/cli.mjs run smoke --root /path/to/project

# 4. 查询证据并检查推送门禁
node src/cli.mjs status --root /path/to/project --json
node src/cli.mjs gate push --root /path/to/project --json
```

> `quality`、`smoke` 来自示例配置，使用前需要登记。`init` 只生成 `verify` 命令样板，默认没有交付门禁，不会覆盖已有配置或运行检查。验收证据要求目标仓库已有至少一个提交。

[示例冒烟脚本](examples/smoke.mjs) 演示真实文件读写和 JUnit 生成；使用示例配置时，将它放到目标项目的 `scripts/smoke.mjs`。业务项目应替换为自身测试。

---

## 代理可以使用哪些工具？

| 工具                | 用途                                          |
| ------------------- | --------------------------------------------- |
| `project_tools`     | 查询工程入口、环境、规则和缓存                |
| `run_project_tool`  | 经确认执行已有入口，兼容原有 quality/e2e 记录 |
| `acceptance_plan`   | 根据 Git 变更制定只读验收计划                 |
| `acceptance_status` | 核对指定验收项，或配置中的完整 action 门禁    |
| `run_acceptance`    | 经确认执行显式配置的验收项                    |
| `task_record`       | 保存目标、需求、备注、决策和阻塞事项          |
| `task_status`       | 查询事项及关联证据，不裁决整个任务是否完成    |
| `prepare_delegate`  | 准备子代理交接正文，关联任务与需求 ID         |

任务可用 `requirements: [{id, description, profiles}]` 关联证据。`task_status` 返回 `evidenceStatus` 与 `openBlockers`，不再返回裁决总任务的 `status`；这是 0.3 的返回语义变更，旧记录仍可读取。备注或子代理声明不能将证据写成通过；blocker 是事项记录，解决时保留审计，不额外请求 UI 批准，也不控制执行或交付。

`prepare_delegate` 是可选的资料整理工具，将交接写入 `.local/pi-find/handoffs/`，返回短 `handoffId`、`dispatchTask` 和完整 `task`。选择这种方式时，子代理读取记录后按当前规则工作；原生派发不要求交接标记，也不会因旧记录过期被封锁。记录不是权限，也不会自动恢复为当前工作目标。

执行结果使用少量字段：`status` 表示本次结果，`started` 表示是否启动进程，`reasonCode` 表示原因，`nextStep` 提供恢复动作。`run_project_tool` 返回实际项目、命令、退出码、输出、`executionOk` 和证据错误；可选 `taskId` 关联失败独立返回，不影响有效命令。证据存储失败不抹去执行结果，也不会自动重跑可能有副作用的命令。普通证据查询返回失效事实；显式 action gate 才把未通过作为门禁失败。

---

<a id="configuration"></a>

## 配置与证据

**配置决定检查什么，证据说明实际检查了什么。**

共享配置放在 `.pi-find.json`，机器专用覆盖放在 `.local/pi-find/config.json`。配置模板和可运行示例位于 [examples/](examples/)。

| 字段                         | 职责                                            |
| ---------------------------- | ----------------------------------------------- |
| `acceptance.profiles`        | 定义输入范围、命令、环境和报告要求              |
| `acceptance.defaultProfiles` | 验收计划中的基础检查项                          |
| `acceptance.impact`          | 将变更路径映射到相关检查项                      |
| `acceptance.gates`           | 定义 `push` / `release` / `deploy` 的验收集合   |
| `deny`                       | Git guard 拦截的禁止提交路径，需要实际接入 hook |

### 两类验收，明确区分

| 类型            | 通过意味着什么                                                |
| --------------- | ------------------------------------------------------------- |
| `kind: command` | 指定命令成功完成，例如格式或类型检查；不声称运行了测试        |
| `kind: test`    | 本次新生成的 JUnit 报告符合要求，且实际通过数达到 `minPassed` |

失败、错误、全跳过、无效 XML 和统计不一致不能作为测试通过证据。默认拒绝包含 skipped 的报告，首版不支持 TAP。

<details>
<summary><strong>输入范围、配置合并与计划选择</strong></summary>

<br />

- 根配置与 `acceptance` 内部均按字段浅合并。覆盖 `profiles` 会替换整个对象，不会逐个验收项合并。
- 输入来自 Git 可见的 tracked 和非忽略 untracked 文件，排除 `.git/`、`.local/`；删除的 tracked 文件保留标记。
- glob 使用 POSIX `/`。输入范围应包含相关源码、测试、执行脚本、配置和锁文件。
- 无法确定依赖关系时，保留默认全范围。插件不会推断所有动态依赖。
- `plan --base <commit-or-ref>` 可以指定 Git 基准。未知变更保守回退全部候选，计划成功不代表验收通过。
- 符号链接输入、submodule、越界目录和报告路径明确拒绝；报告必须位于工作区 `.local/`。

</details>

<details>
<summary><strong>什么时候可以复用检查结果？</strong></summary>

<br />

每项证据记录输入指纹、有效配置哈希、指定环境键哈希、Node/OS、Git HEAD、执行步骤、退出码、耗时、日志及报告摘要。

运行前归档旧报告并使旧成功失效；项目执行锁防止并发混用报告。输入范围、命令配置、运行环境、报告或日志变化会使证据失效。范围外改动可复用已有结果。

交付门禁还要求相关受测内容对应当前 HEAD。Windows 按 Git 内容规范化规则核对，应保持 `.gitattributes` 与 Git 换行设置一致。

前后指纹只证明采样时的状态，无法排除运行中改动后又恢复的情况，不构成隔离保证。

</details>

<details>
<summary><strong>任务恢复、规则与上下文整理</strong></summary>

<br />

任务记录采用写锁和 revision 防止并发覆盖；需求创建后不能通过更新操作静默删除。记录仅按需查询，不自动选择当前任务、目标项目或批准范围。历史记录不构成新授权。

当前目录规则启动时加载，其他目录通过发现结果按需读取，优先顺序为 `AGENTS.override.md`、`AGENTS.md`、兼容 `AGENT.md`。上下文达到 80% 时提供整理提醒；压缩仍由宿主负责，不自动发起，也不修改模型窗口。

</details>

---

## 数据留在项目中

```text
目标项目/
├── .pi-find.json              # 共享的工程与验收配置
└── .local/pi-find/            # 应加入 Git 忽略规则
    ├── config.json           # 机器专用覆盖
    ├── tasks/                # 任务、决策、阻塞和交接记录
    ├── acceptance/           # 分项验收证据与历史报告
    └── logs/                 # 实际命令输出
```

插件本身不自动上传这些记录。项目检查命令仍可能访问外部服务或输出敏感信息，应由项目配置控制其行为。

---

<a id="boundaries"></a>

## 执行权限与能力边界

| 操作               | 执行方式                                    |
| ------------------ | ------------------------------------------- |
| 发现工具、查询计划 | 读取当前工作区声明和 Git 状态               |
| 保存任务与证据     | 写入工作区 `.local/pi-find/`                |
| Desktop 执行检查   | 展示命令、目录和环境覆盖，经确认后执行      |
| CLI 执行检查       | 由用户主动调用命令，不弹出 Desktop 确认窗口 |
| 提交、推送与部署   | 门禁只核对状态，不自动执行这些动作          |

Desktop 确认绑定验收配置哈希。等待确认期间配置发生变化会拒绝执行；敏感环境覆盖值在确认界面遮挡并显示哈希。

同一会话中，UI 已批准的相同项目、入口、命令/目录/环境配置可重复执行，不要求任务账本；任务备注和 blocker 不影响批准。执行范围变化重新确认，拒绝与 UI 超时不缓存批准，loader 重载后重新确认。等待确认时配置改变不执行，也不缓存此次批准。

当前 API 无法把自然语言授权转换成可验证的执行许可，因此插件执行器仍需首次 UI 批准；不要求用户通过任务记录重复授权，也不拦截宿主原生执行工具。`ui_confirmation_failed` 表示命令尚未启动；`execution_failed` 表示执行失败；`evidence_failed` 表示需分别查看 `executionOk` 与证据错误。配置和门禁通过不能授予 commit/push 权限。

锁只保护对应写入资源。锁诊断提供 PID、时间与存活情况；不会只因 PID 消失自动删除锁，因为子进程可能仍在运行。配置摘要读取错误作为启动诊断，不使整个 agent 无法启动；实际使用坏配置的工具仍准确报告失败。

**Pi Find Master 是工程工作流辅助，不是操作系统沙箱。** 扩展使用 `agent.extension` 和 Node 文件/进程 API，命令以运行用户权限执行。项目文件不能扩大授权，普通最终回复也没有强制拦截能力。

插件不会自动修复业务缺陷、安装项目依赖、保证构建缓存命中，或验证远端部署。它不新增调度器、不自动轮询 CI，也不能用任务摘要替代完整长期记忆。

### Git hooks 与旧配置

`tools`、`qualitySteps`、`e2eSteps` 及原有收据格式保留兼容，与新版 `acceptance` 独立。旧收据不能提供新版 HEAD 绑定的交付证明；迁移需要显式配置并重新验收。

未配置新版 `acceptance` 时，`acceptance_status` 保持 `configured:false / ok:false`，同时列出旧模式的真实执行入口、配置步骤、收据有效性和实际输出片段。旧收据只证明所列命令覆盖的范围，没有结构化用例计数；局部用例、原生套件、安装版 GUI 和远程 CI 必须分别核对，不能合称全量通过。先确认当前任务所需范围，再按当次授权执行旧入口，或显式迁移为带 JUnit 报告的新版验收项。

```sh
python tools/install-git-gates.py
```

辅助脚本只输出手动接入说明，不覆盖 hooks 或更改 `core.hooksPath`。保留已有 Husky 检查和 pre-push 引用处理；CLI `gate push` 检查当前 HEAD，`guard.mjs pre-push` 另有推送引用核对。

Git hooks 可被绕过，不能替代远端 CI 和分支保护。

---

<a id="development"></a>

## 开发与验证

```sh
# 语法检查
npm run check

# 真实 Git、文件与子进程冒烟 / E2E
npm run test:e2e

# 查看 npm 分发内容，不执行发布
npm pack --dry-run --json --cache .local/cache/npm
```

具有 Desktop 环境时，可单独验证实际扩展加载器：

```sh
node tests/desktop-smoke.mjs --desktop-root /path/to/desktop
```

| 验证范围                        | 当前说明                                    |
| ------------------------------- | ------------------------------------------- |
| PI-Desktop 扩展运行器           | 已针对 0.21.0 做加载器集成验证              |
| 独立 CLI                        | 提供真实 Git、子进程和文件的冒烟 / E2E      |
| Windows / Ubuntu · Node 22 / 24 | 已配置 CI 矩阵，实际结果以对应 Actions 为准 |
| 标准 Pi CLI 扩展宿主            | 完整兼容性尚未验证                          |
| 付费模型的完整任务执行          | 不在本地自动测试范围内                      |

npm 包仅收录运行文件、说明、MIT 许可、通用示例和安装辅助，不包含 `.local/`、测试、开发规则或 CI 文件。GitHub 源码仓库保留测试与开发资料。

---

## 参与项目

欢迎提交可复现的问题、工程配置示例和改进建议。

报告问题时，建议提供宿主版本、操作系统、Node 版本、脱敏配置、实际命令和相关日志。请区分命令执行失败、测试失败、证据失效与环境阻塞，避免提交凭证和私有业务数据。

## 许可

本项目使用 [MIT License](LICENSE)。

