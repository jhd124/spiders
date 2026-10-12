/** Web-console views over data/career.db: 专业 (major), 专业类 (major_class), 职业 (occupation). */
import { defineDataset, type DatasetConfig } from '../lib/dataset.js';
import { CAREER_DB } from './db.js';

const majors = defineDataset({
  key: 'majors',
  title: 'CAREER · 本科专业目录',
  description: '教育部《普通高等学校本科专业目录》最新版（含上一版已移出目录的专业）。T=特设，K=国家控制布点。',
  kind: 'sqlite',
  dbPath: CAREER_DB,
  table: 'major',
  idColumn: 'code',
  titleColumn: 'name',
  fts: { table: 'major_fts', columns: ['code', 'name', 'class_name', 'category_name', 'degree_note'], updatedColumn: 'updated_at' },
  filters: [
    { key: 'category', label: '学科门类', column: 'category_name', type: 'select' },
    { key: 'class', label: '专业类', column: 'class_name', type: 'select' },
    { key: 'eng', label: '工学(08)', column: 'is_engineering', type: 'boolean' },
    { key: 'special', label: '特设 T', column: 'is_special', type: 'boolean' },
    { key: 'controlled', label: '国控 K', column: 'is_controlled', type: 'boolean' },
    { key: 'status', label: '状态', column: 'status', type: 'select' },
    { key: 'edition', label: '目录版本', column: 'catalog_edition', type: 'select' },
  ],
  topics: [
    { key: 'pilot', label: '试点专业(25)', columns: ['code'], terms: ['080901', '080902', '080903', '080904K', '080910T', '080701', '080702', '080703', '080704', '080717T', '080601', '080801', '080803T', '080202', '080204', '080207', '080216T', '080501', '080503T', '080401', '081001', '081301', '082502', '081801', '082001'] },
  ],
  listColumns: [
    { column: 'code', label: '代码' },
    { column: 'name', label: '专业' },
    { column: 'class_name', label: '专业类' },
    { column: 'category_name', label: '门类' },
    { column: 'degree_categories', label: '学位门类' },
    { column: 'status', label: '状态' },
    { column: 'source_url', label: '来源', format: 'link' },
  ],
  defaultSort: 'code',
});

const classes = defineDataset({
  key: 'classes',
  title: 'CAREER · 专业类',
  description: '专业类（山东常按专业类招生，如 0809 计算机类）。',
  kind: 'sqlite',
  dbPath: CAREER_DB,
  table: 'major_class',
  idColumn: 'code',
  titleColumn: 'name',
  fts: { table: 'major_class_fts', columns: ['code', 'name'] },
  filters: [
    { key: 'category', label: '门类代码', column: 'category_code', type: 'select' },
    { key: 'status', label: '状态', column: 'status', type: 'select' },
  ],
  listColumns: [
    { column: 'code', label: '代码' },
    { column: 'name', label: '专业类' },
    { column: 'category_code', label: '门类' },
    { column: 'status', label: '状态' },
    { column: 'catalog_edition', label: '目录版本' },
    { column: 'source_url', label: '来源', format: 'link' },
  ],
  defaultSort: 'code',
});

const occupations = defineDataset({
  key: 'occupations',
  title: 'CAREER · 职业分类大典 2022',
  description: '《中华人民共和国职业分类大典（2022年版）》大类/中类/小类/细类；细类为职业锚点。S=数字职业，L=绿色职业。',
  kind: 'sqlite',
  dbPath: CAREER_DB,
  table: 'occupation',
  idColumn: 'code',
  titleColumn: 'name',
  fts: { table: 'occupation_fts', columns: ['code', 'name'], updatedColumn: 'updated_at' },
  filters: [
    { key: 'level', label: '层级', column: 'level_name', type: 'select' },
    { key: 'digital', label: '数字职业 S', column: 'is_digital', type: 'boolean' },
    { key: 'green', label: '绿色职业 L', column: 'is_green', type: 'boolean' },
    { key: 'batch', label: '来源批次', column: 'source_batch', type: 'select' },
  ],
  listColumns: [
    { column: 'code', label: '代码' },
    { column: 'name', label: '名称' },
    { column: 'level_name', label: '层级' },
    { column: 'parent_code', label: '上级' },
    { column: 'is_digital', label: 'S', format: 'boolean' },
    { column: 'is_green', label: 'L', format: 'boolean' },
    { column: 'source_url', label: '来源', format: 'link' },
  ],
  defaultSort: 'code',
});

const all: DatasetConfig[] = [majors, classes, occupations];
export default all;
