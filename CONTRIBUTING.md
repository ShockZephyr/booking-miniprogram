# 贡献指南

1. 按 [README](README.md) 在自己的空数据库中配置开发环境；业务预期以 [PRODUCT.md](PRODUCT.md) 为准。
2. 保持原生小程序和 routes → controllers → services → repositories 分层；权限、并发和事务必须在服务端校验。
3. 按 [AGENTS.md](AGENTS.md) 选择相关回归，已确认缺陷应增加针对业务结果的测试。事务和锁用独立 PostgreSQL 验证。日常回归允许自己的本地配置；通用开源快照发布检查单独运行 `npm --prefix backend run opensource:check`，不为通过它清空使用者配置。
4. 修改接口时检查小程序调用、旧客户端兼容和部署顺序。业务规则变化同步更新 PRODUCT.md。
5. 提交说明触发场景、行为变化、验证结果和未覆盖范围。不要提交环境文件、审核码、业务数据、截图中的个人信息或依赖目录。
6. 不要为格式调整批量升级依赖；不得把模拟测试称为微信真机验收。

代码采用 [MIT](LICENSE)；素材说明见 [图标目录](miniprogram/assets/icons/README.md)。
