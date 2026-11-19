# 续章工坊

在桌面网页上传小说滚动录屏，核对识别出的前文，查看主线、人物和当前矛盾，再生成续章。如果只有文字，也可以粘贴前文或上传 TXT。

| 入口 | 用途 |
| --- | --- |
| [续章工坊](http://127.0.0.1:4173/) | 上传录屏、确认前文、续写、登录、订阅与充值 |
| [管理后台](http://127.0.0.1:4173/admin) | 订阅与定价、支付订单、模型配置和用量 |

详细说明见 [项目说明书](docs/项目说明书.md)、[功能文档](docs/功能文档.md) 和 [用户全流程](docs/用户全流程.md)。

## 本地启动

使用 Node.js 22.13+。在 macOS 上安装 Xcode Command Line Tools，以便构建使用 AVFoundation 和 Apple Vision 的录屏识别程序。

```bash
npm ci
npm run build
npm start
```

服务默认监听 `127.0.0.1:4173`，通过 `PORT` 可修改端口。`NF_DB_PATH` 默认为 `data/novelflow.sqlite`。macOS 构建产出 `dist-server/ocr-video`。单独部署识别程序时，`NF_OCR_BIN` 可指定可执行文件路径。该程序接收视频本地路径，向标准输出写出按时间排序的 `[{ "at": 秒数, "lines": [{ "text": "文字", "y": 屏幕纵向归一坐标 }] }]`。

## 模型、登录与在线支付

| 用途 | 配置 |
| --- | --- |
| 续写模型 | 在后台「模型与开关」保存 DeepSeek 或 Gemini 的 API Key，添加并测试档位。也可通过 `NF_PROVIDER_KEY`、`NF_MODEL` 与 `NF_UPSTREAM` 运行兼容接口的旧配置 |
| 管理登录 | 本机可运行 `node scripts/init-local-admin.mjs` 初始化仅密码登录，重启后读取 `data/管理员密码.txt`。TOTP 登录可设置 `NF_ADMIN_PASSWORD_HASH` 和 `NF_ADMIN_TOTP_SECRET`。密码哈希由 `node scripts/admin-password.mjs` 从标准输入生成。TOTP 使用至少 26 个随机 Base32 字符，设置为 SHA-1、6 位、30 秒 |
| 短信网关 | `NF_SMS_WEBHOOK` 为 HTTPS 地址，`NF_SMS_WEBHOOK_TOKEN` 用于 Bearer 鉴权。服务发送 JSON `{ phone, code, expiresIn: 300 }`，网关成功时返回 2xx。本地测试可把 `NF_SMS_DEV_INBOX` 指向私有收件文件 |
| 加密存储模型 Key | 通过本机初始化脚本启用。自行部署时设置 32 字节十六进制 `NF_SETTINGS_SECRET`。后台按厂商加密保存 Key |
| 成本单价 | 默认环境档使用 `NF_INPUT_COST_PER_MILLION` 和 `NF_OUTPUT_COST_PER_MILLION`，单位是元/百万 tokens |
| 在线支付 | 用 `NF_STRIPE_SECRET_KEY`、`NF_STRIPE_WEBHOOK_SECRET`、`NF_PUBLIC_ORIGIN` 启用 Stripe Checkout |
| 订阅和充值 | 在后台「订阅与定价」设置订阅价格、有效天数和篇数，以及可售充值金额和基础单篇价格。商品价格以人民币分录入。每档余额单价在「模型与开关」用元填写 |
| HTTPS 反代 | 上线反代需支持 SSE，使用 `NF_SECURE_COOKIE=1`。仅在本机可信反代覆盖转发头时设置 `NF_TRUST_PROXY=1` |

录屏支持 MP4、MOV 和 M4V，最长 3 分钟，最大 100 MB。服务端识别完成后删除临时录屏。用户确认前文并开始续写时，模型服务收到原样的前文，用于分析和逐段续写。TXT 导入在浏览器中读取，支持 UTF-8。

### 配置 DeepSeek 和 Gemini

1. 打开管理后台「模型与开关」，在厂商卡片粘贴并保存 Key。两家各用自己的 Key，同一家多个档位共用此 Key。
2. 点击「查看可用模型」查询厂商目录。也可直接使用页面预设，再用档位上的「测试连通」检验该 Key 是否能调用所选型号。实际权限、用量与价格由厂商账号决定。
3. 在「续写档位」选厂商和具体模型，填写用户看到的档位名和单篇价格。价格留空时沿用「订阅与定价」的基础单篇价格。保存后可测试、设为默认或停用。
4. 已登录用户可选已启用且接入 Key 的档位。有可用订阅篇数时，各档统一扣 1 篇。使用余额时才按所选档位的页面报价结算。游客试写使用默认档。

[DeepSeek 官方模型](https://api-docs.deepseek.com/quick_start/pricing/) · [Gemini 官方模型](https://aistudio.google.com/docs/models) · [Gemini API Key](https://aistudio.google.com/docs/api-key)

### 支付配置

- `NF_PUBLIC_ORIGIN` 填用户访问的站点地址。正式收款使用公开的 HTTPS 地址。Stripe 收银台付款完成后返回此站点。
- 在 Stripe 配置 `/api/payments/stripe/webhook` 的完整 HTTPS URL，订阅 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed` 和 `checkout.session.expired`。将对应端点的签名密钥与 API 密钥配置到同一测试或正式环境。
- 订单使用人民币分保存金额。服务端核对签名、订单号、币种、金额和支付状态后入账。回到网站时也可向支付服务核对状态。重复通知会返回原订单结果。订阅采用一次性付款，到期可手动续购。
- 历史已入账订单、现有篇数和余额继续保留。旧商品中符合新订阅或等额充值结构的配置会自动归类。正式商户收款未联调，退款也没有自动回收篇数或余额。正式上线前应向支付服务商确认商户可接受的付款方式，以及平台内充值余额的适用限制。

支付接口参考 [Stripe 订单交付](https://docs.stripe.com/checkout/fulfillment?ui=full-page)、[Stripe Webhook 签名](https://docs.stripe.com/webhooks/signature)和 [Stripe 业务限制](https://stripe.com/legal/restricted-businesses)。

## 检查与开发

- `npm run verify` 运行单测、类型检查与构建。
- `npm run smoke:models` 用两个本地厂商桩和 Chrome 验证模型配置、Key 复用、订阅额度和按档位余额扣款。
- `npm run smoke:commerce` 使用临时 SQLite、短信收件箱、模型桩和 Chrome 验证登录、支付确认、余额入账和结算。设置 `NF_TEST_RECORDING` 为本地录屏路径可同时运行实际 OCR 和前文确认流程。
- `npm run dev` 提供前端热更新。另开进程用 `npm start` 启动 API，Vite 将 `/api` 转发到本地 4173。开发后台入口为 `/admin/`。
