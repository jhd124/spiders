# spiders

藤校（常春藤盟校）及 Stanford、MIT 的公开课 / MOOC 信息爬虫，TypeScript + Node 20。

另有 **CAREER** 分组（志愿填报 / 职业规划主数据：教育部本科专业目录、职业分类大典 2022），见 [CAREER/README.md](CAREER/README.md)。
服务器上加载 CAREER 数据：`docker exec spiders npm run career:all`（迁移在 Web 服务启动时自动执行）。

## 目录结构

```
MOOC/
  schema.ts            # 统一字段定义（Course 类型 + 轻量运行时校验）
  ingest.ts            # 入库脚本：data/clean/*.json -> SQLite（data/courses.db）
  <school>/
    crawler.ts         # 爬虫：抓原始数据 -> data/raw/<school>.json
    clean.ts           # 清洗：raw -> 符合 schema 的 data/clean/<school>.json
  dataset.ts           # Web 查询页配置（表、搜索列、筛选项、列表列）
lib/                   # 共用工具：礼貌请求(robots.txt/限速/UA)、Coursera/edX 解析、文本清洗、分组发现
scripts/run-group.ts   # 按分组一键 crawl -> clean -> ingest
web/                   # Web 控制台（见下文）
  server/              # Hono API：爬虫发现、子进程运行、运行历史、SSE 日志、数据查询
  client/              # React + Vite 前端
  shared/types.ts      # 前后端共用类型
data/                  # 输出目录（已 gitignore）：raw/ clean/ courses.db web.db logs/
```

学校：`harvard` `yale` `princeton` `columbia` `upenn` `brown` `dartmouth` `cornell` `stanford` `mit`

## 数据来源

| 学校 | 来源 |
| --- | --- |
| harvard | Harvard 官方免费课目录 https://pll.harvard.edu/catalog/free （含详情页讲师/简介） |
| yale | Open Yale Courses https://oyc.yale.edu/courses + Coursera `partners/yale` |
| princeton | Coursera `partners/princeton` + edX `school/princetonx` |
| columbia | Coursera `partners/columbia` + edX `school/columbiax` |
| upenn | Coursera `partners/penn` + edX `school/pennx` |
| brown | edX `school/brownx`（Brown 不在 Coursera） |
| dartmouth | Coursera `partners/dartmouth` + edX `school/dartmouthx` |
| cornell | edX `school/cornellx`（eCornell 是付费证书项目，未收录） |
| stanford | Stanford Engineering Everywhere https://see.stanford.edu/Course（含详情页）+ Coursera `partners/stanford` + edX `school/stanfordonline`。online.stanford.edu 对非浏览器 UA 一律 403（含 robots.txt），我们不伪装 UA，暂未收录（TODO） |
| mit | MIT OpenCourseWare：MIT Learn 公开目录 API `api.learn.mit.edu/api/v1/courses/?platform=ocw`（learn.mit.edu / OCW 搜索用的同一接口）+ 同一 API 的 MITx（`offered_by=mitx`：MITx Online、Open Learning Library）。edX 的 `school/mitx` 现已重定向到 edX 首页，不再可用 |

- Coursera：robots.txt 禁止 `/api/`，所以不调 API，而是解析合作方页面和课程页 `/learn/<slug>` 里服务端渲染的 Apollo 数据。
- edX：解析学校页 Next.js RSC 数据里内嵌的课程记录（edX 只给讲师 slug，讲师名是由 slug 还原的）。
- 所有请求都会检查 robots.txt、带 UA、同一域名间隔 ≥1.5s（edX 按其 `Crawl-delay: 10`）。

## 使用

```bash
npm install
npm run all                     # MOOC 组全部学校全部 crawl + clean + 入库（= tsx scripts/run-group.ts MOOC）
npm run all -- yale brown       # 只跑部分学校
npm run all -- --no-details     # 跳过逐课详情页（快很多，但缺简介/讲师）

npm run crawl:yale              # 单独爬
npm run clean:yale              # 单独清洗
npm run ingest                  # 把 data/clean 下所有学校入库
npm run typecheck               # 后端 + 前端类型检查
```

环境变量：`SPIDERS_DB`（数据库路径，默认 `data/courses.db`）、`SPIDERS_DATA_DIR`、`SPIDERS_DELAY_MS`、`SPIDERS_UA`。

