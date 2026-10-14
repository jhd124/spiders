/** Web-console views over career.db: 招聘岗位 (job_posting) and 薪资统计 (salary_stat). */
import { defineDataset } from '../lib/dataset.js';
import { CAREER_DB } from '../CAREER/db.js';

const postings = defineDataset({
  key: 'postings',
  title: 'JOBS · 招聘岗位',
  description: '公开来源的岗位（v1：中国石油大学（华东）智慧就业网职位信息）。薪资已折算为元/月；occupation_code 按职位名称规则归到 8 个试点职业。',
  kind: 'sqlite',
  dbPath: CAREER_DB,
  table: 'job_posting',
  idColumn: 'id',
  titleColumn: 'title_raw',
  fts: { table: 'job_posting_fts', columns: ['title_raw', 'company_raw', 'jd_text', 'city'], updatedColumn: 'last_seen_at' },
  filters: [
    { key: 'occ', label: '职业', column: 'occupation_code', type: 'select' },
    { key: 'city', label: '城市', column: 'city', type: 'select' },
    { key: 'edu', label: '最低学历', column: 'education', type: 'select' },
    { key: 'channel', label: '渠道', column: 'channel', type: 'select' },
    { key: 'site', label: '来源', column: 'site', type: 'select' },
  ],
  listColumns: [
    { column: 'title_raw', label: '职位' },
    { column: 'company_raw', label: '单位' },
    { column: 'city', label: '城市' },
    { column: 'salary_raw', label: '薪资(原文)' },
    { column: 'salary_min_month', label: '月薪下限', format: 'number' },
    { column: 'salary_max_month', label: '月薪上限', format: 'number' },
    { column: 'education', label: '学历' },
    { column: 'occupation_code', label: '职业' },
    { column: 'published_at', label: '发布', format: 'date' },
    { column: 'source_url', label: '来源', format: 'link' },
  ],
  defaultSort: 'published_at',
});

export default [postings];
