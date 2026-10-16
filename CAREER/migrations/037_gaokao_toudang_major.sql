-- 投档 row → MOE major_code(s). Only ordinary rows are mapped (is_ordinary=1). A row may link to several majors (category / 试验班).
CREATE TABLE IF NOT EXISTS gaokao_toudang_major (
  toudang_id    INTEGER NOT NULL REFERENCES gaokao_toudang(id) ON DELETE CASCADE,
  major_code    TEXT NOT NULL,                 -- MOE major.code
  match_type    TEXT NOT NULL CHECK (match_type IN ('exact', 'category')),
  rule_note     TEXT,                          -- from rules CSV note / pattern
  -- display hint: category/试验班 → 「按{major_name_raw}投档」
  via_label     TEXT,                          -- e.g. 按计算机类投档; NULL for exact single-major
  PRIMARY KEY (toudang_id, major_code)
);
CREATE INDEX IF NOT EXISTS gaokao_toudang_major_code ON gaokao_toudang_major(major_code);
