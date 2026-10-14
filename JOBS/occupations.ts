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

const NOT_TECH = /销售|售前|客服|招商|行政|人事|财务|会计|商务|市场专员|司机|普工|操作工|(?<!网络|信息|数据)安全员|安全生产|安环|EHS|HSE|保安/i;
/** expert exclusion words (2026-10-14): never a pilot occupation */
const EXCLUDE_WORDS = /销售|教师|顾问|营销/;
const TECH_WORD = /技术|研发|开发|软件|算法|数据|IT|工程|信息|网络|计算机|智能|程序|测试|运维|硬件/i;
/** 管培 without a tech word -> excluded */
const MGMT_TRAINEE = /管培|管理培训生/;
/** design jobs: 设计 without 工程 and without a software/hardware word (视觉设计, 视觉设计师, UI设计) */
const DESIGN_TECH = /工程|软件|嵌入式|算法|系统|架构|数据库|芯片|硬件|电路|FPGA|程序/i;
/** title names no concrete role: '××校园招聘', '2024届校园招聘', '招聘岗位汇总' */
const GENERIC = /校园招聘|届招聘|招聘岗位汇总|岗位汇总|招聘简章|招聘公告|招聘计划|^招聘$/;
/** separators between listed roles; >= MULTI_ROLE_MIN items means a multi-role title */
const ROLE_SEP = /[、，,；;\/／|｜]+/;
export const MULTI_ROLE_MIN = 3;
/** '软件测试 | 硬件测试', 'Java/前端' -> first alternative */
const ALT_SEP = /\s*[\/／|｜]\s*/;

export const OCCUPATION_RULES: OccupationRule[] = [
  {
    code: '2-02-10-07', name: '信息安全工程技术人员',
    keywords: ['网络安全', '信息安全', '渗透测试'],
    include: /信息安全|网络安全|数据安全|网络安全员|安全工程师|安全开发|安全运维|安全研究|渗透|攻防|等保|密码工程|安全服务|漏洞/i,
    exclude: /(?<!网络|信息|数据)安全员|安全生产|(?<!网络|信息|数据|网络、信息|网络与信息)安全管理|安全技术员|安全监督|质量安全|食品安全|消防/,
  },
  {
    code: '2-02-10-06', name: '嵌入式系统设计工程技术人员',
    keywords: ['嵌入式', '单片机', '固件'],
    include: /嵌入式|单片机|MCU|固件|驱动开发|底层软件|(?<![A-Za-z])BSP(?![A-Za-z])|FPGA|Linux驱动|RTOS/,
  },
  {
    code: '2-02-38-01', name: '人工智能工程技术人员',
    keywords: ['算法', '人工智能', '机器学习', '深度学习', '大模型', '视觉'],
    include: /算法|人工智能|视觉工程|\bAI\b|AI工程|机器学习|深度学习|计算机视觉|视觉算法|图像算法|图像识别|NLP|自然语言|大模型|LLM|AIGC|语音识别|推荐算法/i,
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
    include: /软件|Java|前端|后端|全栈|程序员|C\+\+|C#|Python|Golang|Go开发|PHP|\.NET|Android|iOS|鸿蒙|HarmonyOS|Web开发|测试开发|测试工程师|开发工程师|研发工程师|需求工程|需求分析/i,
    exclude: /硬件|机械|结构|电气|工艺|土建|化工|材料|射频|模拟|版图|光学|电子工程|PCB/,
  },
];

export const OCCUPATION_CODES = OCCUPATION_RULES.map((r) => r.code);

export interface Classification {
  code: string | null;
  confidence: number | null;
  /** several roles listed in one title: unclassified, never in salary stats, skills still extracted */
  multiRole: boolean;
  /** why it is (un)classified: 'rule' | 'first_role' | 'multi_role' | 'generic' | 'excluded_word' | 'mgmt_trainee' | 'design' | 'not_tech' | 'no_match' */
  reason: string;
}

function matchRules(t: string): string | null {
  if (NOT_TECH.test(t)) return null;
  for (const r of OCCUPATION_RULES) {
    if (r.exclude?.test(t)) continue;
    if (r.include.test(t)) return r.code;
  }
  return null;
}

/** title -> occupation + flags. Order: multi-role, generic, exclusion words, 管培, design, then rules (first alternative for 'a | b'). */
export function classifyPosting(title: string): Classification {
  const t = title.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const c = t.replace(/\s+/g, '');
  const none = (reason: string, multiRole = false): Classification => ({ code: null, confidence: null, multiRole, reason });
  const items = c.replace(/[…]+|\.{3,}|等$/g, '').split(ROLE_SEP).filter((x) => x.length > 0);
  if (items.length >= MULTI_ROLE_MIN) return none('multi_role', true);
  if (GENERIC.test(c)) return none('generic');
  if (EXCLUDE_WORDS.test(c)) return none('excluded_word');
  if (MGMT_TRAINEE.test(c) && !TECH_WORD.test(c.replace(MGMT_TRAINEE, ''))) return none('mgmt_trainee');
  if (/设计/.test(c) && !DESIGN_TECH.test(c)) return none('design');
  const alts = t.split(ALT_SEP).map((x) => x.replace(/\s+/g, '')).filter(Boolean);
  if (alts.length > 1) {
    const code = matchRules(alts[0]!);
    return code ? { code, confidence: 0.8, multiRole: false, reason: 'first_role' } : none(NOT_TECH.test(alts[0]!) ? 'not_tech' : 'no_match');
  }
  const code = matchRules(c);
  return code ? { code, confidence: 0.8, multiRole: false, reason: 'rule' } : none(NOT_TECH.test(c) ? 'not_tech' : 'no_match');
}

/** title -> occupation; confidence 0.8 for an explicit title match, null when nothing matches */
export function classifyTitle(title: string): { code: string; confidence: number } | null {
  const r = classifyPosting(title);
  return r.code ? { code: r.code, confidence: r.confidence! } : null;
}

/** first-batch cities: city-level salary_stat rows are computed for these; every posting still counts in '全国' */
export const TARGET_CITIES = ['北京', '上海', '深圳', '杭州', '广州', '成都', '武汉', '济南', '青岛'];
