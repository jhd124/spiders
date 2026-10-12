import { join } from 'node:path';
import { DATA_DIR } from '../lib/io.js';

/** CAREER SQLite DB; lives in the shared data dir (SPIDERS_DATA_DIR, /app/data in the container). */
export const CAREER_DB = process.env.CAREER_DB ?? join(DATA_DIR, 'career.db');
