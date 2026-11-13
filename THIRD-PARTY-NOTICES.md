# 第三方组件声明

本仓库自有代码（`index.js`、`lib/`、`client.js`、`test/` 及文档）以 MIT 许可发布，见 [LICENSE](LICENSE)。

`assets/` 下的三个文件是为了让终端面板在断网 / 没有 CDN 的环境里也能工作而内置的**第三方运行库**，
它们是上游 MIT 构建产物的原样副本（未做任何修改），版权归上游作者所有。
这些文件被打包进 npm 包，因此在此声明版权与许可。

## 1. xterm.js（UMD 构建）

- 文件：`assets/xterm.js`、`assets/xterm.css`
- 上游仓库：<https://github.com/xtermjs/xterm.js>
- 上游包：`@xterm/xterm`（5.x 系列的 UMD 构建；构建产物未内嵌版本号，
  以下面的字节数与哈希为准，可与上游对应版本比对确认）
- 许可：MIT
- 版权声明：
  - Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
  - Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
  - Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
- 校验（与本仓库一致）：
  - `xterm.js` 488663 字节，md5 `d7aaaef27ff18a0e8deff9b29439090e`
  - `xterm.css` 7112 字节，md5 `5403ebbaef7d20632abb0716beb9c437`

## 2. @xterm/addon-fit（UMD 构建）

- 文件：`assets/addon-fit.js`
- 上游仓库：<https://github.com/xtermjs/xterm.js>（`addons/addon-fit`）
- 许可：MIT
- 版权声明：Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
- 校验（与本仓库一致）：
  - `addon-fit.js` 1521 字节，md5 `25f0510074e274cfac85ffed228242dc`

## 关于 MIT 许可正文

上述两个上游组件的许可正文与本仓库 [LICENSE](LICENSE) 中的 MIT 正文一致
（仅版权行不同，已在上文逐条列出）。MIT 要求分发时保留版权声明与许可声明，
因此本文件随 npm 包一起分发（见 `package.json` 的 `files`）。

## 运行时依赖

`ssh2`、`ws` 作为普通依赖从 npm 安装，其许可（均为 MIT）随各自包分发，不在本仓库内。

## 如何重新校对 / 升级内置资源

```bash
mkdir -p /tmp/xv && cd /tmp/xv
npm pack @xterm/xterm            # 取对应版本的 lib/xterm.js 与 css/xterm.css
npm pack @xterm/addon-fit
tar xzf xterm-*.tgz
cp package/lib/xterm.js  <repo>/assets/xterm.js
cp package/css/xterm.css <repo>/assets/xterm.css
tar xzf xterm-addon-fit-*.tgz
cp package/lib/addon-fit.js <repo>/assets/addon-fit.js
md5sum <repo>/assets/*           # 与上文哈希对照
```

升级后请同步更新本文件里的字节数与哈希，并跑一遍 `test/smoke.mjs`。
