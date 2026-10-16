#!/usr/bin/env python3
# Generates grad_legacy_map.csv from the official 1997 学科目录 page (saved HTML) + expert/proposed rows. Paths are box-local; kept for provenance.
# NOTE: superseded — grad_legacy_map.csv was expert-reviewed 2026-10-16 and edited directly; re-running this would reset it. Do not regenerate.
import re, html, csv, sqlite3
t=open('/workspace/xk1997.html',encoding='utf-8',errors='ignore').read()
t=html.unescape(re.sub(r'<[^>]+>','\n',t)).replace('\xa0',' ')
two=re.findall(r'(\d{6})\s*([^\n\d]{2,40})',t)
one=dict(re.findall(r'(?m)^\s*(\d{4})\s*([^\n\d]{2,40})',t))
g=dict(sqlite3.connect('/tmp/gwyfull/career.db').execute("select code,name from gwy_grad_discipline").fetchall())
SRC97='http://www.moe.gov.cn/srcsite/A22/moe_833/200512/t20051223_88437.html'
rows={}
def clean(n): return re.sub(r'[（(].*$','',n).strip()
for code,name in two:
  n=clean(name); p=code[:4]
  note=f"1997目录 {code} 属一级学科 {p} {clean(one.get(p,'?'))}"
  if p=='0504':
    p='1301|1403' if n=='设计艺术学' else '1301'
    note+='；1997“0504艺术学”于2011年升为13艺术学门类，2022对应1301艺术学'+('（设计另有1403设计学）' if n=='设计艺术学' else '')+'，需专家确认'
  elif p not in g: note+='；该代码不在2022目录，需专家确认'
  elif clean(g[p])!=clean(one.get(p,'')): note+=f'；2022目录 {p} 为“{g[p]}”'
  rows[n]=dict(old_name=n,old_code=code,parent_codes=p,source=SRC97,note=note,reviewed='0')
  # names like 「矿物学、岩石学、矿床学」 are one discipline; also index the parts
  for part in re.split(r'[、]',n):
    if part!=n and part not in rows: rows[part]=dict(rows[n],old_name=part,note=rows[n]['note']+f'；拆自“{n}”')
OV=[('计算机技术','','0854|0812','专家规则：专业学位领域（原085211），不只归学术学位'),
    ('大数据技术与工程','','0854|0812','专家规则：电子信息专业学位领域（085411）'),
    ('网络与信息安全','','0839|0854','专家规则：电子信息专业学位领域'),
    ('英语口译','','0551','专家规则：翻译专业学位领域'),('英语笔译','','0551','专家规则：翻译专业学位领域'),
    ('食品科学','083201','0832','专家规则'),
    ('会计学','120201','1202|1253','专家规则（研究生）'),('审计学','','1202|1257','专家规则（研究生）'),('财务管理','','1202','专家规则（研究生）')]
for n,c,p,note in OV: rows[n]=dict(old_name=n,old_code=c or rows.get(n,{}).get('old_code',''),parent_codes=p,source='专家规则',note=note,reviewed='0')
# names in the unresolved list that are not in the 1997 目录: proposals, flagged
PROP=[('计量经济学','','0202','不在1997目录；1997“数量经济学”020209属0202，按同类提议'),
      ('国际金融','','0202|0251','不在1997目录（1990目录旧名）；金融学020204属0202，金融专业学位0251'),
      ('货币银行学','','0202|0251','不在1997目录（1990目录旧名，现金融学020204）'),
      ('海上交通工程','','0823','不在1997目录；交通运输工程一级学科（行业自设方向），提议'),
      ('海上安全与环境管理','','0823','不在1997目录；交通运输工程（海事方向），提议'),
      ('港口','','0815|0823','不在1997目录；1997“港口、海岸及近海工程”081505属0815；港口管理亦可属0823，需专家定'),
      ('气候学','','0706','不在1997目录；1997气象学070601属0706大气科学'),
      ('大气遥感与大气探测','','0706','不在1997目录；大气科学方向'),
      ('电子与计算机工程','','0812|0854','不在1997目录；提议'),
      ('船舶工程','','0824','不在1997目录；船舶与海洋工程一级学科'),
      ('载运工具运用工程','082304','0823','1997目录 082304'),
      ('农艺与种业','095131','0951','2022 农业专业学位领域（专业学位，非学术学位）'),
      ('资源利用与植物保护','095132','0951','2022 农业专业学位领域'),
      ('畜牧','095133','0951','2022 农业专业学位领域'),
      ('渔业发展','095134','0951','2022 农业专业学位领域'),
      ('食品加工与安全','095135','0951|0955','农业专业学位领域；亦可对应0955食品与营养，需专家定'),
      ('食品工程','','0832|0860','不在1997目录；1997“食品科学”083201属0832；专业学位可属0860生物与医药，提议'),
      ('交通安全与环境','','0823|0861','不在1997目录；提议 交通运输工程/交通运输专业学位'),
      ('水路交通运输','','0823|0861','不在1997目录；提议'),
      ('交通运输安全与环境工程','','0823|0861','不在1997目录；提议'),
      ('航海科学与技术','','0824|0861','不在1997目录；提议 船舶与海洋工程/交通运输')]
for n,c,p,note in PROP:
  if n not in rows: rows[n]=dict(old_name=n,old_code=c,parent_codes=p,source='提议（非官方目录）',note=note,reviewed='0')
with open('/workspace/spiders/GWY/rules/grad_legacy_map.csv','w',newline='') as f:
  f.write('# 旧研究生二级学科/专业领域名称 → 2022《研究生教育学科专业目录》一级学科/专业学位类别（|分隔）。reviewed=0 待专家抽查。\n')
  f.write(f'# 官方来源：《授予博士、硕士学位和培养研究生的学科、专业目录》(1997年颁布) {SRC97}（经 hudong.moe.gov.cn 镜像抓取）；2011目录只列一级学科。\n')
  w=csv.DictWriter(f,fieldnames=['old_name','old_code','parent_codes','source','note','reviewed']); w.writeheader()
  for r in sorted(rows.values(), key=lambda r:(r['old_code'] or '999999', r['old_name'])): w.writerow(r)
print(len(rows))
