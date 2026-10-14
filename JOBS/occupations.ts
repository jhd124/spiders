/**
 * The 8 pilot occupations (codes from CAREER/seeds/occupation_skills.csv): crawl keywords and the title rules that
 * assign a posting to one 细类. Rules are checked in ORDER (most specific first); the first match wins.
 * Deterministic and reviewable — edit here, re-run `npm run jobs:ingest` to re-classify stored postings.
 */
export interface OccupationRule {
  code: string;
  name: string;
  /** search terms sent to the source (the site matches them against 单位名称/职位名称) */
  keywords: string[];
  include: RegExp;
  exclude?: RegExp;
}

const NOT_TECH = /销售|售前|客服|招商|行政|人事|财务|会计|商务|市场专员|司机|普工|操作工|安全员|安全生产|安环|EHS|HSE|保安/i;

export const OCCUPATION_RULES: OccupationRule[] = [
  {
    code: '2-02-10-07', name: '信息安全工程技术人员',
    keywords: ['网络安全', '信息安全', '渗透测试'],
    include: /信息安全|网络安全|数据安全|安全工程师|安全开发|安全运维|安全研究|渗透|攻防|等保|密码工程|安全服务|漏洞/i,
    exclude: /安全员|安全生产|安全管理|安全技术员|安全监督|质量安全|食品安全|消防/,
  },
  {
    code: '2-02-10-06', name: '嵌入式系统设计工程技术人员',
    keywords: ['嵌入式', '单片机', '固件'],
    include: /嵌入式|单片机|MCU|固件|驱动开发|底层软件|(?<![A-Za-z])BSP(?![A-Za-z])|FPGA|Linux驱动|RTOS/,
  },
  {
    code: '2-02-38-01', name: '人工智能工程技术人员',
    keywords: ['算法', '人工智能', '机器学习', '深度学习', '大模型', '视觉'],
    include: /算法|人工智能|\bAI\b|AI工程|机器学习|深度学习|计算机视觉|视觉算法|图像算法|图像识别|NLP|自然语言|大模型|LLM|AIGC|语音识别|推荐算法/i,
    exclude: /机器视觉调试|视觉设计|平面|美工/,
  },
  {
    code: '2-02-38-03', name: '大数据工程技术人员',
    keywords: ['大数据', '数据开发', '数据仓库'],
    include: /大数据|数据开发|数仓|数据仓库|数据平台|数据工程师|Hadoop|Spark|Flink|ETL/i,
  },
  {
    code: '2-02-30-09', name: '数据分析处理工程技术人员',
    keywords: ['数据分析', '数据挖掘'],
    include: /数据分析|数据挖掘|BI工程|BI开发|商业分析|数据治理|数据处理|数据标注|数据运营/i,
  },
  {
    code: '2-02-38-04', name: '云计算工程技术人员',
    keywords: ['云计算', '运维开发', '云平台'],
    include: /云计算|云平台|云原生|云架构|云产品|DevOps|运维开发|SRE|Kubernetes|K8s|容器|虚拟化|IaaS|PaaS/i,
  },
  {
    code: '2-02-10-04', name: '计算机网络工程技术人员',
    keywords: ['网络工程师', '网络运维'],
    include: /网络工程|网络运维|网络管理|网络架构|网络技术|网络规划|数通|网络优化|IT运维|系统运维|运维工程师/i,
    exclude: /网络主播|网络销售|网络推广|网络营销|新媒体/,
  },
  {
    code: '2-02-10-03', name: '计算机软件工程技术人员',
    keywords: ['软件', 'Java', '前端', '后端', 'C++', 'Python', '软件测试'],
    include: /软件|Java|前端|后端|全栈|程序员|C\+\+|C#|Python|Golang|Go开发|PHP|\.NET|Android|iOS|鸿蒙|HarmonyOS|Web开发|测试开发|测试工程师|开发工程师|研发工程师/i,
    exclude: /硬件|机械|结构|电气|工艺|土建|化工|材料|射频|模拟|版图|光学|电子工程|PCB/,
  },
];

export const OCCUPATION_CODES = OCCUPATION_RULES.map((r) => r.code);

/** title (+ optional category text) -> occupation; confidence 0.8 for an explicit title match, null when nothing matches */
export function classifyTitle(title: string): { code: string; confidence: number } | null {
  const t = title.replace(/\s+/g, '');
  if (NOT_TECH.test(t)) return null;
  for (const r of OCCUPATION_RULES) {
    if (r.exclude?.test(t)) continue;
    if (r.include.test(t)) return { code: r.code, confidence: 0.8 };
  }
  return null;
}

/** first-batch cities: city-level salary_stat rows are computed for these; every posting still counts in '全国' */
export const TARGET_CITIES = ['北京', '上海', '深圳', '杭州', '广州', '成都', '武汉', '济南', '青岛'];
