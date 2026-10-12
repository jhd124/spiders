import { useEffect, useState, type ReactElement } from 'react';
import { CrawlersPage } from './CrawlersPage';
import { RunPage } from './RunPage';
import { DataPage } from './DataPage';
import { ReviewPage } from './ReviewPage';

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
  else page = <CrawlersPage />;

  const tab = parts[0] === 'data' ? 'data' : parts[0] === 'review' ? 'review' : 'crawlers';
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">🕷 spiders</span>
        <nav>
          <a href="#/crawlers" className={tab === 'crawlers' ? 'active' : ''}>爬虫管理</a>
          <a href="#/data" className={tab === 'data' ? 'active' : ''}>数据查询</a>
          <a href="#/review" className={tab === 'review' ? 'active' : ''}>课程审核</a>
        </nav>
        <span className="muted small">本地控制台 · 无鉴权</span>
      </header>
      <main>{page}</main>
    </div>
  );
}
