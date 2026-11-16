# 远程嘉宾音频链路原型（Opus / WebSocket / AudioWorklet）

这是一个**真实可运行**的广播远程嘉宾音频链路：嘉宾端的麦克风或实时测试信号经
Opus 编码后通过 WebSocket 送到主持端，主持端用带界面的抖动缓冲组织播放，并把
播放结果（欠载、隐藏样本数）回传给嘉宾端。

不是画出来的模拟曲线：音频采集、Opus 编解码、网络传输、抖动缓冲、重采样和
扬声器输出都在浏览器里实际执行。测试直接读取声卡实际收到的样本做断言。

---

## 1. 启动界面

### 环境要求

- Node.js 18 或更高版本（服务端仅用内置模块 + `ws`）。
- 支持 WebCodecs 与 AudioWorklet 的浏览器。**推荐 Chrome / Edge 111+**。
  Safari 对 `AudioEncoder` 支持不完整，Firefox 对 WebCodecs Opus 编码支持有限。
- 必须通过 **localhost 或 HTTPS** 访问：`SharedArrayBuffer` 和 WebCodecs 要求
  安全上下文（secure context）；服务端已经发送 COOP/COEP 头，因此 localhost 下
  即可获得跨源隔离。

### 安装与启动

```bash
cd /workspace
npm install          # 安装 ws 与 playwright
npm start            # 等价于 node server/index.js
```

默认监听 `0.0.0.0:8787`。启动后终端会打印两个地址：

```
remote-audio-link listening on http://localhost:8787
  host studio  http://localhost:8787/host
  remote guest http://localhost:8787/guest
```

换端口或只监听本机：

```bash
PORT=9000 HOST=127.0.0.1 npm start
```

### 打开顺序

1. 在**同一台机器**（或能访问该地址的机器）的 Chrome 中打开
   `http://localhost:8787/host`（主持端 / 控制台）。
2. 再打开 `http://localhost:8787/guest`（嘉宾端 / 发送端）。
3. 主持端点击 **「建立接收连接」**。
4. 嘉宾端选择信号来源（持续音 / 脉冲 / 语音 / 麦克风），点击
   **「上线并开始发送」**。使用麦克风时浏览器会请求权限。
5. 主持端复选框应依次变绿；队列条开始增长，点击 **「监听：关」** 打开本机监听，
   即可通过声卡实际听到远程音频。

两端默认房间名都是 `studio`，需要多组并行时修改各自页面上的「会话」输入框。

