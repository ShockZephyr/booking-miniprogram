# 部署与维护

本文中的路径为 Linux 部署约定，`example.invalid`、示例 AppID、密码占位符和虚构商家资料必须替换为自己的配置。不得使用原作者的服务；不要把真实配置、TLS 私钥、备份或业务记录提交到仓库。

环境模板中的全零电话不可拨打；人民广场坐标、隐私主体和备案显示均是示例。密钥自行生成或从自己的平台取得，不复用公开占位值。`BACKUP_MIRROR_DIR` 的路径示例默认被注释，确认自己的独立备份挂载后再启用。详细入口见 [商家配置](../README.md#商家配置入口)。

## 首次 Docker 部署

前提：Linux、Docker Engine 与 Compose 插件、自己的域名和证书。仓库提供 PostgreSQL 18 与 Node 22 镜像配置。以下步骤会创建目录、容器、数据库表并启动清理任务，只能对自己的新环境执行。

1. 将源码放在 `/opt/booking/current` 或自己的版本目录；为 `/var/lib/booking/postgres`、`/var/lib/booking/uploads`、`/var/log/booking`、`/var/backups/booking` 建立持久化目录。数据库目录交给官方镜像管理；应用图片、日志、备份目录需允许镜像 `node` 用户（UID 1000）写入。
2. 复制 `backend/.env.production.example` 到 `/etc/booking/production.env`，复制 `deploy/compose.env.example` 到 `/etc/booking/compose.env`。设置权限 0600，填写自己的密码、随机 JWT 密钥、微信凭据及门店/隐私资料。Compose 通过 `POSTGRES_PASSWORD` 生成内部数据库连接；`production.env` 中用于非 Docker 命令的 `DATABASE_URL` 应对应自己的环境。
3. 将证书链和私钥放在 `/etc/booking/tls/fullchain.pem`、`/etc/booking/tls/privkey.pem`。在 `deploy/nginx/booking.conf` 和 Compose 的 Nginx 健康检查中，将所有 `example.invalid` 替换成自己的域名；证书须覆盖配置中使用的域名。无需 `www` 时删除该域名对应的跳转 server 块，并调整 HTTP server_name。
4. 填写小程序 `project.config.json`、`config/env.js`、门店及备案资料；保持本地调试关闭，生产两个 mock 开关关闭。前后端 AppID 一致。
5. 在源码根目录执行：

```sh
docker compose --env-file /etc/booking/compose.env -f compose.production.yml build backend
docker compose --env-file /etc/booking/compose.env -f compose.production.yml up -d database
docker compose --env-file /etc/booking/compose.env -f compose.production.yml run --rm --no-deps backend npm run production:check -- --release
docker compose --env-file /etc/booking/compose.env -f compose.production.yml up -d
```

后端启动前自动迁移。检查容器健康、HTTP 跳转、HTTPS `/health/ready`、图片上传与重开页面，再按 README 初始化自己的管理员。测试/体验/正式小程序如果连接相同 API，就使用相同数据库，不能把体验版当作数据隔离环境。

## 常规更新与回滚

1. 保留旧源码/镜像、配置和版本号；先运行相关回归，构建新镜像并检查生产配置。
2. 使用下文备份命令备份并校验数据库与图片，再安排切换。不要把备份、运行数据打进发布包。
3. 数据库结构变更先阅读迁移及兼容说明。单后端容器重建会短暂中断接口；仅更新后端时使用 `up -d --no-deps backend`，不删除数据库容器或卷。环境变量改变必须重新创建后端，单纯 restart 不会重读 env_file。
4. 验证新镜像版本、健康检查、公开图片、权限与关键流程，再上传对应的小程序代码。
5. 回滚代码仅在数据库仍兼容且旧版本不会破坏新数据时可用。迁移022后的旧单项目后端不能作为可写回退；恢复数据必须另行确认损失范围，在空目标库和空图片目录演练后再切换。

非 Docker 的 PM2 / 主机 Nginx 示例见本文“日志与进程”；主机 Nginx 配置位于 `nginx/booking.conf`。需要自行准备 Node、PostgreSQL 客户端、TLS、目录权限及服务启动顺序。不要混用 Docker 内部地址和主机回环地址。

## 私有审核码测试登录

需先部署包含迁移 `020_review_accounts.sql` 的后端，再上传新版小程序。迁移只增加测试账号标识与约束，不清空业务数据；首次成功测试登录才创建对应测试账号。前端 `config/development.js` 中 `ENABLE_LOCAL_DEBUG` 必须为 `false`，所有上传版本默认访问 HTTPS。生产的 `WECHAT_MOCK_LOGIN/WECHAT_MOCK_ADMIN` 始终保持 `false`。

后端私有环境配置新增以下字段（占位值须替换，不能原样使用）：

```dotenv
REVIEW_LOGIN_ENABLED=true
REVIEW_LOGIN_CODE=<32至128位随机审核码，仅限字母数字下划线或短横线>
REVIEW_LOGIN_EXPIRES_AT=<带时区的截止时间，例如 YYYY-MM-DDTHH:mm:ss+08:00>
```

可用 Node 的 `crypto.randomBytes(32).toString('hex')` 在受控终端生成审核码，私下提供给测试人员，不写入小程序、Git 或日志。开启时必须同时配置有效审核码和截止时间；过期后自动拒绝登录及已有测试会话。普通／芳疗师／管理员共用审核码，分别对应固定独立账号；持有码者拥有真实管理员操作能力，应仅交给获授权人员。

“我的”页每次出现会匿名请求 `GET /api/auth/review-options`，只得到布尔开关；失败默认隐藏。填写审核码后通过 `POST /api/auth/review-login` 登录，并沿用登录限流。测试账号使用非手机号标识 `review:user`／`review:therapist`／`review:admin`，不能绑定真实手机号或真实芳疗师。普通测试账号初次创建时建立白名单，后续登录不自动恢复被撤销的会员资格。测试芳疗师首次登录创建独立资料及七天默认排班，项目为空，需管理员配置后才能接受顾客预约；重登不改配置、不自动恢复已停用资料。这里的预约、资料维护、上传、删除都是当前数据库中的真实操作；这不是隔离演示库。

新增芳疗师审核入口需先部署后端并应用迁移 `021_review_therapist.sql`，再上传前端。迁移只调整身份约束，不自动创建测试资料、不修改既有账号；原有普通和管理员审核登录继续兼容。

结束测试时设置 `REVIEW_LOGIN_ENABLED=false`。Docker 的环境变量在创建容器时读取，单纯 `restart` 不会更新 `env_file`。按当前部署文件在维护窗口重新创建后端容器（会短暂中断接口，保留数据库和上传目录）：

```sh
docker compose --env-file /etc/booking/compose.env -f compose.production.yml up -d --no-deps --force-recreate backend
```

核对健康检查正常且 `/api/auth/review-options` 返回 `testLoginEnabled:false`；旧测试令牌访问受保护接口应为401，正常账号应继续可用。无需再次上传前端：已打开页面重新进入后隐藏；旧页面点击测试按钮也会被服务器拒绝。若多实例运行，所有实例须使用同一配置并完成更新。重新开启须换新审核码或截止时间，避免先前尚未过期的令牌重新有效。测试数据清理另行授权，关闭开关不会删除预约、账号或历史记录。

测试令牌使用由 `JWT_SECRET` 派生的独立签名域及固定 `kid`，不修改正式凭据；旧版只使用普通签名密钥，因此不能接受测试令牌。回滚仍保留迁移020，不逆向删除字段或账号。若需要确保以后重新部署审核版本也不恢复旧测试会话，在备份后、维护窗口内执行 `UPDATE users SET session_version = session_version + 1 WHERE review_identity IN ('user', 'therapist', 'admin');`，并关闭审核开关。这只撤销测试账号会话，不修改真实账号或删除业务记录。

固定测试会员在白名单中以只读账号标识显示，可以编辑备注；移出后显示“恢复”，只有管理员主动操作才恢复会员资格。无需也不能输入虚构手机号来恢复。新版白名单页面与后端配套发布；普通会员仍使用手机号新增、编辑和恢复。

单人周排班的多日统一保存需要小程序与后端配套发布：新增 `PUT /api/admin/schedules/weekly/:therapistId`，提交不同星期的完整配置并在同一事务中保存。先部署支持该接口的后端，再发布新小程序；本次不新增迁移。原 `PUT /api/admin/schedules/weekly` 保留批量覆盖及旧客户端按天保存的语义，新客户端不能用循环调用旧接口代替整批事务。后端未升级时新页面保存会失败并保留草稿，不能宣称本地更新已在线上生效。

生产模板为 `backend/.env.production.example`，真实密钥写入 `/etc/booking/production.env`，通过 `BOOKING_ENV_FILE` 加载。开发 `.env` 继续用于本地测试，密钥不提交代码。

## 已提供的命令

以下命令在 backend 目录运行：

| 命令 | 用途 |
| --- | --- |
| `npm run production:check` | 检查生产配置、目录、隐私主体和静态图片 |
| `npm run production:check -- --release` | 加验 HTTPS、AppID 一致性、合法域名校验 |
| `npm run ops:status` | 只读盘点账号、mock 账号数量、排期、磁盘和备份 |
| `npm run backup` | 备份 PostgreSQL 和图片，生成并验证 SHA-256 清单 |
| `npm run backup:verify -- <备份目录>` | 逐文件校验数据库备份与图片 |
| `npm run backup:rehearse -- --isolated` | 在密码保护的临时 PostgreSQL 实例中恢复验证，完成后清理 |
| `npm run images:migrate -- <绝对目标目录>` | 复制并校验图片，保留源文件，拒绝覆盖内容不同的同名文件 |

## 服务器配置

使用独立的 booking 系统用户。示例目录需与服务配置保持一致：

```sh
sudo install -d -o booking -g booking -m 0750 /var/lib/booking/uploads /var/log/booking
sudo install -d -o booking -g booking -m 0700 /var/backups/booking /etc/booking
sudo install -o booking -g booking -m 0600 backend/.env.production.example /etc/booking/production.env
```

填入真实数据库连接、微信 AppID/AppSecret、门店资料和坐标。生产必须关闭两个 mock 开关；图片和日志目录必须位于发布目录外。用下列命令生成 JWT_SECRET，将输出直接写入服务器配置：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

隐私主体和联系手机在模板中留空，必须填写自己的运营资料；它们可与门店展示名称、电话分别配置。微信订阅通知已移除，无需配置模板或消息状态；微信登录与手机号授权的配置仍需保留。

Node 需 22 或以上；PostgreSQL 客户端工具须与服务器兼容，可通过 `PG_BIN` 指定 bin 目录。服务器上 `/usr/bin/node` 和 `/opt/booking/current/backend` 与本机不同的，修改 service 文件为实际路径。

## Docker 后端更新

### 站内未读与排序（迁移 023、024）

先备份并校验数据库／图片，在维护窗口部署兼容后端并应用 `023_appointment_inbox.sql` 与 `024_appointment_inbox_consistency.sql`，验证后再上传新版小程序。迁移会写入结构、建立索引及触发器，不清空预约或账号；启用前已有预约默认已读。单后端实例切换会短暂中断接口。

新增 `GET /api/appointment-inbox` 和 `POST /api/appointment-inbox/read`，仅管理员和已绑定芳疗师可用；三端列表支持服务／创建时间升降序，工作人员的新列表还带 `unread=1`。未读列表使用账号、查询和业务版本绑定的短期快照，旧快照失效时保留筛选排序重新查询；已读只确认实际展示的提醒版本。迁移 024 使迁移前旧列表快照需要重查，不清除其已读记录或预约。旧列表请求仍保留原排序兼容，但新前端不可连接缺少上述迁移或接口的后端。

上线核对两名工作人员独立计数、首页跳转、分页不重复／遗漏、旧展示版本不能吞掉新修改，以及切后台／换账号隔离。此功能仅为站内提醒，没有新增微信授权、外部通知、定时提醒或配置凭据。快照一小时后失效，过期快照分批回收，不删除预约和已读记录。回滚仍遵守下方迁移 022 的可写兼容限制，不删除迁移记录来强行回滚。

### 多项目预约（迁移 022）

先构建并检查新镜像，备份并校验数据库和图片，再短暂停止旧后端写入，应用 `022_appointment_projects.sql` 并启动新版后端。迁移为已有预约回填项目关联，不清空业务数据；迁移期间不能让旧实例继续处理预约修改。后端就绪后再上传配套小程序，旧小程序不能用单项目修改覆盖多项目预约，会收到更新客户端提示。

迁移 022 后，旧单项目后端不能作为可写回退版本：它的修改接口不会维护 `appointment_service_items`，会造成详情、筛选与保护规则不一致。出现发布故障应保持停写并优先修复新版；若必须退回旧架构，需另行确认恢复发布前成套数据库／图片备份及其中的后续数据损失，不能只换回旧镜像或删除迁移记录。本说明不授权自动恢复或清空数据。

`deploy/nginx/booking.conf` 使用 Docker 内置 DNS 动态解析 `backend`，避免容器重建并更换内部 IP 后仍访问旧地址。首次部署本次 Nginx 配置时，先备份服务器原配置，再检查并平滑重载：

```sh
cd /opt/booking/current
sudo docker compose --env-file /etc/booking/compose.env -f compose.production.yml exec -T nginx nginx -t
sudo docker compose --env-file /etc/booking/compose.env -f compose.production.yml exec -T nginx nginx -s reload
```

以后只更新后端代码时，重新构建并更新后端容器；后端只有一个实例，更新期间可能短暂不可用，不属于滚动发布。动态 DNS 的缓存时间为 10 秒，更新后应等待就绪并检查外部 `/health/ready`。如仍沿用旧版固定解析配置，后端更新后需要在新容器就绪时重新加载 Nginx。小程序页面的改动仍通过微信开发者工具单独上传。

退出登录会递增账号的会话版本，使该账号此前签发的登录令牌失效，其他设备上的该账号也需要重新登录。

## 图片持久化

先备份，将原 `backend/uploads/therapists` 全部文件复制到服务器持久化目录并核对校验值。保持文件名及 `/uploads/therapists/<文件名>` 相对 URL 不变。

同机迁移可用 `images:migrate`。配置 THERAPIST_UPLOAD_DIR 后重启，检查 `/health/ready`、芳疗师和项目详情。确认重新发布后图片仍可见，再处理旧副本。

## 每日备份

发布芳疗师编辑更新时先应用迁移 018，再配套使用新后端和小程序。迁移为现有芳疗师初始化绑定版本，旧编辑页需重新打开以取得最新版本。显式更换芳疗师手机号会携带原绑定版本，手动开关排班格会携带原时间精度。旧客户端发起这两项更改时可能收到 409，应更新小程序后重新打开对应页面。监控采集器从后端本机回环地址访问规范路径 `/metrics`；Docker 部署可在 backend 容器内采集。

默认保留 14 天。图片引用查询和 pg_dump 使用同一个 PostgreSQL 快照。导出和图片复制期间，专用共享锁推迟孤立图片清理，预约、签到和登录可继续执行。成功校验的完整备份才会发布；未完成备份以 `.pending` 目录留待检查。只删除校验通过且没有额外文件的过期备份目录。更新时配套发布备份脚本与后台清理程序，再启用新版备份任务。

设置 BACKUP_MIRROR_DIR 可复制到已挂载的另一块磁盘或异地目录，校验失败会令任务失败。脚本只能检查目录不重叠，异地性、存储加密和挂载是否有效需要部署时确认。未配置镜像时只有本地备份。备份含个人信息，目录权限限运行用户，密钥另行安全保管。

每天北京时间 02:40 执行：

```sh
sudo install -m 0644 deploy/booking-backup.service deploy/booking-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now booking-backup.timer
sudo systemctl start booking-backup.service
systemctl list-timers booking-backup.timer
journalctl -u booking-backup.service
```

Persistent=true 会补跑服务器离线期间错过的执行。当前不发外部告警，需检查任务状态和最新备份时间。

## 恢复与演练

`backup:rehearse -- --isolated` 需要 initdb、pg_ctl、pg_dump、pg_restore。在备份目录下建立随机密码、仅监听 127.0.0.1 随机端口的临时实例，验证完成后停止并清理。报告为 `restore-rehearsal-latest.json`；原数据库仅供读取。

不传 isolated 时会在当前 PostgreSQL 中创建 booking_restore_... 临时数据库，要求 CREATEDB。可用 REHEARSAL_ADMIN_DATABASE_URL 指定独立演练账号，无需给日常账号增加权限。

手工恢复仅允许不同名称的空数据库和空图片目录，不提供覆盖原库的开关：

```sh
export RESTORE_DATABASE_URL='postgres://<账号>:<密码>@127.0.0.1:5432/booking_restored'
export RESTORE_UPLOAD_DIR='/var/lib/booking/restored-uploads'
npm run backup:restore -- /var/backups/booking/<备份目录名> --confirm-empty-target
```

恢复会为所有用户重新生成随机会话标识，使恢复前签发的登录令牌失效，即使会话版本计数恰好相同也无法复用。历史待发/失败任务标为跳过，避免微信消息重放。事故恢复后需要核对未履行预约和删除申请，配置新数据库/图片目录，运行迁移与健康检查后才开放访问。失败目标保留供排查，不切换业务连接。

`013_session_epoch.sql` 首次部署后需要重新登录一次；缺少随机会话标识的旧令牌将被拒绝。数据库迁移完成后应同时重启后端，以确保签发和校验均使用新逻辑。

只恢复自己管理的可信备份；数据库备份可包含可执行定义。密钥不包含在备份中，需要单独安全保存。

## 日志与进程

Pino 主日志每10分钟检查跨日或10MB大小，按上海日期轮转。文件日期保存在日志目录的 `.rotation-state.json`，持续写入及进程重启都沿用该日期。保持单实例写入同一日志目录。生产默认保留186天。数据库 HTTP、客户端异常、业务、审计及告警日志在启动和每小时45分清理过期部分，每批最多10000条，每表单轮最多100批并受2秒批次预算限制，未处理完的部分下轮继续。清理只处理运行日志。

日志更新包含迁移019，增加客户端异常来源请求编号和日志索引。迁移会写库及建立索引，数据量较大时应在低峰期发布并预留索引空间。发布前执行并验证备份。旧小程序可以继续上报异常，新版小程序上传后才能保留来源请求编号。

Docker Compose 为后端和 Nginx 的容器标准输出配置了每文件10MB、最多5份的轮转上限。该设置在更新对应容器后生效，应用自身的长期日志仍保存在 LOG_DIR。数据库容器沿用既有配置，其容器日志策略在数据库维护时独立核验。后端版本回滚可继续使用迁移019增加的列和索引，无需删除迁移或业务数据。

运行 `deploy/pm2-logrotate.txt` 中的命令配置 PM2 自身输出轮转。Pino 主安全日志在 LOG_DIR，不依赖 PM2 历史文件数量。使用运行服务的同一系统账号：

```sh
export BOOKING_ENV_FILE=/etc/booking/production.env
npm --prefix backend ci --omit=dev
npm --prefix backend run production:check
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

执行 startup 输出的系统安装命令，再安排服务器重启演练。保持单实例，避免定时任务重复执行。示例没有配置外部告警。

## 数据清理和期限

当前账号和记录只做只读盘点。测试账号、正式管理员、会员、排期和资料有关联；清理前先备份，再确定保留范围。不能仅按 mock 标记删除用户，以免损坏已有资料。

预约/会员记录的期限按履约、售后和争议处理需要确定；现有代码没有自动到期删除预约历史。隐私页提供查阅、更正、删除、撤回授权和注销的联系渠道，由门店核验后处理，不能宣称已经实现自动注销。经核验的删除申请需登记，恢复备份时重新执行，备份随 14 天保留期淘汰。

依据：[个人信息保护法](https://www.miit.gov.cn/zwgk/zcwj/flfg/art/2022/art_04a0f1fb5df244e39688fd5372623a8d.html)第十九条、第四十七条；[网络数据安全管理条例](https://cqca.miit.gov.cn/zwgk/wlaqgl/art/2024/art_6b744196beef48829b90f627f6b4c51b.html)第二十一条；[网络安全法](https://www.cac.gov.cn/2025-12/29/c_1768735112911946.htm)的网络日志不少于六个月要求。

技术参考：[pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)、[pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)、[PM2 startup](https://pm2.keymetrics.io/docs/usage/startup/)。

## 域名后的验收

配置 HTTPS/Nginx，替换 API_BASE_URL，设置微信实际使用的合法域名，打开 project.config.json 的 urlCheck；核对微信平台的隐私声明与实际信息处理一致。

在 iOS 和 Android 上验证真实登录、手机号授权、三种身份权限、上传后重开页面、预约全流程（无订阅授权弹窗）、登录回跳、断网重试，以及服务器重启和重新部署后的图片。最后运行 `production:check -- --release`，再提交正式版。


## 排班结构升级

### 过期自动签到（迁移026）

工作人员待签到列表另有“一键签到”入口，需前后端配套发布 `/api/admin/appointments/check-in-preview`、`check-in-batch` 及对应 `/api/therapist/appointments/` 接口。该入口不新增数据库迁移；先发布后端再上传小程序。旧版小程序的逐笔签到保持兼容。

迁移026仅增加自动签到的每日执行记录表，不在迁移中改变预约。启动新版后端后，每天上海时间00:05将前天及更早的未签到预约转为已签到；启动时若已过00:05且当天未执行，也会补跑。因此首次启动可能写入已有历史预约，不仅处理新预约。升级前备份并核对预期范围；无需为此功能更新小程序包，三端重新查询即可显示新状态及实际签到时间。

执行记录、预约更新和业务日志同事务提交，重复进程／重启按日期去重；管理员当天取消签到后，不会因重启立即被补签，下一天再处理。失败日志为 `expired_auto_check_in_failed`，完成摘要为 `expired_auto_check_in_completed`，逐笔系统业务日志 action 为 `auto_check_in_expired`。异常历史重叠会跳过并记录原因，不能删除约束强行签到。失败后可在排除原因后重启后端补跑（会短暂中断接口），不要删除每日执行记录来反复执行。回滚程序不会还原已提交的签到，数据恢复须按备份恢复流程执行。

### 排班即时更新（迁移025）

新版周排班／批量修改会在同一事务更新对应的今天和未来日期配置，保留已有有效预约，独立保存手动关闭区间。迁移025只回填旧关闭区间，不改变已有预约或立即覆盖旧单日配置；明确保存周模板时才执行新规则。生产升级仍应先备份并验证，再在维护窗口应用迁移和切换后端，最后发布包含新确认文案与参数暂缓提示的小程序。

旧后端不理解独立关闭区间和预约保护范围，迁移025并产生新写入后不能仅换回旧后端继续写入。回退须按前述备份恢复流程评估，不删除迁移记录。取消或缩短预约后的保护范围通过查询动态计算，无需新增清理任务。

### 本地从固定时间段切换到每周排班（迁移015）

迁移 015 新增每周模板、日期快照及预约修订。应用启动不会清空旧业务库，有旧排班或预约时迁移会回滚。前后端需要配套更新。在本地开发机优先新建独立数据库并运行迁移，旧环境可作为回退使用。

需要按空库方案清理旧开发库时，先停止针对该库的旧后端及定时任务，备份数据库与图片。在同一终端的环境变量 `LEGACY_LOCAL_DATABASE_URL` 指定本机旧开发库，库名须以 `_dev` 或 `_test` 结尾。以下从仓库根目录执行：

```sh
node backend/src/scripts/resetLegacyLocal.js <本地旧库名>
node backend/src/scripts/resetLegacyLocal.js <本地旧库名> --apply
npm --prefix backend run migrate
```

首条列出各表行数。第二条会在事务内清除指定旧库的账号、白名单、项目、芳疗师、固定时间段、预约、通知、清理候选和运行记录，保留数据库结构及历史迁移记录，只接受已到 014 的旧库。最后一条使用后端的开发环境配置，需指向刚准备的目标库。新环境可配置独立空上传目录。重新登录并通过现有 `seed:admin` 初始化管理员。验收先配置周模板，再从顾客端提交实际起止。回退需使用成套的旧程序、数据库及图片备份。
