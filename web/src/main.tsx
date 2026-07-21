import 'antd/dist/reset.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Aera Admin root element is unavailable');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
