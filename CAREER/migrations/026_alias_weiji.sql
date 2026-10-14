-- CAREER 026 (2026-10-14), expert: alias 微机原理与接口技术 replaced by the shorter 微机原理 (seeds/skill_aliases.csv).
--  The seed is insert-only, so drop the superseded row here (not tombstoned: it is replaced, not deleted by the expert). Idempotent.
DELETE FROM skill_alias WHERE alias = '微机原理与接口技术' AND created_by = 'seed';
