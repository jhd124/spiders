/** Normalized posting written by each JOBS/<source>/clean.ts to data/clean/jobs-<source>.json and loaded by JOBS/ingest.ts. */
export interface CleanPosting {
  id: string; // '<site>:<site posting id>'
  site: string;
  channel: '社招' | '校招' | '实习';
  title_raw: string;
  company_raw: string | null;
  city_raw: string | null;
  city: string | null;
  salary_raw: string | null;
  salary_min_month: number | null;
  salary_max_month: number | null;
  salary_months: number | null;
  salary_note: string;
  education_raw: string | null;
  education: string | null;
  experience_raw: string | null;
  experience_min_years: number | null;
  industry_raw: string | null;
  jd_text: string | null;
  occupation_code: string | null;
  occupation_confidence: number | null;
  search_keyword: string | null;
  dedupe_key: string;
  raw_json: string;
  published_at: string | null;
  source_url: string;
  fetched_at: string;
  extraction_method: 'api' | 'html_parse';
}
