import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom 没有布局引擎，`@tanstack/react-virtual` 量到的高度是 0，
 * 于是一条消息都不渲染。这里给滚动容器一个固定尺寸，让虚拟滚动的计算
 * 有输入可算 —— 测的是"消息渲染与文本呈现"，不是"滚动条位置"。
 */
const VIEWPORT_HEIGHT = 800;

class ResizeObserverStub {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    const box: ResizeObserverSize = { blockSize: VIEWPORT_HEIGHT, inlineSize: 600 };
    this.cb(
      [
        {
          target,
          contentRect: { width: 600, height: VIEWPORT_HEIGHT, top: 0, left: 0, bottom: VIEWPORT_HEIGHT, right: 600, x: 0, y: 0, toJSON: () => ({}) },
          borderBoxSize: [box],
          contentBoxSize: [box],
          devicePixelContentBoxSize: [box],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  // 让滚动容器与测量元素都有非零尺寸
  Element.prototype.getBoundingClientRect = function getRect(this: Element) {
    return {
      width: 600,
      height: VIEWPORT_HEIGHT,
      top: 0,
      left: 0,
      bottom: VIEWPORT_HEIGHT,
      right: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 60,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT_HEIGHT,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 600,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});