import { useEffect, useState, type ReactElement } from 'react';
import { CrawlersPage } from './CrawlersPage';
import { RunPage } from './RunPage';
import { DataPage } from './DataPage';
import { ReviewPage } from './ReviewPage';
import { MatchPage } from './MatchPage';
import { AliasesPage } from './AliasesPage';
import { JobsDemandPage } from './JobsDemandPage';
import { CrawlLogsPage } from './CrawlLogsPage';

/** Tiny hash router: #/crawlers, #/runs/<id>, #/data/<group> */
function useHash(): string {
  const [h, setH] = useState(() => location.hash.slice(1) || '/crawlers');
  useEffect(() => {
    const on = () => setH(location.hash.slice(1) || '/crawlers');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return h;
}

export function App() {
  const hash = useHash();
  const [path] = hash.split('?');
  const parts = (path ?? '').split('/').filter(Boolean);
  let page: ReactElement;
  if (parts[0] === 'runs' && parts[1]) page = <RunPage id={Number(parts[1])} />;
  else if (parts[0] === 'data') page = <DataPage group={parts[1]} />;
  else if (parts[0] === 'review') page = <ReviewPage sel={parts[1] ? decodeURIComponent(parts[1]) : undefined} />;
  else if (parts[0] === 'match') page = <MatchPage code={parts[1] ? decodeURIComponent(parts[1]) : undefined} />;
  else if (parts[0] === 'aliases') page = <AliasesPage />;
  else if (parts[0] === 'jobs') page = <JobsDemandPage code={parts[1] ? decodeURIComponent(parts[1]) : undefined} />;
  else if (parts[0] === 'crawl-logs') page = <CrawlLogsPage id={parts[1] ? decodeURIComponent(parts[1]) : undefined} />;
  else page = <CrawlersPage />;

  const tab = parts[0] === 'data' ? 'data' : parts[0] === 'review' ? 'review' : parts[0] === 'match' ? 'match' : parts[0] === 'aliases' ? 'aliases' : parts[0] === 'jobs' ? 'jobs' : parts[0] === 'crawl-logs' ? 'crawl-logs' : 'crawlers';
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">🕷 spiders</span>
        <nav>
          <a href="#/crawlers" className={tab === 'crawlers' ? 'active' : ''}>爬虫管理</a>
          <a href="#/crawl-logs" className={tab === 'crawl-logs' ? 'active' : ''}>抓取日志</a>
          <a href="#/data" className={tab === 'data' ? 'active' : ''}>数据查询</a>
          <a href="#/review" className={tab === 'review' ? 'active' : ''}>课程审核</a>
          <a href="#/match" className={tab === 'match' ? 'active' : ''}>职业匹配</a>
          <a href="#/aliases" className={tab === 'aliases' ? 'active' : ''}>技能别名</a>
          <a href="#/jobs" className={tab === 'jobs' ? 'active' : ''}>岗位技能需求</a>
        </nav>
        <span className="muted small">本地控制台 · 无鉴权</span>
      </header>
      <main>{page}</main>
    </div>
  );
}