> 若用另一台机器访问，请把 `localhost` 换成服务器 IP，并用 HTTPS 或把该地址
> 加入浏览器的 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`，
> 否则跨源隔离不生效、`SharedArrayBuffer` 不可用。

---

## 2. 页面说明

### 主持端 `/host`

- **队列深度 / 播放位置**：队列条显示当前缓冲毫秒数与目标水位刻度；指标区显示
  已播放位置（设备样本计数）、队列深度、目标水位、EWMA 抖动、标记测得时延、
  欠载 / 缺口次数。
- **示波器与时间线**：示波器来自实际播放线程的输出；时间线按媒体序号展示到达、
  乱序、缺口、隐藏和晚到事件。
- **测试**：脉冲 / 语音 / 持续音测试、注入抖动模型并统计（离线 DSP 模拟，可导出
  统计）、导出统计 JSON、强制一次欠载。
- **统计表**：媒体包、解码帧、乱序 / 重复、晚到、缺口次数、隐藏样本、媒体期重建、
  漂移比例、编解码错误、收发字节。
- **远程控制**：把来源、码率、网络损伤模型和时延标记请求**下发给嘉宾端内核**，
  实际改变发送端行为；结果状态回显在反馈区。
- **结果区**：标记测得的平均 / 最大缓冲时延和最近摘要。

### 嘉宾端 `/guest`

- 选择来源（持续音 / 脉冲 / 语音 / 麦克风），开始 / 停止发送、断线重连。
- 网络损伤注入：基础延迟、抖动、丢包、乱序、重复（种子固定，可复现），
  以及预设模型（干净 / 稳定 / 突发 / 重抖动）。
- 上行统计、采集电平表和标记回传时延。
- **主持端反馈区**：显示主持端下发的控制，以及主持端回传的欠载 / 隐藏结果。

---

## 3. 链路做了什么

| 环节 | 实现 |
| --- | --- |
| 采集 | AudioWorklet 每 20 ms 输出精确 960 样本，48 kHz 单声道 |
| 编码 | WebCodecs `AudioEncoder`，Opus 64 kbps（可下发调整） |
| 封装 | 20 字节包头 `RAL2`：magic、版本、标志、保留、序号 u32、媒体起始时间 u64 |
| 传输 | WebSocket 二进制中继，服务端只转发不解析媒体包 |
| 解码 | WebCodecs `AudioDecoder`，**严格按序号顺序**送入（Opus 有状态，乱序会破坏后续帧） |
| 时序 | 媒体序号 × 960 是权威时间轴；解码输出经 FIFO 与包配对，不依赖解码器时间戳 |
| 抖动缓冲 | 有界目标水位，EWMA 抖动估计，速率受限的升 / 降步进，硬上下限 |
| 乱序 / 丢包 / 重复 | `PacketGate` 按序号等待修复、区分重复与晚到、超窗口立即重建媒体期 |
| 缺失音频 | 按缺口帧数精确隐藏（首帧淡出到静音），**绝不把下一包样本写进上一包位置** |
| 时钟漂移 | 比例重采样（±1% 线性插值），逐帧微调，不整块丢帧 |
| 媒体期 | 嘉宾重连后主持端重建时间轴、清空缓冲并重新填充到目标水位 |
| 监控 | 播放线程把实际输出镜像到监视环，测试和示波器都读真实样本 |

### 抖动目标为什么有界

目标水位只由**平滑后的抖动估计**和**欠载事件**驱动，单个晚到包不会抬高目标。
每次调整都是速率受限的一步，结果被钳制在 `[40, 400] ms`，因此不会出现
「每来一个晚包就把节目延迟越拖越长」。

### 缺失音频为什么不串位

`classifyPlacement` 把每帧相对媒体游标分类为：`epoch` / `place` / `conceal`
（缺口帧数精确）/ `rebase`（大跳变 = 新媒体期）/ `drop`（重复或重叠，不回退）。
隐藏时先写入正好该缺口长度的淡出静音，再在它自己的时间位置写入后续真实帧。

---

## 4. 运行测试

```bash
npm test        # 22 个单元测试：目标控制器、到达估计、乱序门、漂移、重采样、放置规则等
npm run test:e2e   # 真实 Chromium 端到端：38 项检查
```

端到端测试会启动一个独立端口（默认 8791）的服务和 headless Chromium，在一个
浏览器里同时打开主持端和嘉宾端，实际发送 Opus 音频，然后：

- 从监视环读出声卡实际输出的样本，断言非静音且无明显跳变；
- 断言播放位置以约 48 kHz 前进、读指针永不超过写指针；
- 注入突发 / 重抖动 / 确定性丢包，断言目标有界、缺口被显式隐藏、播放继续；
- 触发嘉宾重连，断言媒体期递增且播放恢复；
- 依次切换脉冲、语音来源，断言帧数持续增长；
- 运行离线模拟面板并检查统计输出。

需要 Chromium。若未安装在默认位置，通过 `CHROMIUM_PATH` 指定：

```bash
CHROMIUM_PATH=/path/to/chrome npm run test:e2e
```

常用参数：`node test/e2e.mjs --headed`（可见窗口）、`--keep`（保留服务和窗口）。

### 在受限 Linux 环境运行

如果 Playwright 自带的 Chromium 缺少系统库且没有 root 权限，可以把所需 Debian
包用 `dpkg-deb -x` 解压到一个本地目录，再通过 `LD_LIBRARY_PATH` 指向它：

```bash
export LD_LIBRARY_PATH=/tmp/local-libs-work/root/usr/lib/aarch64-linux-gnu:/tmp/local-libs-work/root/lib/aarch64-linux-gnu
CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1148/chrome-linux/chrome npm run test:e2e
```

---

## 5. 实测时延与统计怎么看

1. 主持端连接后，点击 **「发送时延标记」**（或远程控制里的「请求远程标记」）。
   标记随下一次采集块发出，主持端在解码到该序号时回传，结果区显示
   RTT、缓冲时延和估算端到端时延。
2. 观察指标区的**队列深度**与**目标水位**：队列应在目标附近波动，不应单调增长。
3. 在嘉宾端选择「重抖动」或手动提高丢包，观察主持端统计表的**缺口次数**和
   **隐藏样本**上升，而播放继续、目标不超过 400 ms。隐藏样本按采样点计数
   （960 点 = 20 ms）。
4. 点击「断线重连（新链路）」，主持端媒体期标签递增，播放重新填充。

---

## 6. 目录结构

```
server/index.js             静态服务 + COOP/COEP + WebSocket 会话中继
public/host.html            主持端控制台
public/guest.html           嘉宾端发送页
public/js/protocol.js       协议常量、二进制包头、网络预设
public/js/dsp.js            纯 DSP：到达估计、目标控制、乱序门、漂移、重采样、放置
public/js/network.js        确定性网络损伤注入与投递队列
public/js/kernel-worker.js  媒体内核（Worker）：编解码、缓冲、统计、控制
public/js/audio-io.js       页面侧音频 I/O（AudioContext / AudioWorklet）
public/js/client.js         页面与内核之间的客户端封装
public/js/host.js           主持端 UI 与探针
public/js/guest.js          嘉宾端 UI
public/worklets/            采集与播放 AudioWorklet
test/unit.test.js           单元测试
test/e2e.mjs                真实浏览器端到端测试
```
