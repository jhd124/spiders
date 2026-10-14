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
    { key: 'reason', label: '归类依据', column: 'classify_reason', type: 'select' },
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
    { column: 'multi_role', label: '多岗位' },
    { column: 'classify_reason', label: '归类依据' },
    { column: 'published_at', label: '发布', format: 'date' },
    { column: 'source_url', label: '来源', format: 'link' },
  ],
  defaultSort: 'published_at',
});

const salary = defineDataset({
  key: 'salary',
  title: 'JOBS · 薪资（职业 × 学历）',
  description: '默认展示口径：最近 24 个月（窗口见 window 列）、样本内全部城市、全部渠道，按职业 × 最低学历汇总的月薪 P25/P50/P75。数据来源见「来源」列（目前只有中国石油大学（华东）就业网校招岗位，不代表全国）。样本 < 30 只给数量；样本 < 100 标注「样本较少，仅供参考」。面议、多岗位合写的职位不计入。按城市/季度的细分行仍在 salary_stat 表里。',
  kind: 'sqlite',
  dbPath: CAREER_DB,
  table: 'salary_overview',
  idColumn: 'id',
  titleColumn: 'occupation_name',
  fts: { table: 'salary_overview_fts', columns: ['occupation_name', 'occupation_code', 'education'], updatedColumn: 'computed_at' },
  filters: [
    { key: 'occ', label: '职业', column: 'occupation_code', type: 'select' },
    { key: 'edu', label: '最低学历', column: 'education', type: 'select' },
  ],
  listColumns: [
    { column: 'occupation_name', label: '职业' },
    { column: 'education', label: '学历' },
    { column: 'window', label: '时间窗口' },
    { column: 'sample_size', label: '样本数', format: 'number' },
    { column: 'p25_month', label: 'P25 月薪', format: 'number' },
    { column: 'p50_month', label: '中位数月薪', format: 'number' },
    { column: 'p75_month', label: 'P75 月薪', format: 'number' },
    { column: 'sample_note', label: '提示' },
    { column: 'source_label', label: '来源' },
  ],
  defaultSort: 'id',
});

const demand = defineDataset({
  key: 'demand',
  title: 'JOBS · 岗位技能需求',
  description: '每个职业的岗位里各技能出现的比例。用全部年份的岗位；样本时间范围见 sample_from / sample_to 列。',
  kind: 'sqlite',
  dbPath: CAREER_DB,
  table: 'job_skill_demand',
  idColumn: 'id',
  titleColumn: 'skill_name',
  fts: { table: 'job_skill_demand_fts', columns: ['occupation_name', 'skill_name', 'skill_id'], updatedColumn: 'sample_to' },
  filters: [{ key: 'occ', label: '职业', column: 'occupation_code', type: 'select' }],
  listColumns: [
    { column: 'occupation_name', label: '职业' },
    { column: 'skill_name', label: '技能' },
    { column: 'postings', label: '岗位数', format: 'number' },
    { column: 'occupation_postings', label: '职业岗位总数', format: 'number' },
    { column: 'share_pct', label: '占比 %', format: 'number' },
    { column: 'sample_from', label: '样本起', format: 'date' },
    { column: 'sample_to', label: '样本止', format: 'date' },
  ],
  defaultSort: 'id',
});

export default [salary, demand, postings];
