import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom 未实现滚动；路由恢复滚动位置时会调用。
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});
