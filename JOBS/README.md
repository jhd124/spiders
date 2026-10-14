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
JOBS/stats.ts         季度 × 职业 × 城市(9 个首批城市 + 全国) × 渠道 × 学历 的 P25/P50/P75，样本 < 5 不出数
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
