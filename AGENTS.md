# AGENTS.md

本文件适用于整个项目；若工作目录下存在更具体的 `AGENTS.md` 或 `AGENTS.override.md`，先检查其适用范围。业务语义以 [PRODUCT.md](PRODUCT.md) 的相关章节为依据，不能把当前实现、旧审查发现或测试断言直接当成产品要求；矛盾标为待确认。

## 项目与定位入口

- 原生微信小程序 + CommonJS Node.js/Express + PostgreSQL，Node >= 22；不使用 React/Vue/uni-app/Taro。前端是 `.js/.wxml/.wxss/.json`，不是 HTML 页面。
- [PRODUCT.md](PRODUCT.md)：身份矩阵、状态流转、排期与删除保护、筛选、通知和数据保留规则。涉及其中某项时按章节读取，不必每次重读全部文档。
- [miniprogram/app.js](miniprogram/app.js)、[app.json](miniprogram/app.json)：会话、入口与导航；[pages](miniprogram/pages)、[components](miniprogram/components)：页面与复用组件。
- [miniprogram/services](miniprogram/services)、[utils](miniprogram/utils)：API 调用、请求、资源缓存、上海时间、登录回跳；[config](miniprogram/config)：API 与商家回退配置。
- [backend/src/routes](backend/src/routes) → [controllers](backend/src/controllers) → [services](backend/src/services) → [repositories](backend/src/repositories)：路由授权、输入／响应、业务事务、参数化 SQL；[middleware/auth.js](backend/src/middleware/auth.js) 与 [accessService.js](backend/src/services/accessService.js) 是身份检查入口。
- [backend/migrations](backend/migrations) 是按编号累积的结构演进。不能只看初始迁移推断当前约束；已有迁移不重写，结构调整新增迁移。
- [backend/tests](backend/tests)：Node 原生测试、微信 Page/Component VM 模拟和隔离 PostgreSQL 集成测试。定时任务注册在 [server.js](backend/src/server.js)，没有独立 `src/jobs` 目录。
- [compose.production.yml](compose.production.yml) 与 [deploy/nginx/booking.conf](deploy/nginx/booking.conf)：Docker 部署；[ecosystem.config.js](ecosystem.config.js) 与 [nginx/booking.conf](nginx/booking.conf)：非 Docker 方案。选对当前部署方式，详见 [deploy/README.md](deploy/README.md)。

## 工作方式和架构边界

1. 先用 `rg --files` 和定向 `rg -n` 找入口，读相关业务章节、调用链和测试。常规改动集中审查差异与关联流程，只有跨模块证据才扩大范围，不重复扫描全部源码、日志和历史聊天。
2. 保持当前分层与文件风格：业务校验、权限范围及事务在服务端完成，仓储传入同一事务 client；SQL 参数化。预期错误用 `AppError`，沿用 `{ success, data }`／`{ success:false, code, message, requestId }`；不要把数据库故障伪装为用户错误。
3. 修改接口、字段或状态时，核对对应 routes/controllers、服务、迁移、`miniprogram/services` 和页面／组件调用；搜索旧字段、URL 和兼容回退。例如 `specialtiesVersion` 必须与编辑页协同发布，不能仅改后端使旧客户端反复失败。兼容分支不得绕过授权。
4. 后端取实时身份与资格；前端只展示能力。保留按账号／请求版本隔离异步结果、按稳定 ID 定位卡片、账号切换清草稿的做法。缓存失效应覆盖相关列表与详情，不能靠重启或清缓存掩盖竞态。
   预约／排期、项目／芳疗师资料、白名单写入及芳疗师客户读取通过 [currentActorService.js](backend/src/services/currentActorService.js) 在事务身份锁后复核会话与权限；受保护查询使用同一事务 client。`markNoShows()` 有独立事务，不要在已持有身份锁的事务内再调用它。
   门店元数据、公开项目／芳疗师列表和详情显式匿名请求，DTO 不随身份变化；不要把匿名选项用于预约、管理或上传接口。公共缓存可以跨会话复用，受身份影响的数据仍需账号／请求版本隔离。
