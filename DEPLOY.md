# zzlibrary 部署指南

个人资料库——你的资料放进一座自己的图书馆。Web 声明书架式浏览 + 全格式阅读器，**本地优先**：所有数据保存在你自己的机器上。

## 快速开始（zip 直跑）

1. 安装 [Node.js](https://nodejs.org) **22.5+（推荐 24+）**
2. 解压 zip 到任意目录（建议放数据盘，库文件会存在旁边的 `data/`）
3. 双击 `start-windows.bat`（Linux/macOS 用 `./start-linux.sh`）
4. 浏览器自动打开 `http://localhost:8000`，默认账号 `admin / zzlibrary`

局域网内其他设备（手机/平板）用 `http://<这台机器的IP>:8000` 访问同一个馆。

## 数据在哪 / 怎么备份

- 全部数据在一个目录：`<解压目录>/data/`（元数据库 `library.db` + 文件原件 `files/` + 封面书脊 `art/`）
- **备份 = 整个 data 目录拷走**，或应用内「设置 → 备份整库」生成一致性快照到任意位置（含移动硬盘）
- 升级版本：停服务 → 覆盖新解压目录中的 `dist-server/` 和 `web/`（data 目录不动）→ 重新启动

## ⚠️ 安全边界（务必阅读）

- 服务端是**单账号会话鉴权**，面向个人/家庭局域网使用；**不要未经防护直接暴露到公网**
- 首次启动后**立即改默认密码**：设置环境变量 `ZZLIB_PASSWORD`（支持 `pbkdf2$迭代$盐$哈希` 格式）
- 远程访问推荐 **Tailscale/WireGuard 组网**（加密隧道 + 零公网暴露 + 免备案），比公网裸奔+反代安全得多
- 若确需公网访问：HTTPS 反向代理（Caddy/Nginx）+ 强密码 + IP 白名单，风险自担

## Docker（推荐的自托管姿势）

```bash
docker run -d --name zzlibrary \
  -p 8000:8000 \
  -v /path/to/zzlibrary-data:/data \
  ghcr.io/wenobug/zzlibrary:latest
```

数据全部落在挂载的 `/data` 卷（备份=备份该卷）；NAS 用户用 Container Manager/Container Station 等图形界面等价配置即可。

## 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZZLIB_DATA_DIR` | `<解压目录>/data` | 数据目录（可指到别的盘） |
| `ZZLIB_PORT` / `PORT` | `8000` | 监听端口 |
| `ZZLIB_USERNAME` / `ZZLIB_PASSWORD` | `admin` / `zzlibrary` | 登录账号（**请改密码**） |
| `ZZLIB_ROOT` | 自动 | 应用根（dist-server 的父目录，一般不用动） |
| `ZZLIB_WEB_DIST` | 自动 | web 界面目录（一般不用动） |

## 常见问题

- **启动报端口占用**：换 `ZZLIB_PORT=8001` 或关掉占用程序
- **手机访问不了**：确认手机与服务器同一网络、防火墙放行端口（Windows 首次启动会弹网络授权，选「专用网络允许」）
- **忘记密码**：删掉 `data/.session_secret` 无用——密码本身在环境变量；用 `ZZLIB_PASSWORD=新密码` 启动即可重置
