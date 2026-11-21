# 做成安卓应用要多少东西(估工,2026-11-21 早上问的,先不开工)

> 结论:08:38 Alan 说不搞 App 了,改成「安卓浏览器能直接打开的网页」。这个文件留着,
> 哪天想把网页包成 APK 再翻。实际做的是 README「五之十、手机上用」那一节。

## 现状盘点

| 部分 | 现在是什么 | 搬到安卓的代价 |
|---|---|---|
| 画面 | `viewer/index.html` + `app.js`,纯 canvas,无三方库,无底图瓦片 | **几乎不用改** |
| 数据 | `viewer/server.py` 230 行,本地 HTTP 代理,绕跨域 | 需要重写成原生或挪进 WebView |
| 回放 | `data/*.json` 8 场,原始共 ~90MB | 抽样后打 assets,约 2–3MB |
| 实时 | 轮询 `live2/getRaceDatas` 快照(WS 那条还没解) | 一样,靠轮询 |

## 必须解决的只有一件事:跨域

页面塞进 WebView 后是本地源,`fetch('https://www.saill.cn/...')` 会被 CORS 拦。
所以网络不能在前端发,得走原生:

- 原生:`@JavascriptInterface` 给 JS 一个 `native.getJSON(url, cb)`,内部 OkHttp(不受 CORS 管)。
- JS:把 `getJSON()` 里那一个 `fetch` 换掉,其余 canvas 逻辑一行不动。
- 解压:server.py 里那段 lz-string 解 base64 的活,**不用移植到 Kotlin**——
  把 JS 版 lz-string(~5KB)放进前端,原生只负责把字符串拿回来,JS 自己解。

也就是说 server.py 的四件事(`races` / `snap` / `replays` / `replay`)各翻成十几行 JS,
没有一件是难的。

## 清单与估工(自用版)

1. **工程壳**:Android Studio 一个 Activity + WebView + assets。半天。
2. **数据层**:JS 里拼 4 个接口 + 原生 OkHttp 桥 + lz-string.js 解压。1–1.5 天。
3. **回放打包**:拿 `server.py` 的 `replay()` 跑一遍,t=3s 抽样,导出 `assets/replays/*.json`。半天。
4. **手机 UI**:横屏锁定、顶部按钮折叠成抽屉、canvas 双指缩放 + 拖动、
   标签字号放大(现在 11px 放在 6 寸屏上没法看)。1–1.5 天。
5. **杂项**:INTERNET 权限、看比赛时屏幕常亮、断网重连、退出时清定时器、状态栏深色。半天。

**自用 MVP ≈ 3–4 天**(按每天几个小时算)。做得像个正经 app(在线赛事列表、缓存管理、
启动页、崩溃兜底)再多 2–3 天。

## 风险 / 要先量的事

- `saill.cn` 那几个接口现在是**无鉴权**的公开接口,随时可能加 token 或者改字段。
  搬到原生之后要留个能改接口地址的地方,别写死。
- **流量**:每 2 秒拉一次快照,一场 3 小时的比赛要跑一下实际字节数,没测过。
- **WS 实时帧还是没解**(README 「六、还没做」),所以安卓版实时精度跟现在一样,是轮询粒度。
- Play 商店上架另算:签名 keystore、隐私政策、体积。**自己用直接装 APK 就行,这些都不用。**

## 更省的一条旁路:PWA

页面本身是纯静态的,加个 `manifest.json` + service worker 就能「添加到主屏幕」,
安卓上看起来就是个 app。但它**仍然需要一个能跑 server.py 的地方**(电脑/树莓派/云上),
因为它自己发不了跨域请求。所以 PWA 只适合「服务在别处、手机上看」这种玩法,
省掉的正好是估工里最贵的那 1.5 天。