5. 商家资料以元数据接口和环境配置为准；不把本地 `business.js` 回退值当成服务端配置。开源快照默认使用无效示例域名／AppID、不可拨打的示例电话、虚构商家和上海人民广场示例坐标；前后端示例须一致。示例不能成为可用凭据，未启用的可选配置用注释提供示例，内部空值哨兵保留；只有使用者配置自己的服务后才能上线。图片、图标沿用现有资产约定，不硬编码真实商家为通用规则。
6. 不读取、输出或提交真实密钥、令牌、数据库连接串或客户资料。文档用相对路径、环境变量名和占位符；不把依赖目录、临时日志或本机环境写入长期上下文。
7. 本地修改不等于已部署。未获当前任务授权，不连接生产、不清数据、不执行恢复、不重启或重建服务；不得自动删除容器或卷。需要部署时先检查实际环境、备份并遵循部署说明。
8. 业务决定变化更新 PRODUCT.md；开发入口、验证方式变化更新本文件；详细操作放 README／部署说明。新增文档尽量链接现有资料。保留 PRODUCT.md 的 `impeccable:product-schema` 标记及其必要标题结构。

## 运行与检查命令

下表均从**项目根目录**运行；需已安装 Node >= 22、npm，按需配置本地 PostgreSQL。不要为了只读审查或文档修改启动服务或迁移。

| 命令 | 前提和作用 |
| --- | --- |
| `npm --prefix backend ci` | 按 backend 锁文件安装依赖，会写依赖目录；仅安装确有需要时执行 |
| `npm --prefix backend run migrate` | 配置开发环境与数据库后应用迁移，会写库 |
| `npm --prefix backend start` | `prestart` 自动迁移，再启动 API 和定时任务；默认端口 3000 |
| `npm --prefix backend test` | 基础回归；未设置 RUN_DB_TESTS=1 时集成用例会跳过，不能宣称验证了真实并发 |
| `npm --prefix backend run opensource:check` | 仅用于发布通用开源快照前检查模板默认值；与日常回归分离，不能要求已配置的使用者清空 AppID 或门店资料 |
| `node --check <相对路径.js>` | 检查改动 JS 的语法，不执行其业务逻辑 |
| `npm --prefix backend run production:check` | 需 NODE_ENV=production、BOOKING_ENV_FILE 指向相应配置；只检查代码／配置／资源，不证明线上可用 |
| `npm --prefix backend run production:check -- --release` | 增加 HTTPS 地址、AppID 一致性、合法域名校验；仍不能替代真机验收 |

- 开发配置示例为 [backend/.env.example](backend/.env.example)，生产示例为 [backend/.env.production.example](backend/.env.production.example)。默认 dotenv 按进程 cwd 查找 `.env`；`npm --prefix backend ...` 会在 backend 运行。直接执行 Node 脚本时先进入 backend，或正确设置 `BOOKING_ENV_FILE`，不要误连其他环境。
- `npm --prefix backend run dev` 使用 POSIX 的 `NODE_ENV=development` 语法，不能直接用于 Windows PowerShell。PowerShell 可在 backend 内分行设置 `$env:NODE_ENV='development'`、执行 `node src/server.js`；该直接启动方式需先单独迁移。Linux 可直接用 dev 脚本。
- 后端已有 `images:status/images:cleanup/images:migrate`、`backup/backup:verify/backup:restore/backup:rehearse`、`ops:status` 脚本，参数和副作用看 [部署说明](deploy/README.md)；不是所有检查命令都不写文件或数据库。
- 微信开发者工具导入根目录，`project.config.json` 指向 `miniprogram/`。没有前端 npm build、lint 或浏览器 E2E 脚本，不虚构命令。业务 JS 可做语法检查，JSON 可解析，WXML 事件和资源引用需静态核对。

