import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom 未实现滚动；路由恢复滚动位置时会调用。
window.scrollTo = () => {};

// Radix 的弹层（Popover）与 cmdk 依赖这两个浏览器接口，jsdom 没有。
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  value: () => {},
  configurable: true,
  writable: true,
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});
