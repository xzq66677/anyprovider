# anyprovider

你手上只有一个 API Key 和一个 base URL，而你的编码 agent 需要的是一条 provider 配置：模型 id、上下文窗口、输出上限、reasoning 参数。这个工具直接从网关本身把这些问出来，再写成各家 harness 真正会读的文件。

[![Node](https://img.shields.io/badge/node-%3E%3D18-3c873a?style=flat-square)](#安装)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Dependencies: none](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](#安装)

[English](README.md) · 简体中文

---

## 要解决的问题

接入一家新的模型供应商，是四个叠在一起的未知数：

- **有哪些模型 id？** `/v1/models` 经常不存在、过期，或者是手写的。
- **reasoning 参数怎么传？** `reasoning_effort`、`thinking.type`、`reasoning.effort`、`enable_thinking`、`chat_template_kwargs` —— 每家网关各发明一个，猜错就是硬 400。
- **上下文窗口和输出上限多大？** 猜大了请求被拒，猜小了回答被截断。
- **我的 harness 要什么格式？** ZCode、opencode、Claude Code、DeepSeek Harness、Continue、Cline、LiteLLM、aider、Zed、VS Code Copilot、Windsurf 各自把 provider 配置放在不同的文件里，键名不同，对"模型"的抽象也不同。

anyprovider 用一次探测回答前三个问题，再用 target adapter 回答第四个。

## 它做什么

一次探测产出一份逐模型的记录 —— id、context window、max output、reasoning 参数以及视觉（图像输入）支持情况 —— 然后由各 target adapter 转成自己的文件格式。

它不读厂商文档，也不在 `/models` 缺元数据时假装知道：能力相关的问题一律靠发送若干次极小的真实请求来确认，看网关接受什么、回显什么、以及在你要太多时怎么报错。

## 安装

需要 Node 18 或更高版本。零依赖，不会出现 `node_modules`。

```bash
# 从源码运行
git clone https://github.com/xzq66677/anyprovider.git
cd anyprovider
node src/cli.mjs --help

# 或者从本地 checkout 安装全局命令
npm i -g .
anyprovider --list-targets
```

发布到 npm 之后：

```bash
npx anyprovider --list-targets
```

## 快速开始

先把 Key 放进文件，避免它进入 shell 历史：

```bash
printf '%s' 'sk-...' > ./key.txt

node src/cli.mjs \
  --base https://api.example.com/v1 \
  --key-file ./key.txt \
  --target opencode
```

这是 **dry-run**：只打印探测到的模型和"将会写哪个文件"。加 `--write` 才落盘。

```bash
node src/cli.mjs \
  --base https://api.example.com/v1 \
  --key-file ./key.txt \
  --target opencode,zcode \
  --write
```

## CLI

```
Usage
  anyprovider --base <url> --key <key> --target <ids> [--write]

Required
  --base <url>          gateway base URL (with or without /v1)
  --key-file <path>     file containing the API key (preferred)
  --key <key>           API key inline (visible in shell history)
                        or set ANYPROVIDER_API_KEY / OPENAI_API_KEY
  --target <ids>        逗号分隔；"all" = 全部 adapter，"installed" = 磁盘上检测到的
                        省略则交互式询问导入目标

Discovery
  --model <ids>         comma separated model ids (when /models is missing)
  --protocol <list>     restrict detection to chat,responses,anthropic
  --sample <n>          models to reasoning-probe (default 3, 0 = skip)
  --vision-sample <n>   models to image-probe (default 3, 0 = skip)
  --deep                probe every model individually (slow, thorough)
  --default-context <n> context window when the gateway reports none (128000)
  --default-maxout <n>  max output when it cannot be probed (32000)
  --timeout <ms>        per-request timeout (30000)

Output
  --write               actually write configs (default: dry run)
  --name <text>         display name (default: host)
  --id <text>           provider id (default: derived from host)
  --json                machine-readable discovery output
  --interactive         ask for the import target even without a TTY
  --list-targets        show supported harnesses

Targets  zcode  opencode  claude-code  deepseek-harness  cline  continue  litellm  aider  zed  vscode-copilot  windsurf  env
```

| 参数 | 含义 |
|---|---|
| `--base` | 必填。缺少协议时自动补 `https://`，去掉尾部斜杠，`/v1` 可有可无。 |
| `--key-file` | 与 `--key`、环境变量三选一。取文件第一行并 trim。 |
| `--key` | 直接给 Key。方便，但会出现在 `ps` 和 shell 历史里 —— 优先用 `--key-file`。 |
| `ANYPROVIDER_API_KEY`、`OPENAI_API_KEY` | 只有在既没给 `--key-file` 也没给 `--key` 时才读。 |
| `--target` | 逗号或空格分隔的 id，或 `all`。用 `--list-targets` 查看 id。**省略它，CLI 会交互式地问你导入到哪个工具**（见[对话式选择导入目标](#对话式选择导入目标)）。 |
| `--model` | 有两种用途：`/models` 为空时提供 id；同时也限定最终写入哪些模型。 |
| `--protocol` | 限定并重排协议探测顺序，例如已知网关是 Anthropic 原生就用 `--protocol anthropic`。 |
| `--sample` | 有几个模型做 reasoning 探测；缺元数据的模型优先。`0` 表示完全跳过。 |
| `--vision-sample` | 有几个模型做[视觉探测](#视觉能力探测)。`0` 表示跳过。抽样顺序与 `--sample` 相同。 |
| `--deep` | 逐模型探测 reasoning、视觉与输出上限，而不是整网关一次。请求数大致等于「模型数 × 候选参数数」。 |
| `--interactive` | 即使 stdin 不是 TTY 也强制弹出目标选择（脚本里用）。 |
| `--default-context` | `/models` 不报上下文窗口时的兜底值。 |
| `--default-maxout` | 越界探测拿不到上限时的兜底值。 |
| `--timeout` | 单请求超时，毫秒。 |
| `--write` | 真正写入。不加则磁盘不会有任何变化。 |
| `--name` | 写进配置的显示名，默认是 base URL 的 host。 |
| `--id` | provider id，默认 `custom-<host-slug>`，最长 40 字符。 |
| `--json` | 向 stdout 输出 `{ discovery, targets }`，并静默人类可读输出，便于管道处理。 |
| `--list-targets` | 打印所有 adapter 的 id、名称和主页，然后退出。 |

`-h` / `--help`、`-v` / `--version` 也可用。

退出码：`0` 成功，`1` 网关无法识别或某个 target 失败，`2` 调用错误（缺 `--base`、`--target` 或 Key）。

### 示例

只探测，看看网关到底提供什么，不写任何文件：

```bash
node src/cli.mjs --base https://api.example.com/v1 --key-file ./key.txt --target env
```

一个 Key 一键写进磁盘上检测到的所有 harness（先 dry-run 预览，确认后加 `--write`）：

```bash
node src/cli.mjs --base https://api.example.com/v1 --key-file ./key.txt --target installed
```

网关没有 `/models`，但你知道模型 id：

```bash
node src/cli.mjs \
  --base https://api.example.com \
  --key-file ./key.txt \
  --model model-a,model-b \
  --target opencode --write
```

只把其中两个模型写进 ZCode，并指定 provider id：

```bash
node src/cli.mjs \
  --base https://api.example.com/v1 \
  --key-file ./key.txt \
  --id my-gateway \
  --name "My Gateway" \
  --model gpt-x,gpt-x-mini \
  --target zcode --write
```

给脚本用的机器可读探测结果：

```bash
node src/cli.mjs --base https://api.example.com/v1 --key-file ./key.txt \
  --target env --json > discovery.json
```

## 向导

向导是同一个引擎，只是把参数换成提问 —— 先问这个 Key 要给哪些 harness 用（可多选），再依次询问 base URL、Key（不回显）、显示名，然后列出模型，最后一次确认一键写入。

```bash
node src/wizard.mjs
# 或 npm i -g . 之后
anyprovider-wizard
```

向导不接受任何参数，跑起来一条条回答就行。提示语目前是中文。

流程：**先选 target**（只列本机已检测到配置文件的 harness；按显示的序号或 id 多选，回车 = 列出的全部，`A` = 全部）→ base URL → Key → 显示名 → 探测 → 模型表格与选择提示（回车 = 全部，`1,3-5` = 序号，`M id1,id2` = 手工指定，`Q` = 退出）→ 预览每个将要写入的文件 → **一次确认，把同一个地址和 Key 一键写进你勾选的所有 harness**。

**显示名由你决定。** 输入框默认是空的，想叫什么就输什么；直接回车才用域名作为建议值。如果你输的内容看着像 API Key，向导会提醒但**不会替你改**，而是让你选择保留还是重输。

在真实终端里它会等一次回车再关闭窗口，所以双击启动也不会一闪而过。管道输入同样可用：先到的行会进队列，不会被丢掉。

## 对话式选择导入目标

不必事先记住 target 的 id。在终端里省略 `--target`，CLI 会探查本机环境，**只列出确实已安装的 harness**：

```bash
node src/cli.mjs --base https://api.example.com/v1 --key-file ./key.txt
```

```
   #  id           tool         config
   1  zcode        ZCode        ~/.zcode/v2/provider_config.json
   2  env          Generic      ~/.anyprovider/providers.json

   Only locally installed harnesses are listed.   Enter = all listed   id / all = any target
   › 你目前需要向哪个里面导入？ [zcode env]
```

- **回车** 选中列出的全部 target。本机一个都没检测到时会重新询问 —— 输入 id 或 `all` 继续。
- **序号** 只对应上面列出的行（`1` = 列表里的第一个，不再是全部 target 里的第一个）。
- **id / `all`** 仍然匹配所有 adapter，所以可以显式指定未安装的 harness。
- **`--list-targets`** 可查看全部 id，了解本机菜单之外还有哪些。

向导的「你目前需要向哪个里面导入？」用的是同一套答案语法。在非交互 shell（CI、管道）里若没给 `--target`，CLI 仍然直接以 `2` 退出而不会挂住 —— 想强制弹选择就加 `--interactive`，想全程脚本化就显式给 `--target`。`--json` 始终要求显式 `--target`，保证机器输出确定。

## 视觉能力探测

模型是否接受图片同样靠实测，而不是静态能力标记。对每个抽样模型，探测会用检测到的协议发送一张极小的内嵌 1×1 PNG —— chat 用 `image_url` 块、responses 用 `input_image`、Anthropic 用 `image` source —— 再读出结论：

| 结果 | 含义 |
|---|---|
| `yes` | 带图片的请求被接受（网关若回显 image-token 用量，会记为证据）。 |
| `no` | 图片被拒，但同形状的纯文本对照请求成功 —— 说明是图片的问题，不是格式的问题。 |
| `unknown` | 无法判定（网络/鉴权错误，或网关拒绝所有 content 数组）。 |

默认抽样 3 个模型（`--vision-sample`），顺序与 reasoning 相同：优先挑 `/models` 里缺元数据的。`--deep` 则逐个模型探测。严格多数会成为打印在摘要里的 provider 默认值；平票则留空，避免任何模型继承一个猜测。每行的视觉值会进 `--json`，并且在 ZCode 里驱动生成的 `inputFormat.supportsImage`（未探测的模型保守保持 `false`，除非 provider 投了 `yes`）。

```bash
node src/cli.mjs --base https://api.example.com/v1 --key-file ./key.txt \
  --target zcode --vision-sample 5
```

人类可读输出 —— 注意 `vision` 列和摘要行：

```
   format    openai-chat-completions
   reasoning reasoning_effort
   vision    mixed/unknown  (no:1  yes:1)

   #  model id    context  max out  reasoning         vision
   1  gpt-4o      128000   16384    reasoning_effort  yes
   2  gpt-4o-mini 128000   16384    -                 no

   · Vision probed on 2 model(s): 1 accept images, 1 reject them (unknown = inconclusive).
```

同样的字段也出现在 `--json` 里：

```json
{
  "providerVision": null,
  "visionVotes": { "yes": 1, "no": 1 },
  "models": [
    { "id": "gpt-4o", "vision": "yes", "visionEvidence": ["image_tokens=1"] },
    { "id": "gpt-4o-mini", "vision": "no", "visionEvidence": [] }
  ]
}
```

用 `--vision-sample 0` 可完全跳过这些额外请求。

## 支持的 target

| id | 工具 | 写入文件 | 可安全合并? | 协议 |
|---|---|---|---|---|
| `zcode` | ZCode | `<dataBaseDir>/.zcode/v2/provider_config.json` | 是 —— 合并，且先自校验 | chat, responses, anthropic |
| `opencode` | opencode | `~/.config/opencode/opencode.json`（或 `.jsonc`） | 是 —— 合并，兼容两代 schema | chat, responses, anthropic |
| `claude-code` | Claude Code | `~/.claude/settings.json` | 是 —— 合并 `env` 块 | 仅 anthropic |
| `deepseek-harness` | DeepSeek Harness | `~/.dsh/profiles/desktop/cordis.patch.yml`，密钥写入 `~/.dsh/.credentials.yaml` | 是 —— 按缩进做 YAML 行手术 | chat, responses, anthropic |
| `cline` | Cline / Roo Code | VS Code 用户 `settings.json` | 是 —— 合并扁平的 `cline.*` 键 | chat |
| `continue` | Continue | `~/.continue/config.yaml` | 仅在文件不存在时创建，否则出建议文件 | chat |
| `litellm` | LiteLLM | `./litellm.config.yaml` | 仅在文件不存在时创建，否则出建议文件 | chat, responses, anthropic |
| `aider` | aider | `~/.aider.conf.yml` | 仅在文件不存在时创建，否则出建议文件 | chat |
| `zed` | Zed | `~/.config/zed/settings.json`（Windows：`%APPDATA%\Zed\settings.json`） | 是 —— 合并 `language_models` | chat, responses, anthropic |
| `vscode-copilot` | VS Code Copilot Chat | `chatLanguageModels.json` 自定义端点列表 | 是 —— 合并数组 | chat, responses, anthropic |
| `windsurf` | Windsurf（引导模式） | 只写 `~/.anyprovider/windsurf.json` 捆绑包 | 是 —— 绝不碰 Windsurf 自身文件 | chat, responses, anthropic |
| `env` | 其他任意工具 | `~/.anyprovider/providers.json` | 是 —— 合并 registry | chat, responses, anthropic |

「协议」一列表示生成配置所假定的协议。当探测出的协议是某个 target 说不通的，该 target 会被**跳过并给出警告**，而不是写出一个永远用不了的配置 —— 所以在 Anthropic 原生网关上跑 `--target all`，会写 ZCode、opencode、LiteLLM 和通用包，跳过只认 chat 的那几个。

每个 target 的准确键名、路径覆盖方式和重启要求见 [docs/targets.md](docs/targets.md)。

## 安全模型

- **默认 dry-run。** 不加 `--write` 不会写任何文件。
- **备份。** 覆盖已有文件前，先备份为 `<file>.bak-<ISO 时间戳>`。
- **原子写入。** 内容先写到同目录的临时文件，再 `rename` 到位，中途崩溃不会留下半份配置。
- **三种写入模式**，由各 target 声明：
  - `merge` —— adapter 理解这个格式，合并进去，其余内容原样保留。
  - `create` —— 只在文件不存在时写入；已存在则降级为 `suggest`。
  - `suggest` —— 绝不碰真实文件，只在旁边写 `<name>.anyprovider.<ext>` 让你手工合并。
- **无法解析的文件一律不碰。** 已有配置不是合法 JSON（或 JSONC）时，adapter 直接抛错，不做猜测。
- **ZCode 先校验再写。** ZCode 用 zod 校验整份 `provider_config.json`，全有或全无：只要有一条规则缺必填字段（比如 `optionSpecs.reasoningLevel`），整份配置就会被丢弃、以空配置进内存 —— 此时 UI 里所有自定义供应商消失，而磁盘文件其实完好。ZCode 的 adapter 复刻了这套必填项检查，拒绝生成会被拒的配置。
- **部分片段会打印 Key。** `continue`、`litellm`、`aider`、`env` 这几个 target 的配置里必须内联 API Key，所以输出里就有它。不要把这段输出贴进 issue 或日志。

## 探测是怎么做的

五步，每一步靠实测。

**1. 模型列表。** 对给定的 base URL 和去掉版本段的变体都尝试 `GET {base}/models`，缺 `/v1` 时再补一次 —— 各家对 base URL 是否含版本段并不一致。第一个返回 200 且列表非空的结果胜出。遇到 401/403 立刻终止，而不是把所有候选重试一遍。

**2. 协议嗅探。** 每个协议发一条极小请求，顺序是 `chat` → `responses` → `anthropic`，分别命中候选 base 下的 `/chat/completions`、`/responses`、`/messages`。只有当返回结构确实像该协议（`choices[]`、`output[]`、`content[]`）时才算通过。第一个通过的结果确定格式：`openai-chat-completions`、`openai-responses` 或 `anthropic-messages`。

**3. reasoning 参数。** 先发一条基线请求，然后逐个候选参数各发一条，保留第一个不被 400 的：

| 协议 | 候选，按顺序 |
|---|---|
| chat | `reasoning_effort`、`thinking`、`reasoning`、`enable_thinking`、`chat_template_kwargs` |
| responses | `reasoning`、`reasoning_effort` |
| anthropic | `thinking` |

参数被接受就保留；同时会记录网关是否真的回显了 reasoning（`reasoning_content`、`thinking` 块、`reasoning_tokens`），被接受却完全没有回显的会在 `--json` 输出里标记为 silent。默认抽样三个模型（优先挑 `/models` 里缺元数据的），多数结果作为整个 provider 的默认值；`--deep` 则逐个模型探测。**被测过且拒绝所有参数的模型记为"不支持 reasoning"，不会去继承那个全局结论。**

**4. 视觉。** 用检测到的协议原生图片形状发送一张极小的内嵌 1×1 PNG。图片被接受就是 `yes`；被拒时与纯文本对照请求比较，以区分"不支持图片"和"不支持这种 content 格式"；含糊不清的一律 `unknown`。默认抽样三个模型，严格多数成为 provider 默认值 —— 详见[视觉能力探测](#视觉能力探测)。

**5. 输出上限。** `/models` 有元数据就用（`max_completion_tokens`、`max_output_tokens`、`max_tokens`）。没有就故意用 `max_tokens: 1000000` 越界，让网关自己的 400 报错里写出真实上限，再从文本里解析出来，并约束在越界值之下。缺上限的模型共用这一次探测；`--deep` 则逐个探测。上下文窗口取自 `context_length` / `context_window` / `max_context_length` / `max_model_len`，都没有就用 `--default-context`。

所有结果汇总成一个对象，`--json` 会原样输出。

## 局限

- **只支持三种协议。** OpenAI chat completions、OpenAI responses、Anthropic messages。没有原生 Gemini、Bedrock、Cohere 协议。
- **只有视觉做能力探测。** 图片输入会被检测（见[视觉能力探测](#视觉能力探测)）；视频、PDF、原生联网搜索、JSON-schema 输出仍然默认关闭。adapter 会写保守默认值（ZCode 里是 `supportsVideo: false`、`supportsPdf: false`、`supportsNativeWebSearch: false`），模型确实支持的话需要手工打开。
- **逐模型差异会被抹平。** 除非加 `--deep`，一个 provider 只保留一个 reasoning 参数；如果同一端点后面混着推理模型和非推理模型，可能需要 `--deep`。
- **探测要花请求。** 每次运行会发若干条极小的 completion 请求；`--deep` 大致是「每模型 × 每个候选参数一条」。`--sample 0` 跳过 reasoning 探测，`--vision-sample 0` 跳过视觉探测。
- **opencode 新版把凭据放在环境变量里。** 现代 `providers` 结构引用的是环境变量名而不是 Key，所以 adapter 会打印你需要先执行的 `export` / `setx` 行；只有旧的 `provider` 结构才接受内联 `apiKey`。
- **YAML target 从不合并。** Continue、LiteLLM、aider 只有在文件不存在时才整份生成；已存在就给你一个 `.anyprovider.<ext>` 建议文件，让你自己粘贴。YAML 列表没法安全追加。
- **`--target all` 会写到当前目录。** `litellm` target 解析成相对于当前工作目录的 `./litellm.config.yaml`，而 `env` 会在 `~/.anyprovider/providers.json` 里留一份含 Key 的副本。

## 新增一个 target

adapter 只声明元数据和一个纯函数 `plan()`，自己绝不写文件 —— 写盘、备份、原子替换都由 `src/core/apply.mjs` 负责。

```js
export default {
  id: 'mytool',
  label: 'My Tool',
  homepage: 'https://example.com',
  protocols: ['chat'],          // 生成的配置所假定的协议
  defaultPath: () => join(home(), '.mytool', 'config.json'),
  plan({ discovery, selected, providerId, providerName, baseUrl, apiKey, path }) {
    return {
      writes: [{ path: path || join(home(), '.mytool', 'config.json'), text: toJson(root), mode: 'merge' }],
      snippet: null,            // 可选：打印给用户的文本
      notes: ['重启 My Tool 让它重新加载配置。'],
    };
  },
};
```

约定：只返回文本，绝不自己写盘；确信会生成非法内容时抛错而不是硬写；任何无法确定能否合并的格式，一律用 `mode: 'suggest'`。注册到 `src/targets/index.mjs` —— `--target all`、`--list-targets` 和向导菜单都由这个列表驱动。完整契约（包括 `mode` 的语义和 `readJsonIfExists`、`parseJsonLoose`、`toJson`、`yamlString`、`upsertBlock` 这些公共 helper）写在 `src/targets/_shared.mjs` 文件顶部。

## 开发

```bash
npm test        # node --test test/probe.test.mjs test/targets.test.mjs
```

测试用本地 mock 网关（`test/mock-gateway.mjs`），只往临时目录写，绝不会碰你的真实配置。CI 在 Ubuntu、Windows、macOS 上分别用 Node 18、20、22 跑同一条命令。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

欢迎 issue 和 PR；最有价值的贡献是新的 target adapter，上面的契约刻意做得很小。