普通回归测试用显式夹具验证运行模式，不应断言工作区的本机调试开关必须关闭或商家资料必须为空。公开模板断言集中在 `backend/tests/release/`，由 `opensource:check` 单独执行；发布小程序仍需 `production:check -- --release`。

### 相关测试如何选择

以下命令在 **backend 目录**运行；选择相关组，不要求每次运行所有组。

| 改动范围 | 测试入口 |
| --- | --- |
| 创建／修改／取消／签到 | `node --test tests/appointmentService.test.js tests/appointmentInput.test.js tests/bookingProjects.test.js` |
| 多项目预约、卡片与详情 | `node --test tests/multiProjectAppointments.test.js tests/dayBookingForm.test.js tests/appointmentNavigation.test.js`；`multiProjectIntegration.test.js` 按下文使用隔离 PostgreSQL 验证迁移、关联项目保护、历史、筛选与事务回滚。项目集合在 `appointment_service_items`，旧单项目列只作兼容，查询和删除保护不得只检查首项目 |
| 排期、批量、配置保护 | `node --test tests/scheduleService.test.js tests/businessRegression.test.js` |
| 登录、身份、白名单、芳疗师范围 | `node --test tests/authService.test.js tests/therapistIdentity.test.js tests/therapistPortalService.test.js tests/whitelistService.test.js` |
| 私有审核码登录、入口开关与环境选择 | `node --test tests/reviewLogin.test.js tests/reviewLoginFrontend.test.js tests/productionHardening.test.js`；真实 HTTP／事务撤销另跑 `reviewLoginIntegration.test.js`，必须使用下述隔离测试库。配置和关闭步骤见部署说明，生产 mock 始终关闭 |
| 回收站、图片 | `node --test tests/recycleBin.test.js tests/imageUpload.test.js`，生命周期／引用关系另跑数据库集成 |
| 移除订阅后的业务兼容、旧任务停用 | `node --test tests/subscriptionSettings.test.js tests/subscriptionRetirement.test.js`；后者需显式指定隔离测试库并启用 RUN_DB_TESTS |
| 页面交互、异步状态、缓存 | `node --test tests/frontendRegression.test.js tests/resourceCache.test.js` |
| 三端预约列表排序与游标分页 | `node --test tests/appointmentSorting.test.js tests/appointmentRepository.test.js tests/cursor.test.js`；真实 HTTP／数据库用 `node --test --test-concurrency=1 tests/appointmentSortingIntegration.test.js tests/multiProjectIntegration.test.js`，需下述独立测试库及 RUN_DB_TESTS=1。同库首次创建扩展时串行运行，避免隔离 schema 之间竞争扩展初始化 |
| 工作人员未读提醒、首页优先级与已读分页 | `node --test tests/appointmentInbox.test.js tests/appointmentInboxFrontend.test.js tests/appointmentInboxRegression.test.js tests/appointmentInboxLifecycle.test.js`；`node --test --test-concurrency=1 tests/appointmentInboxRegression.test.js tests/appointmentInboxIntegration.test.js tests/appointmentSortingIntegration.test.js tests/multiProjectIntegration.test.js` 使用下述隔离库。迁移 023 保留旧预约已读，触发器在创建／取消及修订事务中递增提醒版本；024 为列表快照补充预约业务版本，旧快照需重查但保留精确版本确认。快照不复制客户资料，有效期一小时，分批回收过期快照，不删除预约或已读记录。测试区分请求返回、setData 完成和页面可见；追加分页不能作废此前已展示页，原预约变化则须刷新查询；返回等待身份刷新时不能确认隐藏期间加载的记录 |
| 当日排班同页预约、草稿与登录回跳 | `node --test tests/dayBookingForm.test.js tests/appointmentNavigation.test.js tests/bookingProjects.test.js tests/bookingDateReturn.test.js`；表单与提交状态在 `miniprogram/utils/scheduleBooking.js`，页面渲染在 `components/day-schedule` |
| 预约页芳疗师筛选、时间范围自动调整 | `node --test tests/bookingRosterFilters.test.js tests/bookingDateReturn.test.js tests/scheduleService.test.js`；抽屉状态与时间调整在 `miniprogram/utils/bookingFilters.js`。前者含回环 HTTP 测试，需允许本机端口连接；真实数据库另跑 `bookingRosterFiltersIntegration.test.js`，沿用下文隔离条件 |
| 签到／取消确认、重载与重复操作 | `node --test tests/checkInConfirmation.test.js tests/confirmationLifecycle.test.js tests/appointmentCancellation.test.js`；周模板、当日调整与本人详情权限另跑 `confirmationTransactions.test.js`，需 RUN_DB_TESTS=1 和显式 TEST_DATABASE_URL，沿用 `audit-2026-10-20/isolated.js` 限定的独立本地测试库 |
| 审查后回归：页面竞态、游标、预约登录回跳 | `node --test tests/auditFixesFrontend.test.js`，已纳入 `npm test`；数据库专项见 `backend/tests/audit-2026-10-20/`，必须显式指定隔离测试库 |
| 看板输出、事务身份复核、游标和保存草稿 | 默认测试包含 `currentActorService.test.js`、`cursor.test.js`、`auditOctober22Frontend.test.js`、`publicCatalog.test.js`；管理事务等待锁专项为 `audit-2026-10-22/postfix.test.js`，隔离前提和命令见下文“隔离数据库验证” |
| 周排班多日草稿、批量表单及真实保存链路 | 页面先跑 `node --test tests/batchWeeklyMemory.test.js tests/weeklyDirectory.test.js`；真实 HTTP／数据库跑 `node --test tests/batchSlotsE2E.test.js tests/flexibleAppointmentTransactions.test.js`，需按下文启用 RUN_DB_TESTS 并配置本地测试库。前者的数据库链路包含单人多日原子提交、失败回滚及锁后权限复核；微信原生返回询问为模拟 |
| 生产配置、备份与会话恢复 | `node --test tests/productionHardening.test.js`，真实恢复与并发按独立环境另验 |
| 日志、脱敏、查询与事务输出 | `node --test tests/logManagement.test.js tests/productionHardening.test.js`；日志完整链路需启用下述隔离数据库。事务测试使用 `db.withTransaction(client, handler)`，以验证提交后日志和回滚行为 |

