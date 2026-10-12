/**
 * Stage 2 (stub): course -> skill tagging. Level-2 skills are not defined yet, so the default tagger
 * returns nothing. A real tagger (LLM or rules over skill + skill_alias) implements SkillTagger and its
 * output goes to course_skill (extraction_method 'llm' | 'manual', confidence, reviewed=0).
 */
export interface SkillRef { id: string; name: string; aliases: string[]; primary_domain_id: string }
export interface CourseForTagging { course_id: string; name: string; major_code: string; snippet: string | null }
export interface SkillTag { course_id: string; skill_id: string; weight: number | null; confidence: number; method: 'llm' | 'manual' | 'rule' }

export interface SkillTagger {
  readonly name: string;
  tag(courses: CourseForTagging[], skills: SkillRef[]): Promise<SkillTag[]>;
}

export class NoopSkillTagger implements SkillTagger {
  readonly name = 'none';
  async tag(): Promise<SkillTag[]> {
    return [];
  }
}
