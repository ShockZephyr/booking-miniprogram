# 微信预约小程序

面向单门店服务预约的原生微信小程序，后端为 Node.js / Express，数据库为 PostgreSQL。没有 React、Vue、uni-app、Taro 或前端构建步骤。

这是独立开源快照，不含原部署的账号、会员、预约、上传图片、数据库备份、凭据或 Git 历史。默认 API 地址是不可用于正式服务的 `https://api.example.invalid`；不会连接原作者的服务。

## 功能与边界

- 顾客按芳疗师与日期选择起止时间，可多选项目并填写备注；会员准入由白名单控制。
- 芳疗师仅查看本人排班和客户预约，并为客户签到；管理员管理全店资料和预约，兼任芳疗师时仍按管理员权限处理。
- 周模板、具体日期快照、单日开关、批量覆盖、多日草稿；预约冲突由数据库排他约束保护。
- 签到、未签到、取消与修改历史；项目和芳疗师回收站、恢复与到期清理。
- 图片上传、最多五张首页封面、日志查询、健康检查、备份及隔离恢复工具。
- 三端预约列表按服务时间／创建时间升降序全量排序后分页，保留项目、芳疗师、日期和时间筛选。
- 管理员与芳疗师的站内未读提醒：首页汇总新增和变更，按优先级进入对应栏目；未读优先分页，按账号和展示版本确认已读。普通顾客界面不增加工作人员提醒。
- **没有支付、微信订阅／短信等外部通知发送、取消审批、多租户或自动注销账号功能。** 订阅通知的旧迁移仅保留历史兼容，不能删除。

完整规则见 [PRODUCT.md](PRODUCT.md)。测试通过不等于真机验收或可直接上线。

## 目录

| 路径 | 用途 |
| --- | --- |
| `miniprogram/pages`、`components` | 原生页面、共享卡片、日历和排班组件 |
| `miniprogram/services`、`utils` | API、会话、异步隔离与日期处理 |
| `miniprogram/config` | API、开发调试开关、门店回退展示和备案资料 |
| `backend/src` | 路由、控制器、业务服务、仓储、脚本；任务注册在 `server.js` |
| `backend/migrations` | 按编号累积的数据库迁移 |
| `backend/tests` | Node 测试、页面事件模拟和隔离数据库验证 |
| `compose.production.yml`、`deploy` | Docker 部署路径与维护说明 |

## 环境要求

- Node.js **22 或更新版本**、npm。
- PostgreSQL：推荐 **18**，与 Docker 配置一致；迁移账号需有建表及 `pgcrypto`、`btree_gist` 扩展权限。
- 微信开发者工具；真实登录还需要自己的小程序 AppID、AppSecret、手机号能力和平台隐私配置。
- 正式部署需要自己的域名、HTTPS 证书、持久化图片目录及备份位置。

## 从空环境本地启动

以下命令从仓库根目录运行。

1. 安装锁定依赖：

```sh
npm --prefix backend ci
```

2. 用 PostgreSQL 管理账号创建专用开发角色和空库。例如在 `psql -U postgres` 内执行：

```sql
CREATE ROLE booking LOGIN;
\password booking
CREATE DATABASE booking_dev OWNER booking;
```

`\password` 会交互询问密码；请自行设置，项目不提供生产密码。若创建扩展需要更高权限，由数据库管理员在新库内建立 `pgcrypto`、`btree_gist`，不要直接让公网应用长期使用数据库超级用户。

3. 复制环境模板：

```powershell
# Windows PowerShell
Copy-Item backend/.env.example backend/.env
```

```sh
# Linux / macOS
cp backend/.env.example backend/.env
```

编辑 `backend/.env`：填写自己的 `DATABASE_URL`；用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成 `JWT_SECRET`，私下写入该文件，不提交 Git。连接串中的特殊字符须进行 URL 编码。模板已填写开发用图片、日志和备份目录（相对于 `backend`）；生产必须改用发布目录外的持久化目录。

首次迁移会创建 **3 个通用示例项目**，不含真实人员或预约数据；可通过项目管理修改或停用。为了迁移与测试兼容，保留原始迁移，不把生产数据作为种子。

4. 应用迁移并启动 API（会写入刚配置的开发库）：

