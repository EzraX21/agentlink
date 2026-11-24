#!/bin/sh
# 容器入口：让 `docker run` 不带任何环境变量也能跑起来。
#
# 为什么需要这一层：服务端本身是"缺 JWT_SECRET 就退出"的（M0 硬性要求，
# 不许静默用默认值）。这个严格性要保留 —— 直接 `node dist/index.js` 时
# 少配置就该报错。但容器是面向"一键起"的场景，让用户先跑
# `openssl rand -hex 32` 再拼 docker run 参数，门槛太高。
#
# 所以：**容器里**第一次启动时生成随机密钥并落到数据卷，之后每次复用。
# 这不是"静默用默认值"—— 生成的是强随机值，而且会明确打在日志里。
set -eu

SECRETS_FILE="${SECRETS_DIR:-/data}/secrets.env"

need_secret=0
[ -z "${JWT_SECRET:-}" ] && need_secret=1
[ -z "${AGENT_TOKEN_PEPPER:-}" ] && need_secret=1

if [ "$need_secret" = "1" ]; then
  if [ -f "$SECRETS_FILE" ]; then
    # shellcheck disable=SC1090
    . "$SECRETS_FILE"
    echo "[entrypoint] 已从 $SECRETS_FILE 载入既有密钥"
  else
    mkdir -p "$(dirname "$SECRETS_FILE")"
    JWT_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    AGENT_TOKEN_PEPPER="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    # 0600：密钥文件不能被同容器里的其他用户读到
    umask 077
    cat >"$SECRETS_FILE" <<EOF
# 这个文件由容器入口自动生成，不要提交到任何地方。
# 换掉它会让所有已签发的 token 失效（所有人需要重新登录）。
JWT_SECRET=$JWT_SECRET
AGENT_TOKEN_PEPPER=$AGENT_TOKEN_PEPPER
EOF
    echo "[entrypoint] 首次启动：已生成随机密钥并写入 $SECRETS_FILE"
    echo "[entrypoint] 备份这个文件，否则重建容器后所有人要重新登录"
  fi
  export JWT_SECRET AGENT_TOKEN_PEPPER
fi

# 容器场景默认开"自动建管理员"：一键启动时没人会去注册"第一个账号"，
# 而管理页需要管理员才能进。直接 `node dist/index.js` 跑时这个默认是关的，
# 以保留"第一个注册用户成为管理员"那条原有规则。
export BOOTSTRAP_ADMIN="${BOOTSTRAP_ADMIN:-1}"

# 交给服务端进程（exec 保证信号能直达，docker stop 才会优雅退出）
exec "$@"
