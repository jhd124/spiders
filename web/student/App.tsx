import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, href, type MajorDetail, type MajorForOcc, type MajorItem, type Occ, type OccDetail, type CourseRef, type GwyForMajor } from './api';

const FOOTER = '本结果依据各校公开的培养方案和招聘数据，反映的是课程设置，不代表教学质量或就业结果。目前只收录了 3 所试点学校。';

function useHash() {
  const [h, setH] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => { setH(location.hash.slice(1) || '/'); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return h.split('/').filter(Boolean).map(decodeURIComponent);
}

function useLoad<T>(f: () => Promise<T>, deps: unknown[]) {
  const [s, setS] = useState<{ data?: T; err?: string }>({});
  useEffect(() => { let on = true; setS({}); f().then((data) => on && setS({ data }), (e: Error) => on && setS({ err: e.message })); return () => { on = false; }; }, deps);
  return s;
}

function Loaded<T>({ s, children }: { s: { data?: T; err?: string }; children: (d: T) => ReactNode }) {
  if (s.err) return <p className="muted">{s.err}</p>;
  if (!s.data) return <p className="muted">加载中…</p>;
  return <>{children(s.data)}</>;
}

const Back = ({ to, text }: { to: string; text: string }) => <a className="back" href={to}>‹ {text}</a>;
const Badge = ({ t }: { t: CourseRef['type'] }) => <span className={`badge b-${t}`}>{t}</span>;
const yuan = (n: number | null) => (n == null ? '—' : `${(n / 1000).toFixed(1)}k`);

export function StudentApp() {
  const p = useHash();
  let page: ReactNode;
  if (p[0] === 'occ' && p[1] && p[2] && p[3]) page = <MajorForOccPage code={p[1]} school={p[2]} major={p[3]} />;
  else if (p[0] === 'occ' && p[1]) page = <OccPage code={p[1]} />;
  else if (p[0] === 'major' && p[1] && p[2]) page = <MajorPage school={p[1]} major={p[2]} />;
  else page = <Home key={p[0] ?? ''} initial={p[0] === 'majors' ? 'major' : 'occ'} />;
  return (
    <div className="s-app">
      <header className="s-top"><a href={href.home}>职业 · 专业</a></header>
      <main className="s-main">{page}</main>
      <footer className="s-foot">{FOOTER}</footer>
    </div>
  );
}

function Home({ initial }: { initial: 'occ' | 'major' }) {
  const [tab, setTab] = useState<'occ' | 'major'>(initial);
  return (
    <>
      <div className="tabs">
        <button className={tab === 'occ' ? 'on' : ''} onClick={() => setTab('occ')}>按职业找专业</button>
        <button className={tab === 'major' ? 'on' : ''} onClick={() => setTab('major')}>这个专业能做什么</button>
      </div>
      {tab === 'occ' ? <OccSearch /> : <MajorPick />}
    </>
  );
}

function OccSearch() {
  const s = useLoad(api.occupations, []);
  const [q, setQ] = useState('');
  return (
    <section>
      <input className="search" placeholder="搜职业：如 程序员、算法、PLC、电气" value={q} onChange={(e) => setQ(e.target.value)} />
      <Loaded s={s}>{(list: Occ[]) => {
        const k = q.trim().toLowerCase();
        const hits = list.filter((o) => !k || [o.display_name, o.official_name, ...o.aliases].some((t) => t.toLowerCase().includes(k)));
        return hits.length ? (
          <ul className="cards">{hits.map((o) => (
            <li key={o.code}><a href={href.occ(o.code)}>
              <b>{o.display_name}</b><small>{o.official_name}</small>
              {o.aliases.length > 0 && <span className="tags">{o.aliases.join(' · ')}</span>}
            </a></li>))}
          </ul>) : <p className="muted">没有找到「{q}」，试试换个说法。</p>;
      }}</Loaded>
    </section>
  );
}

function MajorPick() {
  const s = useLoad(api.majors, []);
  const [school, setSchool] = useState('');
  return (
    <Loaded s={s}>{(list: MajorItem[]) => {
      const schools = [...new Map(list.map((m) => [m.school_id, m.school])).entries()];
      const cur = school || schools[0]?.[0] || '';
      return (
        <section>
          <div className="chips">{schools.map(([id, name]) => <button key={id} className={id === cur ? 'on' : ''} onClick={() => setSchool(id)}>{name}</button>)}</div>
          <ul className="cards">{list.filter((m) => m.school_id === cur).map((m) => (
            <li key={m.major_code}><a href={href.major(m.school_id, m.major_code)}><b>{m.major}</b><small>{m.major_code}</small></a></li>))}
          </ul>
        </section>
      );
    }}</Loaded>
  );
}

function OccPage({ code }: { code: string }) {
  const s = useLoad(() => api.occupation(code), [code]);
  return (
    <>
      <Back to={href.home} text="首页" />
      <Loaded s={s}>{(d: OccDetail) => (
        <>
          <h1>{d.display_name}</h1>
          <p className="official">职业分类大典：{d.official_name}</p>

          <h2>需要的能力</h2>
          <p className="lbl">核心能力</p>
          <div className="pills">{d.core_skills.map((x) => <span key={x} className="pill core">{x}</span>)}</div>
          <p className="lbl">一般能力</p>
          <div className="pills">{d.general_skills.map((x) => <span key={x} className="pill">{x}</span>)}</div>

          <h2>校招起薪（按学历要求，月薪）</h2>
          {d.salary.length ? (
            <>
              <table className="sal"><thead><tr><th>学历</th><th>样本</th><th>P25</th><th>中位数</th><th>P75</th></tr></thead>
                <tbody>{d.salary.map((r) => (
                  <tr key={r.education}><td>{r.education === '全部' ? '全部学历' : r.education}</td><td>{r.sample_size}{r.note ? '*' : ''}</td>
                    {r.p50 == null ? <td colSpan={3} className="muted">样本不足 30 条，只显示数量</td> : <><td>{yuan(r.p25)}</td><td><b>{yuan(r.p50)}</b></td><td>{yuan(r.p75)}</td></>}
                  </tr>))}
                </tbody></table>
              {d.salary.some((r) => r.note) && <p className="note">* 样本较少，仅供参考</p>}
              {[...new Set(d.salary.map((r) => r.source_label.replace(/[，,]\s*样本\s*\d+\s*条/, '')).filter(Boolean))].map((l) => <p key={l} className="src">{l}</p>)}
            </>) : <p className="muted">暂时没有这个职业的薪资数据。</p>}

          <h2>招聘要求里常见的技能</h2>
          {d.demand.postings ? (
            <>
              <ul className="bars">{d.demand.skills.map((x) => (
                <li key={x.skill}><span className="bl">{x.skill}</span><span className="bar"><i style={{ width: `${Math.min(100, x.pct)}%` }} /></span><span className="bp">{x.pct}%</span></li>))}
              </ul>
              <p className="src">基于 {d.demand.postings} 条招聘信息</p>
            </>) : <p className="muted">暂时没有足够的招聘信息。</p>}

          <h2>哪些专业的课程覆盖得更全</h2>
          <p className="muted small">按必修和限选课覆盖核心能力的比例排序</p>
          <Legend first={d.majors[0]} />
          <MajorList code={d.code} majors={d.majors} />
        </>)}
      </Loaded>
    </>
  );
}

const TOP_MAJORS = 6;
function MajorList({ code, majors }: { code: string; majors: OccDetail['majors'] }) {
  const [all, setAll] = useState(false);
  const shown = all ? majors : majors.slice(0, TOP_MAJORS);
  return (
    <>
          <ul className="cards">{shown.map((m) => (
            <li key={m.school_id + m.major_code}><a href={href.majorForOcc(code, m.school_id, m.major_code)}>
              <b>{m.school} · {m.major}</b><span className="score">{m.label}</span>
            </a></li>))}
          </ul>
          {majors.length > TOP_MAJORS && <button className="more" onClick={() => setAll(!all)}>{all ? '收起' : `展开全部 ${majors.length} 个专业`}</button>}
    </>
  );
}

const Courses = ({ list }: { list: CourseRef[] }) => (
  <ul className="courses">{list.map((c) => <li key={c.course}><Badge t={c.type} /> {c.course}</li>)}</ul>
);

function MajorForOccPage({ code, school, major }: { code: string; school: string; major: string }) {
  const s = useLoad(() => api.majorForOcc(code, school, major), [code, school, major]);
  return (
    <>
      <Back to={href.occ(code)} text="返回职业" />
      <Loaded s={s}>{(d: MajorForOcc) => (
        <>
          <h1>{d.school} · {d.major}</h1>
          <p className="official">对照职业：{d.occupation.display_name}（{d.occupation.official_name}）</p>
          <p className="sentence">{d.sentence}</p>
          {d.covered.map((x) => <div key={x.skill} className="skill"><h3>✓ {x.skill}</h3><Courses list={x.courses} /></div>)}
          {d.to_supplement.length > 0 && (
            <>
              <h2>这些需要靠选修或自学补上</h2>
              {d.to_supplement.map((x) => (
                <div key={x.skill} className="skill sup"><h3>{x.skill}</h3>
                  {x.courses.length > 0 && <Courses list={x.courses} />}
                  {x.in_practice && <p className="muted small">在课程设计、实验等实践环节中涉及</p>}
                  {!x.courses.length && !x.in_practice && <p className="muted small">培养方案里没有找到对应课程</p>}</div>))}
            </>)}
          <p><a href={href.major(d.school_id, d.major_code)}>这个专业还能做什么 ›</a></p>
        </>)}
      </Loaded>
    </>
  );
}

function MajorPage({ school, major }: { school: string; major: string }) {
  const s = useLoad(() => api.major(school, major), [school, major]);
  return (
    <>
      <Back to={href.home} text="首页" />
      <Loaded s={s}>{(d: MajorDetail) => (
        <>
          <h1>{d.school} · {d.major}</h1>
          <p className="official">专业代码 {d.major_code}</p>
          <h2>这个专业能做什么</h2>
          <p className="muted small">按必修和限选课覆盖核心能力的比例排序</p>
          <Legend first={d.occupations[0]} />
          <ul className="cards">{d.occupations.map((o) => (
            <li key={o.code}><a href={href.majorForOcc(o.code, d.school_id, d.major_code)}>
              <b>{o.display_name}</b><small>{o.official_name}</small><span className="score">{o.label}</span>
            </a></li>))}
          </ul>
          {d.not_covered.length > 0 && <p className="muted small fold">课程基本不涉及：{d.not_covered.join('、')}</p>}
          <GwyBlock major={d.major_code} />
        </>)}
      </Loaded>
    </>
  );
}

/** 能报考的国考岗位: hidden when the API has no 国考 data (404) */
function GwyBlock({ major }: { major: string }) {
  const s = useLoad(() => api.gwy(major), [major]);
  if (!s.data) return null;
  const g: GwyForMajor = s.data, u = g.undergrad;
  return (
    <section className="gwy">
      <h2>能报考的国考岗位</h2>
      <div className="gwy-main"><b>{u.positions}</b> 个岗位<span className="muted">，共招 {u.hires} 人（本科学历即可报考）</span></div>
      <ul className="gwy-stats">
        <li>要求中共党员 <b>{u.party.positions}</b> 个<span className="muted">（{u.party.pct}%）</span></li>
        <li>限应届毕业生 <b>{u.fresh_grad.positions}</b> 个<span className="muted">（{u.fresh_grad.pct}%）</span></li>
      </ul>
      <div className="gwy-grad"><span>需读研后报考</span><b>{g.needs_grad.positions}</b> 个岗位<span className="muted">，共招 {g.needs_grad.hires} 人</span></div>
      <p className="muted small">{g.note}</p>
    </section>
  );
}

/** first appearance of 核心能力 n/m: explain with the first row's numbers */
const Legend = ({ first }: { first?: { core_covered: number; core_total: number } }) =>
  first ? <p className="muted small legend">{first.core_covered}/{first.core_total} 表示 {first.core_total} 项核心能力里，必修和限选课教到了 {first.core_covered} 项</p> : null;
