-- GWY expert rulings on the top-50 list (2026-10-16, part 3)
ALTER TABLE gwy_major_rule ADD COLUMN context TEXT;        -- rule applies only when this phrase is listed alongside (统计 with 数学)
ALTER TABLE gwy_position_major ADD COLUMN exclusions_partial INTEGER NOT NULL DEFAULT 0 CHECK (exclusions_partial IN (0, 1)); -- 排除项未全部对上
ALTER TABLE gwy_position_major ADD COLUMN via TEXT CHECK (via IN ('rule', 'legacy', 'catalog', 'remarks'));
-- old 研究生 二级学科 / 专业领域 names → 2022 parents, loaded from GWY/rules/grad_legacy_map.csv on every ingest
CREATE TABLE IF NOT EXISTS gwy_grad_legacy (
  old_name      TEXT PRIMARY KEY,
  old_code      TEXT,
  parent_codes  TEXT NOT NULL,                 -- '|'-separated 2022 codes
  source        TEXT NOT NULL,
  note          TEXT,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);
-- gwy_position.majors_incomplete now means 部分专业要求未归类: the position still counts for its matched majors;
-- only positions with no matched major at all are absent from gwy_position_undergrad_major.
