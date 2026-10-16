-- GWY expert review 2026-10-16 (part 4): an unmatched 不含/除外 item makes the phrase unresolved (排除项未对上),
-- and standalone 「以上…均不含特设专业」 phrases act as modifiers. Both columns are rebuilt by every ingest.
ALTER TABLE gwy_position_major DROP COLUMN exclusions_partial;
ALTER TABLE gwy_position_major DROP COLUMN via;
-- 0 none; 1 expert-rule / listed sub-item not found, ignored (排除项未全部对上); 2 exclusion not matched → unresolved (排除项未对上)
ALTER TABLE gwy_position_major ADD COLUMN exclusions_partial INTEGER NOT NULL DEFAULT 0 CHECK (exclusions_partial IN (0, 1, 2));
ALTER TABLE gwy_position_major ADD COLUMN via TEXT CHECK (via IN ('rule', 'legacy', 'catalog', 'remarks', 'modifier'));
