import { useEffect, useState } from 'react';

/**
 * 响应式断点（对齐 TG 桌面版：窄窗口时收起侧栏，只显示聊天）。
 *
 * 用 `matchMedia` 而不是监听 resize：只在跨越断点时触发一次，不随每个像素重渲染。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches);
    setMatches(mql.matches);
    // Safari < 14 只有 addListener
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}

/** 窄屏（手机/窄窗口）：单栏布局。 */
export const NARROW_QUERY = '(max-width: 767px)';
