/** MOOC 数据集在 Web 查询页里的配置（表结构来自 schema.ts / ingest.ts）。 */
import { join } from 'node:path';
import { defineDataset } from '../lib/dataset.js';
import { DATA_DIR } from '../lib/io.js';
import { SCHOOLS } from './schema.js';

export default defineDataset({
  title: 'MOOC 公开课',
  description: '藤校公开课 / MOOC（Harvard PLL、Open Yale Courses、Coursera、edX）',
  kind: 'sqlite',
  dbPath: process.env.SPIDERS_DB ?? join(DATA_DIR, 'courses.db'),
  table: 'courses',
  idColumn: 'id',
  titleColumn: 'title',
  searchColumns: ['title', 'description', 'instructors', 'tags'],
  filters: [
    { key: 'school', label: '学校', column: 'school', type: 'select', labels: SCHOOLS },
    { key: 'platform', label: '平台', column: 'platform', type: 'select' },
    { key: 'level', label: '难度', column: 'level', type: 'select' },
    { key: 'status', label: '状态', column: 'status', type: 'select' },
    { key: 'isFree', label: '免费', column: 'is_free', type: 'boolean' },
  ],
  listColumns: [
    { column: 'title', label: '课程', format: 'text' },
    { column: 'school', label: '学校' },
    { column: 'platform', label: '平台' },
    { column: 'instructors', label: '讲师', format: 'list' },
    { column: 'level', label: '难度' },
    { column: 'is_free', label: '免费', format: 'boolean' },
    { column: 'url', label: '链接', format: 'link' },
  ],
  jsonColumns: ['instructors', 'subjects', 'tags', 'languages'],
  defaultSort: 'title',
});
