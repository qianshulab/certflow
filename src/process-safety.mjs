// Preserve locks when an OS could not confirm termination. Aggregate deployment
// errors must retain this signal through their nested causes.
export function processCleanupError() {
  const error = new Error('程序执行超时，且无法确认所有子进程已停止。运行锁将保留；请确认相关进程全部结束后按故障恢复说明处理。');
  error.code = 'EPROCESSCLEANUP';
  return error;
}

export function requiresProcessCleanup(error) {
  const seen = new Set();
  const pending = [error];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (current.code === 'EPROCESSCLEANUP') return true;
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return false;
}
