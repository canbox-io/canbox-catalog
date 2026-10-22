# canbox-catalog

Canbox 生态的 APP 目录数据生产仓库：自动发现、校验并评分 GitHub 上带 `canbox-app` topic 的仓库，把结果输出到 [canbox-catalog-data](https://github.com/canbox-io/canbox-catalog-data)，供官网与管理器消费。

[English Documentation](./README.md)

## 项目作用

canbox-catalog 不提供任何界面，也不参与 APP 的下载与运行。它只做一件事：**把散落在 GitHub 上的 Canbox APP 仓库，整理成一份可持续维护、可被前端直接消费的目录数据**。

具体职责包括：

- 通过 GitHub Search API 发现带 `canbox-app` topic 的仓库，持续增量扫描
- 拉取并校验仓库内的 `.canbox-app` 与 `package.json`
- 按仓库可访问性、配置完整性、更新活跃度、连续失败次数计算 0–100 风险评分
- 维护 APP 状态机（active / warning / critical / stale / removed）
- 过滤、转换、排序并分片，生成平台无关的 `catalog.json` 与 `catalogs/shard-*.json`
- 所有产出物写入独立的 `canbox-catalog-data` 仓库，由 GitHub Actions 自动提交

数据格式与 GitHub 解耦：平台相关常量集中在 `scripts/github/adapter.js`，公共逻辑位于 `scripts/common/`，后续接入 Gitee 等平台只需新增一个适配器目录。

## 在生态中的位置

```text
GitHub 仓库（topic: canbox-app）
        │  GitHub Search API
        ▼
  canbox-catalog（GitHub Actions）
  discover → verify / reconcile → assemble
        │  自动提交
        ▼
  canbox-catalog-data（catalog.json + 分片）
        │  raw.githubusercontent.com
        ├──────────────► canbox-pages（官网 APP 中心）
        └──────────────► canbox-manager（应用仓库页）
```

canbox-catalog 是**数据生产者**，`canbox-catalog-data` 是**数据存储**，canbox-pages 与 canbox-manager 是**数据消费者**。三者通过公开的 raw URL 解耦，互不依赖部署。

## 数据流与产物

```text
discover / reconcile / rediscover
        │  写入 app_lists_shards/shard-XXX.json
        ▼
verify（按分片轮询刷新）
        │  更新同一批分片
        ▼
assemble
        │  过滤 + 转换 + 排序 + 分片
        ▼
catalog.json + catalogs/shard-XXX.json
```

所有产出物位于 `canbox-catalog-data` 仓库根目录：

| 文件 | 内容 | 主要消费方 |
| --- | --- | --- |
| `catalog.json` | 展示数据索引：schemaVersion、totalApps、分片列表、过滤规则 | canbox-pages、canbox-manager |
| `catalogs/shard-XXX.json` | 展示数据分片，每片 100 个 APP，已转换为平台无关格式 | canbox-pages、canbox-manager |
| `app_lists.json` | 原始数据索引：分片列表、`nextShardToVerify` 游标 | canbox-catalog 自身 |
| `app_lists_shards/shard-XXX.json` | 原始数据分片，每片 200 个 APP，含校验状态与评分 | canbox-catalog 自身 |
| `discovery_cursor.json` | 发现游标：`lastRun`、`firstRun`、累计发现数与最近 100 条历史 | canbox-catalog 自身 |
| `.{action}-result.json` | 触发标记：本次新增数量，供 CI 决定是否触发 assemble | GitHub Actions |

消费方读取示例：

```text
https://raw.githubusercontent.com/canbox-io/canbox-catalog-data/main/catalog.json
https://raw.githubusercontent.com/canbox-io/canbox-catalog-data/main/catalogs/shard-001.json
```

## GitHub Actions 任务

| Workflow | 触发方式 | 作用 |
| --- | --- | --- |
| `discover.yml` | 每小时（`0 * * * *`）+ 手动 | 增量发现新创建的 APP 仓库；首次运行执行全量扫描 |
| `verify.yml` | 每 2 小时（`0 */2 * * *`）+ 手动 | 轮询校验**一个**分片，刷新元数据、检测改名、重新校验、重算评分 |
| `reconcile.yml` | 每周一 02:00 UTC + 手动 | 全量 topic 对账，捕获“老仓库后来才加 topic”的情况 |
| `rediscover.yml` | 仅手动 | 扫描 `firstRun` 之前创建的仓库，补齐首次全量扫描可能遗漏的部分 |
| `assemble.yml` | 被上游触发 + 手动 | 过滤、转换、排序、分片，生成 `catalog.json` 与 `catalogs/*` |

各任务的关系与细节：

- **discover**：读取 `discovery_cursor.json`。没有 `lastRun` 时按 `topic:canbox-app` 全量分页扫描；否则只查 `created:{lastRun-30min}..{now}` 区间。回溯 30 分钟是为了容忍 Actions 调度延迟，宁可多扫，最终由分片去重兜底。新增数量写入 `.discover-result.json`，大于 0 时触发 assemble。
- **verify**：从 `app_lists.json` 读取 `nextShardToVerify`，每次只处理一个分片，逐条检查仓库可访问性（404 / 403）、owner/repo 改名（301 重定向）、刷新 stars/forks/lastCommit、重新拉取 `.canbox-app` 与 `package.json`、重算评分与状态，处理完后游标加一并回绕。分片轮询避免了一次性打爆 GitHub API 配额。
- **reconcile**：不带 `created` 条件，拉取当前所有带 topic 的仓库，与已有分片按仓库 ID 和仓库 URL 求差集，只补新增，不做刷新。它解决的是“仓库早就存在、后来才加 topic，增量扫描按创建时间永远扫不到”的盲区。
- **rediscover**：仅扫描 `created:<=firstRun`，补首次全量扫描因 API 限流、1000 条上限等原因漏掉的早期仓库，同样只补新增。
- **assemble**：读取全部原始分片，按状态与评分过滤，转换为展示格式，按 stars 降序排序后每 100 个一片写入 `catalogs/`，同时生成索引并清理多余分片。配置了 `concurrency: catalog-assemble`，多个上游同时触发时串行执行，避免互相覆盖。

## 检索归路（发现路径）

所有发现路径最终都落到同一个 GitHub Search 查询：`topic:canbox-app`，差别只在时间条件与触发方式。

| 路径 | 查询条件 | 覆盖范围 | 触发 |
| --- | --- | --- | --- |
| 首次全量 | `topic:canbox-app` | 当前全部带 topic 的仓库 | cursor 无 `lastRun` 时的 discover |
| 增量发现 | `topic:canbox-app created:{since..now}` | 上次运行前 30 分钟至当前新创建的仓库 | 每小时 discover |
| topic 对账 | `topic:canbox-app` | 当前全部仓库，与已有数据求差集 | 每周 reconcile |
| 早期补扫 | `topic:canbox-app created:<=firstRun` | `firstRun` 之前创建的仓库 | 手动 rediscover |

三条写入路径共用同一套去重与落盘逻辑：

1. 由仓库 URL 生成 APP ID，如 `https://github.com/acme/notes` → `com.github.acme.notes`
2. 去重主键为 GitHub 仓库 ID（`githubRepoId`），回退为仓库 URL（`repo`）
3. 追加到最后一个未满的原始分片，每片上限 200 个，满了自动新建 `shard-XXX.json` 并更新 `app_lists.json`

GitHub Search API 单次查询最多返回 1000 条结果，全量类任务到达上限时会打印告警；仓库数量超过 1000 后需要按时间窗口切分查询。

## APP 发现举例

以开发者新建仓库 `https://github.com/acme/notes` 为例：

1. **打标**：开发者在仓库设置中添加 `canbox-app` topic。
2. **发现**：下一次整点 `discover.yml` 运行时，`created` 区间覆盖到该仓库，Search API 返回它。
3. **解析**：脚本生成 APP ID `com.github.acme.notes`，通过 Contents API 拉取 `.canbox-app` 与 `package.json`（文件缺失按 404 容忍，不中断整批任务）。
4. **校验**：
   - `.canbox-app` 必须有 `type`，取值 `native` / `web` / `pwa`；`native` 还必须有 `electron.range`
   - `package.json` 必须有 `name`、`version`、`main`
   - `category` 可选，若存在但不在九项枚举内，记告警并扣分，但不阻断
5. **评分与状态**：初始 100 分，按仓库不可访问、配置缺失、超过 180 天未更新、连续失败、分类告警等逐项扣分。`.canbox-app` 与 `package.json` 均通过时状态直接置为 `active`。
6. **落盘**：追加到 `app_lists_shards/shard-001.json`，更新游标与历史，写入 `.discover-result.json`（`newCount=1`）。
7. **触发组装**：新数量大于 0，`discover` 提交数据仓库并派发 `assemble.yml`。
8. **生成展示数据**：assemble 只保留 `active` / `warning` / `critical` 且评分不低于 30 的 APP，转换为 `id`、`name`、`description`、`logo`、`stars`、`riskLevel`、`showDownload` 等字段，按 stars 降序写入 `catalogs/shard-001.json` 并重建 `catalog.json`。
9. **消费**：canbox-pages 与 canbox-manager 读取 raw URL，在 APP 中心展示并允许下载。

另外两种典型场景：

- **老仓库后加 topic**：增量扫描只看 `created`，永远发现不了；每周 `reconcile` 全量求差集后补入。
- **仓库改名**：`verify` 检查仓库时发现实际 owner/repo 与记录不一致，自动更新 APP ID 与仓库 URL，后续校验使用新地址。

## 状态机与评分

| 状态 | 进入条件 | 是否进入目录 |
| --- | --- | --- |
| `unknown` | 刚发现，尚未完成有效校验 | 否 |
| `active` | 配置校验通过 | 是 |
| `warning` | 连续失败 3–4 次 | 是 |
| `critical` | 连续失败 ≥ 5 次 | 是（评分 ≥ 30 时） |
| `stale` | critical 状态持续超过 30 天 | 否 |
| `removed` | critical 状态持续超过 365 天 | 否 |

评分规则（满分 100，扣分项累加后取 0–100 区间）：

| 扣分项 | 扣分 |
| --- | --- |
| 仓库 404 | −40 |
| 仓库私有（403） | −30 |
| `.canbox-app` 校验失败 | −20 |
| `package.json` 校验失败 | −10 |
| 无提交记录或超过 180 天未更新 | −10 |
| 连续失败次数 | 每次 −2，最多 −20 |
| `category` 非法告警 | −10 |

目录过滤规则：包含 `active` / `warning` / `critical`，排除 `stale` / `removed`，且评分不低于 30。

## 仓库结构

```text
canbox-catalog/
├── .github/workflows/       # 5 个 GitHub Actions 工作流
│   ├── discover.yml
│   ├── verify.yml
│   ├── reconcile.yml
│   ├── rediscover.yml
│   └── assemble.yml
├── scripts/
│   ├── common/              # 平台无关逻辑
│   │   ├── assemble.js      # 过滤、转换、分片、生成索引
│   │   ├── category.js      # 九项分类枚举与归一化
│   │   ├── constants.js     # 分片大小、状态、过滤规则、schema 版本
│   │   ├── index.js         # 公共模块统一出口
│   │   ├── paths.js         # 命令行参数与数据目录解析
│   │   ├── platform-adapter.js  # 平台适配注册表、APP ID、展示格式转换
│   │   ├── scoring.js       # 评分、状态机、过滤、错误历史
│   │   ├── storage.js       # JSON 读写、分片、游标、触发标记
│   │   └── validate.js      # .canbox-app 与 package.json 校验
│   └── github/              # GitHub 平台实现
│       ├── adapter.js       # idPrefix、域名、raw 地址构造
│       ├── helpers.js       # Octokit 封装、Search API、文件拉取、仓库检查
│       ├── discover.js
│       ├── verify.js
│       ├── reconcile.js
│       ├── rediscover.js
│       └── assemble.js
├── package.json
└── README.md / README_zh-CN.md
```

## 本地运行

```bash
npm install
```

脚本通过参数指定平台与数据仓库路径：

```bash
node scripts/github/discover.js --platform=github --data-repo-root=../canbox-catalog-data
node scripts/github/verify.js --platform=github --shard=1 --data-repo-root=../canbox-catalog-data
node scripts/github/reconcile.js --platform=github --data-repo-root=../canbox-catalog-data
node scripts/github/assemble.js --platform=github --data-repo-root=../canbox-catalog-data
```

`package.json` 中提供了对应的 npm 脚本：

| 命令 | 说明 |
| --- | --- |
| `npm run catalog:discover` | 增量发现（首次为全量） |
| `npm run catalog:verify` | 校验指定分片 |
| `npm run catalog:reconcile` | 全量 topic 对账 |
| `npm run catalog:rediscover` | 补扫 `firstRun` 之前的仓库 |
| `npm run catalog:assemble` | 生成展示数据 |

环境变量：

| 变量 | 说明 |
| --- | --- |
| `CATALOG_GITHUB_TOKEN` | 优先读取的 GitHub Token |
| `GITHUB_TOKEN` | 备用 Token；CI 中使用 workflow 的 token |

未传 `--data-repo-root` 时，脚本回退到仓库内的 `data/github`（已被 `.gitignore` 忽略），仅供本地调试。生产环境必须指向已 clone 的 `canbox-catalog-data` 目录。

## 相关仓库

- [canbox-catalog-data](https://github.com/canbox-io/canbox-catalog-data)：目录数据产出物存储
- [canbox-pages](https://github.com/canbox-io/canbox-pages)：官网与 APP 中心
- [canbox-manager](https://github.com/canbox-io/canbox-manager)：桌面管理器，应用仓库页消费目录数据
- [canbox-core](https://github.com/canbox-io/canbox-core)：统一运行时注入模块
