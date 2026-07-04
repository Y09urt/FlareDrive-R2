# FlareDrive-R2

基于 Cloudflare Pages Functions、R2 和 D1 的轻量网盘。现在支持：

- Web 端上传、下载、目录浏览、删除
- 账号注册、登录和 HttpOnly 会话 Cookie
- 文件分享链接
- 文字暂存和文字分享链接
- 管理员与普通用户隔离目录

## 资源绑定

项目使用两个 Cloudflare 绑定：

| 绑定名 | 类型 | 用途 |
| --- | --- | --- |
| `BUCKET` | R2 Bucket | 保存文件内容 |
| `DB` | D1 Database | 保存用户、会话、分享和文字暂存 |

`wrangler.toml` 已声明这两个绑定。部署前需要把 `database_id` 替换为你的 D1 数据库 ID，`bucket_name` 替换为你的 R2 bucket 名称。

## 本地运行

```bash
npm install
npm run types
npx wrangler d1 execute flaredrive-r2 --local --file migrations/0001_init.sql
npm run dev
```

打开 Wrangler 输出的本地地址。第一次注册的账号会自动成为管理员。

## 部署

1. 在 Cloudflare 创建 R2 bucket。
2. 在 Cloudflare 创建 D1 database。
3. 修改 `wrangler.toml` 中的 `bucket_name`、`database_name`、`database_id`。
4. 执行远端 D1 初始化：

```bash
npx wrangler d1 execute flaredrive-r2 --remote --file migrations/0001_init.sql
```

5. 部署 Pages 项目，确保 Pages 的 R2 和 D1 绑定名分别是 `BUCKET` 和 `DB`。
6. 首次打开站点并注册管理员账号。

## 注册策略

默认只有第一个用户能注册，且会成为管理员。后续如果要开放注册，在 Pages 环境变量中设置：

```txt
ALLOW_SIGNUP=true
```

普通用户只能访问自己的 `users/{id}/` 目录；管理员可以访问全部对象。
