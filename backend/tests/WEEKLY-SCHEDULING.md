# 排班与预约验证入口

业务预期见 [PRODUCT.md](../../PRODUCT.md)，测试前提见 [AGENTS.md](../../AGENTS.md#隔离数据库验证)。本说明不沿用历史测试数量或设备验收结论。

| 范围 | 测试 |
| --- | --- |
| 单人多日草稿、批量覆盖、自动排序 | [batchWeeklyMemory.test.js](batchWeeklyMemory.test.js)、[weeklyDirectory.test.js](weeklyDirectory.test.js) |
| 顾客同页选时、项目、备注、重复提交与登录回跳 | [dayBookingForm.test.js](dayBookingForm.test.js)、[appointmentNavigation.test.js](appointmentNavigation.test.js) |
| 页面事件 → HTTP → PostgreSQL | [batchSlotsE2E.test.js](batchSlotsE2E.test.js) |
| 抢订、续时、模板变更、日期冻结及锁后校验 | [flexibleAppointmentTransactions.test.js](flexibleAppointmentTransactions.test.js)、[confirmationTransactions.test.js](confirmationTransactions.test.js) |
| 多项目迁移、历史与删除保护 | [multiProjectIntegration.test.js](multiProjectIntegration.test.js) |
| 旧模型迁移的隔离预检 | [localScheduleCutover.test.js](localScheduleCutover.test.js) |

在 backend 目录运行对应 `node --test tests/<文件名>`。数据库部分必须显式启用 `RUN_DB_TESTS=1` 和专用本地 `TEST_DATABASE_URL`；仅接受 `127.0.0.1:55483/booking_audit`，采用随机 schema、虚构账号、临时图片和可控时间。

测试清理仅针对本次资源；不得连接生产或把真实资料作为 fixture。微信原生 UI 另验：窄屏分组换行、边界点颜色、确认弹窗期间切日、键盘与底栏、连续修改一次返回、图片失败重试、授权与登录回跳。Node VM / HTTP 测试不能替代 iOS 和 Android 真机验收。

整套数据库回归从根目录执行 `npm --prefix backend run test:db`，需上述隔离库和 `RUN_DB_TESTS=1`。测试文件串行，用例内部并发保留；备份用例需匹配 PostgreSQL 18 的客户端工具（`PG_BIN`）。
