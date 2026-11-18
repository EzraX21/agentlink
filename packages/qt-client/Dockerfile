# Qt/C++ 桌面客户端镜像
#
# 为什么要单独一个镜像：宿主机的 Qt 版本各不相同（有的根本没装），
# 客户端要能"在任意电脑上跑"，构建环境就得是**固定的**。
#
# 用 qt6-base-dev（Widgets + Network + Core）+ Qt Test。
# 不装 qt6-declarative（QML）：桌面客户端用 Widgets 更直接。
#
# 构建：
#   docker build -f packages/qt-client/Dockerfile -t agentlink-qt:latest .
#
# 运行（需要显示环境）：
#   docker run --rm -it --network host \
#     -v /tmp/.X11-unix:/tmp/.X11-unix -e DISPLAY=$DISPLAY \
#     agentlink-qt:latest
FROM ubuntu:22.04 AS build

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
      qt6-base-dev qt6-base-dev-tools libqt6websockets6-dev \
      libgl1-mesa-dev libx11-dev libxext-dev libxcb1-dev libxcb-util-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY packages/qt-client/CMakeLists.txt ./packages/qt-client/
COPY packages/qt-client/src ./packages/qt-client/src
COPY packages/qt-client/tests ./packages/qt-client/tests

# Widgets 需要 OpenGL 头文件（Qt6Gui 的 cmake 配置依赖 WrapOpenGL）。
# 这里**编完整的 GUI**，因为客户端本身就是 GUI 应用；
# BUILD_GUI=OFF 留给"只想跑协议层单测"的场景。
#
# 构建目录用 /build（不是 /src/build）：CMake 会把**绝对路径**写进
# CTestTestfile.cmake，运行时阶段把产物拷到 /build 后路径才对得上。
RUN cmake -S /src/packages/qt-client -B /build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /build -j"$(nproc)"

# ---- 运行阶段：只带产物 ----
FROM ubuntu:22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# qt6-base 的运行时库（不带 dev 头文件）+ 字体 + X11 转发需要的库
# 注意包名：Ubuntu 22.04 (jammy) 是 libqt6core6，**没有** t64 后缀
# （t64 是 Debian trixie / Ubuntu 24.10 之后的命名）。
#
# qt6-qpa-plugins 里装着**两个**必需的东西：
#   - plugins/tls/libqopensslbackend.so —— 没有它 Qt 报 "No functional TLS backend"，
#     wss:// 根本连不上（生产环境必须）
#   - plugins/platforms/libqxcb.so —— 有显示环境时的界面后端
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libqt6core6 libqt6network6 libqt6widgets6 libqt6gui6 \
      libqt6websockets6 libqt6test6 cmake qt6-qpa-plugins \
      libssl3 \
      libgl1 libegl1 libxkbcommon0 libxkbcommon-x11-0 libdbus-1-3 \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/agentlink-qt /usr/local/bin/agentlink-qt

# 测试二进制也带上：验收套件（qt-client）要在容器里跑 ctest，
# 所以运行时也要有 ctest 与测试可执行文件。
COPY --from=build /build /build

ENTRYPOINT ["/usr/local/bin/agentlink-qt"]
