/**
 * 公开课 / MOOC 统一字段定义（所有学校的清洗脚本都输出这个结构）。
 * Shared course schema: every MOOC/<school>/clean.ts must emit Course[].
 */

export const SCHOOLS = {
  harvard: 'Harvard University',
  yale: 'Yale University',
  princeton: 'Princeton University',
  columbia: 'Columbia University',
  upenn: 'University of Pennsylvania',
  brown: 'Brown University',
  dartmouth: 'Dartmouth College',
  cornell: 'Cornell University',
  stanford: 'Stanford University',
  mit: 'Massachusetts Institute of Technology',
} as const;
export type SchoolKey = keyof typeof SCHOOLS;

export const PLATFORMS = ['edX', 'Coursera', 'Harvard Online Learning', 'Open Yale Courses', 'Stanford Engineering Everywhere', 'MIT OpenCourseWare', 'MITx', 'Other'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const LEVELS = ['introductory', 'intermediate', 'advanced', 'mixed'] as const;
export type Level = (typeof LEVELS)[number];

export const PACES = ['self-paced', 'instructor-paced'] as const;
export type Pace = (typeof PACES)[number];

export const STATUSES = ['active', 'upcoming', 'archived'] as const;
export type Status = (typeof STATUSES)[number];

export interface Course {
  /** Stable id: `${school}:${platformSlug}:${sourceId}` */
  id: string;
  school: SchoolKey;
  schoolName: string;
  /** Sub-unit / edX org / Harvard school that offers it, e.g. "PennX", "Harvard Business School" */
  provider: string | null;
  title: string;
  description: string | null;
  instructors: string[];
  /** Broad subject areas, e.g. "Computer Science" */
  subjects: string[];
  /** Skills / keywords */
  tags: string[];
  /** Canonical public URL of the course page (unique per school) */
  url: string;
  platform: Platform;
  /** Id of the course on its platform (Coursera course id, edX uuid, Drupal path…) */
  sourceId: string | null;
  /** Course code at the school, e.g. "AFAM 162" */
  courseCode: string | null;
  level: Level | null;
  /** Languages the course is taught in (human readable or ISO codes as given by the source) */
  languages: string[];
  /** Free-text duration as shown by the source, e.g. "3 weeks long" */
  duration: string | null;
  /** Free-text effort, e.g. "2–3 hours/week" */
  effort: string | null;
  weeks: number | null;
  /** true = auditable / free per the source; null = source doesn't say */
  isFree: boolean | null;
  price: number | null;
  certificatePrice: number | null;
  currency: string | null;
  pace: Pace | null;
  /** ISO date (YYYY-MM-DD) or ISO datetime if known */
  startDate: string | null;
  /** Free-text term / date as given, e.g. "Spring 2010", "Available now" */
  termText: string | null;
  status: Status | null;
  imageUrl: string | null;
  enrollmentCount: number | null;
  rating: number | null;
  /** ISO datetime of the crawl */
  scrapedAt: string;
}

/** Columns that hold arrays (stored as JSON text in SQL). */
export const ARRAY_FIELDS = ['instructors', 'subjects', 'tags', 'languages'] as const satisfies readonly (keyof Course)[];

/** Column definitions used by ingest.ts to derive the table. Keep in sync with Course. */
export const COURSE_COLUMNS: Record<keyof Course, 'TEXT' | 'INTEGER' | 'REAL' | 'JSON' | 'BOOLEAN'> = {
  id: 'TEXT',
  school: 'TEXT',
  schoolName: 'TEXT',
  provider: 'TEXT',
  title: 'TEXT',
  description: 'TEXT',
  instructors: 'JSON',
  subjects: 'JSON',
  tags: 'JSON',
  url: 'TEXT',
  platform: 'TEXT',
  sourceId: 'TEXT',
  courseCode: 'TEXT',
  level: 'TEXT',
  languages: 'JSON',
  duration: 'TEXT',
  effort: 'TEXT',
  weeks: 'REAL',
  isFree: 'BOOLEAN',
  price: 'REAL',
  certificatePrice: 'REAL',
  currency: 'TEXT',
  pace: 'TEXT',
  startDate: 'TEXT',
  termText: 'TEXT',
  status: 'TEXT',
  imageUrl: 'TEXT',
  enrollmentCount: 'INTEGER',
  rating: 'REAL',
  scrapedAt: 'TEXT',
};

export const platformSlug = (p: Platform) => p.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function makeCourseId(school: SchoolKey, platform: Platform, sourceId: string): string {
  return `${school}:${platformSlug(platform)}:${sourceId}`;
}

/** Build a Course with all optional fields defaulted to null / []. */
export function makeCourse(
  required: Pick<Course, 'school' | 'title' | 'url' | 'platform' | 'scrapedAt'> & { sourceId: string },
  rest: Partial<Course> = {},
): Course {
  const c: Course = {
    id: makeCourseId(required.school, required.platform, required.sourceId),
    schoolName: SCHOOLS[required.school],
    provider: null,
    description: null,
    instructors: [],
    subjects: [],
    tags: [],
    courseCode: null,
    level: null,
    languages: [],
    duration: null,
    effort: null,
    weeks: null,
    isFree: null,
    price: null,
    certificatePrice: null,
    currency: null,
    pace: null,
    startDate: null,
    termText: null,
    status: null,
    imageUrl: null,
    enrollmentCount: null,
    rating: null,
    ...rest,
    ...required,
  };
  return c;
}

/* ---------------- lightweight runtime validator ---------------- */

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown) => v === null || isStr(v);
const isNumOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isStrArr = (v: unknown) => Array.isArray(v) && v.every(isStr);
const oneOfOrNull = (list: readonly string[]) => (v: unknown) => v === null || (isStr(v) && list.includes(v));