已确认 bug 尽量增加能复现触发条件的回归测试；不要只测试新实现的内部步骤。相关检查通过后，只有新改动、失败或未解决风险才扩大／重复测试。纯文档变更优先检查链接、命令依据、职责、秘密泄漏和变更范围。

### 隔离数据库验证

涉及事务回滚、锁顺序、唯一／排他约束、绑定竞态、回收站引用或备份恢复，模拟测试不足。阅读 [therapistIntegration.test.js](backend/tests/therapistIntegration.test.js)；批量操作另有 [batchSlotsE2E.test.js](backend/tests/batchSlotsE2E.test.js)，将页面事件和实际前端服务接到真实 HTTP API 与数据库，但不覆盖微信原生界面渲染。使用专用本地测试数据库，**不连接生产**。

PowerShell，从根目录运行（连接串占位符须先替换为专用测试库；完成后恢复本次设置的环境变量）：

```powershell
$env:TEST_DATABASE_URL='<专用测试数据库连接串>'
$env:RUN_DB_TESTS='1'
npm --prefix backend run test:db
```

Linux，从根目录运行：

```sh
TEST_DATABASE_URL='<专用测试数据库连接串>' RUN_DB_TESTS=1 npm --prefix backend run test:db
```

整套数据库验证使用 `npm --prefix backend run test:db`，串行测试文件以免临时 schema／扩展生命周期互相干扰；用例内部并发仍保留。备份测试需 PostgreSQL 18 客户端工具，必要时设置 `PG_BIN`。测试会建独立临时 schema、应用全部迁移并写临时图片，最后清理；账号需有建 schema 和所需 PostgreSQL 扩展的权限。显式指定本机专用测试实例（127.0.0.1:55483，库名 booking_audit）。测试不得加载真实商家数据充当 fixture。