```sh
npm --prefix backend run migrate
npm --prefix backend start
```

`start` 自带迁移前置步骤并启动定时任务。不要指向已有生产库。检查 `http://127.0.0.1:3000/health/ready`，应返回数据库与图片存储正常。

5. 用微信开发者工具导入仓库根目录。将 `project.config.json` 中不可用的示例 `appid`（`wx0000000000000000`）替换为自己的 AppID，`miniprogramRoot` 已指向 `miniprogram/`。本机模拟开发需显式设置：

- `miniprogram/config/development.js`：`ENABLE_LOCAL_DEBUG=true`，本机 API 默认 `http://127.0.0.1:3000`。
- `backend/.env`：`NODE_ENV=development`、`WECHAT_MOCK_LOGIN=true`；`WECHAT_MOCK_ADMIN` 默认保持 `false`。
- 开发者工具本机 HTTP 调试需调整本地合法域名校验设置；该设置不能代替发布时的 HTTPS 与合法域名配置。

本地模拟入口只在 **开发者工具 + develop + 显式调试开关** 同时满足时出现。手机不会使用电脑的 `127.0.0.1`；手机调试须配置自己的可达 HTTPS 后端。上传前将 `ENABLE_LOCAL_DEBUG` 恢复为 `false`，并把 `config/env.js` 的示例地址替换为自己的 HTTPS 地址。

`npm --prefix backend run dev` 使用 POSIX 环境变量语法，不能直接在 PowerShell 使用。Windows 推荐上述 `start`；若直接执行 `node src/server.js`，应先迁移并注意执行目录在 `backend`。

## 管理员、会员及真实登录

默认没有管理员。先用需要的账号登录一次，再在连接同一数据库的后端执行：

```sh
npm --prefix backend run seed:admin -- <已登录账号的手机号>
```

此命令写入管理员权限。开发可使用明确虚构的模拟账号；正式环境需本人授权手机号登录。随后在管理界面维护会员白名单、项目、芳疗师与排班。管理员和芳疗师不能以顾客身份预约。

