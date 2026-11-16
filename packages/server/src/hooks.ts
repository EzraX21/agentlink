import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Content } from '@agentlink/protocol';

/**
 * 插件钩子（实现计划 M11）。
 *
 * 两个钩子，契约极简：
 *   - `onMessageIn(msg) => msg | null`   返回 null 则**丢弃**该消息（不入库、不推送）
 *   - `onMessageOut(msg) => msg`         发出前改写
 *
 * 钩子以**本地 ESM 模块**加载，路径由 `HOOKS_MODULE` 指定（需求确认书 §5：
 * 插件/扩展机制：服务端钩子（消息进出可拦截改写））。
 */

export interface HookMessage {
  readonly conv_id: string;
  readonly sender_id: string;
  readonly client_msg_id: string;
  /** 块数组（协议 §5.3）。钩子可以改写它。 */
  content: Content;
}

export interface HookModule {
  onMessageIn?: (msg: HookMessage) => HookMessage | null | Promise<HookMessage | null>;
  onMessageOut?: (msg: HookMessage) => HookMessage | Promise<HookMessage>;
}

export interface LoadedHooks {
  readonly hasIn: boolean;
  readonly hasOut: boolean;
  readonly onMessageIn: (msg: HookMessage) => Promise<HookMessage | null>;
  readonly onMessageOut: (msg: HookMessage) => Promise<HookMessage>;
  readonly modulePath: string;
}

/**
 * 仓库根：hooks.ts 在 src/ 时是 packages/server/src → 上三级；
 * 编译到 dist/ 时是 packages/server/dist → 同样上三级。两种情况下都是仓库根。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface HookFailurePolicy {
  /** 钩子抛错时是丢弃消息还是放行。默认放行（可用性优先）。 */
  readonly dropOnError?: boolean;
}

/** 载入钩子模块。路径为空时返回 null（不启用）。 */
export async function loadHooks(
  modulePath: string | null,
  logger: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
  policy: HookFailurePolicy = {},
): Promise<LoadedHooks | null> {
  if (modulePath === null || modulePath === '') return null;

  // 相对路径的解析基准很关键：服务端的 cwd 可能是 packages/server（本地 dev），
  // 也可能是 /app（Docker）。所以先按 cwd 找，再按仓库根找，都不行就明确报错 ——
  // 静默禁用钩子会让"配置了但没生效"这种问题极难发现。
  const candidates = isAbsolute(modulePath)
    ? [modulePath]
    : [resolve(process.cwd(), modulePath), resolve(REPO_ROOT, modulePath)];
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    logger.warn(
      { modulePath, tried: candidates },
      '钩子模块不存在，钩子被禁用（请检查 HOOKS_MODULE 路径）',
    );
    return null;
  }

  let mod: HookModule;
  try {
    mod = (await import(pathToFileURL(found).href)) as HookModule;
  } catch (err) {
    logger.warn({ err, modulePath: found }, '钩子模块加载失败，钩子被禁用');
    return null;
  }

  const hasIn = typeof mod.onMessageIn === 'function';
  const hasOut = typeof mod.onMessageOut === 'function';
  if (!hasIn && !hasOut) {
    logger.warn({ modulePath }, '钩子模块没有导出 onMessageIn / onMessageOut');
    return null;
  }

  logger.info({ modulePath, hasIn, hasOut }, '钩子已启用');

  const dropOnError = policy.dropOnError ?? false;

  return {
    hasIn,
    hasOut,
    modulePath,
    async onMessageIn(msg) {
      if (!mod.onMessageIn) return msg;
      try {
        const out = await mod.onMessageIn(msg);
        return out ?? null;
      } catch (err) {
        logger.warn({ err }, 'onMessageIn 抛错');
        return dropOnError ? null : msg;
      }
    },
    async onMessageOut(msg) {
      if (!mod.onMessageOut) return msg;
      try {
        return await mod.onMessageOut(msg);
      } catch (err) {
        logger.warn({ err }, 'onMessageOut 抛错');
        return msg;
      }
    },
  };
}

/** 空的钩子集合（未配置 HOOKS_MODULE 时用它，避免到处判空）。 */
export const NOOP_HOOKS: LoadedHooks = {
  hasIn: false,
  hasOut: false,
  modulePath: '',
  onMessageIn: async (msg) => msg,
  onMessageOut: async (msg) => msg,
};