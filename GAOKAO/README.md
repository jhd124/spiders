# GAOKAO — 高考投档 / 录取数据

## 山东 · 普通类常规批第 1 次志愿投档情况表

**Source:** provincial 投档情况表 only (山东省教育招生考试院), **not** school admissions sites.

**Input directory** (mirrors the server data mount):

| Env | Default |
|---|---|
| `GAOKAO_SD_TOUDANG_DIR` | `$SPIDERS_DATA_DIR/gaokao/sd-toudang/` |
| Server | `/opt/spiders/data/gaokao/sd-toudang/` |

Drop one file per year, with the year in the filename, e.g.:

- `2025年山东省普通类常规批第1次志愿投档情况表.xls`
- `2026-sd-putong-toudang.xlsx`

Accepted: `.xls` / `.xlsx` / `.csv`.

### Headers

| Years | Columns |
|---|---|
| 2022–2025 | 院校代号及名称, 专业代号及名称, 投档计划数, 最低位次 |
| 2026 | 院校代号及名称, 专业代号及名称, 选考科目要求, 最低位次 (**no** 投档计划数) |

Rows are stored **raw** keyed by 院校名 + 专业（类）名 (`school_name` + `major_name_raw`). **No MOE major-code mapping yet** — expert rules later.

### Pilot schools (filter helpers only; ingest loads all)

| 代号 | 学校 |
|---|---|
| A422 | 山东大学 |
| A425 | 中国石油大学(华东) |
| H213 | 哈尔滨工业大学(威海) |

### Commands

```bash
npm run career:migrate          # applies 035_gaokao_sd_toudang.sql
npm run gaokao:sd-toudang       # ingest all files in the input dir → career.db
npm run test:gaokao
```

### Bin (production)

1. Place provincial files in `/opt/spiders/data/gaokao/sd-toudang/` (year in filename).
2. In the spiders container: `npm run career:migrate && npm run gaokao:sd-toudang`.
3. Check: `SELECT year, school_code, count(*) FROM gaokao_toudang GROUP BY 1,2;`

一分一段表: already on the server; not ingested here.

## Special types (`special_type` + `is_ordinary=0`)

Matched on `major_name_raw` (and sheet/`admission_type` when needed), first hit wins:

| Label | Rule |
|---|---|
| 高校专项 | name or type contains `高校专项` |
| 非西藏生定藏就业 | name has `非西藏生` and (`定藏` or `定向西藏`) |
| 定向西藏 | name has `定向西藏` (and not the 非西藏生 form above) |
| 文物全科 | name contains `文物全科` |
| 中外合作 | name or type contains `中外合作` |
| 专项 / 艺术类… | non-普通类 sheet/type fallbacks |

Default student major-page counts use `is_ordinary = 1` only.

## Export majors for expert mapping

After ingest (all years 2022–2026 that are present):

```bash
npm run gaokao:export-pilot-majors
# → $SPIDERS_DATA_DIR/gaokao/pilot-majors-for-mapping.csv
npm run gaokao:export-pilot-majors -- --out /tmp/pilot-majors.csv
```

Columns: `院校代号,专业代号,专业名称原文,出现年份,是否已标特殊类型,特殊类型`  
One row per school_code + major_code_raw + major_name_raw; `出现年份` is a comma-separated list (e.g. `2024,2025,2026`).
