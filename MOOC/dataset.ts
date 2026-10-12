/** MOOC 数据集在 Web 查询页里的配置（表结构来自 schema.ts / ingest.ts）。 */
import { join } from 'node:path';
import { defineDataset } from '../lib/dataset.js';
import { DATA_DIR } from '../lib/io.js';
import { SCHOOLS } from './schema.js';

/** Whole-word / phrase terms for the AI topics (case-insensitive; FTS has no stemming, so plurals are listed). */
const AI_TERMS = [
  'artificial intelligence',
  'machine learning',
  'deep learning',
  'neural network',
  'neural networks',
  'LLM',
  'LLMs',
  'large language model',
  'large language models',
  'generative AI',
  'GenAI',
  'ChatGPT',
  'GPT',
  'prompt engineering',
  'natural language processing',
  'NLP',
  'computer vision',
  'reinforcement learning',
  'TinyML',
  'MLOps',
];

export default defineDataset({
  title: 'MOOC 公开课',
  description: '藤校公开课 / MOOC（Harvard PLL、Open Yale Courses、Coursera、edX）',
  kind: 'sqlite',
  dbPath: process.env.SPIDERS_DB ?? join(DATA_DIR, 'courses.db'),
  table: 'courses',
  idColumn: 'id',
  titleColumn: 'title',
  fts: {
    table: 'courses_fts',
    columns: ['title', 'description', 'instructors', 'subjects', 'tags'],
    updatedColumn: 'ingested_at',
  },
  topics: [
    {
      key: 'ai',
      label: 'AI（标题/简介/学科/标签任一提及）',
      columns: ['title', 'description', 'subjects', 'tags'],
      terms: AI_TERMS,
      // "AI" only as an upper-case whole word (avoids Italian/Spanish "ai", names like "Ai")
      caseSensitiveTerms: ['AI'],
    },
    {
      key: 'ai-core',
      label: 'AI 核心课（标题/学科命中）',
      columns: ['title', 'subjects'],
      terms: AI_TERMS,
      caseSensitiveTerms: ['AI'],
    },
  ],
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
