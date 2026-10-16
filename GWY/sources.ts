/** Official sources for GWY (公务员考试). Everything else (training-company mirrors etc.) is not used. */
import { join } from 'node:path';
import { DATA_DIR } from '../lib/io.js';
import type { SourceDoc } from '../CAREER/sources.js';

/** Inputs and outputs live under data/civil-service/ (mounted as /app/data/civil-service in the container). */
export const GWY_DIR = join(DATA_DIR, 'civil-service');

export const GK2027 = {
  id: 'gk2027',
  year: 2027,
  exam_type: '国考' as const,
  province: null,
  title: '中央机关及其直属机构2027年度考试录用公务员公告',
  url: 'http://bm.scs.gov.cn/kl2027',
  /** 国家公务员局 notice as reposted by 新华网 (来源：国家公务员局); scs.gov.cn is not reachable from every network */
  text_source_url: 'https://www.xinhuanet.com/edu/20261013/ce6bf7dc36474dd68ecd90aa8b722f06/c.html',
  published: '2026-10-13',
  /** 招考简章.zip from 专题网站 → 相关下载; default local copy */
  default_file: join(GWY_DIR, 'gk2027_zhaokaojianzhang.zip'),
  /** age clause verbatim from the notice (一、报考条件（二）) */
  age_text: '年龄一般为18周岁以上、38周岁以下（1987年10月至2008年10月期间出生），对于2027年应届硕士、博士研究生，放宽到43周岁以下（1982年10月以后出生）',
};

export const GRAD_CATALOG: SourceDoc = {
  id: 'moe-grad-catalog-2022',
  title: '研究生教育学科专业目录（2022年）',
  publisher: '国务院学位委员会 教育部（学位〔2022〕15号 附件1）',
  edition: '2022',
  url: 'http://www.moe.gov.cn/srcsite/A22/moe_833/202209/W020220914572994461110.pdf',
  notice_url: 'http://www.moe.gov.cn/srcsite/A22/moe_833/202209/t20220914_660828.html',
  fetch: [
    'https://hudong.moe.gov.cn/srcsite/A22/moe_833/202209/W020220914572994461110.pdf',
    'http://www.moe.gov.cn/srcsite/A22/moe_833/202209/W020220914572994461110.pdf',
  ],
  is_official: true,
};
