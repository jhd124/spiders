import type { RunStatus } from '../../shared/types';

const LABEL: Record<RunStatus, string> = { running: '运行中', success: '成功', failed: '失败', stopped: '已停止' };

export function StatusBadge({ status }: { status: RunStatus | null | undefined }) {
  if (!status) return <span className="badge none">未运行</span>;
  return <span className={`badge ${status}`}>{LABEL[status]}</span>;
}
