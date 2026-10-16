-- GWY: rule provenance, 备注 overrides, incomplete-major positions (expert rulings 2026-10-16, part 2).
ALTER TABLE gwy_major_rule ADD COLUMN source TEXT;          -- e.g. 专家规则
-- 0 = none; 1 = the position's 备注 lists the majors included in this phrase and they replaced the rule/catalog match;
-- 2 = such a list was detected in 备注 but could not be parsed → unresolved
ALTER TABLE gwy_position_major ADD COLUMN remarks_override INTEGER NOT NULL DEFAULT 0 CHECK (remarks_override IN (0, 1, 2));
-- 1 = at least one 专业 phrase is unresolved/related: the position is left out of major page counts
-- (gwy_position_undergrad_major) and the page says 部分岗位的专业要求尚未归类
ALTER TABLE gwy_position ADD COLUMN majors_incomplete INTEGER NOT NULL DEFAULT 0 CHECK (majors_incomplete IN (0, 1));
