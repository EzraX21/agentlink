# ---- 构建阶段：装依赖 + 构建全部包 + 构建 Web ----
# 用 debian 而不是 alpine：better-sqlite3 的预编译 binary 对 glibc 更稳，
# 且 caddy 之后单独一层。Node 26 LTS 是项目目标版本（需求确认书 §8.2）。
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
COPY examples/package.json examples/

# XDG_RUNTIME_DIR 必须在可写位置：pnpm 会在那里放 store 操作锁
ENV XDG_RUNTIME_DIR=/tmp/pnpm-runtime
RUN mkdir -p /tmp/pnpm-runtime
RUN pnpm install --frozen-lockfile

# 再拷贝源码并构建
COPY tsconfig.base.json ./
COPY packages ./packages
COPY examples ./examples
RUN pnpm -r build

# 裁掉 devDependencies，只留运行期依赖
RUN pnpm prune --prod

# ---- 运行阶段：只带产物 ----
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/data/agentlink.db
ENV UPLOADS_DIR=/data/uploads
ENV PUBLIC_DIR=/app/public

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
COPY --from=build /app/packages/web/dist ./public

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