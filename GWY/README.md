# GWY — 公务员考试职位 (国考 first, 山东省考 pilot next)

Official sources only (GWY/sources.ts). Fetching uses lib/http (robots.txt, delays) with crawl logging; if a site is
unreachable or blocked, the crawler stops and says where to put the official file. Nothing is bypassed.

| step | command | input / output |
| --- | --- | --- |
| 研究生学科目录 | `npm run crawl:gwy-grad` | MOE PDF 研究生教育学科专业目录（2022年） → data/raw/gwy-grad_catalog.json |
| 国考职位表 | `npm run crawl:gwy-gk2027 [-- --file=path]` | `data/civil-service/gk2027_zhaokaojianzhang.zip` (招考简章.zip from http://bm.scs.gov.cn/kl2027 → 相关下载; zip, xlsx or xls) → data/civil-service/gk2027_positions.json |
| ingest | `npm run gwy:ingest` | career.db tables gwy_* (migration 030); data/civil-service/gk2027_unresolved_majors.csv, gk2027_match_stats.json |

In the container the data dir is /app/data, so the zip goes to /opt/spiders/data/civil-service/ on the host.

Matching (GWY/parse.ts) never guesses. A 专业 item is `exact`/`category` only when its code and name agree with
the 本科 catalog (major / major_class / major_category, from CAREER) or the 研究生 catalog (gwy_grad_discipline);
a name without a code must equal a catalog name. `不限` → unlimited; 相关/相近/等专业 → related; everything else
(including codes whose printed name differs from the catalog) → unresolved. The expert rules in
GWY/rules/major_rules.csv are applied first and mark matches reviewed=1; fill them from the unresolved CSV.
