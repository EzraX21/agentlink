import type { Config } from '../config.js';
import type { OpenedDb } from '../db/index.js';
import type { Hub } from '../hub.js';
import type { AuthService } from '../auth/service.js';
import type { WsGateway } from '../ws/gateway.js';
import type { StreamRegistry } from './stream.js';

/**
 * 服务端运行时依赖的集合。处理器从这里取，不各自 new。
 */
export interface AppServices {
  readonly config: Config;
  readonly dbc: OpenedDb;
  readonly hub: Hub;
  readonly auth: AuthService;
  readonly gateway: WsGateway;
  readonly streams: StreamRegistry;
}
