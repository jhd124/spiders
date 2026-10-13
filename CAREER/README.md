# CAREER：志愿填报 / 职业规划数据

思路是从就业市场倒推：**职业 → 技能 → 专业/课程 → 院校**。
里程碑 1 只做两张主表，数据要完整、准确、可溯源：**专业主表**（教育部本科专业目录）和 **职业主表**（职业分类大典 2022）。其余表目前只建了结构，还没有数据。

## 目录结构

```
CAREER/
  migrations/001_init.sql              # 全部表结构（版本化迁移）
  migrations/002_seed_skill_domains.sql# 一级能力域种子（草案，待专家审核）
  migrate.ts                           # 迁移执行器（schema_migrations 表记录已执行的版本）
  db.ts                                # 数据库路径：$SPIDERS_DATA_DIR/career.db（默认 data/career.db）
  sources.ts                           # 官方文件清单（规范 URL、实际下载 URL、公告页）
  fetchdoc.ts                          # 下载器：遵守 robots.txt、限速、诚实 UA；PDF 存到 data/raw/career/
  moe_majors/crawler.ts + clean.ts     # 本科专业目录（2026 最新版 + 2025 版，用于对比差异）
  occupations/crawler.ts + clean.ts    # 职业分类大典 2022 分类体系表
  ingest.ts                            # 迁移 → upsert → 种子 → 重建 FTS
  dataset.ts                           # Web 控制台里的三个数据集：专业 / 专业类 / 职业
  seeds/pilot_majors.csv               # 25 个试点专业（专家决定）
  seeds/schools_pilot.csv              # 50 所试点院校（专家名单 2026-10-12）
```

## 运行

```bash
npm run career:all          # crawl + clean 两个爬虫，然后 ingest（等同 tsx scripts/run-group.ts CAREER）
npm run career:migrate      # 只执行迁移（幂等；Web 服务启动时也会自动执行）
npm run career:ingest       # 只入库（会先执行迁移）
# 在 Web 控制台「爬虫管理」→ CAREER 里也能跑；数据在「数据查询」→ CAREER · 本科专业目录 / 专业类 / 职业分类大典 2022
```

如果服务器连不上下载地址，可以手动下载官方 PDF，再把本地文件传给爬虫：
`npm run crawl:career-majors -- --file=moe-major-catalog-2026=/path/x.pdf`（职业表的参数是 `--file=osta-occupation-2022-table=...`）。
下载失败时，爬虫会复用 `data/raw/career/` 里已缓存的 PDF。

## 数据库与可移植性

- 目前用 SQLite：`data/career.db`，路径跟随 `SPIDERS_DATA_DIR`，服务器上是 `/opt/spiders/data/career.db`。
- 迁移 SQL 按 PostgreSQL 可移植的写法：
  - 只用 TEXT、INTEGER、REAL 三种类型；
  - 布尔值存成 0/1，并加 CHECK 约束；
  - 时间用 ISO-8601 文本；
  - 不用 AUTOINCREMENT，也不用 SQLite 专有语法；
  - upsert 用的是 PG 同样支持的 `INSERT … ON CONFLICT (…) DO UPDATE`。
- 迁移到 PG 时，只需要换掉 `migrate.ts` 和 `ingest.ts` 里的驱动；FTS5 部分换成 PG 全文检索或 pg_trgm。
- 已执行的迁移不要再改：`schema_migrations` 存了校验和，改动后会告警。需要改结构就新增 `003_xxx.sql`。
- 每张数据表都带溯源字段：
  - `source_url`、`source_doc_id`（关联 `source_document`，表里记录 sha256、实际下载地址和是否官方）；
  - `source_page`、`fetched_at`；
  - `extraction_method`（pdf_parse / llm / manual / expert）；
  - `confidence`、`reviewed`。

## 数据模型

