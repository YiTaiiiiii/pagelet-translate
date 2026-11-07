# 原页 / Pagelet：贡献与代理规则

> 仓库根目录如果有 `CLAUDE.local.md`，那是本机的私有备注（机器、密钥位置、个人流程），已列入 .gitignore，不要提交，也不要把其中内容抄进公开文件。

Chrome 系浏览器的整页阅读翻译扩展（Manifest V3）。技术栈固定为 WXT、React、TypeScript 和 CSS Modules。

## 文档

- `README.md`：是什么、安装、配置、开发命令。
- `CHANGELOG.md`：面向用户的变更，按版本记，用英文写（也是 Release 说明）。
- `docs/behavior.md`：已定的行为细节（提取、调度、请求、显示）。改行为时同步改这份，它是规格。
- `AGENTS.md`：本文件，贡献和代理规则。

## 产品约束

- React 只管扩展自己的界面（弹窗、设置页）；网页提取、显示和模型接口各自独立，不依赖 React。
- 模型接口只支持两种标准格式：OpenAI 兼容的 Chat Completions 和 Anthropic 兼容的 Messages，各保持一个小调用函数，不引入 SDK。模型 ID 和思考强度由用户设置。
- 所有标签页合计最多 10 个并发请求。
- 快捷键只有 Alt+T。
- 不加账号、遥测、云同步、传统（非大模型）翻译服务。
- 只做整页阅读翻译，不追同类扩展的功能（字幕、划词、输入框翻译、朗读、PDF 等）。
- 代码、命令、文件路径和表单不作为翻译内容。
- 界面文案只留功能名称、状态和必要操作说明。

## Key 与隐私

- Key 只在扩展可信页面和后台流转；storage.local 限制为可信上下文访问。
- Key 不输出到日志、不写进仓库、不打进构建产物。
- 网页文字只发往用户配置的服务；请求由后台发出，不带 Cookie、不跟随重定向。
- 自动化测试只用假 Key 和本机假接口，不调用真实模型服务。

## 验证

- 改动要在真实网页上检查本次涉及的操作；模拟页面和自编样本不能代替真实页面检查。
- `pnpm test`、`pnpm test:upgrade` 只当回归保护，都只连本机假接口。
- 真实页面检查用 `scripts/check-browser.mjs`：`pnpm build` 后 `node scripts/check-browser.mjs start|reload|stop`。它启动 Playwright 缓存里的 Chrome for Testing（无头），独立配置在 `~/.local/share/pagelet-check`，加载当前构建并预先给全部站点访问权。Key 由你自己在这个配置里的扩展设置中填写，只存在那里。页面操作脚本 `import { connect } from './scripts/check-browser.mjs'`，用和弹窗相同的消息开关翻译、切模式、读用量，截图看效果；查完用 `stop` 关掉，不留后台进程。
- 检查浏览器没有登录态，也测不到 Chrome 的站点授权弹窗和工具栏弹窗本身；这几项要在日常 Chrome 里加载 `.output/chrome-mv3` 检查。
- 正常浏览产生的少量真实请求可以；批量模型测试和付费语料要先得到维护者同意。

## 流程

- 按主题提交 git，提交信息用英文祈使句。
- 行为改动同步更新 `docs/behavior.md`，并在 `CHANGELOG.md` 最上面的版本下用英文记一行（未发布时标 Unreleased）。
- 版本号在发布时修改；发布打 `v<版本号>` 标签，发布工作流会检查标签和 package.json 的版本一致。
- 文档用简短的 Markdown。注释说明代码为什么是现在这样，不记录历史（历史看 git）。
