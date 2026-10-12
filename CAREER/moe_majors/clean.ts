/**
 * Parse the MOE catalog text dumped by crawler.ts into categories / classes / majors.
 * Strict: every line after the first 门类 heading must be a heading, a major, a wrapped note or a
 * page number — anything else aborts, so a layout change can't silently drop or invent rows.
 * Output: data/clean/career-moe_majors.json
 */
import { cleanPath, rawPath, readJson, writeJson, type RawDump } from '../../lib/io.js';
import { isMain } from '../../lib/main.js';
import type { FetchedDoc } from '../fetchdoc.js';
import { RAW_NAME } from './crawler.js';

type RawCatalog = FetchedDoc & { pages: number; lines: [number, string][] };

export interface CatalogCategory { code: string; name: string; page: number }
export interface CatalogClass { code: string; name: string; category_code: string; page: number }
export interface CatalogMajor {
  code: string;
  base_code: string;
  name: string;
  category_code: string;
  category_name: string;
  class_code: string | null;
  class_name: string | null;
  is_special: boolean;
  is_controlled: boolean;
  is_engineering: boolean;
  degree_categories: string[];
  degree_note: string | null;
  former_code: string | null;
  page: number;
}
export interface ParsedCatalog {
  doc: Omit<FetchedDoc, 'path'>;
  edition: number;
  categories: CatalogCategory[];
  classes: CatalogClass[];
  majors: CatalogMajor[];
}

const CAT = /^(\d{2})\s*学科门类：\s*(\S+)$/;
const CLS = /^(\d{4})\s*(\S+类)$/;
const MAJ = /^(\d{6,7})(TK|T|K)?\s*(\S.*)$/;
const PAGE = /^—\s*\d+\s*—$/;
const DEGREE = /(哲学|经济学|法学|教育学|文学|历史学|理学|工学|农学|医学|军事学|管理学|艺术学|交叉学科)/g;

export function parseCatalog(raw: RawCatalog): ParsedCatalog {
  const categories: CatalogCategory[] = [];
  const classes: CatalogClass[] = [];
  const majors: CatalogMajor[] = [];
  let cat: CatalogCategory | null = null;
  let cls: CatalogClass | null = null;
  let open: { m: CatalogMajor; text: string } | null = null;

  const closeMajor = () => {
    if (!open) return;
    const { m, text } = open;
    const nm = text.match(/^(.+?)（注：(.+)）$/);
    if (text.includes('（') && !nm) throw new Error(`unterminated note for ${m.code}: ${text}`);
    m.name = (nm ? nm[1]! : text).trim();
    m.degree_note = nm ? nm[2]! : null;
    m.former_code = m.degree_note?.match(/原专业代码为(\d{6,7}(?:TK|T|K)?)/)?.[1] ?? null;
    const degreePart = m.degree_note?.match(/(?:可授|授予)(.+?)学士学位/)?.[1];
    m.degree_categories = degreePart ? [...new Set(degreePart.match(DEGREE) ?? [])] : [m.category_name];
    if (!m.degree_categories.length) throw new Error(`no degree category for ${m.code}: ${m.degree_note}`);
    majors.push(m);
    open = null;
  };

  for (const [page, rawText] of raw.lines) {
    const t = rawText.trim();
    if (!cat && !CAT.test(t)) continue; // 说明 front matter
    if (PAGE.test(t)) continue;
    let m: RegExpMatchArray | null;
    if ((m = t.match(CAT))) {
      closeMajor();
      cat = { code: m[1]!, name: m[2]!, page };
      categories.push(cat);
      cls = null;
    } else if ((m = t.match(CLS))) {
      closeMajor();
      if (!m[1]!.startsWith(cat!.code)) throw new Error(`class ${m[1]} outside category ${cat!.code}`);
      cls = { code: m[1]!, name: m[2]!, category_code: cat!.code, page };
      classes.push(cls);
    } else if ((m = t.match(MAJ))) {
      closeMajor();
      const base = m[1]!, suffix = m[2] ?? '', rest = m[3]!;
      const parent = cls && base.startsWith(cls.code) ? cls : null;
      if (!base.startsWith(cat!.code)) throw new Error(`major ${base} outside category ${cat!.code}`);
      if (cls && !parent) throw new Error(`major ${base} outside class ${cls.code}`);
      open = {
        text: rest,
        m: {
          code: base + suffix,
          base_code: base,
          name: '',
          category_code: cat!.code,
          category_name: cat!.name,
          class_code: parent?.code ?? null,
          class_name: parent?.name ?? null,
          is_special: suffix.includes('T'),
          is_controlled: suffix.includes('K'),
          is_engineering: cat!.code === '08',
          degree_categories: [],
          degree_note: null,
          former_code: null,
          page,
        },
      };
    } else if (open && open.text.includes('（') && !open.text.endsWith('）')) {
      open.text += t; // wrapped note
    } else {
      throw new Error(`unexpected line on page ${page}: ${JSON.stringify(t)}`);
    }
  }
  closeMajor();
  const seen = new Set<string>();
  for (const x of majors) {
    if (seen.has(x.base_code)) throw new Error(`duplicate code ${x.code}`);
    seen.add(x.base_code);
  }
  const doc = { doc: raw.doc, fetched_url: raw.fetched_url, fetched_at: raw.fetched_at, sha256: raw.sha256, bytes: raw.bytes };
  return { doc, edition: Number(raw.doc.edition), categories, classes, majors };
}

export async function clean() {
  const dump = await readJson<RawDump>(rawPath(RAW_NAME));
  const out: ParsedCatalog[] = [];
  for (const [id, recs] of Object.entries(dump.sources)) {
    const raw = recs[0] as RawCatalog | undefined;
    if (!raw) {
      console.warn(`[${RAW_NAME}] ${id}: no raw data (${dump.errors?.[id] ?? 'missing'})`);
      continue;
    }
    const p = parseCatalog(raw);
    const eng = p.majors.filter((m) => m.is_engineering).length;
    console.log(
      `[${RAW_NAME}] ${id}: ${p.categories.length} 门类, ${p.classes.length} 专业类, ${p.majors.length} 专业 (工学 ${eng}, T ${p.majors.filter((m) => m.is_special).length}, K ${p.majors.filter((m) => m.is_controlled).length})`,
    );
    out.push(p);
  }
  if (!out.length) throw new Error('nothing to clean');
  await writeJson(cleanPath(RAW_NAME), out);
  console.log(`[${RAW_NAME}] clean: ${out.reduce((n, p) => n + p.majors.length, 0)} records -> ${cleanPath(RAW_NAME)}`);
}

if (isMain(import.meta.url)) await clean();
