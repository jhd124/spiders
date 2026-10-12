-- CAREER 004 (2026-10-12, expert decisions):
--  (a) occupation_alias: 公示稿 old names of the 8 renamed 细类 (searchable in the console via occupation.aliases)
--      The 3 shifted codes (2-05-07-13, 2-07-08-00, 4-07-03-07) get NO alias: their old 公示稿 names belong to the
--      next code (2-05-07-14 心理治疗技师, 2-07-09-00 法律顾问, 4-07-03-08 招聘师 — verified against the imported data).
--  (b) the 15 real name differences use the imported (final-edition) names -> name_source 'official-2022 (via mirror:cccac, expert-verified)'
--  (c) occupation reviewed = 1, reviewer_note 'expert 2026-10-12' (is_official of the mirror document stays 0; the expert
--      judged the cccac copy to follow the final printed edition). ingest keeps this as long as the mirror file is unchanged (sha256).
--  (d) major.engineering_degree_type: 'only' (只授工学) | 'optional' (可授工学 among others) | NULL; degree_display for the console

CREATE TABLE occupation_alias (
  occupation_code TEXT NOT NULL REFERENCES occupation(code),
  alias           TEXT NOT NULL,
  alias_type      TEXT NOT NULL,             -- '公示稿旧称', later e.g. '常用名' / 'JD title'
  source          TEXT NOT NULL,
  PRIMARY KEY (occupation_code, alias)
);
CREATE INDEX occupation_alias_alias_idx ON occupation_alias(alias);

ALTER TABLE occupation ADD COLUMN aliases TEXT;          -- denormalized '|'-joined occupation_alias.alias (for search)
ALTER TABLE occupation ADD COLUMN reviewer_note TEXT;

INSERT INTO occupation_alias (occupation_code, alias, alias_type, source) VALUES
  ('1-04-03-00', '民办非企业单位负责人', '公示稿旧称', '公示稿 2022-07 (expert 2026-10-12)'),
  ('2-05-04-00', '民族医医师', '公示稿旧称', '公示稿 2022-07 (expert 2026-10-12)'),
  ('2-06-05-00', '税务专业人员', '公示稿旧称', '公示稿 2022-07 (expert 2026-10-12)'),
  ('2-06-12-05', '版权专业人员', '公示稿旧称', '公示稿 2022-07 (expert 2026-10-12)'),
  ('3-01-04-01', '村和社区工作者', '公示稿旧称', '公示稿 2022-07 (expert 2026-10-12)'),
  ('4-02-02-06', '路况信息监控员', '公示稿旧称', '公示稿 2022-07 (expert 2026-10-12)'),
  ('4-07-03-06', '劳务外包管理员', '公示稿旧称', '公示稿 2022-07 (expert 2026-10-12)'),
  ('6-02-01-01', '糕点面包烘焙工', '公示稿旧称', '公示稿 2022-07 (expert 2026-10-12)')
ON CONFLICT (occupation_code, alias) DO NOTHING;
UPDATE occupation SET aliases = (SELECT GROUP_CONCAT(a.alias, '|') FROM occupation_alias a WHERE a.occupation_code = occupation.code);

UPDATE occupation SET name_source = 'official-2022 (via mirror:cccac, expert-verified)'
  WHERE code IN ('1-04-03-00','2-02-27-07','2-05-04-00','2-05-07-13','2-06-01-03','2-06-05-00','2-06-12-05','2-06-12-09','2-07-08-00','3-01-04-01','4-02-02-06','4-07-03-06','4-07-03-07','6-02-01-01','6-02-05-08');
UPDATE occupation SET reviewed = 1, reviewer_note = 'expert 2026-10-12';

ALTER TABLE major ADD COLUMN engineering_degree_type TEXT CHECK (engineering_degree_type IN ('only', 'optional'));
ALTER TABLE major ADD COLUMN degree_display TEXT;
UPDATE major SET engineering_degree_type = CASE
    WHEN degree_categories = '工学' THEN 'only'
    WHEN ('|' || degree_categories || '|') LIKE '%|工学|%' THEN 'optional'
    ELSE NULL END;
UPDATE major SET degree_display = CASE
    WHEN degree_categories = '工学' THEN '只授工学'
    WHEN engineering_degree_type = 'optional'
      THEN '可授工学/' || TRIM(REPLACE(REPLACE('|' || degree_categories || '|', '|工学|', '|'), '|', '/'), '/')
    WHEN degree_categories LIKE '%|%' THEN '可授' || REPLACE(degree_categories, '|', '/')
    ELSE '授' || degree_categories END;
