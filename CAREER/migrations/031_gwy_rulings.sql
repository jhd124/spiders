-- GWY expert rulings 2026-10-16: name wins over code (code_doubtful), segment-aware codes, 本科 product counts only
-- from 本科-segment matches, positions needing 硕士+ kept apart (需读研后报考).
ALTER TABLE gwy_position_major ADD COLUMN segment TEXT NOT NULL DEFAULT 'any' CHECK (segment IN ('any', 'undergrad', 'grad'));
ALTER TABLE gwy_position_major ADD COLUMN code_doubtful INTEGER NOT NULL DEFAULT 0 CHECK (code_doubtful IN (0, 1));
ALTER TABLE gwy_position ADD COLUMN needs_grad INTEGER NOT NULL DEFAULT 0 CHECK (needs_grad IN (0, 1)); -- 1 = 需读研后报考
-- 本科 majors each position admits (专业类/门类 expanded). Only positions with needs_grad = 0; the basis for 本科 product counts.
CREATE TABLE IF NOT EXISTS gwy_position_undergrad_major (
  notice_id     TEXT NOT NULL,
  dept_code     TEXT NOT NULL,
  position_code TEXT NOT NULL,
  major_code    TEXT NOT NULL,                 -- major.code
  via_seq       INTEGER NOT NULL,              -- first gwy_position_major.seq that admitted it
  PRIMARY KEY (notice_id, dept_code, position_code, major_code)
);
CREATE INDEX IF NOT EXISTS gwy_position_undergrad_major_code ON gwy_position_undergrad_major(major_code);