const CHECKS: Record<keyof Course, (v: unknown) => boolean> = {
  id: (v) => isStr(v) && v.length > 0,
  school: (v) => isStr(v) && v in SCHOOLS,
  schoolName: isStr,
  provider: isStrOrNull,
  title: (v) => isStr(v) && v.trim().length > 0,
  description: isStrOrNull,
  instructors: isStrArr,
  subjects: isStrArr,
  tags: isStrArr,
  url: (v) => isStr(v) && /^https?:\/\//.test(v),
  platform: (v) => isStr(v) && (PLATFORMS as readonly string[]).includes(v),
  sourceId: isStrOrNull,
  courseCode: isStrOrNull,
  level: oneOfOrNull(LEVELS),
  languages: isStrArr,
  duration: isStrOrNull,
  effort: isStrOrNull,
  weeks: isNumOrNull,
  isFree: (v) => v === null || typeof v === 'boolean',
  price: isNumOrNull,
  certificatePrice: isNumOrNull,
  currency: isStrOrNull,
  pace: oneOfOrNull(PACES),
  startDate: isStrOrNull,
  termText: isStrOrNull,
  status: oneOfOrNull(STATUSES),
  imageUrl: isStrOrNull,
  enrollmentCount: isNumOrNull,
  rating: isNumOrNull,
  scrapedAt: (v) => isStr(v) && !Number.isNaN(Date.parse(v)),
};

/** Returns a list of problems; empty list = valid. */
export function validateCourse(c: unknown): string[] {
  if (typeof c !== 'object' || c === null) return ['not an object'];
  const o = c as Record<string, unknown>;
  const errs: string[] = [];
  for (const [k, check] of Object.entries(CHECKS)) {
    if (!(k in o)) errs.push(`missing ${k}`);
    else if (!check(o[k])) errs.push(`bad ${k}: ${JSON.stringify(o[k])?.slice(0, 80)}`);
  }
  return errs;
}

export function isCourse(c: unknown): c is Course {
  return validateCourse(c).length === 0;
}
