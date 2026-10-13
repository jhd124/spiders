/** Runs after CAREER ingest in `career:all` (scripts/run-group.ts): course -> skill tagging. */
import { isMain } from '../lib/main.js';
import { main as tagSkills } from './curriculum/tag.js';
if (isMain(import.meta.url)) await tagSkills();
