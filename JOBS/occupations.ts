/**
 * The 11 pilot occupations (8 IT + 3 EE/automation, 2026-10-15) (codes from CAREER/seeds/occupation_skills.csv): crawl keywords and the title rules that
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

const NOT_TECH = /非技术|新媒体|品牌|宣传|招聘启事|售前|客服|招商|行政|人事|财务|会计|商务|市场专员|司机|普工|操作工|(?<!网络|信息|数据)安全员|安全生产|安环|EHS|HSE|保安/i;
/** expert exclusion words (2026-10-14): never a pilot occupation */
const EXCLUDE_WORDS = /销售|教师|顾问|营销/;
/** product roles (expert 2026-10-14): not 软件工程; a future product-pm occupation */
const PRODUCT = /产品经理|产品助理|产品运营/;
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
    keywords: ['嵌入式', '单片机', '固件', '硬件工程师'],
    include: /嵌入式|单片机|STM32|硬件工程师|硬件开发|MCU|固件|驱动开发|底层软件|(?<![A-Za-z])BSP(?![A-Za-z])|FPGA|Linux驱动|RTOS/,
  },
  // EE / automation (expert 2026-10-15). 硬件工程师 / 硬件开发 stay 嵌入式 (rule above); 硬件测试 -> 电子仪器与电子测量.
  {
    code: '2-02-07-07', name: '自动控制工程技术人员',
    keywords: ['自动化工程师', '电气自动化', 'PLC'],
    include: /电气自动化|自动化工程|自动化工程师|自动控制|控制工程师|控制系统工程|PLC|DCS|过程控制|仪控|自控/i,
    exclude: /自动化测试|测试自动化|办公自动化|营销自动化|流程自动化|RPA/i,
  },
  {
    code: '2-02-11-01', name: '电工电器工程技术人员',
    keywords: ['电气工程师', '电力'],
    include: /电气|电力|供配电|配电|变电|输电|电网|继电保护|电机工程|电机设计|电机研发|电力电子|高压|新能源发电|光伏电站|储能电站/,
    exclude: /电力销售|电力营销|抄表/,
  },
  {
    code: '2-02-09-04', name: '电子仪器与电子测量工程技术人员',
    keywords: ['电子工程师', '硬件测试'],
    include: /电子工程师|电子工程|硬件测试|测试工程师[（(]硬件|电子测量|测试测量|仪器仪表|仪表工程|电子技术|电子设计|电路设计|射频工程|射频测试|EMC|电磁兼容/i,
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
  /** why it is (un)classified: 'rule' | 'first_role' | 'multi_role' | 'generic' | 'excluded_word' | 'mgmt_trainee' | 'design' | 'not_tech' | 'no_match' | 'support' | 'product' | 'chip' | 'cpp' (C/C++ -> software) | 'cpp_embedded' (C/C++ moved to 嵌入式 by JD) */
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

export const SOFTWARE_CODE = '2-02-10-03';
export const EMBEDDED_CODE = '2-02-10-06';
/** C/C++ titles (classify_reason 'cpp'): software by title; moved to embedded after skill extraction if the JD is embedded */
const CPP = /C\+\+|(?<![A-Za-z#])C语言/i;
/** delivery / support roles: not in the 8 pilot occupations (expert 2026-10-14) */
const SUPPORT = /实施工程师|技术支持|交付经理|交付工程师|售后/;
/** chip titles: left for a later semiconductor batch */
const CHIP = /芯片|集成电路|(?<![A-Za-z])IC设计|版图/i;
/** a concrete role word; trainee/intern titles without one are generic */
const ROLE_WORD = /开发|工程师|算法|测试|数据|软件|前端|后端|运维|硬件|嵌入式|分析|安全|Java|Python|C\+\+|网络/i;
const TRAINEE = /(暑期)?(实习生|管培生|管理培训生|校招生|培训生)(招聘)?$/;
const GENERIC_EXACT = /^(技术类|工程技术岗|技术岗|研发类|实习生|综合实习生)$/;

const PLACES = '北京|上海|天津|重庆|深圳|广州|杭州|成都|武汉|南京|苏州|西安|济南|青岛|烟台|威海|潍坊|淄博|东营|临沂|济宁|合肥|长沙|郑州|沈阳|大连|厦门|福州|宁波|无锡|珠海|东莞|佛山|昆明|贵阳|南宁|南昌|太原|石家庄|哈尔滨|长春|兰州|乌鲁木齐|呼和浩特|海口|雄安|山东|山西|河北|河南|湖北|湖南|江苏|浙江|安徽|福建|江西|广东|广西|云南|贵州|四川|陕西|甘肃|青海|辽宁|吉林|黑龙江|内蒙古|宁夏|新疆|西藏|海南|全国';
const LEAD_YEAR = /^(?:20\d{2}|\d{2})\s*(?:届|年)?(?:秋招|春招|校招)?[-—–_\s]*/;
const TRAIL_PLACE = new RegExp(`(?:\\s*[-—–_·]\\s*(?:${PLACES})(?:[市省]|地区|区域)?|\\s*[（(](?:${PLACES})(?:[市省、,，/]|${PLACES})*[）)])\\s*$`);
const TRAIL_CODE = /\s*[（(\[【]\s*[A-Za-z]{0,4}[-_]?\d{2,}[A-Za-z0-9-]*\s*[）)\]】]\s*$/;

/** strip leading year ('2026', '2027届'), trailing location ('-深圳', '（深圳）') and bracketed codes ('(J10605)') before matching */
export function normalizeTitle(title: string): string {
  let t = title.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(TRAIL_CODE, '').replace(TRAIL_PLACE, '').trim();
    if (t === before) break;
  }
  const y = t.replace(LEAD_YEAR, '').trim();
  return y.length ? y : t;
}

/** title -> occupation + flags. Order: normalize, multi-role, generic, product, support, chip, exclusion words, 管培, design, then rules (first TECH alternative for 'a / b'). */
export function classifyPosting(title: string): Classification {
  // 'C/C++', 'Qt/C++' are one skill, not two roles: protect the slash before splitting
  const t = normalizeTitle(title).replace(/(?<![A-Za-z])(?:C|QT|Qt|qt)\s*[\/／]\s*C\+\+/g, 'C++');
  const c = t.replace(/\s+/g, '');
  const none = (reason: string, multiRole = false): Classification => ({ code: null, confidence: null, multiRole, reason });
  const items = c.replace(/[…]+|\.{3,}|等$/g, '').split(ROLE_SEP).filter((x) => x.length > 0);
  if (items.length >= MULTI_ROLE_MIN) return none('multi_role', true);
  if (GENERIC.test(c) || GENERIC_EXACT.test(c)) return none('generic');
  if (PRODUCT.test(c)) return none('product');
  if (SUPPORT.test(c)) return none('support');
  if (CHIP.test(c)) return none('chip');
  if (EXCLUDE_WORDS.test(c)) return none('excluded_word');
  if (NOT_TECH.test(c) && !ROLE_WORD.test(c)) return none('not_tech');
  const noParen = c.replace(/[（(][^）)]*[）)]/g, '');
  if (MGMT_TRAINEE.test(c) && !TECH_WORD.test(c.replace(MGMT_TRAINEE, ''))) return none('mgmt_trainee');
  if (TRAINEE.test(noParen) && !ROLE_WORD.test(noParen.replace(TRAINEE, '').replace(/研发|技术|\d+届?|暑期/g, ''))) return none('generic');
  if (/设计/.test(c) && !DESIGN_TECH.test(c)) return none('design');
  const hit = (code: string, reason: string): Classification =>
    ({ code, confidence: 0.8, multiRole: false, reason: code === SOFTWARE_CODE && CPP.test(c) ? 'cpp' : reason });
  const alts = t.split(ALT_SEP).map((x) => x.replace(/\s+/g, '')).filter(Boolean);
  if (alts.length > 1) {
    // first TECH alternative wins: '市场/数据分析师' -> 数据分析, '电气/视觉工程师' -> 视觉
    for (const a of alts) { const code = matchRules(a); if (code) return hit(code, 'first_role'); }
    const code = matchRules(c);
    if (code) return hit(code, 'rule');
    return none(NOT_TECH.test(alts[0]!) ? 'not_tech' : 'no_match');
  }
  const code = matchRules(c);
  return code ? hit(code, 'rule') : none(NOT_TECH.test(c) ? 'not_tech' : 'no_match');
}

/** embedded terms that move a C/C++ posting to 嵌入式 after skill extraction (JOBS_EMBEDDED_TERMS=a,b,c overrides) */
export const EMBEDDED_TERMS = (process.env.JOBS_EMBEDDED_TERMS ?? '单片机,RTOS,FreeRTOS,驱动开发,Linux驱动,设备驱动,驱动程序,驱动,嵌入式,MCU,STM32,固件,BSP,ARM Cortex,裸机,uboot,u-boot')
  .split(',').map((s) => s.trim()).filter(Boolean);
/** '驱动' also appears in 数据驱动 / 业务驱动 / 驱动力: ignored */
const DRIVE_FALSE = /数据驱动|业务驱动|价值驱动|技术驱动|创新驱动|驱动力|自我驱动|自驱/g;
export function embeddedEvidence(text: string, terms = EMBEDDED_TERMS): string | null {
  const t = text.replace(DRIVE_FALSE, '').toLowerCase();
  return terms.find((x) => t.includes(x.toLowerCase())) ?? null;
}

/** title -> occupation; confidence 0.8 for an explicit title match, null when nothing matches */
export function classifyTitle(title: string): { code: string; confidence: number } | null {
  const r = classifyPosting(title);
  return r.code ? { code: r.code, confidence: r.confidence! } : null;
}

/** first-batch cities: city-level salary_stat rows are computed for these; every posting still counts in city '全部' (all cities in the sample; never labelled 全国) */
export const TARGET_CITIES = ['北京', '上海', '深圳', '杭州', '广州', '成都', '武汉', '济南', '青岛'];
