# 帆船赛实时追踪(SAILFISH / 赛事零距离)

2026-11-20 晚起。Alan 在电脑上看一场 J70 青少年帆船赛的实时追踪,想知道能不能直接拿到船位、船队名、风向这些数据。**这是帆船赛的项目,跟 ESP32 气象站没关系**——虽然数据里有风向风速,那是赛场的风力仪。

比赛:`raceCd=9baa93b239ac4419aa0958e7a8cb7d91`(2026 第八届粤港澳大湾区帆船赛 · J70青少年 R1)。

---

## 一、入口:小程序 + 网页版

- 他最早给的是微信小程序「赛事零距离」(appid `wx3e1317652a95a205`)。页面上印的 `http://www.sail.cn` 只是字,那个域名已经过期停放(76.223.54.146 / 13.248.169.48,跳 /lander),不是入口。
- 真正的网页版:
  `https://www.saill.cn/sf-admin/html/race/live/open_trac.html?raceCd=<raceCd>`
- 手机也能开,普通网页,不用登录。

## 二、接口(不用登录,curl 就能拿)

| 用途 | 地址 |
|---|---|
| 比赛信息 | `/sf-admin/api/app-api/match/race/getRace?pageName=open_trac&raceCd=<cd>` |
| 实时数据 | `/sf-admin/api/app-api/match/race/live2/getRaceDatas?&raceCd=<cd>&time=<毫秒时间戳>` |
| 航线 | `/sf-admin/api/app-api/match/race/getRouteInfo?raceCd=<cd>` |
| 回放 | 同 live2,路径换 `replay2/`(status=99 时页面自己切) |

- 根地址:`https://www.saill.cn`,全局配置在 `/sf-admin/static/config.js`(`BaseUrl: '/sf-admin/api'`)。
- `time` 必须是毫秒时间戳,macOS 的 `date +%s%3N` 不支持 `%N`,用 python 算。给错返回 `{"code":500}`。

## 三、返回怎么解

**`result` 是 lz-string 压过的 JSON**,不是 protobuf,也不是 base64 二进制。

外壳:`{"result":"<lz-string>","success":true,"flag":1}` → `decompressFromBase64(result)` → `json.loads`。

- `tools/lzstring.py` 是 python 移植(空格当 `+`,字母表跟 JS 里那个 `tn` 常量一致)。
- 怎么发现的:`appX.min.js` 是 HippoJs(packer)混淆。用 `tools/js_unpack.js`(靠 `osascript -l JavaScript`)把 `eval(` 换成括号执行,一层就出明文,563KB。明文里 `function on(e){...sn(len,32,i=>nn(tn,e.charAt(i)))}` 就是 lz-string,`hn()` 里写着 `JSON.parse(on(result))`。

## 四、数据结构

- 顶层:`teamList` `windInstrumentList` `markpositions` `marktimes` `navigationMark` `centerLat/Lng` `status` `stomp` `viewConfig` `worklist` `searoute`。
- `teamList[i]`:`teamName` `teamNameEn` `sailNo` `teamCd` `raceTeamColor` `nationality` `deviceCd` `model` + **`runtime` 数组**。
- `windInstrumentList[i]`:同样是 `runtime` + `windInstrumentName`(风力仪)。
- `runtime` 是 **protobuf 逐字段手解的**,1 起编号(JS 里写 `n[i-1]`)。类型表在 `function Nd(t)`:
  1 string / 2-3 u32 / 4-8 string / 9 u32 / 10 u64 / 11-14 float / 15-16 string / **17 float(2 位小数) / 18-19 double** / 20-21 u32 / 22 string / 23-24 u64 / 25-27 string / 28 float / 29 string / 30 u32 / 31 float / 32 u32 / 33 float / 34-37 string / 38 u64 / 39-40 string / 41-50 float / 51 hex。
- 实际用到的:`runtime[16]` 航向(风力仪那边是风向) `runtime[17]` 纬度 `runtime[18]` 经度 `runtime[19]` 速度 `runtime[22..23]` 毫秒时间戳。

## 五、现成脚本

```
python3 tools/sailfish.py <raceCd>          # 船队表格 + 风况
python3 tools/sailfish.py <raceCd> --json   # 解码后的原始 JSON
```

2026-11-20 跑出来:10 条船,南沙期货产业园队 J7001 … 杭州威雅学校帆船队 J7011;风力仪风向 355.36°、风速 6.03。

