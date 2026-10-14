# JOBS：公开招聘岗位 → 薪资统计（v1）

补上 **职业 → 岗位需求 → 薪资** 这一环：填 `career.db` 里的 `job_posting`、`job_posting_skill`、`salary_stat`（迁移 021）。

## 来源（只用公开、免登录的数据）

| 来源 | 结论 | 原因 |
|---|---|---|
| 中国石油大学（华东）智慧就业网 职位信息 `career.upc.edu.cn/career/zwxx` | **采用** | 站点匿名页面自己调用的公开检索接口，无登录、无验证码、无签名；每条职位有月薪区间、工作地、学历、完整 JD；约 5.8 万条 |
| 国聘 iguopin.com | 不用 | 职位检索接口 `/api/jobs/v3` 需要前端 HMAC 签名（Sign/T/Nonce 头），属于反爬签名，不绕过 |
| 应届生求职网 yingjiesheng.com | 不用 | 检索页有阿里云 WAF JS 挑战 |
| 国家大学生就业服务平台 ncss.cn | 不用 | 职位页对爬虫返回 403 |
| 上海公共招聘网 jobs.rsj.sh.gov.cn | 不用 | 纯 SPA，接口带 RSA 加密 |
| 智通直聘 job5156.com | 不用 | robots 允许，但目标城市的 IT 岗位列表几乎为空（以东莞制造业为主），且 robots 禁止带 `?` 的检索 URL |
| 齐鲁人才网 qlrc.com | 不用 | robots 对主流搜索引擎全站禁止，意图明显不欢迎抓取 |
| Boss直聘 / 猎聘 / 智联 / 拉勾 | 不用 | 登录墙 + 强反爬，按约定不碰 |

UPC 爬虫规则（不要放宽）：只发站点匿名 UI 同样的请求（`POST /career/zwxx/search/{page}/10`，表单 `dwmc=<关键词>`）；
返回“需要登录查看”(code 403) 的页只记录、跳过，不换方式重试；≥2 秒/请求，诚实 UA，检查 robots.txt；
只保存职位公开字段（不存联系邮箱/电话）；断点续爬（`data/raw/jobs/upc.json`）。

**偏差**：雇主面向石大学生招聘，山东（济南/青岛）和校招偏多，没有社招和工作年限；薪资是雇主自填的区间。
同一平台（易就业）还被很多高校使用，可以按同样方式加第二所学校做交叉。

## 流程

```
JOBS/upc/crawler.ts   关键词（occupations.ts，8 个试点职业）× 页 → data/raw/jobs/upc.json
JOBS/upc/clean.ts     薪资 → 元/月、城市、最低学历、渠道、去重键、职位名 → 职业 → data/clean/jobs-upc.json
JOBS/ingest.ts        upsert job_posting（每次按最新规则重新归职业）→ JD 技能 → salary_stat
JOBS/skills.ts        JD 技能：技能名 + skill_alias + seeds/jd_skill_terms.csv 词表匹配（无 LLM）；
                      LLM 兜底只在 --llm 且服务器配置了 LLM_* 时，对无命中的岗位调用
JOBS/stats.ts         薪资窗口内（默认最近 24 个月）职业 × 城市(9 个首批城市 + 全国) × 渠道 × 学历，按季度和整窗口两级的 P25/P50/P75；样本 < 30 只存数量
```

薪资口径（写在每行 `method_note`）：区间中点 ×（N 薪 / 12），年薪 ÷12；K=×1000、万=×10000；无单位 ≥100 视为元/月；
日薪/时薪、面议不计；同一 dedupe_key 只算一次；“全部”渠道不含实习。

## 运行

```bash
npm run jobs:all        # crawl → clean → ingest → 技能 → 统计（cron：每月 1 日 04:47）
npm run jobs:crawl -- --max-pages=10 --keywords=Java,算法 --budget=400
npm run jobs:ingest -- --llm      # 服务器上：无词表命中的岗位走 deepseek 兜底
npm run jobs:stats      # 只重算 salary_stat（JOBS_MIN_SAMPLE=5）
npm run test:jobs
```

## 专家口径（2026-10-14，迁移 022）

**归类**（`JOBS/occupations.ts` 的 `classifyPosting`，结果写 `job_posting.classify_reason`，按顺序判断）：
1. 多岗位合写（职位名按 、，；/ | 切开 ≥ 3 段，如「系统开发、测试、应用维护、网络与信息安全管理……」「职能类岗位（数据分析/数据管理/…）」）
   → 不归类，`multi_role = 1`，**不计入薪资统计**，技能匹配照常做。
2. 没写具体岗位（「××校园招聘」「××届招聘」「招聘岗位汇总」）→ 不归类（generic）。
3. 排除词：销售、教师、顾问、营销 → 不归类；「管培」且不带技术词（技术/研发/开发/软件/数据/工程…）→ 不归类。
4. 带「设计」但不带「工程」也不带软硬件词的（视觉设计、视觉设计师）→ 设计岗，不归类。
5. 「A | B」「A/B」两个备选 → 按第一个岗位归（「软件测试 | 硬件测试」→ 软件工程）。
6. 规则表：机器视觉工程师/视觉工程师 → 人工智能；网络安全员、「网络、信息安全管理」→ 信息安全；需求工程师、软件测试 → 软件工程；
   集成电路设计暂不归类（以后做半导体方向再加）。

**每次 ingest 都会对库里所有岗位按当前规则重新归类**（`reclassifyAll`），不只是本次清洗文件里的。改规则后在服务器上：

```bash
npm run jobs:reclassify     # 不读清洗文件：重新归类全部已存岗位 → 补打技能 → 重算 salary_stat
npm run jobs:ingest         # 同上，但先 upsert data/clean/jobs-upc.json
```

**薪资统计**（`salary_stat`，每次整表重算）：
- 只用最近 24 个月发布的岗位：从「运行日期 − 24 个月」所在季度的第一天起（2026-10-14 运行 → 2024-10-01，即 2024Q4 起）。
  `JOBS_SALARY_MONTHS=24` 改月数；`JOBS_SALARY_SINCE=2024-10-01` 固定起点。发布日期缺失时用抓取日期。
- 面议、日薪/时薪、多岗位合写、未归类的岗位不计入；转发的同一岗位（dedupe_key）只算一次。
- 样本 < 30（`JOBS_MIN_SAMPLE`）的格子保留一行，只存 `sample_size`，P25/P50/P75 为 NULL。
- 行的约定：`quarter = '2026Q3'` 是单季度；`quarter = '2024Q4-2026Q4'` 是整个窗口（城市、渠道、学历维度照旧）。
- **默认展示 = 窗口行 × 全国 × 全部渠道 = 职业 × 学历**，视图 `salary_overview`，后台「JOBS · 薪资（职业 × 学历）」页。按城市、季度的细分行留在表里，等数据源扩充后再展示。

**技能需求**：视图 `job_skill_demand`（后台「JOBS · 岗位技能需求」页），用全部年份的已归类岗位，每行带样本时间范围 `sample_from` / `sample_to`。
