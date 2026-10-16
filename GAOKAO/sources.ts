/** Shandong 普通类常规批第1次志愿投档情况 — provincial files only (not school sites). */
import { join } from 'node:path';
import { DATA_DIR } from '../lib/io.js';

export const PROVINCE = '山东';
export const ADMISSION_TYPE_DEFAULT = '普通类常规批第1次志愿';
/** Directory mirroring the server: /opt/spiders/data/gaokao/sd-toudang/ */
export const SD_TOUDANG_DIR = () => process.env.GAOKAO_SD_TOUDANG_DIR ?? join(DATA_DIR, 'gaokao', 'sd-toudang');

/** Pilot 院校代号 (山东投档表). Ingest still loads every school; filter with these for product pages. */
export const PILOT_SCHOOLS = [
  { school_code: 'A422', school_name: '山东大学' },
  { school_code: 'A425', school_name: '中国石油大学(华东)' },
  { school_code: 'H213', school_name: '哈尔滨工业大学(威海)' },
] as const;
export const PILOT_CODES: Set<string> = new Set(PILOT_SCHOOLS.map((s) => s.school_code));