## 五之二、直接读页面元素(11-20 23:56 打通)

不碰接口,开个无头 Chrome 把网页渲出来,从 DOM 里把东西抠出来——**位置能还原到米级**。

```
python3 tools/dom_read.py <raceCd>           # 船队表 + 风 + 标
python3 tools/dom_read.py <raceCd> --json    # 带像素坐标的原始结构
```

- 页面用 Leaflet。地图上每个东西都是一个节点,`style="transform: translate3d(Xpx, Ypx, 0px)"` 就是它在图上的像素位置;船头/风向是内层 `<r>` 的 `rotate(Ndeg)`。
  - 船:`.leaflet-racer-pane > n` 是队名(`<span>` + 国旗 `fi fi-cn`),紧跟着的 `> z` 是船图标(颜色 = 赛队颜色)。
  - 风:`.leaflet-wind-pane > z`。
  - 标:`.leaflet-mark-pane > z`,`r` 的 class 是 `grs2d-icon2-pisa` / `-ring` / `detour-left` / `detour-right`,同位置常有红(#f44336)绿(#4caf50)两份。
- 像素 → 经纬度:URL hash `#19/22.78155/113.59755` 给 zoom 和地图中心,容器尺寸给宽高,Web Mercator 反算:
  `latlng = unproject(project(center) - size/2 + pixel, zoom)`。实测跟接口给的坐标差 3e-6 度(不到 1 米)。
- 配套:`tools/cdp_eval.py <file.js>` 把一段 JS 丢进那个无头 Chrome 里跑,调页面结构时很好用。
- 坑:风向图标那个 `rotate()` 在这场比赛里一直是 `0deg`,而接口说 355.36°——**风向别从 DOM 拿**,要么读接口,要么读图上的风羽/风杆。船头航向倒是准的。

## 五之三、整场比赛(回放)全量数据 — 11-21 00:07 打通

`raceCd=255db49e82c4467bb0bc47ff7b62a1e1`(J70公开组 R1,status=99 = 已结束,页面自动进回放)。

```
python3 tools/replay.py <raceCd>                 # 抓全 → data/<raceCd>.json,打印概览
python3 tools/replay.py <raceCd> --csv           # 再导一份 data/<raceCd>.csv
python3 tools/replay.py <raceCd> --at <毫秒>      # 看任意时刻各船在哪
python3 tools/replay.py <raceCd> --refresh       # 不管缓存重抓
```

**关键接口**:`/app-api/match/race/replay2/getEncryptionReplayData`

```
?raceCd=<cd>&matchCd=<matchCd>&rounds=R1&replayFlag=1
&timeSpan=1&asTime=<endTime>&timestamp=<这一片的起点>&nonCache=false
```

- 名字里的 `getEncryption` 就是 `getRaceDatas` 那个加密:返回 `{result: "<lz-string>", ...}`,解出来是 `{teamCd: [帧, 帧, ...]}`。
- **一片 60 秒**(`timeSpan=1` 分钟),`asTime` 固定填 `endTime`,`timestamp` 逐片往后推 60 秒。
- **少了 `timestamp` 会 500「系统异常」**——这是踩了半小时的坑。`nonCache` 可省。
- 页面是拿 Web Worker 并发拉的,一片约 60 帧;整场 39 片,几十秒拉完。

**frame 就是那个 runtime 数组**(跟实时数据同一套下标):`[3]` teamCd、`[10]` 速度(m/s)、`[16]` 航向(风力仪那行是风向)、`[17]` 纬度、`[18]` 经度、`[22]` 毫秒时间戳。

**这场抓到的**:19 个设备 = 10 条船(J7001–J7011)+ 8 个标(起航线 A/B、终点线 A/B、`1`、`1a`、`4p`、`4s`)+ 1 台风力仪。1 秒一帧,11:29:00 → 12:07:03 共 2284 帧/设备,合计约 4.3 万帧。

- 标也有轨迹:它们会漂(风推流推),不是固定点。
- `data/<raceCd>.json` 一次存全:race 元信息、viewConfig、teams(队名/帆号/颜色)、marks、searoute、tracks。
- 抓过的比赛直接复用本地文件,`--refresh` 才重下。

## 五之四、赛事 → 组别 → 场次(11-21 00:2x)

Alan 发的 `https://www.saill.cn/#/events/detail/scf1fea990ea3649999c6686076b54286b` 是**赛事详情**页,不是单个 raceCd。它走的是一套 **`sf-front-api`**(给网页/小程序自己用的,不是 `app-api`),全是 POST、body 给 `{}` 就行:

| 用途 | 地址 |
|---|---|
| 赛事 | `POST /sf-front-api/api/event/info/<eventCd>` |
| 组别 + 每组当前场次 | `POST /sf-front-api/api/event/level/<eventCd>` |
| 该组所有场次 | `POST /sf-front-api/api/level/race/<levelCd>` |
| 该组成绩 | `POST /sf-front-api/api/level/score/<levelCd>`(没细验) |
| 图片 / 视频 | `POST /sf-front-api/api/event/img|video/<eventCd>` |

```
python3 tools/event.py <eventCd>            # 组别 + 当前场次
python3 tools/event.py <eventCd> --races    # 连每组 R1..Rn 一起列
```

- `event/level` 返回的每组里带 `race` = **当前那一场**(含 `traceUrl`,就是 open_trac 的完整链接),拿它的 `raceCd` 直接能跑 replay/live。
- **两套状态编号别混**:`sf-front-api` 的 `race.status` 是 `1` 没比 / `4` 比完;`app-api` 的 `status` 是 `10` 待发 / `99` 完赛。
- 2026 第八届粤港澳大湾区帆船赛(`scf1fea990ea3649999c6686076b54286b`)现在的样子:
  - J70公开组 `scb1b48eaaaec8418dbd5622758d097114`:R1–R4 都比完了,R5 待发;
  - J70青少年 `sc582ad8491ae4471699bdabb7c187dc51`:只有 R1,待发;
  - FE26公开组 `scd40c7ac216634fe18d528b99bacc8940`:R1–R4 比完,R5 待发。

## 五之五、实时(live2)和回放(replay2)差在哪 — 11-21 00:2x 实测

| | 实时 `live2/getRaceDatas` | 回放 `replay2/getEncryptionReplayData` |
|---|---|---|
| 给什么 | **这一刻的一张快照**,每设备一条 runtime | **时间片**,`timeSpan=1` 就是 60 秒,每设备 60 帧 |
| 什么时候有 | 当前场次随时能拉(待发也有,给的是陈旧坐标) | 只在比完之后(`status=99`)有;待发的场次拉出来是 `{}` |
| 拿到整场 | 得自己轮询慢慢攒 → `tools/live.py` | 一次请求一片,几十秒拿全 → `tools/replay.py` |
| 顶层字段 | 多 `nio`、`stomp`(WebSocket 地址,base64),**没有** `startTime/endTime` | 多 `startTime`、`endTime`、`replayFlag` |
| `status` | 跟现实走:10 待发 / 99 完赛 | 恒为 99,`diff` 恒为 0 |
| runtime 长度 | 51 项(完整字段表) | 轨迹帧 51 项;`replay2/getRaceDatas` 里那条"当前帧"被截成 40 项 |
| 分片参数 | 只要 `raceCd` + `time=<毫秒>` | 还要 `matchCd`、`rounds`、`asTime=endTime`、`timestamp=<片起点>` |

待发阶段的实测(`R5` / 青少年 `R1`,`status=10`):

- `getRace` 的 `startTime`、`endTime` 是空字符串,`currentStep=0`、`stepOverFlag=1`、`teamList=[]`。
- `live2` 照样给 10 条船 + 8 个标 + 1 个风力仪,**但位置是最后一次上报的陈旧坐标**(这批是 11-20 15:02 的,船停在码头,速度全是 0.01),`marktimes=[]`。所以「未开赛」和「船真的不动」从坐标上分不出来,只能看 `status`。
- 风力仪倒是还在上报:355.36° / 6.03 m/s。
- `diff` 这个字段没搞懂:待发时在 310~365 之间乱跳,不是倒计时,别拿它算开赛时间。

## 五之六、已经抓到手的本地数据(11-21 00:25)

`data/<raceCd>.json`,每场 19 个设备(10 船 + 8 标 + 1 风力仪),1 秒一帧:

| 组别 | 轮次 | raceCd | 帧数 | 时间 |
|---|---|---|---|---|
| J70公开组 | R1 | `255db49e82c4467bb0bc47ff7b62a1e1` | 43,219 | 11:29:00→12:07:03 |
| | R2 | `11fe68076cdc4c7496acf70a5eae3f31` | 46,020 | 12:19:00→13:00:00 |
| | R3 | `1fbf4d2bdc2943d38cf871ddd0a8af51` | 53,585 | 13:14:00→14:01:23 |
| | R4 | `ab3064ec06974c9bb1971993026d9461` | 42,803 | 14:09:00→14:46:59 |
| FE26公开组 | R1 | `75ea8b02ae384d50aafd672d066d9bb1` | 39,831 | 11:35:00→12:10:09 |
| | R2 | `a938bed292ec4b3995ee031b048e8ba1` | 51,926 | 12:25:00→13:10:58 |
| | R3 | `4024da9875204ca7915ea45ed4931351` | 57,318 | 13:20:00→14:10:33 |
| | R4 | `b193c14f948c44658ccbf5eab73c07c1` | 47,014 | 14:15:00→14:56:59 |

合计 38 万帧、约 98 MB(R1 那份还有个 4.5MB 的 csv 样例,其它的要 csv 自己 `--csv`)。

还差:J70公开组 R5、J70青少年 R1、FE26 R5 —— 都还没比。

## 五之七、实时看板 viewer/ — 11-21 00:40

一个本地小服务 + 一个 canvas 页面,只吃实时数据(live2),把船、标、风、轨迹和预判线画在一张图上。

```
cd projects/sailfish-race
python3 viewer/server.py            # 本机 http://127.0.0.1:8899/,手机看那个 192.168.x.x 的地址
python3 viewer/server.py 9000       # 换端口
python3 viewer/server.py 8899 127.0.0.1   # 只给本机用(第三个参数是绑定地址,默认 0.0.0.0)
```

- **为什么要有这个 server**:`saill.cn` 没有 CORS 头,`file://` 或别的端口打开都读不到;顺便在这里把 lz-string 解了,前端只吃普通 JSON。
- 本地接口(只读):`/api/races`(赛事各组当前那一场 + 状态)、`/api/snap?raceCd=`(一张快照)、`/api/health`。
- **自动找比赛**:`/api/races` 走 `sf-front-api`,每组拿「当前那一场」,再用 `getRace` 的 `status` 判 `running / waiting / over`,排序把在跑的排最前。页面默认选第一个,也可以 `?raceCd=` 指定,右上角下拉可换。
- 画面前端 `app.js`:等距圆柱投影成米,自动框住所有设备(滚轮缩放、拖动平移、双击复位),网格自适应 5/10/20/50/100… 米。
- 每条船留 20 分钟轨迹;设备上报超过 30 秒就标灰(待发时全是灰的,因为给的是最后一次旧坐标)。
- **预判线**:最近一段轨迹算方位角和实际对地速度(比上报的 spd 稳),沿这个方向外推 120 秒,每 30 秒一个刻度点。**风目前只画箭头,还没进模型**(等水流那块一起做):`predict()` 里留了位置,加横向漂移就在那两行。
- 已验证(待发状态下):19 个设备里画出 10 船 8 标、风 355°/11.7kn、网格 50 米、投影落点全在画布内;造一艘以 4 m/s 往东北跑的假船,预判线方位 50°、120 秒走 372 m 东 / 312 m 北,对得上。

## 五之八、官网那个罗盘上的 203° 是什么(11-21 00:45)

`open_trac.html` 左上角有个 `Wind` 罗盘,显示 `203° # NA`,指针朝 23°。查了 `appX.min.js`:

- 值来自 `app.windField.getWindwardBearing()` → `{bearing, cog}`。**迎风方位**(风从哪个方位来,真北起算),不是风力仪的读数。
- 算法:`game.markpositions[0]`、`[1]`(缺了退回 `legs.getLeg(1).latlngs`)两点投影后求方位,再 +90° 归一。实测那两个点 `(22.780595,113.597872)`、`(22.781942,113.598499)`,连线 203.25° / 163.2 m —— 和地图上那段 leg 标签的 `data-bearing=203 data-dist=163.0m` 对得上。
- 指针画的时候 `meteoBearing` 再 +180°(`rotate(23.25deg)`),所以**针尖指下风,数字是来向**。
- 这个 bearing 还被拿去画 layline、算 VMG(`calcVMG` 用它)、算 `angleWind`/`portSide`,是整页的"风向"统一来源。
- **风力仪是另一回事**:`windInstrumentList[0].runtime[16]` = 355.36°(图标朝向)、`[10]` = 6.03 m/s。但 `runtime[22]` 时间戳停在 15:03(取快照时已 9.6 小时没更新),待发阶段别拿它当当前风。
- 对自己的 viewer:预判线现在用的还是风力仪那个 355°,换成这个几何迎风方位更靠得住;两套都留着,标明数据年龄。

## 五之九、起航线分析 + 回放(11-21 01:00)

### 起航线为什么有利端

- 起航线两端 `起航线A` / `起航线B`(标点),连线方位 = **起航线方位**,长度 = 起航线长度。
- 法线两条,取**指向一标(上风标)** 的那条 = **标点轴**,也就是「光看标就知道风从哪来」的那个角。
- 跟风力仪实测的风向比,差多少 = **偏差**(`delta`)。风偏了,起航线就不正,一头就比另一头更靠上风。
- **有利端**:把 B−A 投影到「上风方向」单位向量上,投影为正 B 更靠上风。`adv` 就是那一端多出来多少米的上风优势(`adv = |proj|`,`偏差角 = asin(proj/长度)`)。
- 页面左上 `#bias` 面板显示:`起航线 164 m · 270° | 风 8° 9.7 kn | 标点轴 0° · 偏差 8.4° | 有利端 起航线A +24 m`;风力仪超过 60 秒没更新会在后面标「N 分钟前的」。地图上起航线画成蓝线,有利端画成绿色光圈加「↑上风」,过中点的蓝虚线是风轴。

### 回放

- `data/` 里抓下来的整场可以直接拖:点「回放」→ 选场次 → 时间轴(默认停在起航前 90 秒),▶ 循环播放。
- 也能用链接直接跳:`http://127.0.0.1:8899/?replay=<raceCd>&t=<毫秒时间戳>`。
- 服务端两个新接口:`/api/replays`(扫 `data/*.json`,只读文件头拿 race 信息)、`/api/replay?raceCd=&step=`(整场抽样,默认 3 秒一帧)。
- 回放模式下 `nowMs()` 返回回放时刻,新鲜度判断才不会全是灰的;publish 的 live 轮询靠 `S.mode` 挡住,否则在途快照会覆盖风和标题。

实测 R1(11:29→12:05,3 秒一帧):起航线 163.5 m / 270°,风从 2.7°→339.6°→6.5° 摆,偏差从 2.6° 晃到 27°,有利端在 A / B 之间翻——线是死的,风是活的,这个数就是拿来看这个的。

### 预判线(01:12 改)—— 有无水流两种情况

- 顶栏多了两个框:**流向**(水流去向,0=北 90=东 180=南 270=西)、**流速**(节)。
- 没填流:`predict()` 出来的就是**船方位的直线延伸**——拿最近一段轨迹算方位角、用对地速度,120 秒一条直线,跟以前一样。
- 填了流:船自己的速度还是沿方位不变,再叠一个水流矢量。漂移**不是一下就有**的(水先推船,船身要一会儿才跟上),按 `1 - e^(-t/25)` 慢慢加上来,所以船根儿那段是弯的、越远越直——这就是那条曲线的来源。
- 实测(1.2 kn 正东、船 3.4 kn 航 182°):120 秒后终点往东偏 49.7 米,离弦线最远 5.7 米。
- 方位**直接取上报的航向**(`hdg`),不做平均 —— 船会突然转向,预判线要跟着一下转过去;轨迹只用来在没有航向或停船时兜底估个速度。船头朝向也一样直接吃 `hdg`,免得线跟箭头对不上。
- 一条 3 秒一段,共 40 段;`30/60/90/120` 秒的位置点改画在曲线上。有流时终点画个小方框,方便和没流的位置比。
- 线调暗了(0.34,原来是 0.85),十条船一起弯的时候不糊。
- 链接也能带:`?replay=<raceCd>&t=<毫秒>&cur=90,1.2`(去向,节)。
- 注意:上报的 `spd` 本身是对地速度,这里当成「船自己的速度」再加流,是 what-if 用法,不是两套数据的严格换算。

### 1 标 layline(01:47 重做)—— 紫线是 layline,橙线是实际上要跑的

- **上风轴不再用风力仪**。这台仪器的数一直在飘(那一刻报 329.8°),跟航线差 30 多度,照它画出来的 layline 整个歪掉。改成**标位关系**:`起航线A/B 中点 → 1 标` 的方位 = 这一段的轴;没有起点线就退到 `4s/4p` 两个门标的中点。这场算出来是 **5.5°**,跟船实际跑 0–40° 对得上。
- **紫色虚线** = layline:从 1 标往回收,轴左右各让 45°(迎风角),两条,`右舷 320.5°` / `左舷 50.5°`。沿着它跑刚好贴着标到,不用换舷。
- **橙色实线** = 有流时实际要对的路径:船头还是 45°,但流会把对地航迹带走,所以要偏一个角度才真的落到标上。偏多少标在边上:`实际路径 跑高 16°` / `跑低 9°`。
- 参考船速仍是全队平均(底部那行写着),流 1.2 kn 正东、队均 4.0 kn 时:右舷线高 16°,左舷线低 9°——同一股流两边不等。
- 线直接画到画布边,标签贴在边线内侧,缩放到哪儿都看得见。

## 五之十、手机上用(11-21 08:5x)

- server 默认绑 `0.0.0.0`,起的时候会把局域网地址打印出来:`→ 手机 http://192.168.x.x:8899/`。手机跟电脑连同一个 Wi-Fi,直接开这个地址就行,功能和电脑上一样。
- 第一次起服务 macOS 可能弹「是否允许 Python 接受传入连接」,点允许;不然手机打不开。
- 页面按屏宽/指针类型分两套:
  - **桌面**:还是原来那一行工具栏。
  - **手机**:顶栏只留 `比赛名 + 状态 + 船表 + ⚙`(45px 高),参数全在 ⚙ 里弹出的面板,不占画布高度;船表从底部升起,点一下画布就收起来。
- 手势:`touch-action:none` + pointer 事件,单指拖动、**双指捏合缩放**(跟着两指中点走)、双击屏复位自动框住;`dblclick` 之外自己判双击,安卓上更稳。
- 图上标签 11px → 手机 13px(`LABEL_PX`),底部手势提示也换成「双指缩放 · 单指拖动 · 双击复位」。
- 高度用 `100dvh` + flex 竖排,地址栏收起/展开不会留白;`viewport-fit=cover` 配合 `safe-area-inset` 躲开刘海和横条。
- 实测(390×844 竖屏 / 844×390 横屏,headless Chrome 套 iframe 量的):竖屏顶栏 45px、画布 799px、无横向滚动、`S.log` 空;⚙ 面板 159px 落在画布上不顶出去;桌面 1500 宽下 `#ctrls` 仍是 `display:contents`,一行摆开,紫线橙线像素数跟改之前一致。

## 五之十一、离线单文件包(11-21 08:45,**已停用**)

> 08:52 Alan 说「不要回放,只要实时」,页面里的回放整套已删掉,`build_static.py` 不再跟着改,
> 重新跑出来的包不会工作。`dist/sailfish-offline.html` 那份旧的还留着当快照,能开。

```
cd projects/sailfish-race
python3 tools/build_static.py            # → dist/sailfish-offline.html(3 秒抽样,8 场,6.3MB)
python3 tools/build_static.py --step 2   # 抽密一点,文件更大
cd dist && zip -j sailfish-offline.zip sailfish-offline.html README.txt   # 1.2MB
```

- **为什么是单文件**:安卓从本地打开是 `file://`,Chrome 不让 `file://` 页面 fetch 任何东西,所以 8 场数据、`app.js` 全塞进同一个 HTML 的 `<script>` 里(script 标签能跑,JSON 里的 `</` 要先转义成 `<\/`)。
- `app.js` 里 `getJSON()` 开头多了一个分支:`window.__STATIC__` 存在就直接从内存里取 `/api/replays`、`/api/replay`,不碰网络;`/api/races`、`/api/snap` 给空。其他一行没改。
- 离线包里没有实时:`回放/回实时` 按钮和时钟都 `display:none`,打开就自动进第一场(按开赛时间排),停在起航前 90 秒。
- 每场 0.66–0.94MB、35–51 分钟,3 秒一帧,19 个设备(10 船 + 8 标 + 风力仪)。
- 实测:headless Chrome 直接开 `file://…/dist/sailfish-offline.html`,8 场都在列表里、18 个设备画出来、紫线橙线都有、`S.log` 空、无横向滚动。
- `dist/README.txt` 是给手机看的说明(用 Chrome 打开,别用系统网页查看器)。

## 六、还没做

- **WebSocket 实时帧没解**:`wss://www.saill.cn/sailfish-ntwss?token=sailfish`(`token` 写死,页面里 base64 编的)。外壳是 JSON 的 STOMP 风格——`{"subscribe":"/topic/SAIL_DATA_BATCH_P_<cd>"}`,收到 `{"v":"CONNECTED","k":"CMD"}` 这种。三个主题:
  - `SAIL_DATA_BATCH_P_<cd>` 船位/船速
  - `BUOY_DATA_<cd>` 标
  - `RACE_CONTROL_<cd>` 比赛状态
  body 是 base64 + protobuf 二进制,前端用 `Nd` 那套手解;批量主题外面还包一层,`slice(2)` 后循环读 field1 的 bytes。要做真·实时推送再补。
- TODO:把 `sailfish.py` 加个 `--watch` 轮询模式,或者干脆走 WebSocket。

## 七、小程序那条线(已停,留个底)

网页版直接给数据之后就没必要啃小程序了,过程记在这儿,以后要拆别的微信小程序能复用。

- 页面确实是小程序:点「…」菜单只有「重新进入小程序 / 复制链接 / 静音」,没有「在浏览器打开」。
- 包在
  `…/applet/packages/<小程序包>.wxapkg`(V1MMWX 加密)。
- `tools/wxapkg_unpack.py`:appid 用 pbkdf2(sha1, salt=`b"saltiest"`, 1000, 32) 出 key,iv 是 `the iv: 16 bytes`,AES-256-CBC 解 `data[6:]`;先解前 1024 字节再解剩下,拼起来去 PKCS7 就是标准 v0 wxapkg(0xBE 开头,索引 big-endian)。**尾部长度不是 16 的倍数要先截断**。
- 解出 23 个文件(在 `miniapp/`),但每个文件本身还被压/加过一层:brotli/zlib/gzip/raw-deflate/lzma/bz2 全失败,首字节 `b2 76 95 7d`。头 1024 字节解得对(能读到 `0xBE` 和 `/images/ad-image.jpg` 索引),说明 key/iv/偏移都对,问题在数据段。另外索引里的 entries offset 很可能相对解密缓冲区开头、不是相对 data_start,脚本里多加了一次 data_start——真要续这条线先改这个。

## 八、工具在哪

- `tools/event.py`(赛事→组别→场次)、`tools/replay.py`(赛后整场)、`tools/live.py`(开赛中轮询攒序列)、`tools/sailfish.py`、`tools/lzstring.py`、`tools/dom_read.py`、`tools/cdp_eval.py`、`tools/wxapkg_unpack.py` —— 就在这个文件夹里,项目自带的。
- `tools/js_unpack.js`、`tools/cdp_capture.py` —— 通用工具,留在工作区 `tools/`:
  - js_unpack:`osascript -l JavaScript tools/js_unpack.js <in.js> <out.js>`
  - cdp_capture:`python3 tools/cdp_capture.py <url> 25 /tmp/cap.json`,得先起一个带 `--remote-debugging-port=9222` 的 Chrome(独立 profile,不动他的窗口):
    `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cap --no-first-run --disable-gpu about:blank`

## 五之十二、只留实时(11-21 08:52)

Alan 说手机上网页「不要回放,只要实时功能」。改动:

- `index.html` 里删掉 `#mode`(回放/回实时)、`#rsel`、`#play`、`#rng`(时间轴)、`#rclock`,连 `#rng` 的两条 CSS 一起删。
- `app.js` 里删掉整段回放:`loadReplays/rpLoad/rpSeek/rpTogglePlay/backToLive`(约 3.7KB)、它们的事件绑定、启动时按 `?replay=` 进回放的分支;`S.rp`、`S.mode`、`nowMs` 的 replay 分支也去了。`getJSON()` 回到只走 `fetch`,不再看 `window.__STATIC__`。
- 现在打开就是实时:自动选「第一场在跑的」(`/api/races` 排序),每秒 `/api/snap` 拉一张快照,自己在浏览器里攒轨迹。
- 实测(390×844 headless):3 场在列,18 个设备画出来,顶栏 45px,`S.log` 空,`#mode`/`#rng` 都不存在,时钟每秒滚。
- 实时必须有服务端:`python3 viewer/server.py` 默认绑 `0.0.0.0`,手机开 `http://192.168.x.x:8899/`(同一个 Wi-Fi)。

## 五之十三、切换组别 / 场次(11-21 08:56)

Alan:比赛可能已经到 R2,要能到时候切换。

- 服务端新加 `GET /api/rounds?levelCd=` → 走 `sf-front-api/api/level/race/<levelCd>`,把这一组的 R1..Rn 列出来(`raceCd`、`roundName`、`frontStatus`:`1` 没比 / `4` 比完、`startTime`)。
- 页面上 `#sel` 改成**组别**下拉(值换成 `levelCd`),新加 `#round` **场次**下拉。手机上这两个都在 ⚙ 面板里并排(各 ~46% 宽),桌面端还是顶栏一行。
- 默认挑哪一场:`?raceCd=` 指定 > 官方当前那一场(它没比完才算) > 第一个没比完的 > 最后一场。比完的场次在下拉里带 `✓`。
- `selectRace()` 现在自己拼 `S.race`(组名 + 轮次 + frontStatus),不用再去 `/api/races` 里找;加了 `S.gen` 代号,换场次时旧的轮询链自己退出,不会两条链一起拉。
- **比完的场次没有实时数据**(`live2` 只给 `status=99` 的空壳),这时画布空白 + 中间一行提示「这一场已经比完了,实时数据不给了 — 换个没比完的场次」。待发(`10`)反而有陈旧坐标,能画出来。
- 实测(390 宽 headless):组别 J70公开组 ↔ FE26公开组 切得动,场次 R1..R5 切得动,R5 有 18 个设备、R2 提示已结束,`S.log` 空。

## 五之十四、单文件实时页 `dist/sailfish-live.html`(11-21 08:57)

Alan 问「文件在哪」,他还是要一个 html 拿着走。做法:

- 服务端 `/api/*` 加 `Access-Control-Allow-Origin: *`;`app.js` 里多一个 `API_BASE = window.__API__ || ''`,`getJSON()` 拼在前面(直接访问服务端时它为空,行为不变)。
- `tools/build_live.py` 把 `index.html` + `app.js` 内联成一个文件,并塞 `window.__API__ = "http://<本机IP>:8899"`(IP 自动认,也能传参)。→ `dist/sailfish-live.html`,41KB。桌面上也放了一份 `~/Desktop/sailfish-live.html`。
- **实测**:headless Chrome 直接开 `file://…/sailfish-live.html`,跨到 `192.168.x.x:8899` 拿数,18 个设备画出来、场次下拉 R1..R5 在、`S.log` 空。也就是手机上用 Chrome 打开这个文件能跑——但**电脑上的 `server.py` 必须开着**、手机跟电脑同一个 Wi-Fi。
- 换了 IP、改了端口、或以后改了 `index.html`/`app.js`,重新跑一次 `python3 tools/build_live.py` 就行。

## 五之十五、手机自己跑的单文件 `dist/sailfish-phone.html`(11-21 09:00)

Alan:网页要能在手机上独立运行,电脑的服务器可以关掉。

- 关键发现:**saill.cn 的接口 CORS 是放开的**。`live2/getRaceDatas` 回 `access-control-allow-origin: *`;`sf-front-api/*`(POST JSON)回显 Origin,连 `Origin: null`(也就是 `file://` 页面)都回 `null`,预检也过。所以浏览器直连就行,不需要中间那个服务。
- `app.js` 加了第二种活法:`window.__DIRECT__` 为真时 `getJSON()` 不走本机 `/api/*`,自己拼——
  - `/api/races` → `POST sf-front-api/event/level/<赛事Cd>` + 每场 `GET app-api/getRace` 拿状态;
  - `/api/rounds` → `POST sf-front-api/level/race/<levelCd>`;
  - `/api/snap` → `GET live2/getRaceDatas`;
  - 返回结构和本地服务一模一样,所以 `loadRaces/loadRounds/ingest` 一行没改。
- lz-string 的解压搬成了 JS(`lzDecode()`,照 `tools/lzstring.py` 一行一行对着写),只有直连时才用到。
- `tools/build_standalone.py` 把 `index.html` + `app.js` 内联,塞 `window.__DIRECT__=true; window.__EVENT__='scf1fea…'`,输出 46KB 的单文件。桌面上放了一份 `~/Desktop/sailfish.html`。
- **实测**(headless Chrome 直接开 `file://…/dist/sailfish-phone.html`,本地 8899 已经关掉):3 个组别、R1–R5 场次、18 个设备画出来、时钟每秒走、`S.log` 空;切到 R2 提示「已经比完了」;切到 FE26 正常。
- 这个包的风险写在明处:靠的是对方服务器现在把跨域放开,哪天他们收紧,直连就废,得退回 server.py 那条路(`dist/sailfish-live.html`)。
