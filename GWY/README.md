# GWY — 公务员考试职位 (国考 first, 山东省考 pilot next)

Official sources only (GWY/sources.ts). Fetching uses lib/http (robots.txt, delays) with crawl logging; if a site is
unreachable or blocked, the crawler stops and says where to put the official file. Nothing is bypassed.

| step | command | input / output |
| --- | --- | --- |
| 研究生学科目录 | `npm run crawl:gwy-grad` | MOE PDF 研究生教育学科专业目录（2022年） → data/raw/gwy-grad_catalog.json |
| 国考职位表 | `npm run crawl:gwy-gk2027 [-- --file=path]` | `data/civil-service/gk2027_zhaokaojianzhang.zip` (招考简章.zip from http://bm.scs.gov.cn/kl2027 → 相关下载; zip, xlsx or xls) → data/civil-service/gk2027_positions.json |
| ingest | `npm run gwy:ingest` | career.db tables gwy_* (migration 030); data/civil-service/gk2027_unresolved_majors.csv, gk2027_match_stats.json |

In the container the data dir is /app/data, so the zip goes to /opt/spiders/data/civil-service/ on the host.

Matching (GWY/parse.ts), expert rulings 2026-10-16 — MOE catalogs only, for 国考 and 省考 alike:
1. The name decides. A printed code that disagrees with the catalog name (120401行政管理 → 120402) or is not in the
   catalog only sets `code_doubtful = 1`.
2. Segment = the printed 本科：/研究生： prefix, else the 学历 (硕士+ → 研究生). In the 本科 segment a 4-digit code/name is a
   专业类 and is expanded to all its majors (gwy_position_undergrad_major); in the 研究生 segment it is a 一级学科.
   Several codes with one name（0832、0972）食品科学与工程: every code whose catalog name agrees counts, the rest are flagged.
3. 本科 product counts use only 本科-segment matches of positions that do not need 硕士+. Positions needing 硕士及以上
   have `gwy_position.needs_grad = 1` (需读研后报考) and are reported separately in gk2027_match_stats.json.
`不限` → unlimited; 相关/相近/等专业 → related; no catalog name → unresolved; both go to the unresolved CSV for the expert.
Expert rules (GWY/rules/major_rules.csv, applied first, reviewed = 1) can map custom names such as 财会审计类 to code lists.
Empty / headerless sheets (e.g. an empty Sheet1) are ignored silently.

Expert rules part 2: rule rows carry `source` (专家规则). If a position's 备注 spells out what a phrase includes
(「财会审计类专业包括…」/「社会保障类（含…）」), that list replaces the rule (`remarks_override = 1`); a detected but
unparseable list makes the phrase unresolved (`remarks_override = 2`). Positions with any unresolved/related phrase get
`gwy_position.majors_incomplete = 1` and are left out of gwy_position_undergrad_major (major page counts);
gk2027_match_stats.json → undergrad.positions_incomplete / hires_incomplete backs the note 部分岗位的专业要求尚未归类.
