/** Official documents used by CAREER crawlers. `fetch` URLs are tried in order; `url` is the canonical one. */
export interface SourceDoc {
  id: string;
  title: string;
  publisher: string;
  edition: string;
  url: string;
  notice_url?: string;
  fetch: string[];
  is_official: boolean;
  note?: string;
}

export const MOE_CATALOGS: SourceDoc[] = [
  {
    id: 'moe-major-catalog-2026',
    title: '普通高等学校本科专业目录（2026年）',
    publisher: '中华人民共和国教育部（教高函〔2026〕2号 附件）',
    edition: '2026',
    url: 'http://www.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/W020260427440749576927.pdf',
    notice_url: 'http://www.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/t20260427_1434931.html',
    fetch: [
      'https://hudong.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/W020260427440749576927.pdf',
      'http://www.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/W020260427440749576927.pdf',
    ],
    is_official: true,
  },
  {
    id: 'moe-major-catalog-2025',
    title: '普通高等学校本科专业目录（2025年）',
    publisher: '中华人民共和国教育部（教高函〔2025〕3号 附件2）',
    edition: '2025',
    url: 'http://www.moe.gov.cn/srcsite/A08/moe_1034/s4930/202504/W020250422312780837078.pdf',
    notice_url: 'http://www.moe.gov.cn/srcsite/A08/moe_1034/s4930/202504/t20250422_1188239.html',
    fetch: [
      'https://hudong.moe.gov.cn/srcsite/A08/moe_1034/s4930/202504/W020250422312780837078.pdf',
      'http://www.moe.gov.cn/srcsite/A08/moe_1034/s4930/202504/W020250422312780837078.pdf',
    ],
    is_official: true,
    note: 'previous edition, used only to derive first_catalog_edition / removed codes',
  },
];

/**
 * 《中华人民共和国职业分类大典（2022年版）》分类体系表.
 * The official MOHRSS announcement page and its attachments sit behind a JS bot challenge
 * (EdgeOne) that we do not bypass; the table is fetched from a public mirror and every row is
 * flagged is_official = 0 / reviewed = 0 until checked against the official attachment.
 * Counts are verified against the official announcement (8 / 79 / 449 / 1636 in the 公示稿).
 */
export const OCCUPATION_TABLE: SourceDoc = {
  id: 'osta-occupation-2022-table',
  title: '中华人民共和国职业分类大典（2022年版）分类体系表',
  publisher: '国家职业分类大典修订工作委员会（人力资源社会保障部）',
  edition: '2022',
  url: 'https://hxbj.oss-cn-hangzhou.aliyuncs.com/zrhx/upload/%E8%81%8C%E4%B8%9A%E5%A4%A7%E5%85%B8%E4%BD%93%E7%B3%BB%E5%88%86%E7%B1%BB%E8%A1%A8.pdf',
  notice_url: 'http://www.mohrss.gov.cn/xxgk2020/fdzdgknr/jcgk/zqyj/202207/t20220712_457477.html',
  fetch: [
    'https://hxbj.oss-cn-hangzhou.aliyuncs.com/zrhx/upload/%E8%81%8C%E4%B8%9A%E5%A4%A7%E5%85%B8%E4%BD%93%E7%B3%BB%E5%88%86%E7%B1%BB%E8%A1%A8.pdf',
  ],
  is_official: false,
  note: 'mirror (linked from cccac.org.cn) of the official 分类体系表; official MOHRSS page blocks automated access',
};
