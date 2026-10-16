-- Flag special 投档 rows by name/sheet (高校专项、定向西藏、文物全科、非西藏生定藏就业、中外合作, …).
ALTER TABLE gaokao_toudang ADD COLUMN special_type TEXT; -- NULL = ordinary product; else label, with is_ordinary = 0
