#!/usr/bin/env python3
"""
Offline helper (needs poppler `pdftotext`; not run on the server).
Reads the 《职业分类大典（2022年版）》社会公示稿 正文 PDF and writes:
  CAREER/seeds/occupation_draft_2022.csv   code,name,flag  (细类 as printed in the 公示稿; flag = S | L | L/S | '')
  CAREER/review/occupation_name_diff.csv   细类 whose imported name != a single-line 公示稿 name
    (the committed CSV additionally carries the expert's decision / alias_added / decided_by columns, added by hand
     on 2026-10-12; re-running this script overwrites them, so don't)
Usage:
  curl -A 'spiders-bot/0.1 (+https://github.com/jhd124/spiders)' -o draft.pdf \
    https://file.m12333.cn/upfile/download/063d5abb-fada-f27f-a1e8-3de63b44d5df.pdf
  python3 CAREER/tools/draft_2022.py draft.pdf data/clean/career-occupations.json
"""
import csv, json, os, re, subprocess, sys

FLAG = re.compile(r'(L/S|L|S)$')
HERE = os.path.dirname(os.path.abspath(__file__))

def draft_records(pdf):
    txt = subprocess.run(['pdftotext', pdf, '-'], capture_output=True, check=True, text=True).stdout
    L = [l.strip() for l in txt.split('\n')]
    recs = {}
    for i in range(len(L) - 5):
        if re.fullmatch(r'\d', L[i]) and re.fullmatch(r'\d{2}', L[i+1]) and re.fullmatch(r'\d{2}', L[i+2]):
            m = re.fullmatch(r'(\d{2}) ?(\S.*)', L[i+3])
            if m:
                code = f'{L[i]}-{L[i+1]}-{L[i+2]}-{m.group(1)}'
                recs.setdefault(code, []).append((m.group(2).replace(' ', ''), L[i+4].replace(' ', '')))
    out = {}
    for code, v in recs.items():
        flag, single, joined = '', [], []
        for n, nx in v:
            fm = FLAG.search(n)
            if fm:
                flag = fm.group(1); n = n[:-len(flag)]
            elif re.fullmatch(r'\S*?(L/S|L|S)', nx) and len(nx) < 15:
                flag = FLAG.search(nx).group(1)
            single.append(n)
            if re.fullmatch(r'[\u4e00-\u9fff（）()、]{1,8}(L/S|L|S)?', nx) and not nx.startswith(('在', '从事', '本', '主要')):
                joined.append(n + FLAG.sub('', nx))
        out[code] = {'flag': flag, 'single': sorted(set(single), key=len), 'all': sorted(set(single + joined), key=len)}
    return out

def main(pdf, clean_json):
    d = draft_records(pdf)
    seed = os.path.join(HERE, '..', 'seeds', 'occupation_draft_2022.csv')
    with open(seed, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f, lineterminator='\n'); w.writerow(['code', 'name', 'flag'])
        for code in sorted(d, key=lambda c: [int(x) for x in c.split('-')]):
            # longest reading of the name (a wrapped PDF line may still be cut short; the importer
            # therefore matches by exact name first, then same code + prefix)
            w.writerow([code, d[code]['all'][-1], d[code]['flag']])
    occ = [o for o in json.load(open(clean_json, encoding='utf-8'))['occupations'] if o['level'] == 4]
    final_names = {o['name']: o['code'] for o in occ}
    singles = {n for v in d.values() for n in v['single']}
    any_name = {n: c for c, v in d.items() for n in v['all']}
    rows = []
    for o in occ:
        if o['name'] in singles:
            continue
        same = d.get(o['code'])
        if same and (o['name'] in same['all'] or any(o['name'].startswith(n) and len(n) >= 6 for n in same['single'])):
            dn, kind = same['all'][-1], '公示稿PDF换行，名称一致（非差异）'
        elif o['name'] in any_name:
            dn, kind = o['name'], f"重新编号：公示稿代码 {any_name[o['name']]}"
        elif same:
            dn = same['all'][-1]
            moved = final_names.get(dn)
            kind = f'正式版新增/改名占用此码；公示稿此码名称在正式版为 {moved}' if moved else '同码改名（正式版名称调整）'
        else:
            dn, kind = '', '公示稿无此代码（正式版新增职业）'
        rows.append([o['code'], o['name'], dn, kind])
    rep = os.path.join(HERE, '..', 'review', 'occupation_name_diff.csv')
    with open(rep, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f, lineterminator='\n'); w.writerow(['code', 'imported_name', 'draft_name', 'note']); w.writerows(rows)
    print(f'draft 细类 {len(d)}, diff rows {len(rows)}')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
