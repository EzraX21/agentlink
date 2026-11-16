import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function Placeholder() {
  return (
    <div className="flex h-screen items-center justify-center text-neutral-500">
      AgentLink · M0 占位页（M6 换成真正的客户端）
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
