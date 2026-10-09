# 多租户首版验收矩阵

状态：用户于 2026-10-02 确认基本测试验证通过，[issue #1](https://github.com/eesql/k-dense-byok/issues/1) 已关闭为 completed。后续修复及验证结果见 [进度记录](multi-tenancy-progress.md)；代码交付与提交记录见 [代码交付 issue #2](https://github.com/eesql/k-dense-byok/issues/2)。

范围：原始 `multi-tenancy-spec.md` 的 58 条用户故事、实现决策与测试边界。执行环境为 macOS、Node 22.22.3；所有模型请求使用本地模拟供应商，OAuth token exchange 被替换为测试响应，没有真实付费调用。用户指定的本机执行信任边界保留。

## 用户故事证据

| 故事 | 实现与直接证据 |
| --- | --- |
| 1–2 | 原生 Node 管理入口和项目进程；实际 macOS CLI、浏览器与真实工作进程测试，无 Docker/VM 依赖。 |
| 3–4 | 默认关闭的启动分支沿用原启动入口；管理数据库、配置和目录独立。单用户认证、项目 scope、凭据与环境注入的原有回归通过。 |
| 5 | ADR-0003、部署文档和管理对话框明确说明全站可信使用者及 shell 无执行隔离。 |
| 6 | 本机管理员初始化 CLI 的实际交互已检查，密码不回显，SQLite 只保存带盐哈希；重复初始化保护在管理存储中。 |
| 7–9 | 管理 HTTP 创建租户、负责人邀请及成员列表；浏览器实际创建 QA-Lab、邀请 owner 并展示 owner 成员。 |
| 10 | 管理 API 停用账号、删除其所有登录会话，并关闭已有响应观察者；HTTP 测试确认旧 cookie 随即被拒绝。 |
| 11–13 | 平台主 Key、累计模型预算、Agent/模型请求并发字段的管理 API 与 UI；浏览器保存 USD 10 预算；租户及全站任务限制测试。 |
| 14 | 按租户/项目聚合全部网关调用的用量 API和表格；API检查 0.7 USD 归属，浏览器检查合成的项目累计 0.2500 USD。 |
| 15 | SQLite 预算/已结算/预约/未结算持久化；重开管理服务仍保留支出，存储恢复仅由持有 manager lock 的服务执行。 |
| 16–18 | 一天有效期、令牌摘要和原子消费；HTTP检查过期、重复消费及并发加入只有一人成功；浏览器加入链接、fragment 清理和刷新保留。 |
| 19–20 | owner/admin 成员接口与租户归属检查；HTTP确认 member 无法邀请/改额度，owner 不能管理其他租户。 |
| 21–24 | scrypt 登录、HttpOnly/SameSite cookie、退出/停用/移除失效、响应观察者撤销；HTTP登录/退出/过期/账号停用测试和浏览器退出。 |
| 25 | 用户/租户命名空间覆盖活动项目、工作区元数据和 IndexedDB；旧身份响应被拒绝；前端存储与延迟 BYOK 回复测试，浏览器退出 active identity 为 null。 |
| 26–27 | 归属型项目列表/创建；浏览器管理员建项目，新加入 owner 看到同一共享项目。科研存储和文件格式复用原后端。 |
| 28–29 | 管理入口统一检查 path/header/query/cookie/body 的项目选择，拒绝冲突与外部资源；固定项目工作进程拒绝其他 ID，不读取默认工作区作为回退。HTTP双租户矩阵覆盖详情、修改、删除、历史、文件、Office、OAuth及停止操作；删除后返回404。 |
| 30 | HTTP/SSE透传、broker持续拥有运行、实际模型流、工具回合及重开历史；原流式重连/abort/run-broker 回归。 |
| 31 | multipart 不整包缓冲，原后端限额继续生效；实际项目进程上传/下载文本、二进制读写、预览通过认证代理。资源请求只携带用户 cookie/项目选择。 |
| 32 | 实际 Office DOCX 二进制读取、样式预览、修订保存、过期修订拒绝；原三种 Office 格式的预览/原生编辑桥接/修订回归。 |
| 33 | 真实模型调用 interview 等待回答，经代理提交选项后继续；真实 destructive guard 请求经代理拒绝后保留文件。原 steer/abort/follow-up/permissions 回归。 |
| 34 | BYOK 模型字段与供应商目录继续使用原 API；真实 Pi manual OAuth 经管理代理完成、共享认证状态重开，其他租户拒绝访问。原 callback/manual/provider catalogue 测试覆盖各供应商合同。 |
| 35 | 管理服务串行提交暂存 env/auth/MCP 变更；BYOK认证使用一个规范路径，文件锁由 SDK持有；实际旧 Key、存储 Key优先和新 Key运行检查。 |
| 36–38 | 管理项目明确显示供给；实际 BYOK/平台请求各用其 Key；失败不改变供给字段，UI提供明确手动选择，浏览器持久化切换。 |
| 39 | 平台 Pi models.json 覆盖内置/子代理请求地址，统一网关；实际 parent、detached child、scheduled child 请求都到本地网关上游，认证为平台主 Key。 |
| 40–41 | 先 drain 后检查全部活动/调度，再重建；真实忙碌模型/子代理和未暂停计划导致 409，空闲切换保存文件及历史。损坏元数据导致重建失败时公开入口报告失败、仍保持选择的来源；修复后可读取原文件。 |
| 42–43 | pending 状态由项目元数据暴露；新模型任务拒绝，旧工作在 per-work auth snapshot 上继续；实际工具回合中更新凭据，空闲项目用新 Key、忙碌项目完成后重载。启动中的项目纳入更新，新项目等待共享配置事务完成；并发保存/启动后实际工作进程读取新Key。 |
| 44–46 | 实际 HTTP SSE在结束前收到首段，并发调用拒绝；断流保留未结算状态与预约，不当作零支出；管理员确认费用接口受角色控制。 |
| 47 | 项目文件、历史与归属在 worker 重建及管理数据库重开后保留；普通聊天重启终止语义与原项目/Modal恢复规则不变。 |
| 48 | OAuth API所有请求先校验所属项目；provider loopback callback留在原 SDK listener；计划的居民会话/内部回调继承固定项目/env/token，实际计划运行与OAuth代理测试。 |
| 49 | 外部服务配对验证/暂存仍使用原 credentials handler，服务 env复制到两种供给的 worker；平台 Key 写入被限制，Modal/source manager原回归通过。GPU实际执行按规格不使用真实付费供应商测试。 |
| 50 | 移除成员只撤销用户会话/观察者，worker及项目任务不按用户停止；broker对浏览器断开仍拥有运行。原断线运行及管理会话撤销测试覆盖两层合同。 |
| 51 | 服务端角色与归属授权；member 修改租户/额度/平台Key和外部项目请求被拒绝，项目所属租户不可变。 |
| 52 | 主 Key 保存在管理数据库/网关，不进入 worker env，普通 status响应只给 configured；真实上游头为主 Key而worker只持项目令牌；错误和诊断凭据值有脱敏检查。 |
| 53 | parent/child/watchdog分别持有租约，SDK已等待的 session_shutdown释放child租约；真实完成/拒绝/清理和同-child双review测试；进程退出只清理匹配该worker token的租约。 |
| 54 | Native模型上游全部是本地mock；OAuth exchange mock拒绝意外外部URL；数据/认证/SQLite均临时目录。 |
| 55–56 | 开关解析、native off/invalid启动失败且不创建状态；on不自动回退；锁所有权下重开保留归属/余额；off入口不加载管理服务或映射租户工作区。 |
| 57 | 新能力集中在 managed模块、独立启动文件和可选外壳；原文件仅启动/env/scope/生命周期/cache接入；没有更改第三方 SDK/extension源，required child-runtime 是本仓库拥有的扩展。 |
| 58 | 原单用户启动/页面分支继续作为关闭路径，前端内部flag由同一个部署开关派生；原完整前后端回归证明未启用路径兼容。 |

## 实现及验证约束

- API会话401、角色403、项目404、冲突/忙碌409、预算402、并发429均从入口检查；既有provider认证401不触发管理session-expired标记。
- manager独占锁防止另一个实例重新恢复活动状态；本机初始化/读取存储不会清空已有承诺。重启的已提交调用以未结算状态保留，确认费用幂等，预算调整不重置账本。
- 请求路径与固定上游 origin校验，binary/SSE回压由Node流执行；same-origin、Host、CSRF和原后端路径/CSP/Office修订校验保留。开发WebSocket转发仅限已配置UI origin下的 `_next`路径。
- 一次性编辑/方法/实验建议/语音请求持有独立任务租约；主会话、子代理、watchdog和计划归属同一额度规则。写操作的busy生命周期持续到实际处理结束，不以客户端close提前清除。
- 模式、供给和预算是不同概念。预算为累计模型费用估计，20人/5任务为容量参考；无执行隔离、provider硬账单上限或任意程序资源配额的声明。
- 本规格的不做项（开放注册、SSO、邮件、支付、多机/VM隔离、私人空间及自动供给回退）没有被暗中引入。

## 检查入口

主要 managed checks：`multitenant.test.ts`、`multitenant-workers.test.ts`、`multitenant-runs.test.ts`、`multitenant-gateway.test.ts`、`multitenant-oauth.test.ts`、`multitenant-lifecycle.test.ts`、`multitenant-diagnostics.test.ts`。前端包括 managed shell/storage/discovery 和原有 workspace/Office/模型回归。

首轮完整回归（2026-10-02）：后端137个测试文件通过、1个跳过，1471项通过、8项跳过；前端128个文件、855项通过。后续模型目录修复后的完整前端回归为857项通过，后端目录／模型／定价相关48项通过；token上限修复的网关／管理／运行链相关14项通过，并补充真实Pi DeepSeek大token流式调用验证。两端typecheck、前端初始生产构建、启动脚本语法及 `git diff --check` 通过。付费服务发票、硬件最大吞吐和不互信用户隔离属于用户已确认的限制，不能用本地mock测试作这些主张。

浏览器证据在 `/private/tmp/kady-browser-qa/`：桌面1200×900与移动390×844的登录、邀请、共享项目、供给、退出及用量截图。Browser插件未提供，因此使用Playwright CLI，未向项目增加浏览器依赖。已关闭测试浏览器与服务。测试返回的未登录401、SQLite实验性提示、原KaTeX预加载警告及jsdom canvas警告不代表应用框架错误；正常登录后的关键页面未出现框架覆盖层或运行时错误。