入库表 `courses`，主键 `id`（`<school>:<platform>:<sourceId>`），`(school, url)` 唯一；数组字段存 JSON 文本。
换数据库：在 `MOOC/ingest.ts` 里实现 `CourseStore` 接口（init / upsert / close），在 `openStore()` 返回即可。

## Web 控制台

```bash
npm run web:dev      # 开发：API http://127.0.0.1:8787 + 前端 http://127.0.0.1:5173（热更新，/api 代理到 8787）
npm run web:build    # 构建前端到 web/dist
npm run web:start    # 生产：单进程 http://127.0.0.1:8787（API + 静态页面）
```

- **爬虫管理**：自动扫描仓库顶层目录，凡是 `<分组>/<名字>/crawler.ts` 都算一个爬虫，按顶层目录分组（`MOOC` 是第一个分组，新增分组无需改代码）。
  每个爬虫可单独「爬取 / 清洗 / 入库 / 全流程」，可停止；分组可「全部运行（crawl→clean→ingest）」和「整组入库」；可勾选 `--no-details`。
- 每次运行都是子进程，运行历史（开始/结束时间、状态 running/success/failed/stopped、退出码、PID、从日志解析的抓取/清洗/入库条数）存在 `data/web.db`；
  stdout/stderr 按行带时间戳存为 `data/logs/<id>.jsonl`。运行详情页通过 SSE 实时推送日志，历史运行可回看、可下载纯文本日志。
- 同一爬虫（或同一分组的整组任务）同时只允许一个运行；服务重启时遗留的 running 记录会标记为 failed。
- **数据查询**：关键词、主题预设、学校、平台、难度、状态、是否免费筛选，分页，点击行看详情。
  - 关键词走 SQLite FTS5 全文索引（标题/简介/讲师/学科/标签），**整词匹配**、不区分大小写：`AI` 不会再命中 maintain / detail / Spain。
    多个词 = 同时包含；`"machine learning"` = 短语；`learn*` = 前缀（只有加 `*` 才做前缀）；`OR` = 或。
    全大写的短缩写（如 `AI`、`NLP`、`LLM`）额外要求原样大写出现。
  - 主题：MOOC 内置 `AI`（标题/简介/学科/标签任一提及 AI 相关词，如 artificial intelligence、machine learning、deep learning、neural network(s)、LLM、generative AI、ChatGPT、NLP、computer vision、reinforcement learning…；`AI` 只匹配大写整词）和 `AI 核心课`（只看标题/学科）。
  - 索引表 `courses_fts` 由 `npm run ingest` 重建；Web 服务发现索引缺失或过期（行数 / `ingested_at` 变化）时也会自动重建一次。
- **⚠️ 无鉴权**：默认只监听 `127.0.0.1`。可用 `HOST` / `PORT` 改，但不要直接暴露到公网（任何能访问的人都能启动/停止爬虫）。

### 分组约定（新增分组时）

| 文件 | 必需 | 作用 |
| --- | --- | --- |
| `<分组>/<名字>/crawler.ts` | ✓ | 爬虫，接受 `--flag` 参数 |
| `<分组>/<名字>/clean.ts` | | 清洗 |
| `<分组>/ingest.ts` | | 入库，参数为爬虫名（不传 = 全部） |
| `<分组>/dataset.ts` | | `export default defineDataset({...})`（见 `lib/dataset.ts`），配置数据库路径、表、全文索引列（`fts`）、主题预设（`topics`）、筛选项、列表列，查询页自动出现；也可以导出数组（每项带 `key`，数据集 id 为 `<分组>.<key>`） |
| `<分组>/migrate.ts` | | 导出 `migrate()`，Web 服务启动时自动调用（须幂等） |

关键词搜索：英文按整词（FTS5），含中文的词按子串匹配（中文没有词边界）。

日志里的条数按约定解析：`[x] 来源: N records`（抓取）、`clean: N`（清洗）、`upserted N`（入库）。

## 加一所学校 / 一个来源

1. 在 `MOOC/schema.ts` 的 `SCHOOLS` 里加 key；
2. 新建 `MOOC/<school>/crawler.ts`（用 `runSources` 写 raw）和 `clean.ts`（输出 `Course[]`，用 `writeClean` 校验去重）；
3. `package.json` 加 `crawl:<school>` / `clean:<school>`（Web 控制台会自动发现，无需改动）。
