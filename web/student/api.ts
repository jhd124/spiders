/** Student API client: GET /api/public/* only. */
export interface Occ { code: string; display_name: string; official_name: string; aliases: string[]; core_skills: number; skills: number }
export interface MajorRow { school_id: string; school: string; major_code: string; major: string; core_covered: number; core_total: number; label: string }
export interface Salary { education: string; window: string; sample_size: number; p25: number | null; p50: number | null; p75: number | null; source_label: string; note: string }
export interface OccDetail { code: string; display_name: string; official_name: string; core_skills: string[]; general_skills: string[]; salary: Salary[];
  demand: { postings: number; skills: { skill: string; pct: number; listed: boolean }[] }; majors: MajorRow[] }
export interface CourseRef { course: string; type: '必修' | '限选' | '任选' }
export interface MajorForOcc { occupation: { code: string; display_name: string; official_name: string }; school_id: string; school: string; major_code: string; major: string;
  core_covered: number; core_total: number; label: string; sentence: string; covered: { skill: string; courses: CourseRef[] }[]; to_supplement: { skill: string; courses: CourseRef[]; in_practice: boolean }[];
  general: { skill: string; covered: boolean; courses: CourseRef[] }[] }
export interface MajorItem { school_id: string; school: string; major_code: string; major: string }
export interface MajorDetail extends MajorItem { not_covered: string[]; occupations: { code: string; display_name: string; official_name: string; core_covered: number; core_total: number; label: string }[] }

export interface GwyForMajor { notice: { id: string; title: string }; major_code: string;
  undergrad: { positions: number; hires: number; party: { positions: number; pct: number }; fresh_grad: { positions: number; pct: number } };
  needs_grad: { positions: number; hires: number }; note: string }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api/public${path}`);
  if (!r.ok) throw new Error(r.status === 404 ? '没有找到' : `加载失败（${r.status}）`);
  return r.json() as Promise<T>;
}
const e = encodeURIComponent;
export const api = {
  occupations: () => get<Occ[]>('/occupations'),
  occupation: (code: string) => get<OccDetail>(`/occupation/${e(code)}`),
  majorForOcc: (code: string, school: string, major: string) => get<MajorForOcc>(`/occupation/${e(code)}/major/${e(school)}/${e(major)}`),
  majors: () => get<MajorItem[]>('/majors'),
  major: (school: string, major: string) => get<MajorDetail>(`/major/${e(school)}/${e(major)}`),
  gwy: (major: string) => get<GwyForMajor>(`/gwy/major/${e(major)}`),
};
export const href = {
  home: '#/',
  occ: (code: string) => `#/occ/${e(code)}`,
  majorForOcc: (code: string, school: string, major: string) => `#/occ/${e(code)}/${e(school)}/${e(major)}`,
  major: (school: string, major: string) => `#/major/${e(school)}/${e(major)}`,
};
