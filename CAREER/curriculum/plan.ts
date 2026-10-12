/** Which (major, text) units to extract from a fetched document: the whole document, or its major sections. */
import { isMultiMajor, majorCodes, pilotMajors, type CurriculumSource } from './manifest.js';
import { findSections, selectSections, type MajorSection } from './sections.js';
import type { PageText } from './text.js';

export interface ExtractUnit { major_code: string; pages: PageText[]; section: Omit<MajorSection, 'pages'> | null }
export type SectionInfo = Omit<MajorSection, 'pages'> & { pilot: boolean; extracted: boolean };

export function planUnits(source: Pick<CurriculumSource, 'major_code'>, pages: PageText[]) {
  const pilot = pilotMajors();
  const sections = findSections(pages);
  const strip = ({ pages: _p, ...rest }: MajorSection) => rest;
  if (!isMultiMajor(source)) {
    // single-major document: whole text (if it is a 汇编 anyway, narrow to that major's main section)
    const sel = selectSections(sections, [source.major_code], new Set(pilot.keys()));
    const s = sel.chosen[0];
    const units: ExtractUnit[] = [{ major_code: source.major_code, pages: s && sections.length > 1 ? s.pages : pages, section: s && sections.length > 1 ? strip(s) : null }];
    return { units, sections: info(sections, sel.chosen, pilot), notes: sel.notes, missing: [] as string[] };
  }
  const sel = selectSections(sections, majorCodes(source), new Set(pilot.keys()));
  return {
    units: sel.chosen.map((s) => ({ major_code: s.major_code, pages: s.pages, section: strip(s) })),
    sections: info(sections, sel.chosen, pilot),
    notes: sel.notes,
    missing: sel.missing,
  };
}

function info(all: MajorSection[], chosen: MajorSection[], pilot: Map<string, string>): SectionInfo[] {
  return all.map(({ pages: _p, ...s }, i) => ({ ...s, pilot: pilot.has(s.major_code), extracted: chosen.includes(all[i]!) }));
}