```mermaid
erDiagram
  source_document ||--o{ major : "来源"
  source_document ||--o{ occupation : "来源"
  major_category ||--o{ major_class : "门类-专业类"
  major_category ||--o{ major : ""
  major_class ||--o{ major : "专业类-专业"
  major ||--o| pilot_major : "试点"
  occupation ||--o{ occupation : "parent_code (大类>中类>小类>细类)"
  skill_domain ||--o{ skill : "primary_domain_id（必填）/ secondary_domain_id（可选，≠主）"
  skill ||--o{ skill_alias : "别名"
  school ||--o{ course : ""
  school ||--o{ major_course : "培养方案"
  major ||--o{ major_course : ""
  course ||--o{ major_course : ""
  course ||--o{ course_skill : ""
  skill ||--o{ course_skill : ""
  major ||--o{ major_skill : ""
  skill ||--o{ major_skill : ""
  occupation ||--o{ occupation_skill : ""
  skill ||--o{ occupation_skill : ""
  occupation ||--o{ job_posting : "归一化细类"
  occupation ||--o{ salary_stat : "季度"
  school ||--o{ employment_report : "年度"
  major ||--o{ employment_report : ""
  school ||--o{ admission_rank : "年度投档"
  major ||--o{ admission_rank : "按专业"
  major_class ||--o{ admission_rank : "按专业类"

  major {
    TEXT code PK "如 080904K（原样）"
    TEXT base_code
    TEXT name
    TEXT category_code FK
    TEXT class_code FK "交叉学科(14)无专业类=NULL"
    INT is_special "T"
    INT is_controlled "K"
    INT is_engineering "学位授予门类含工学"
    TEXT degree_categories "学位授予门类"
    TEXT former_code "原专业代码"
    TEXT duration_years "NULL"
    INT added_year "NULL"
    INT first_catalog_edition
    TEXT status "在目录/已移出目录"
  }
  occupation {
    TEXT code PK "2-02-10-01"
    INT level "1-4"
    TEXT name
    TEXT parent_code FK
    TEXT gbm_code
    INT is_digital "S"
    INT is_green "L"
    TEXT name_source "mirror:cccac / 公示稿 / official"
    TEXT digital_flag_source
    TEXT green_flag_source
    TEXT source_batch "大典2022 / 新职业批次"
  }
  employment_report {
    TEXT school_id FK
    INT year
    TEXT college "所属学院"
    TEXT major_code FK
    TEXT stat_scope "统计口径"
    REAL employment_rate
    TEXT report_pdf_url
  }
  admission_rank {
    TEXT province "山东→浙江"
    INT year
    TEXT school_id FK
    TEXT major_code FK
    TEXT major_class_code FK
    INT min_score
    INT min_rank
  }
```

## 数据来源与现状（2026-10-12）

