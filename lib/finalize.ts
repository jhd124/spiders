import { validateCourse, type Course, type SchoolKey } from '../MOOC/schema.js';
import { cleanPath, rawPath, readJson, writeJson, type RawDump } from './io.js';

/** Read the raw dump for a school. */
export const loadRaw = (school: SchoolKey) => readJson<RawDump>(rawPath(school));

/** Validate, de-duplicate (by id, then by url) and write cleaned courses for a school. */
export async function writeClean(school: SchoolKey, courses: Course[]): Promise<Course[]> {
  const byId = new Map<string, Course>();
  const urls = new Set<string>();
  let invalid = 0;
  for (const c of courses) {
    const errs = validateCourse(c);
    if (errs.length) {
      invalid++;
      console.warn(`[${school}] invalid course "${c.title}": ${errs.join('; ')}`);
      continue;
    }
    if (byId.has(c.id) || urls.has(c.url)) continue;
    byId.set(c.id, c);
    urls.add(c.url);
  }
  const out = [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  await writeJson(cleanPath(school), out);
  console.log(`[${school}] clean: ${out.length} courses (${invalid} invalid dropped) -> ${cleanPath(school)}`);
  return out;
}
