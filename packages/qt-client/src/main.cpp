#include <QApplication>
#include <QMessageBox>

#include "core/auth_api.hpp"
#include "core/client.hpp"
#include "core/settings.hpp"
#include "gui/main_window.hpp"
#include "gui/onboarding.hpp"

using namespace agentlink;

/**
 * 入口。
 *
 * 启动流程（像 QQ / Element 那样）：
 *   1. 读本地设置
 *   2. 有已保存的服务器 + token → 直接连，进聊天
 *   3. 没有 → 走引导：填地址 → 注册/登录 → 进聊天
 *
 * 这是"客户端在任意电脑上，服务端部署在服务器上"的关键：
 * 客户端里**没有**写死任何地址，全靠用户填 + 本地记住。
 */
int main(int argc, char** argv) {
  QApplication app(argc, argv);
  QApplication::setApplicationName(QStringLiteral("AgentLink"));
  QApplication::setApplicationVersion(QStringLiteral("1.0.0"));
  QApplication::setOrganizationName(QStringLiteral("AgentLink"));

  SettingsStore settings;
  settings.load();

  AuthApi api;
  Client client;

  // 有记住的服务器就直接连。
  const ServerEntry* active = settings.activeEntry();
  if (active != nullptr && !active->accessToken.isEmpty()) {
    const auto address = ServerAddress::parse(active->address);
    if (address.has_value()) {
      api.setHttpBase(address->httpBase());
      MainWindow window(&client, &api, &settings);
      window.show();
      client.connectTo(*address, active->accessToken);
      return app.exec();
    }
  }

  // 没有就引导。
  Onboarding onboarding(&api, &settings);
  if (onboarding.exec() != QDialog::Accepted) {
    return 0;  // 用户取消：正常退出，不是错误
  }

  const auto address = ServerAddress::parse(onboarding.serverAddress());
  if (!address.has_value()) {
    QMessageBox::warning(nullptr, QStringLiteral("地址不对"),
                         QStringLiteral("保存的服务器地址无法解析：%1").arg(onboarding.serverAddress()));
    return 1;
  }

  api.setHttpBase(address->httpBase());
  MainWindow window(&client, &api, &settings);
  window.show();
  client.connectTo(*address, onboarding.accessToken());
  return app.exec();
}
