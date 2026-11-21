# 给 AI 助手(和第一次来的人)

这是「赛事零距离 / saill.cn」帆船赛实时图的浏览器前端:把官方接口的实时快照
拉下来,在 canvas 上画船位、轨迹、预判线、起航线、1 标 layline。

写给人看的说明在 `README.md`(很长,里面有接口抓包和一堆踩坑记录)。这份只讲**怎么改**。

## 跑起来

```bash
# 桌面 / 局域网:起本地小服务,它顺手解压、绕开跨域
python3 viewer/server.py 8899     # → http://127.0.0.1:8899/

# 手机单文件:把所有 js 内联成 dist/sailfish-phone.html,直连 saill.cn,不需要服务
python3 tools/build_standalone.py --out ~/Desktop/sailfish.html
```

改了 `viewer/` 里任何东西,**要重新跑一次 `build_standalone.py`**,手机上那个文件才会变。

## 目录

```
viewer/
  index.html      结构和样式(都在里面)
  js/state.js     全局状态 S、常量、时间/数字、经纬度→米
  js/api.js       拉数据:/api/* 或直连 saill.cn,含 lz-string 解压、组别/场次
  js/feed.js      轮询、把一条快照塞进 S、刷新顶部和船表
  js/calc.js      预判线、起航线方位、1 标 layline(纯计算,不碰 DOM)
  js/draw.js      canvas 尺寸/视图/网格/全部绘制
  js/interact.js  拖动、双指缩放、双击复位
  js/ui.js        按钮和下拉的接线、水流输入
  js/main.js      启动
  server.py       本地服务:转出 /api/races /api/rounds /api/snap
tools/            打包、抓数、解 lz-string、解包小程序
android-port.md   安卓 WebView 移植笔记
```

`js/` 是**普通脚本,不是模块**:按 `index.html` 里的顺序加载,彼此共享全局
(`S`、`getJSON`、`draw`…)。加文件就加一个 `<script src="js/x.js">`,
放对位置(先 state,最后 main),`tools/inline.py` 会按这个顺序内联。

## 改的时候

- **一个 PR 一件事**,尽量小。改的是 `draw.js` 就别顺手重排 `calc.js`。
- 提交信息用 Conventional Commits:`feat(draw): 加风向箭头`、`fix(api): 待发场次返回空`。
  别人(和人之外的接手者)靠 `git log` 判断发生了什么。
- 别整文件重排格式。缩进/换行照 `.editorconfig`(2 空格、LF、末尾留空行)。
  (等谁把这台机器装上 node,再加 `npx prettier` 统一格式,别手动全量重排。)
- **别把 `data/`、`dist/`、`miniapp/` 加进仓库**(`.gitignore` 里已经挡了)。
- **别写真实 IP、绝对路径、邮箱、账号**。README 里的局域网地址一律 `192.168.x.x`。
  这个检查在 CI 里跑,过不了不让合。
- 上游接口随时可能变。改 `api.js` 之前先在 README 里搜对应接口那节。

## 提交前自查

```bash
node --check viewer/js/*.js          # 语法(需要 node)
python3 -m py_compile tools/*.py viewer/server.py
python3 tools/build_standalone.py --out /tmp/t.html   # 能打出来
```

能开浏览器的话,再瞄一眼:`file:///tmp/t.html` 页面里应当有船、有刻度、
`window.S.dev.size > 0`。数字对不上就先别提 PR。