| 表 | 来源 | 行数 | 说明 |
|---|---|---|---|
| major / major_class / major_category | 教育部《普通高等学校本科专业目录（2026年）》（教高函〔2026〕2号附件），[公告](http://www.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/t20260427_1434931.html)，[PDF](http://www.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/W020260427440749576927.pdf)；另加 2025 年版（教高函〔2025〕3号附件2），只用来对比差异 | 13 门类、92 专业类、**883 专业（在目录）**；**工科 329 个**（按学位授予门类含工学判定，003 迁移起；按门类 08 统计为 293 个）；另有 11 个"已移出目录"的专业和 1 个已移出的专业类（0832 交叉工程类），都是 2026 年整体迁到 14 交叉学科的，新代码的 `former_code` 指向原代码 | 与教育部公告的"13 个门类、92 个专业类、883 种专业"一致。2025 年版解析结果是 12/93/845，也与官方一致。PDF 实际从教育部官方镜像 `hudong.moe.gov.cn` 通过 https 下载（box 没有 80 端口出网），`source_url` 记录的是 moe.gov.cn 的规范地址 |
| pilot_major | 专家决定（25 个） | 25 | 代码和名称逐一与 2026 年目录核对，**全部一致** |
| occupation | 《中华人民共和国职业分类大典（2022年版）》分类体系表 | 大类 8、中类 79、小类 450、**细类 1639**；数字职业 S 97 个、绿色职业 L 134 个，其中 L/S 23 个 | 1639 个细类、S 97、L 134、L/S 23 都与人社部正式颁布时公布的数字一致（公示稿是 1636 个细类、L 133 个）。人社部官网的公告页和附件放在 JS 反爬挑战（EdgeOne）后面，我们**不绕过**，所以表格 PDF 取自公开镜像（cccac.org.cn 链接的 aliyuncs OSS 文件）。这些行 `source_document.is_official=0`，`confidence=0.9`，`reviewed=0`，需要人工对照官方附件后再标记为已审核。另外用 1.3 万行公示稿正文做了独立交叉校验：1585/1639 个细类名称完全一致，其余是正式版改名、重新编号或公示稿里的长名被截断 |
| school | 专家名单（2026-10-12） | 50 | 只有名称和分层（省内 15 / 省外头部 10 / 省外中上 15 / 省外行业特色校 10）；学校标识码和省份待补 |
| skill_domain | 专家修订版（003 迁移，source='expert 2026-10-12'，reviewed=1） | 20 | 二级技能刻意留空 |
| occupation_draft_2022 | 公示稿正文（m12333.cn 镜像）经 `CAREER/tools/draft_2022.py` 提取，提交为 `seeds/occupation_draft_2022.csv` | 1635 | 用于按专家决定以公示稿补 S/L 标注；名称差异见 `review/occupation_name_diff.csv`（54 行，未审核） |
| 其他表 | — | 0 | 只有结构 |

### 已知缺口

- **修业年限**：目录"说明"第五条写明"基本修业年限为四至五年……专业目录不再单独列出"，所以 `duration_years` 为 NULL。
- **增设年份**：最新版目录不标注增设年份。目前只能通过版本对比得到 `first_catalog_edition`：2026 年新列入的 38 个专业加上 11 个迁移专业，共 49 个代码标为 2026，其余标为 2025，意思是"至少 2025 年就已存在"。`added_year` 要等以后解析教育部历年《本科专业备案和审批结果》，在那之前保持 NULL。
- **"已撤销"状态**：目录只列现有专业。本次新增的 `已移出目录` 只覆盖"2025 年版有、2026 年版没有"的代码，全部是迁到交叉学科的；专业设置调整的历史还没有导入。
- **职业来源的官方性**：见上表。如果能拿到人社部官网附件（比如在国内服务器上或手工下载），用 `--file=osta-occupation-2022-table=…` 重跑即可，sha256 会写进 `source_document`。
- **2022 年后的新职业**（人社部分批发布，`source_batch` 字段已预留）：发布页面同样在 mohrss.gov.cn 的反爬挑战后面，**本次未导入**。
- 小类解析出 450 个，正式颁布的公告只给出细类、S、L 的数量，没有核对小类数量的官方数字（公示稿是 449 个）。其中"X-XX-99 其他……"这类小类按惯例没有细类。

### S/L 标注与名称溯源（003）

- 入库后会用公示稿的 S/L 标注补全缺失的标记（按专家决定以公示稿为准）。匹配方式：先按同名匹配，找不到时再按"同代码 + 名称前缀"匹配，1622/1639 能匹配上。目前**补入 0 个**：两份来源在共有职业上的标注完全一致。
- `digital_flag_source` / `green_flag_source` 的取值：`mirror:cccac`（只有镜像体系表有标注）、`公示稿`（由公示稿补入）、`mirror:cccac+公示稿`（两者一致）。
- 绿色职业数 133 和 134 的差别来自 2-02-27-07 碳管理工程技术人员：它是正式版新增的职业，公示稿里没有，标注为 L。
- `name_source` 目前都是 `mirror:cccac`；以后用官方文件重跑时会写成 `official`。

### 专家审核结论（004，2026-10-12）

- **职业主表已审核**：所有 occupation 行 `reviewed=1`，`reviewer_note='expert 2026-10-12'`。镜像文件的 `source_document.is_official` 仍为 0，但专家判断 cccac 镜像与正式印刷版（2022 年版）一致。审核只对当前这个文件有效：如果镜像文件内容变了（sha256 不一致），ingest 会把所有行重新标为 `reviewed=0`。
- **名称差异**：`review/occupation_name_diff.csv` 已加上 `decision`、`alias_added`、`decided_by` 三列，状态为已决。
  - 15 处真实差异一律采用导入的名称，`name_source='official-2022 (via mirror:cccac, expert-verified)'`；其余 39 行只是 PDF 换行造成的，不需要改。
  - 8 个改名职业的公示稿旧名存入 `occupation_alias`（`alias_type='公示稿旧称'`），控制台的职业搜索也会匹配别名，例如搜"民办非企业单位负责人"能找到 1-04-03-00。
  - 3 个代码顺延的职业（2-05-07-13、2-07-08-00、4-07-03-07）不加别名，因为它们的旧名现在属于下一个代码，已核对一致。
- **工科**：仍按"学位授予门类含工学"判定，共 329 个。新增 `engineering_degree_type` 字段，取值 `only`（只授工学，291 个）或 `optional`（可授工学，同时可授其他门类，38 个）。新增 `degree_display` 字段用于控制台显示，例如工程管理显示为"可授工学/管理学"。
- **一级能力域**：保持 20 个，不合并。

## 培养方案 → 专业核心课（005，curriculum/）

流程：`seeds/curriculum_sources.csv`（专家填链接）→ `curriculum/crawler.ts`（礼貌抓取：robots.txt、按域名间隔 `SPIDERS_DELAY_MS`、真实 UA；原件存 `data/raw/career/curriculum/<id>.<ext>`，sha256 记入 `source_document`）→ 文本抽取（PDF: unpdf 按页、表格单元格用 ` | ` 分隔；HTML: cheerio；DOCX: mammoth；旧版 .doc 不支持，请要 PDF/DOCX）→ `curriculum/clean.ts`（LLM 抽取）→ `career:ingest`（写 `course` / `major_course`，`extraction_method='llm'`、model、confidence、页码、原文片段、`reviewed=0`、`review_status='pending'`）→ 控制台 **课程审核**（`#/review`）逐条 通过/驳回/修改，记录审核人和时间。

- 格式只按文件头识别（PDF 以 `%PDF-` 开头，DOCX 以 zip 的 `PK` 开头），不看服务器的 Content-Type（很多下载接口返回 `application/octet-stream`）；文件头不符（登录页、反爬页）直接报错。
- 从清单删掉的行不当历史保留：`crawl` 会删掉它缓存的原件，`career:ingest` 会删掉对应的 `curriculum_source`、分段记录和待审核（pending）的 `major_course`；已审核过的行保留但去掉来源关联，并打警告。

清单列：`school,major_code,grade_year,url,format,verified_by,notes`（format = pdf|html|docx|doc；major_code 为单个代码、`080901|080902` 列表，或 `*`（全校/学院汇编：按「××专业培养方案（代码）」标题切分，抽取其中的试点专业；菁英班/实验班等班级变体只记录在 `curriculum_source_major` 与 `sections_note`，不映射新专业代码；非试点专业只记录）；每个 url 只能出现一行，文件只下载一次（sha256），之后复用，`crawl:career-curriculum -- --refresh` 才重新下载；major_code 必须在 major 表；学校按校名对应 `school`，没有则自动新建 `name:<校名>`）。只收 专业核心课/主干课，不收选修。

环境变量（服务器上写入容器 env；不配置则为 mock 模式）：

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` | OpenAI 兼容地址，如 `https://api.deepseek.com/v1`、`https://dashscope.aliyuncs.com/compatible-mode/v1`、`https://api.openai.com/v1` |
| `LLM_API_KEY` | 密钥 |
| `LLM_MODEL` | 如 `deepseek-chat`、`qwen-plus`、`gpt-4o-mini` |
| `LLM_JSON_MODE` | 默认开启 `response_format=json_object`；不支持的服务设 `0` |
| `LLM_CHUNK_CHARS` | 每块最大字符数，默认 6000 |
| `LLM_MAX_CALLS` | 每次 clean 最多付费调用次数，默认 200（也可 `-- --max-calls=N`） |
| `LLM_TIMEOUT_MS` | 默认 120000 |
| `LLM_MOCK=1` | 强制 mock |
| `CURRICULUM_MANIFEST` | 替换清单路径（测试用） |

命令：

```bash
npm run career:curriculum:try -- --url='<链接>' --format=pdf --school=山东大学 --major=080901   # 单个链接试跑，不写库 -> data/tmp/curriculum-try.json
docker exec spiders npx tsx scripts/run-group.ts CAREER curriculum                            # 只跑培养方案：抓取 -> 抽取 -> 入库
docker exec spiders npm run career:all                                                        # 全部（清单为空时课程这一步 0 条）
npm run test:career                                                                           # 离线测试（无需 key）
```

防编造：mock（未配置 LLM）结果带 `mock:true`，ingest 跳过，绝不入库；模型返回的每门课都必须给出原文片段，片段须在该块原文中逐字出现（忽略空白和 ` | `）且包含课程名，否则丢弃；JSON 按 schema 严格校验；同名课程合并，保留置信度高者。已审核（approved/rejected/edited）的行重跑不会被覆盖；文档 sha256 变了而未重新抽取时不入库。

成本控制：只把含 核心课/主干课/课程设置/学位课/教学计划 等关键词的块发给模型；按 sha256(model+提示词版本+块) 缓存在 `llm_cache`，重跑不重复付费（改模型或 `PROMPT_VERSION` 才会重新调用）；temperature 0；`LLM_MAX_CALLS` 硬上限；日志打印每份文档的块数、调用数、token 数。实测山大 080901（16 页）≈ 3 块、约 9k 输入 token/份；25 专业 × 4 校 ≈ 100 份 ≈ 100 万输入 token。

就业/教学质量报告（006，仅表结构）：`employment_report.report_type` = 就业质量报告 | 本科教学质量报告，新增 graduation_rate（本科毕业率）、placement_rate（去向落实率）、degree_rate、report_source_id（升学率 further_study_rate、出国率 abroad_rate 已有）；链接清单 `seeds/report_sources.csv`（school,report_type,year,url,format,verified_by,notes），ingest 时同步到 `report_source`，暂不抽取。

第二阶段（课程 → 技能）：`curriculum/skills.ts` 的 `SkillTagger` 接口，目前为 `NoopSkillTagger`（二级技能未定义）。

## 课程 → 二级技能打标签（007，curriculum/skills.ts + tag.ts）

- 迁移 007 写入专家给的第一批二级技能：6 个计算机相关一级域共 36 个（id 形如 `software.dsa`）。名称按专家原文，reviewed=1；`skill_type`（专业知识/工具与技术）是开发先填的，等专家确认。
- `npm run career:tag-skills`：每个「学校×专业」调用一次大模型，给每门课挂 1–3 个技能，只能从清单里选（清单外的 id 直接丢掉）。核心课要求至少挂 1 个，但对不上的课不硬挂，写进 `course_skill_untagged` 并附原因，交给专家决定是否补技能。
- 写入 `course_skill`（extraction_method='llm'，source='llm:<model>'，附一句 rationale，reviewed=0）；已审核的行不会被覆盖。结果按 sha256(模型+prompt 版本+输入) 缓存在 llm_cache，重跑不重复花 token；mock 模式什么都不写。
- `career:all` 跑完 ingest 后会自动执行 `CAREER/post_ingest.ts`，也就是打标签这一步（见 scripts/run-group.ts）。

## 定时任务（deploy/cron/spiders-career）

- 每月 1 日 03:17（Asia/Shanghai，`CRON_TZ`）在服务器上跑 `docker exec spiders npm run career:all`，用 `flock -n /tmp/spiders-career.lock` 防止和手动运行重叠，日志写到 `/var/log/spiders-career.log`。
- 每次部署时 `deploy/deploy.sh` 都会把这个文件装到 `/etc/cron.d/spiders-career`，内容没变就跳过。改时间只需改仓库里的这个文件。

## 专家决策（取代原来的开放问题）

1. **省份**：先做山东（专业(类)+院校模式，最多 96 个志愿，每个志愿对应一个专业(类)；山东省教育招生考试院每年公布一分一段表和投档线），再做浙江。`admission_rank` 粒度是"院校 × 专业(类) × 年 × 省"，字段包括最低分和最低位次；按专业类招生时填 `major_class_code`。
2. **试点 25 个专业**：080901 080902 080903 080904K 080910T 080701 080702 080703 080704 080717T 080601 080801 080803T 080202 080204 080207 080216T 080501 080503T 080401 081001 081301 082502 081801 082001。存放在 `pilot_major` 表（Web 控制台里的主题"试点专业(25)"），已核对，无差异。
3. **技能体系分两级**（每个技能有且只有一个主能力域，可选一个次能力域）。一级能力域已由专家修订并确认（2026-10-12，共 20 个，不合并）：工程基础、软件开发、数据分析、人工智能、网络与信息安全、电路与硬件、集成电路与微电子、通信技术、自动化与控制、电气工程、能源与动力、机械设计、车辆工程、航空航天、材料、化工与环境、土木与交通、测试与质量、产品与项目管理、通用职业能力。其他规则：
   - 一级是能力域（15～20 个）；
   - 二级是 JD 粒度的具体技能（目标 300～500 个，不区分版本）；
   - 每个技能有类型：专业知识 / 工具与技术 / 通用能力；
   - 别名单独建 `skill_alias` 表；
   - 现在只给出一级种子草案，二级暂不列。
4. **招聘数据源**（后续里程碑）：
   - 社招先做智联招聘、前程无忧，BOSS 直聘和猎聘反爬较强，放到以后；
   - 校招做应届生求职网、实习僧、国聘；
   - 合规要求：只采集公开的岗位信息，不采集个人信息，限速，只存结构化字段和用于统计的 JD 文本。
5. **就业质量报告**：
   - 覆盖约 50 所山东考生常报的院校，名单已放在 `seeds/schools_pilot.csv`，报告链接以后由专家提供；
   - `employment_report` 按"校 × 年（× 学院 / 专业，如果报告里有）"存储，带 `stat_scope`（统计口径：按学院还是按专业、就业率是否含升学、统计截止日期）、`college`（所属学院）和来源 PDF 地址。

## 路线图

1. ✅ 里程碑 1：两张主表 + 全部表结构 + 试点种子。
2. 职业主表补全：
   - 用官方附件复核（把 `reviewed` 标为 1）；
   - 导入 2022 年后人社部各批新职业（`source_batch`）；
   - 导入历年《本科专业备案和审批结果》，补 `added_year` 和撤销记录。
3. 培养方案：抽取试点 25 个专业 × 试点院校的课程（LLM 抽取 + 人工抽检，`extraction_method='llm'`、`reviewed`），建立 `major_course` 和 `course_skill`。
4. 二级技能表（300～500 个）和别名：从 JD 统计中提取候选，再由专家审定。
5. 招聘数据采集（智联、前程无忧 → 应届生、实习僧、国聘），归一化到细类，生成 `occupation_skill` 和季度 `salary_stat`。
6. 50 所院校的就业质量报告（PDF 解析或 LLM，带统计口径）。
7. 山东投档线和一分一段表（`admission_rank`），之后做浙江。

## 还需要确认的问题

