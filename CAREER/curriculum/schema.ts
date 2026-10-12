/** Strict schema for LLM output (hand-rolled validator: no extra dependency). */
export const COURSE_TYPES = ['核心', '主干'] as const;
export type CourseType = (typeof COURSE_TYPES)[number];

export interface ExtractedCourse {
  name: string;
  course_type: CourseType;
  credits: number | null;
  hours: number | null;
  semester: string | null;
  page: number;
  snippet: string; // verbatim text from the document
  confidence: number; // 0..1
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);

/** Validate a parsed JSON value; returns valid courses and a list of problems (invalid items are dropped). */
export function validateExtraction(value: unknown): { courses: ExtractedCourse[]; errors: string[] } {
  const errors: string[] = [];
  const list = (value as { courses?: unknown })?.courses;
  if (!Array.isArray(list)) return { courses: [], errors: ['top-level "courses" array missing'] };
  const courses: ExtractedCourse[] = [];
  list.forEach((raw, i) => {
    const c = raw as Record<string, unknown>;
    const where = `courses[${i}]`;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    const type = c.course_type;
    const credits = num(c.credits), hours = num(c.hours), page = num(c.page), conf = num(c.confidence);
    const snippet = typeof c.snippet === 'string' ? c.snippet.trim() : '';
    const problems = [
      !name && 'name',
      !(COURSE_TYPES as readonly unknown[]).includes(type) && `course_type=${String(type)}`,
      Number.isNaN(credits) && 'credits',
      Number.isNaN(hours) && 'hours',
      (page === null || Number.isNaN(page) || page < 1) && 'page',
      !snippet && 'snippet',
      (conf === null || Number.isNaN(conf) || conf < 0 || conf > 1) && 'confidence',
    ].filter(Boolean);
    if (problems.length) {
      errors.push(`${where}: invalid ${problems.join(', ')}`);
      return;
    }
    courses.push({
      name,
      course_type: type as CourseType,
      credits,
      hours: hours === null ? null : Math.round(hours),
      semester: typeof c.semester === 'string' && c.semester.trim() ? c.semester.trim() : c.semester == null ? null : String(c.semester),
      page: page!,
      snippet,
      confidence: conf!,
    });
  });
  return { courses, errors };
}

/** JSON schema text embedded in the prompt (documentation for the model). */
export const OUTPUT_SCHEMA = `{"courses":[{"name":string,"course_type":"核心"|"主干","credits":number|null,"hours":number|null,"semester":string|null,"page":integer,"snippet":string,"confidence":number}]}`;
