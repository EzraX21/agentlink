# ---- 服务端镜像：只有 API + WebSocket，**不含前端产物** ----
#
# 前端在 Dockerfile.web 里单独构建（nginx 托管）。两个镜像的边界与代码边界一致：
# 服务端镜像里没有 dist/ 的客户端代码，客户端镜像里没有数据库与 token。
#
# 用 debian 而不是 alpine：better-sqlite3 的预编译 binary 对 glibc 更稳。
# Node 24 LTS 是当前环境版本（需求确认书 §8.2 目标是 26）。
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate

# better-sqlite3 的构建工具（没有匹配的 prebuilt 时需要现场编译）
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只拷贝清单，让依赖层可以被缓存
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/agent-sdk/package.json packages/agent-sdk/
COPY packages/mcp/package.json packages/mcp/
COPY examples/package.json examples/

# XDG_RUNTIME_DIR 必须在可写位置：pnpm 会在那里放 store 操作锁
ENV XDG_RUNTIME_DIR=/tmp/pnpm-runtime
RUN mkdir -p /tmp/pnpm-runtime
RUN pnpm install --frozen-lockfile

# 再拷贝源码并构建
COPY tsconfig.base.json ./
COPY packages ./packages
COPY examples ./examples
# 只构建服务端需要的包（不含 web / mcp）：
# 服务端镜像里不该出现前端与 MCP 的产物，否则镜像边界就糊了。
RUN pnpm --filter @agentlink/protocol build \
 && pnpm --filter @agentlink/agent-sdk build \
 && pnpm --filter @agentlink/server build

# 裁掉 devDependencies，只留运行期依赖
RUN pnpm prune --prod

# ---- 运行阶段：只带产物 ----
FROM node:24-bookworm-slim AS runtime

# ffmpeg：视频附件上传时抽一帧做缩略图（客户端列表里显示画面而不是黑框）。
# 体积可控（ffmpeg 本体 ~290 KB，共享库 ~40 MB），且是**可选** ——
# 没装它服务端会跳过缩略图生成，其余功能不受影响。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/data/agentlink.db
ENV UPLOADS_DIR=/data/uploads
# 明确**不**托管前端：客户端在另一个镜像里。
# 设成空串而不是不设，是为了让"这个镜像不提供前端"成为显式声明。
ENV PUBLIC_DIR=

WORKDIR /app

# 只拷运行需要的东西
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/drizzle ./packages/server/drizzle
COPY --from=build /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /app/packages/protocol/node_modules ./packages/protocol/node_modules

# 数据卷：SQLite 与附件都在这里，重启不丢（验收 6）
RUN mkdir -p /data/uploads

# 用非 root 跑。必须先把 /app 与 /data 的所有权交给 node，
# 否则 node 用户读不了自己目录里的 package.json（会报 ERR_INVALID_PACKAGE_CONFIG）。
RUN chown -R node:node /app /data
VOLUME ["/data"]

USER node

EXPOSE 3000

# HEALTHCHECK 打 /healthz（协议 §1）
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>r.json()).then(j=>process.exit(j.ok===true?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]