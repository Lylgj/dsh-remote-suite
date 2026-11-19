# 第三方组件声明

本仓库自有代码（`index.js`、`lib/`、`client.js`、`test/` 及文档）以 MIT 许可发布，见 [LICENSE](LICENSE)。

`assets/` 下的四个文件是为了让终端面板在断网 / 没有 CDN 的环境里也能工作而内置的**第三方运行库**，
它们是上游 MIT 构建产物的副本（内容未改动，只把换行统一成 LF，与本仓库的 `.gitattributes` 一致），
版权归上游作者所有。
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
  - `xterm.js` 289441 字节，md5 `7ab162c8b43e3d6590400143d9b4388f`
  - `xterm.css` 5559 字节，md5 `b9e25e4fb0f5a4fbf4b23962dc246b34`

## 2. @xterm/addon-fit（UMD 构建）

- 文件：`assets/addon-fit.js`
- 上游仓库：<https://github.com/xtermjs/xterm.js>（`addons/addon-fit`）
- 许可：MIT
- 版权声明：Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
- 校验（与本仓库一致）：
  - `addon-fit.js` 1497 字节，md5 `f8d75700a8b8838b556c11d7e0a61845`

## 3. @xterm/addon-webgl（UMD 构建）

- 文件：`assets/addon-webgl.js`
- 上游仓库：<https://github.com/xtermjs/xterm.js>（`addons/addon-webgl`）
- 许可：MIT
- 版权声明：Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
- 用途：长输出时的 GPU 加速渲染。加载失败或浏览器不支持 WebGL 时终端静默退回普通渲染，
  功能不受影响。
- 校验（与本仓库一致）：
  - `addon-webgl.js` 247535 字节，md5 `d6d59dc92de5740e179ef48379c14a93`

## 关于 MIT 许可正文

上述三个上游组件的许可正文与本仓库 [LICENSE](LICENSE) 中的 MIT 正文一致
（仅版权行不同，已在上文逐条列出）。MIT 要求分发时保留版权声明与许可声明，
因此本文件随 npm 包一起分发（见 `package.json` 的 `files`）。

## 运行时依赖

`ssh2`、`ws`、`node-pty` 作为普通依赖从 npm 安装，其许可（均为 MIT）随各自包分发，不在本仓库内。

## 如何重新校对 / 升级内置资源

```bash
mkdir -p /tmp/xv && cd /tmp/xv
npm pack @xterm/xterm            # 取对应版本的 lib/xterm.js 与 css/xterm.css
npm pack @xterm/addon-fit
npm pack @xterm/addon-webgl
tar xzf xterm-*.tgz
cp package/lib/xterm.js  <repo>/assets/xterm.js
cp package/css/xterm.css <repo>/assets/xterm.css
tar xzf xterm-addon-fit-*.tgz
cp package/lib/addon-fit.js <repo>/assets/addon-fit.js
tar xzf xterm-addon-webgl-*.tgz
cp package/lib/addon-webgl.js <repo>/assets/addon-webgl.js
md5sum <repo>/assets/*           # 与上文哈希对照（均为 LF 换行后的字节）
```

升级后请同步更新本文件里的字节数与哈希，并跑一遍 `test/smoke.mjs`。
