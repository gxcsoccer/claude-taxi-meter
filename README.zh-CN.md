# 🚕 Claude 出租车计价器

[English](README.md) | **简体中文**

给 Claude Code 装一个出租车计价器。Claude 每烧掉一点 token，状态栏里的金额就往上跳一下：$0.03、$0.47、$2.18……看着数字往上蹦的那种肉疼感，比任何"成本意识"说教都管用。

![Claude 出租车计价器演示：状态栏金额实时上涨，面板显示大号 LED 数字，越过 $0.50 时弹出 Ka-ching 提示](docs/demo.gif)

## 安装

在 Claude Code 里输入：

```
/plugin marketplace add gxcsoccer/claude-taxi-meter
/plugin install taxi-meter@claude-taxi-meter
```

下次启动会话时计价器就会出现（或者运行 `/reload-plugins` 立即生效）。可以先用 `/taxi demo` 看一段模拟行程，不花钱。

> 需要较新版本的 Claude Code：计价器是一个 **mod**，基于 Claude Code 的函数钩子插件 API，目前还处于早期测试阶段（early access）。本项目在 2.1.289 上开发和测试。

## 功能

**状态栏实时计价**

```
🚕 空车   $1.20                                ← 空闲
🚖 载客●   $1.27 ▲0.03 · 本程 $0.07 · 🔥$0.42/分   ← Claude 正在输出
🚕 等候⏳   $1.31 · 本程 $0.11 · Bash            ← 正在执行工具
🚕 空车   $1.34 · 上一程 $0.14                   ← 本程结束
```

- **随 token 实时跳表**，每次回复结束后对齐会话的真实花费，和 `/cost` 显示的是同一个数。
- **"叮"一声** 💸：越过 $0.50、$1、$2、$5、$10…… 时弹出提示并播放收银机音效。
- **小票提醒** 🧾：单程花费超过 $0.50 时弹出小票。

**实时面板**（`/taxi meter`）：大号 LED 数字、本程计时、烧钱速度、预算进度条、近 30 分钟花费曲线、最近几程，还有带快捷键的按钮。

**预算提醒**（`/taxi budget 5`）：状态栏显示 `预算 49%`，接着变成 `⚠️ 预算 84%`、`🛑 超预算`，用到 80% 和 100% 时各提醒一次。只提醒，不会拦着你。

**订阅用户的回本模式**（`/taxi plan 200`）：Pro 或 Max 订阅按月付费，按 token 算的花费并不心疼，所以计价器换个角度，显示本月用量抵得上几份订阅费：`💎 回本 3.2 倍`，回本 1、2、3、5、10 倍时各庆祝一次 🎉。插件能自动识别订阅用户，并给一次提示。

**晒小票**：`/taxi` 打印一张乘车凭证（行程数、跳表次数、最贵的一句 prompt、累计花费，以及这些钱够买几杯拿铁、在北京打几公里车）。`/taxi share` 把一段简短总结复制到剪贴板。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/taxi` | 打印小票 |
| `/taxi meter` | 打开实时面板 |
| `/taxi demo` | 模拟一段 14 秒的行程，用来体验或录 GIF；不计费、不记录 |
| `/taxi share` | 复制行程总结到剪贴板 |
| `/taxi plan 200` | 填写每月订阅价（美元），显示回本倍数；`off` 清除 |
| `/taxi budget 5` | 设置本次会话的预算（美元）；`off` 清除 |
| `/taxi usd` · `cny` | 切换币种 |
| `/taxi en` · `zh` | 切换语言 |
| `/taxi hide` · `show` | 隐藏或显示状态栏计价器 |

`/taxi` 会立即执行，Claude 还在回复时也能随时查看。

## 配置

在 `/config` 里设置，或写在 `settings.json` 的 `pluginConfigs["taxi-meter"].options` 下。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `language` | `en` | `en`（FOR HIRE / HIRED / WAITING）或 `zh`（空车 / 载客 / 等候） |
| `currency` | `USD` | `USD` 或 `CNY` |
| `cnyRate` | `7.1` | 美元兑人民币汇率 |
| `sound` | `true` | 越过整数关口时播放音效（macOS） |
| `bigTripUsd` | `0.5` | 单程花费达到多少时弹出小票 |
| `budgetUsd` | `0` | 每个会话的默认预算，0 表示不设 |
| `planUsd` | `0` | 每月订阅价，设置后开启回本模式；按 API 计费填 0 |

想要中文界面：`/taxi zh`，或者把 `language` 设为 `zh`。

## 实现原理

Claude Code 的 **mod** 是运行在 Claude Code 内部、挂在它各种事件上的插件。计价器用到了这几个：

| 钩子 | 计价器用它做什么 |
| --- | --- |
| `turn.step` | 在 Claude 流式输出时读取内容，实时估算车费：约 4 个字符算 1 个 token，按模型的输出单价计；看不到内容的思考过程按时间计费，就像出租车堵车时照样走表 |
| `session.measure` | 对齐会话的真实花费，也就是 `/cost` 显示的数 |
| `ui.status` | 在状态栏画出计价器 |
| `ui.render` | 画出实时面板和小票卡片 |
| `command.run` | 响应 `/taxi` 命令 |

实时估算只用来填补回复进行中的空档，最终金额一定落在真实数字上。

## 常见问题

**金额准吗？** 总额是准的，直接取自会话自己的花费账本。只有回复进行中的跳表是估算。

**计价器前面为什么有个 ⚠？** 这是 Claude Code 目前展示插件状态的方式，和它自己的提示排在一起，并不表示出了问题。

**我是订阅用户，这些钱要我付吗？** 不用。显示的是同样用量按 API 价格计算的费用。用 `/taxi plan` 可以改成看回本倍数。

**`/taxi demo` 花钱吗？** 不花。它只是一段脚本动画：不计费，你的行程记录、累计金额和里程碑都不受影响。

## 开发

```sh
claude --plugin-dir /path/to/claude-taxi-meter   # 从本地目录运行
claude plugin validate . && claude plugin test .  # 校验和测试
```

更新已安装的版本：`claude plugin marketplace update claude-taxi-meter && claude plugin update taxi-meter@claude-taxi-meter`。

## 许可证

[MIT](LICENSE)