## Code Review Rules

1. **身份不能被手机号或前端参数提升。** 核对管理员优先、芳疗师独立绑定、实时会员资格和本人数据范围；OpenID 冲突按 PRODUCT.md 处理并使旧会话失效。旧账号请求不得覆盖新账号页面或清除新会话。
   私有审核码只登录数据库标记的固定测试身份，不能复用或换绑真实账号；开关、截止时间和凭据版本须在鉴权及事务身份锁后检查。前端入口隐藏不等于撤销权限，审核码不得进入日志或小程序包。`config/development.js` 的本机调试开关上传前关闭，不能因 `develop` 自动连接本机。
   测试令牌须使用独立签名域，旧版普通 JWT 校验不能接受它；白名单测试会员的标识只读，恢复仅由管理员明确操作，不能放松真实手机号校验或登录时自动补回资格。
2. **排期与预约写入必须防止竞态。** 按实时身份锁、排序的芳疗师、预约行的顺序校验并写入。同一芳疗师及同一顾客的有效预约有半开区间排他约束。首次成功预约及有效单日调整在同一事务固定日期，用周模板覆盖多个组合不能覆盖固定日期。
3. **区分预约时间与排班配置。** 签到从预约实际开始前一小时开放。修改保持日期、芳疗师、预约 ID 及签到时间，锁后复核时钟和版本。已开始固定起点，结束即停止修改。日排班只允许开关空闲未结束格，端点能作结束不代表能作开始。资料停用依据实际未结束有效预约。
4. **恢复不能破坏关联与历史。** 项目／芳疗师追加恢复、重新校验账号绑定；保留可恢复标签和回收站图片，显式标签编辑校验版本且不截断数量。永久删除仍保留预约快照和历史可读性，不能级联抹掉业务记录。
5. **“全部”、停用与分页必须一致。** 不选或完整全选均不加该分类条件；“已停用”用独立条件与所选在用项取并集。历史筛选在 SQL 分页前完成；抽屉草稿、账号切换和旧请求不能制造隐形筛选或泄漏其他人员资料。
6. **订阅已移除，不误删登录与状态处理。** 所有身份均不申请订阅、不入队或发送通知；不得重新引入模板、发送端点和提醒任务。微信登录／手机号授权、自动未签到和事务日志仍保留。旧通知表与迁移仅作历史兼容；迁移和恢复旧备份须停止遗留待发任务，旧 JWT 在恢复后仍须实际失效。
   站内未读提醒独立于旧通知渠道：按账号、预约和展示版本确认，旧版本不能清除新变更；工作人员未读优先列表沿用身份与查询绑定的快照位置，不能按实时已读分组直接续页，也不能混用旧提醒与新业务内容。新前端的未读列表需与迁移 023、024 及对应后端配套发布；旧列表接口仍保留原排序兼容。已读请求按 UUID 规范值检查重复，不能让大小写变体导致重复 upsert。

## 审查证据与完成标准

- 每项发现给出文件位置、触发条件、证据和实际影响；区分“已复现”“源码确认”“待验证风险”。不把假设、历史已修问题或未测设备效果写成当前确定故障。
- UI 检查区分 WXML/WXSS 静态核对、Node VM 模拟、开发者工具渲染和 iOS／Android 真机验收。涉及排版、手势、键盘、安全区、手机号授权弹窗、上传或登录回跳时，说明实际验证层级及未覆盖设备；模拟通过不代表真机通过。
- 汇报改动原因、相关测试和限制；说明是否仅本地、是否有迁移、是否已发布。不沿用历史测试数量，不把跳过的数据库测试或配置检查说成完整业务／生产验收。
