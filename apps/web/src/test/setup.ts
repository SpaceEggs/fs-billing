import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { i18n, initI18n } from '../i18n';

// 现有测试默认在中文下运行；英文用例另用 renderWithLocale。
initI18n();

beforeEach(async () => {
  await i18n.changeLanguage('zh');
});

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
