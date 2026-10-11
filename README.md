# spiders

藤校（常春藤盟校）公开课 / MOOC 信息爬虫，TypeScript + Node 20。

## 目录结构

```
MOOC/
  schema.ts            # 统一字段定义（Course 类型 + 轻量运行时校验）
  ingest.ts            # 入库脚本：data/clean/*.json -> SQLite（data/courses.db）
  <school>/
    crawler.ts         # 爬虫：抓原始数据 -> data/raw/<school>.json
    clean.ts           # 清洗：raw -> 符合 schema 的 data/clean/<school>.json
lib/                   # 共用工具：礼貌请求(robots.txt/限速/UA)、Coursera/edX 解析、文本清洗
scripts/run-all.ts     # 一键 crawl -> clean -> ingest
data/                  # 输出目录（已 gitignore）
```

学校：`harvard` `yale` `princeton` `columbia` `upenn` `brown` `dartmouth` `cornell`

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

- Coursera：robots.txt 禁止 `/api/`，所以不调 API，而是解析合作方页面和课程页 `/learn/<slug>` 里服务端渲染的 Apollo 数据。
- edX：解析学校页 Next.js RSC 数据里内嵌的课程记录（edX 只给讲师 slug，讲师名是由 slug 还原的）。
- 所有请求都会检查 robots.txt、带 UA、同一域名间隔 ≥1.5s（edX 按其 `Crawl-delay: 10`）。

## 使用

```bash
npm install
npm run all                     # 8 所学校全部 crawl + clean + 入库
npm run all -- yale brown       # 只跑部分学校
npm run all -- --no-details     # 跳过逐课详情页（快很多，但缺简介/讲师）

npm run crawl:yale              # 单独爬
npm run clean:yale              # 单独清洗
npm run ingest                  # 把 data/clean 下所有学校入库
npm run typecheck
```

环境变量：`SPIDERS_DB`（数据库路径，默认 `data/courses.db`）、`SPIDERS_DATA_DIR`、`SPIDERS_DELAY_MS`、`SPIDERS_UA`。

入库表 `courses`，主键 `id`（`<school>:<platform>:<sourceId>`），`(school, url)` 唯一；数组字段存 JSON 文本。
换数据库：在 `MOOC/ingest.ts` 里实现 `CourseStore` 接口（init / upsert / close），在 `openStore()` 返回即可。

## 加一所学校 / 一个来源

1. 在 `MOOC/schema.ts` 的 `SCHOOLS` 里加 key；
2. 新建 `MOOC/<school>/crawler.ts`（用 `runSources` 写 raw）和 `clean.ts`（输出 `Course[]`，用 `writeClean` 校验去重）；
3. `package.json` 加 `crawl:<school>` / `clean:<school>`。