真实微信登录需配置服务端 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`，关闭两个 mock 开关，并在微信公众平台配置匹配的 AppID、合法域名与隐私用途。**AppSecret、数据库密码和审核码不能写入小程序包。** 微信登录与手机号能力的实际可用性以账号权限和真机验收为准。

可选的私有审核码登录默认关闭；它登录真实数据库中的固定测试身份，持码者可以获得管理员能力，不是隔离演示环境。设置及关闭方法见 [部署说明](deploy/README.md#私有审核码测试登录)。

## 商家配置入口

| 配置 | 位置 |
| --- | --- |
| 正式 API 地址、超时 | `miniprogram/config/env.js` |
| 本机调试开关和地址 | `miniprogram/config/development.js` |
| 门店正式展示、联系与隐私主体 | 后端环境变量 `BUSINESS_*`、`SERVICE_PROVIDER_NAME`、`PRIVACY_*`，由 `/api/meta/business` 返回 |
| 无网络时的展示回退、关于页 | `miniprogram/config/business.js`；与后端配置保持一致 |
| 设置页版权、主办单位、备案号 | `miniprogram/config/legal.js`；未填写的行不显示 |
| 小程序 AppID、导航标题 | `project.config.json`、`miniprogram/pages/home/index.json` |
| 图标文件及来源说明 | [icons/README.md](miniprogram/assets/icons/README.md) |

公开模板提供可见的虚构示例，前后端保持一致：
- 门店为“示例预约馆”，主体为“示例预约服务工作室（虚构主体）”。电话 `00000000000` 是不可拨打的占位，首页、关于和隐私页不会拨出该号码。
- 地址使用上海人民广场示例，GCJ-02 纬度 `31.228827`、经度 `121.475213`，来源为[高德地图地点页](https://ditu.amap.com/place/B00157917M)。它不是实际门店定位，上线时应重新定位。
- 版权展示和 ICP 号明确标注为示例，与代码的 MIT 版权署名无关。正式发布须替换为自己的实际资料；未取得备案号时清空 `icpNumber` 隐藏对应行，不能发布示例编号。
- AppID、AppSecret、JWT、数据库密码和审核码均使用不可直接部署的占位值；密钥须在私有配置中自行生成或填写。审核登录默认关闭，公开占位码即使误开开关也会被拒绝；到期时间使用已过期的格式示例。
- 可选的 `BACKUP_MIRROR_DIR` 提供完整但被注释的路径示例，默认不启用；确认独立挂载后再配置。微信编译器的空 `outputPath`、无列表项和服务端内部的“未配置”空值保留其原有含义，不应为了填示例而启用功能或写入凭据。

隐私条款是业务模板，运营者应按实际收集与处理方式核对。`production:check -- --release` 会拒绝示例 API、示例凭据和未替换的示例资料；检查通过仍需完成真机验收。

## 验证

```sh
npm --prefix backend test
```

日常回归允许按上面的步骤填写自己的 AppID、门店展示资料和开发调试开关，不要求恢复模板示例值。发布小程序前关闭本地调试的要求仍然有效。

默认只运行本地回归，数据库集成用例会跳过。HTTP 模拟测试会监听本机临时端口。完整数据库验证要求专用 `127.0.0.1:55483/booking_audit`，不能使用现有开发库或生产库：

```powershell
$env:TEST_DATABASE_URL='<专用本地测试库连接串>'
$env:RUN_DB_TESTS='1'
npm --prefix backend run test:db
# 完成后恢复这两个环境变量的原值。
```

```sh
TEST_DATABASE_URL='<专用本地测试库连接串>' RUN_DB_TESTS=1 npm --prefix backend run test:db
```

数据库全套测试使用 `test:db` 串行运行测试文件，避免不同文件同时创建和移除扩展；用例内部仍验证真实并发。备份用例需要匹配 PostgreSQL 18 的 `pg_dump`、`pg_restore`、`psql`，不在 PATH 时设置 `PG_BIN` 为工具目录。

测试会建立临时 schema，使用虚构数据与临时图片，并清理本次资源。检查范围、测试选择及工作方式见 [AGENTS.md](AGENTS.md) 和 [排班验证说明](backend/tests/WEEKLY-SCHEDULING.md)。源码和 Node VM 模拟不证明微信原生布局、触摸、登录、图片或安全区正常，需分别验收 iOS、Android。

维护者在发布通用开源快照前，另行运行：

```sh
npm --prefix backend run opensource:check
```

它检查模板使用无效示例 API／AppID、虚构联系及备案资料、前后端示例一致、环境模板没有空的有效配置项、本地调试关闭，并验证正式发布检查拒绝示例配置。此命令不属于 `test` 或 `test:db`，也不在普通 CI 回归中自动执行。已填写自己配置的使用者无需运行它；其失败不能当作预约业务故障，也不要为通过它清空实际配置。它只覆盖这些配置检查，不能代替发布前对凭据、运行数据和 Git 历史的完整扫描。

## 部署

Docker Compose 是主要维护路径：Node 22、PostgreSQL 18、Nginx HTTPS，图片、日志、备份与数据库持久化在发布目录之外。首次部署、更新、备份、恢复、回滚见 [deploy/README.md](deploy/README.md)。

仓库也保留 PM2 / 主机 Nginx 的非 Docker 示例，需要自行安装服务与 PostgreSQL 客户端；不能把 Docker 内部 DNS 配置直接用于主机 Nginx。

**后端部署与小程序上传是两件事。** 后端升级不会自动更新手机上的小程序。接口变更应先升级兼容后端，再上传配套前端。生产检查：

```sh
npm --prefix backend run production:check -- --release
```

新增站内未读功能需先部署含迁移 `023_appointment_inbox.sql`、`024_appointment_inbox_consistency.sql` 的后端，再上传配套小程序。旧预约默认已读，迁移不清空业务数据；详见 [站内未读升级说明](deploy/README.md#站内未读与排序迁移-023024)。

运行前需 `NODE_ENV=production` 和完整私有环境配置。示例域名、示例 AppID、占位密钥和虚构商家资料不能作为正式部署配置。

## 许可证与贡献

代码采用 [MIT License](LICENSE)，版权署名 **2026 ShockZephyr**。图标素材和第三方依赖不因代码许可证而改变原有许可，见 [图标说明](miniprogram/assets/icons/README.md)。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。
