# Asuka 本地设置中心

本目录提供一个只绑定 `127.0.0.1` 的本地设置前端，用来编辑当前工作区的 `openclaw.json` 和 `workspace/*.md`。

## 启动

```bash
cd settings-ui
npm install
npm run dev
```

默认地址：

- Web UI: `http://127.0.0.1:5175`
- Local API: `http://127.0.0.1:18766`

Windows 远端建议仍然绑定本机地址，然后通过 SSH 隧道访问：

```bash
ssh -L 5175:127.0.0.1:5175 -L 18766:127.0.0.1:18766 Administrator@100.70.128.95
```

如果确实要在远端局域/Tailscale 地址上直接暴露，可设置：

```powershell
$env:SETTINGS_UI_HOST="0.0.0.0"
$env:SETTINGS_UI_WEB_PORT="5175"
$env:SETTINGS_UI_API_PORT="18766"
npm run dev
```

远端 Asuka 的启动脚本使用独立运行态目录时，建议这样启动设置中心，让它编辑真实运行配置：

```powershell
$env:OPENCLAW_CONFIG_PATH="D:\app\asuka\home\.openclaw\openclaw.json"
$env:OPENCLAW_STATE_DIR="D:\app\asuka\home\.openclaw"
$env:SETTINGS_UI_PROJECT_ROOT="D:\app\asuka\project"
npm run dev
```

## Windows 启动器

远端 Windows 可使用 `windows/start-settings-ui.cmd` 启动。它会自动设置：

- `OPENCLAW_CONFIG_PATH=D:\app\asuka\home\.openclaw\openclaw.json`
- `OPENCLAW_STATE_DIR=D:\app\asuka\home\.openclaw`
- `SETTINGS_UI_PROJECT_ROOT=D:\app\asuka\project`

也可以用 Windows 自带 `iexpress.exe` 将它包装成 `D:\app\asuka\AsukaSettings.exe`：

```powershell
Copy-Item D:\app\asuka\project\settings-ui\windows\start-settings-ui.cmd D:\app\asuka\start-settings-ui.cmd -Force
iexpress.exe /N /Q D:\app\asuka\project\settings-ui\windows\asuka-settings.iexpress.sed
```

## 安全策略

- `apiKey`、`oauthKey`、`clientSecret`、`token` 等敏感字段读取时只返回掩码。
- 保存时未修改的掩码会保留原始值。
- 将敏感输入置空会清除该字段。
- 输入新值才会覆盖原始 secret。
- API 会拒绝把 `********`、`••••••••xxxx` 这类掩码占位符写成真实配置。

## 检查

```bash
npm test
npm run build
node -e "JSON.parse(require('fs').readFileSync('../openclaw.json','utf8'))"
cd ../extensions/qqbot && npm test
```
