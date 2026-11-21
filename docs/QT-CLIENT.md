# AgentLink Qt 桌面客户端（已拆到独立仓库）

Qt/C++ 桌面客户端现在是独立仓库：
**[`EzraX21/agentlink-desktop`](https://github.com/EzraX21/agentlink-desktop)**。

拆出去的原因：桌面客户端有自己的构建体系（CMake + Qt6）、自己的发布节奏，
和 TypeScript 服务端放在一个仓库里互相拖累 —— 改一行 C++ 不该触发
TS 全量构建与验收。两个仓库都以 GPLv3 发布。

它的验收（协议层单测 + 真连服务端的端到端）跟着那个仓库走：
`node scripts/acceptance.mjs`（在 agentlink-desktop 仓库里跑）。

本仓库的历史提交里仍有它的完整代码（`packages/qt-client`，在
`09b0b14` 之前的提交可见）。
