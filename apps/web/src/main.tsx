import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { healthResponseSchema } from '@fs-billing/shared';
import './style.css';

function App() {
  const [status, setStatus] = useState('正在连接');
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('API unavailable');
        const result = healthResponseSchema.parse(await response.json());
        if (result.service !== 'api') throw new Error('Unexpected service');
        setStatus('连接正常');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('暂时无法连接');
      });
    return () => controller.abort();
  }, []);
  return (
    <main>
      <p className="eyebrow">FS-Billing</p>
      <h1>电话计费系统</h1>
      <p>客户门户与管理后台将在后续阶段开放。</p>
      <p role="status">服务状态：{status}</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
