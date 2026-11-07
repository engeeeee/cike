# CIKE Windows x64

这是基于 [chainfix/cike](https://github.com/chainfix/cike) v0.7.0（`abeacd2`）制作的独立 Windows 移植版，在 [engeeeee/cike](https://github.com/engeeeee/cike) 维护。

[下载 Windows 发布版](https://github.com/engeeeee/cike/releases/latest)，选择应用 ZIP 和 `SHA256SUMS.txt`。Release 中的下载文件无需登录 GitHub。

## 使用

1. 使用 Windows 10 1803 或更新版本、Windows 11 的 Intel/AMD 64 位系统。
2. 将 `CIKE-0.7.1-windows-x64.zip` 完整解压到本地可写目录，例如 `D:\Apps\CIKE`。
3. 双击 `CIKE.exe`。运行时已随包提供，无需另装 Node.js。请保留同目录的 DLL、资源目录等文件。
4. 在“设置”中下载 Chromium 内核，然后创建并打开环境。首次下载需要联网。

本包没有 Windows 代码签名，系统可能显示未识别的发布者。可用随包的 `SHA256SUMS.txt` 核对文件。

## 浏览器窗口（0.7.1）

新环境默认最大化。手动按 F11 切换全屏后，后续新建环境和浏览器新窗口会沿用全屏状态，重启应用后仍会记住。普通标签页不会重置当前窗口。

可在“设置 → 浏览器窗口”选择记住上次状态、始终最大化、始终全屏，或按环境分辨率打开。Windows 的页面尺寸随实际窗口变化；环境中的分辨率用于普通窗口启动大小，无头自动化仍使用环境配置。

## 数据和更新

- 默认数据目录：`%LOCALAPPDATA%\CIKE`。设置中的“打开数据目录”可以直接打开。
- 自定义数据目录：在启动前设置 `LFB_DATA`。桌面版与独立 Node API 应使用不同数据目录。
- 浏览器下载保存到 Windows 当前用户的系统“下载”目录。
- 桌面版代理密码通过 Electron safeStorage 使用当前 Windows 用户的 DPAPI 加密。不能假设将数据目录复制给其他用户或其他电脑后仍可解密。
- Windows 文件访问使用当前用户目录的 Windows ACL；POSIX 的 `0600/0700` 权限声明仅适用于 Unix 系统。
- 更新时先退出 CIKE 和所有环境，将新版完整解压到新目录再启动。环境数据留在用户目录，更新前建议备份。
- Windows 版使用手动更新，不会下载上游 macOS DMG。
- Windows 环境使用原始 Chromium 内核，不提供 macOS Dock 的每环境独立编号图标。

## 自行构建

安装 Node.js 22.12 或更新的 LTS 版本，在仓库目录执行：

```powershell
npm ci
npm run test:unit
npm run pack:win-x64
```

也可以双击根目录的 `build-windows.cmd`。输出：

```text
dist/CIKE-win32-x64/CIKE.exe
dist/CIKE-0.7.1-windows-x64.zip
dist/SHA256SUMS.txt
```

打包脚本同样可以在 macOS/Linux 上交叉生成 Windows x64 压缩包，使用 Electron 官方预编译运行时并校验其下载内容。

## GitHub Actions

fork 后在 GitHub 的 Actions 页面启用工作流。`main`、`windows` 和 `windows-*` 分支的代码提交会触发 **Build Windows x64**。完成后在该次运行的 Artifacts 中下载 `CIKE-windows-x64`，解压后得到应用压缩包及校验文件。

工作流在 Windows runner 上检查 API/凭据存储、代理与浏览器回归、最大化和全屏继承、CIKE 内核下载与版本检测，以及源码和打包后桌面应用启动。所有步骤通过后才上传应用。

**Publish Windows Release** 可以复用已通过的 Windows 构建发布 Release。手动运行时填写构建运行 ID 与 `v0.7.1-windows.1` 形式的标签；工作流确认应用源码一致、校验压缩包后，上传应用与校验文件并发布。

## 验证范围与实机验收

本地构建环境为 Linux ARM64。交叉打包及单元测试不等于 Windows 安装和启动实测；Windows 自动验证以 fork 中实际的 Actions 运行结果为准。图形、系统代理、杀毒软件及下载目录重定向仍应在自己的 Windows 设备上检查。

建议检查：完整解压后的首次启动、内核下载及重启后的状态、两个环境的登录状态隔离、HTTP/SOCKS5 代理认证、关闭后重开环境、同名文件下载、退出应用后的进程清理。目录含空格或中文也应能正常工作。
