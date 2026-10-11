# 示例 · 监控驾驶舱（实时曲线 + 阈值告警）

把下面整段围栏粘贴进 DSH 会话即可看到渲染效果。

覆盖：**深色驾驶舱面板**、**LED 状态灯**、**进度条**、**本地实时曲线**（`setInterval` 驱动，
纯 Canvas 绘制，无任何网络）、**阈值告警**（`<input>` 即时联动）。

````
```dsh-html
<!--dsh-html {"title":"产线监控驾驶舱"}-->
<div class="cp">
  <style>
    .cp{background:linear-gradient(160deg,#0b1220,#12203a);border:1px solid rgba(56,189,248,.3);
        border-radius:14px;padding:14px 16px;color:#d6e9ff;max-width:780px;
        font:12.5px/1.7 ui-monospace,Consolas,"Microsoft YaHei",monospace}
    .cp h4{margin:0 0 10px;color:#7dd3fc;font-size:13px;letter-spacing:1px}
    .cp .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
    .cp .tile{background:rgba(56,189,248,.08);border:1px solid rgba(56,189,248,.22);border-radius:10px;padding:9px 11px}
    .cp .lbl{display:block;font-size:11px;color:#7dd3fc;letter-spacing:.5px}
    .cp .num{font-size:22px;font-weight:700;color:#38bdf8}
    .cp .num small{font-size:11px;font-weight:400;color:#7dd3fc;margin-left:2px}
    .cp .led{display:inline-block;width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399}
    .cp .led.warn{background:#fbbf24;box-shadow:0 0 8px #fbbf24}
    .cp .led.crit{background:#fb7185;box-shadow:0 0 8px #fb7185}
    .cp .bar{height:6px;border-radius:4px;background:rgba(56,189,248,.15);margin-top:8px;overflow:hidden}
    .cp .bar>i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#0ea5e9,#34d399);
               transition:width .3s linear}
    .cp .bar>i.hot{background:linear-gradient(90deg,#f59e0b,#fb7185)}
    .cp canvas{display:block;width:100%;height:120px;margin-top:12px;
               background:rgba(2,6,23,.55);border:1px solid rgba(56,189,248,.22);border-radius:10px}
    .cp .ctl{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-top:12px;font-size:11.5px;color:#7dd3fc}
    .cp input[type=range]{width:130px;accent-color:#38bdf8}
    .cp .st{font-weight:700}
    .cp .st.ok{color:#34d399}.cp .st.warn{color:#fbbf24}.cp .st.crit{color:#fb7185}
  </style>

  <h4>产线监控 · LINE-07（本地模拟数据）</h4>

  <div class="tiles">
    <div class="tile">
      <span class="lbl">主轴转速</span>
      <span class="num" id="c-rpm">1480<small>r/min</small></span>
    </div>
    <div class="tile">
      <span class="lbl">负载率</span>
      <span class="num" id="c-load">62<small>%</small></span>
      <div class="bar"><i id="c-loadbar" style="width:62%"></i></div>
    </div>
    <div class="tile">
      <span class="lbl">温度</span>
      <span class="num" id="c-temp">58.4<small>°C</small></span>
      <div class="bar"><i id="c-tempbar" style="width:58%"></i></div>
    </div>
    <div class="tile">
      <span class="lbl">状态</span>
      <span class="num" id="c-st"><span class="led" id="c-led"></span> <span class="st ok" id="c-stt">正常</span></span>
      <span class="lbl" id="c-msg">各项参数在阈值内</span>
    </div>
  </div>

  <canvas id="c-cv" width="760" height="120" aria-label="主轴转速与温度实时曲线"></canvas>

  <div class="ctl">
    <label>温度阈值 <input id="c-th" type="range" min="50" max="95" value="75"> <b id="c-thv">75</b> °C</label>
    <label>负载阈值 <input id="c-lh" type="range" min="50" max="100" value="85"> <b id="c-lhv">85</b> %</label>
    <span>采样间隔 500 ms · 曲线保留最近 60 点</span>
  </div>
</div>
<script>
(function () {
  var rpm = document.getElementById('c-rpm');
  var load = document.getElementById('c-load');
  var temp = document.getElementById('c-temp');
  var loadBar = document.getElementById('c-loadbar');
  var tempBar = document.getElementById('c-tempbar');
  var led = document.getElementById('c-led');
  var stt = document.getElementById('c-stt');
  var msg = document.getElementById('c-msg');
  var th = document.getElementById('c-th');
  var lh = document.getElementById('c-lh');
  var thv = document.getElementById('c-thv');
  var lhv = document.getElementById('c-lhv');
  var cv = document.getElementById('c-cv');
  var ctx = cv.getContext('2d');

  var MAX = 60;
  var series = { rpm: [], temp: [] };
  var state = { rpm: 1480, load: 62, temp: 58.4 };

  function step() {
    // 纯本地随机游走，模拟产线波动
    state.load += (Math.random() - 0.5) * 6;
    state.load = Math.min(100, Math.max(35, state.load));
    state.rpm += (Math.random() - 0.5) * 40 + (state.load - 62) * 0.6;
    state.rpm = Math.min(1800, Math.max(900, state.rpm));
    state.temp += (Math.random() - 0.5) * 1.6 + (state.load - 62) * 0.05;
    state.temp = Math.min(120, Math.max(30, state.temp));
  }

  function push() {
    series.rpm.push(state.rpm);
    series.temp.push(state.temp);
    if (series.rpm.length > MAX) { series.rpm.shift(); series.temp.shift(); }
  }

  function render() {
    var tLimit = parseFloat(th.value);
    var lLimit = parseFloat(lh.value);

    rpm.innerHTML = state.rpm.toFixed(0) + '<small>r/min</small>';
    load.innerHTML = state.load.toFixed(0) + '<small>%</small>';
    temp.innerHTML = state.temp.toFixed(1) + '<small>°C</small>';
    loadBar.style.width = state.load.toFixed(0) + '%';
    tempBar.style.width = Math.min(100, state.temp).toFixed(0) + '%';

    var hot = state.temp > tLimit || state.load > lLimit;
    loadBar.className = hot ? 'hot' : '';
    tempBar.className = state.temp > tLimit ? 'hot' : '';

    if (state.temp > tLimit + 8 || state.load > lLimit + 8) {
      led.className = 'led crit';
      stt.className = 'st crit';
      stt.textContent = '超限';
      msg.textContent = '温度 ' + state.temp.toFixed(1) + ' °C / 负载 ' + state.load.toFixed(0) + ' %，已超阈值 —— 建议降速检查冷却。';
    } else if (hot) {
      led.className = 'led warn';
      stt.className = 'st warn';
      stt.textContent = '预警';
      msg.textContent = '接近阈值：温度阈值 ' + tLimit + ' °C、负载阈值 ' + lLimit + ' %。';
    } else {
      led.className = 'led';
      stt.className = 'st ok';
      stt.textContent = '正常';
      msg.textContent = '各项参数在阈值内';
    }
  }

  function draw() {
    var w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);

    // 网格
    ctx.strokeStyle = 'rgba(56,189,248,.14)';
    ctx.lineWidth = 1;
    for (var gx = 0; gx <= w; gx += w / 6) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }
    for (var gy = 0; gy <= h; gy += h / 4) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    function plot(arr, min, max, color) {
      if (arr.length < 2) { return; }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var i = 0; i < arr.length; i++) {
        var x = (i / (MAX - 1)) * w;
        var y = h - ((arr[i] - min) / (max - min)) * h;
        if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }

    plot(series.rpm, 800, 1900, '#38bdf8');
    plot(series.temp, 20, 120, '#fbbf24');

    // 温度阈值线
    var tLimit = parseFloat(th.value);
    var ty = h - ((tLimit - 20) / 100) * h;
    ctx.strokeStyle = 'rgba(251,113,133,.75)';
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#7dd3fc';
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.fillText('转速 800~1900 r/min', 8, 14);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText('温度 20~120 °C', 8, 28);
    ctx.fillStyle = '#fb7185';
    ctx.fillText('温度阈值 ' + tLimit + ' °C', w - 116, ty - 5);
  }

  function tick() { step(); push(); render(); draw(); }

  th.addEventListener('input', function () { thv.textContent = th.value; render(); draw(); });
  lh.addEventListener('input', function () { lhv.textContent = lh.value; render(); });

  for (var i = 0; i < MAX; i++) { step(); push(); }
  tick();
  var timer = setInterval(tick, 500);

  // 宿主在卸载 iframe 时会销毁文档，这里做一次主动清理（避免宿主重挂时残留）
  window.addEventListener('pagehide', function () { clearInterval(timer); });
})();
</script>
```
````

## 这里演示了什么

| 能力 | 对应写法 |
|---|---|
| 深色面板 | 「驾驶舱」风格自带底色（有意出跳），LED 灯用 `box-shadow` 发光 |
| 实时曲线 | `<canvas>` + `setInterval(500)`，双序列（转速蓝、温度黄）+ 虚线阈值 |
| 阈值联动 | `<input type="range">` 的 `input` 事件即时重算状态灯、告警文案与阈值线 |
| 零外网 | 无 `<script src>`、无 `<img src>`、无 `fetch`；`connect-src 'none'` 下也能跑 |
| 清理 | `pagehide` 时 `clearInterval`，避免宿主重挂 iframe 时定时器残留 |

> 提示：围栏内的脚本运行在 `sandbox="allow-scripts"` 的 iframe 中，**不能联网、不能访问父页**，
> 但会占用该 iframe 的 CPU——所以请不要把来路不明的死循环脚本粘进来（见
> [SECURITY.md](../SECURITY.md) 的残余风险一节）。
