<div align="center">

<img src="public/icon/128.png" width="96" alt="原页图标">

# 原页 · Pagelet

**使用 LLM API 的网页翻译扩展**

[![Release](https://img.shields.io/github/v/release/YiTaiiiiii/pagelet-translate?label=release&color=3346c9)](https://github.com/YiTaiiiiii/pagelet-translate/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/YiTaiiiiii/pagelet-translate/ci.yml?branch=main&label=CI)](https://github.com/YiTaiiiiii/pagelet-translate/actions/workflows/ci.yml)
[![Downloads](https://img.shields.io/github/downloads/YiTaiiiiii/pagelet-translate/total?color=ffb547)](https://github.com/YiTaiiiiii/pagelet-translate/releases)
[![License: MIT](https://img.shields.io/github/license/YiTaiiiiii/pagelet-translate)](LICENSE)
[![Stars](https://img.shields.io/github/stars/YiTaiiiiii/pagelet-translate?style=flat)](https://github.com/YiTaiiiiii/pagelet-translate/stargazers)

[下载](https://github.com/YiTaiiiiii/pagelet-translate/releases/latest) · [安装](#安装) · [配置](#配置) · [English](#english)

<img src="docs/images/demo.gif" width="860" alt="翻译一个英文网页：译文逐段出现在原文下方，阅读位置不动，再切换成只看译文">

</div>

## 功能

- 双语对照或只看译文，再按一次恢复原文
- 插入译文时阅读位置不跳
- 按滚动方向提前翻译，已是目标语言的段落跳过
- 单段查看原文、重译、失败重试
- 总是翻译某个网站
- 快捷键 Alt+T（macOS 为 ⌥T）

## 安装

1. 在 [Releases](https://github.com/YiTaiiiiii/pagelet-translate/releases/latest) 下载 `pagelet-<版本>-chrome.zip` 并解压。
2. 打开 `chrome://extensions`，开启右上角“开发者模式”。
3. 点“加载已解压的扩展程序”，选择解压出的文件夹。

## 配置

在扩展设置页填 API Key，点“测试连接”，再保存。之后在网页上点工具栏图标，或按 Alt+T。

推荐 DeepSeek `deepseek-flash`，思考强度“关闭”，也是默认设置。其他 OpenAI 兼容或 Anthropic 兼容的服务也能用，在服务商列表里选或自定义地址。

<p align="center"><img src="docs/images/settings.png" width="500" alt="设置页"></p>

## 开发

```sh
pnpm install
pnpm dev                                # 开发模式
pnpm build && pnpm test                 # 构建并测试
pnpm test:upgrade                       # 升级测试
pnpm zip                                # 打包
```

## Star History

<a href="https://star-history.com/#YiTaiiiiii/pagelet-translate&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=yitaiiiiii/pagelet-translate&type=Date&theme=dark">
    <img alt="Star History" src="https://api.star-history.com/svg?repos=yitaiiiiii/pagelet-translate&type=Date" width="600">
  </picture>
</a>

## 许可

[MIT](LICENSE)

---

## English

A web page translation extension that uses an LLM API.

**Install**: download `pagelet-<version>-chrome.zip` from [Releases](https://github.com/YiTaiiiiii/pagelet-translate/releases/latest), unzip it, open `chrome://extensions`, enable Developer mode, then "Load unpacked".

**Configure**: enter your API key in the options page, test the connection and save. Recommended: DeepSeek `deepseek-flash` with thinking off (the default). Other OpenAI- or Anthropic-compatible services work too.

**License**: [MIT](LICENSE)
