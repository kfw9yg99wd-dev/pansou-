# 个人网页部署版

本仓库将 **PanSou 搜索后端与独立编写的网页界面打包成一个 Go 程序**。网页和 API 使用同一域名，不依赖 Node.js 服务，也不需要先运行前端开发服务器。

## 部署状态与边界

- GitHub 仓库用于保存代码和运行构建检查；**上传代码不等于网站已经公网运行**。
- GitHub Pages 不能运行 Go 后端。本版应部署到支持 Docker 或常驻 Go 程序的服务器/托管平台。
- 仓库不包含个人登录令牌、真实服务密码、本机缓存、搜索日志或安装工具。
- 默认容器开启账号认证。未正确设置密码或 JWT 密钥时会拒绝启动，不会退回匿名公网服务。
- 本仓库的 CI 只构建和验证，不创建云服务，也不发布容器镜像。

## 方案一：自己的服务器运行 Docker

1. 在你管理的服务器克隆本仓库：

   ```sh
   git clone https://github.com/kfw9yg99wd-dev/pansou-.git
   cd pansou-
   ```

2. 用编辑器将 `.env.example` 另存为 `.env`，替换 `AUTH_USERS` 和 `AUTH_JWT_SECRET` 中的占位值。
   - `AUTH_USERS` 格式为 `用户名:密码`，也支持用逗号分隔多个账号。
   - 公网监听时，每个密码至少 12 字符，建议使用独立随机密码；密码不要含逗号。
   - `AUTH_JWT_SECRET` 至少 32 字符，应使用另一份独立随机值。
   - 可以分别运行 `openssl rand -hex 32` 生成随机值。不要把生成结果提交到仓库。

3. 在本目录启动：

   ```sh
   docker compose up -d --build
   docker compose logs --tail=80 pansou
   ```

4. 服务器本机访问 `http://127.0.0.1:8080/`。浏览器中的「服务用户名/密码」指 `.env` 中设置的账号，**不是 GitHub、Apple 或网盘账号**。

5. 公网使用前，为你拥有的域名配置 HTTPS 反向代理，转发到 `127.0.0.1:8080`。代理应保留原始 `Host`，不要替换为内部 IP；为搜索请求设置合理的超时。不要直接在公网用明文 HTTP 输入密码。

随附 `compose.yml` 仅将端口发布到服务器本机。缓存使用命名卷，容器以普通用户运行；修改配置后重新创建容器生效。停止服务可运行 `docker compose stop`，它不会删除缓存卷。

## 方案二：支持 Docker 的托管平台

确认所选平台的网络、配额、价格和使用条款后，在平台中连接本仓库，以根目录 `Dockerfile` 构建 Web Service。**本文档不会自动申请任何付费资源。**

必填环境变量：

| 变量 | 配置 |
|---|---|
| `PANSOU_LISTEN_HOST` | `0.0.0.0` |
| `AUTH_ENABLED` | `true` |
| `AUTH_USERS` | 你自行设置的服务账号和随机密码 |
| `AUTH_JWT_SECRET` | 你自行生成的独立随机密钥 |
| `ENABLED_PLUGINS` | 从 `.env.example` 中选择需要的插件 |
| `CHANNELS` | 从 `.env.example` 中选择需要的公开频道 |

其他性能和缓存配置可参考 `.env.example`。平台若注入 `PORT`，程序会自动使用；否则默认 `8888`。健康检查路径为 `/api/health`。应使用平台提供的 HTTPS 地址。

免费或低配方案可能有休眠、CPU/内存、出站网络或缓存持久化限制，请以平台当时的说明为准。来源网络不可达、限流或站点变动不代表整个程序故障。

## 源码方式

需要 Go 1.25。网页文件通过 `go:embed` 编译进程序，修改网页后需要重新构建：

```sh
go test .
go build -trimpath -o pansou .
```

直接运行时默认只监听 `127.0.0.1:8888`。设置非回环监听地址时必须同时满足上述认证配置。运行环境中必须显式设置 `ENABLED_PLUGINS` 才会启用插件。

前端检查使用 Node.js 内置测试工具，没有 npm 第三方依赖：

```sh
npm run check:web
npm run test:web
```

## 安全与资源结果

- 页面中的标题、来源等外部文本按纯文本呈现；不执行资源结果携带的 HTML/JavaScript。
- 只允许 HTTP(S)、磁力及文件型电驴链接。相同磁力哈希会合并来源，可能少于后端原始条数。
- CSV 导出会转义引号并处理潜在表格公式。打开外部分享或下载文件之前仍需自行判断安全性。
- 登录会话只保留在当前浏览器会话存储或内存中。退出会清除当前浏览器的令牌；上游 JWT 为无状态令牌，退出不等于撤销其他位置已复制的令牌。
- 更换 JWT 密钥可使旧令牌失效。不要共享管理员密码，也不要将密钥填进前端 JavaScript。
- 登录接口有基于 TCP 连接来源的基础限流。反向代理后的用户可能共享限流配额；多人服务需在可信代理层配置更完善的访问控制。
- 来源标题中的「全集」「4K」等是发布者描述，不是本站验收结果。链接可用性、集数、画质、字幕和版权授权都需要另行核验。

## 来源与许可

- 后端基于 [fish2018/pansou](https://github.com/fish2018/pansou)，起始版本 `221665fb2c9279f22af4684ea2d8c0c331eac1cc`，保留根目录 MIT `LICENSE`。
- `web/` 的界面与交互为本仓库独立实现；没有复制 `fish2018/pansou-web` 的前端代码或图标。
- IBM Plex Sans 字体来自 [Google Fonts](https://github.com/google/fonts/tree/main/ofl/ibmplexsans)，未修改字体内容，遵循随附的 `web/fonts/OFL.txt`，不属于 MIT 授权范围。
- 原有 README 保留上游资料供 API 参考；**本分支部署与认证要求以本文档为准**。
