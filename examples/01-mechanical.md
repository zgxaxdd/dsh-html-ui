# 示例 · 非标机械设计（工程蓝图风格）

把下面整段围栏粘贴进 DSH 会话即可看到渲染效果。

覆盖：**交互式参数计算**（模数 / 齿数 → 分度圆直径、中心距、传动比、从动轮转速）、
**块级 KaTeX 公式**、**内联 SVG 机构简图**、**公差配合对照表**。
风格取「工程蓝图」（深蓝网格底、白线、公差值黄色等宽），零外链、脚本仅本地。

````
```dsh-html
<!--dsh-html {"title":"齿轮传动参数计算卡"}-->
<div class="bp">
  <style>
    .bp{background:linear-gradient(160deg,#0e2a4d,#0a1f3c);
        background-image:repeating-linear-gradient(0deg,rgba(255,255,255,.05) 0 1px,transparent 1px 24px),
                         repeating-linear-gradient(90deg,rgba(255,255,255,.05) 0 1px,transparent 1px 24px);
        border:1px solid rgba(147,197,253,.4);border-radius:10px;padding:16px 18px;color:#dbeafe;
        font:13px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:760px}
    .bp h3{margin:0 0 4px;font-size:16px;letter-spacing:.5px;color:#bfdbfe}
    .bp .sub{margin:0 0 12px;font-size:12px;opacity:.75}
    .bp .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:12px 0}
    .bp label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:#93c5fd}
    .bp input{font:inherit;font-size:13px;padding:6px 8px;border-radius:6px;
              border:1px solid rgba(147,197,253,.45);background:rgba(15,42,77,.75);color:#e0efff}
    .bp input:focus{outline:2px solid rgba(56,189,248,.5);outline-offset:1px}
    .bp .out{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin:10px 0 4px}
    .bp .cell{background:rgba(56,189,248,.08);border:1px solid rgba(56,189,248,.22);border-radius:8px;padding:8px 10px}
    .bp .k{display:block;font-size:11px;color:#93c5fd}
    .bp .v{font:600 18px/1.35 ui-monospace,Consolas,monospace;color:#7dd3fc}
    .bp .v small{font-size:11px;font-weight:400;color:#93c5fd;margin-left:2px}
    .bp .warn{color:#fbbf24}
    .bp .hint{margin:8px 0 0;font-size:12px}
    .bp svg{display:block;width:100%;max-width:420px;height:auto;margin:14px 0 4px}
    .bp svg circle,.bp svg line,.bp svg path{stroke:#dbeafe;fill:none;stroke-width:1.6}
    .bp svg .pitch{stroke-dasharray:5 4;stroke-width:1.1;opacity:.75}
    .bp svg .center{fill:#fbbf24;stroke:#fbbf24}
    .bp svg text{fill:#dbeafe;font:10px ui-monospace,Consolas,monospace}
    .bp .tb{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:12px}
    .bp .tb th,.bp .tb td{border:1px solid rgba(147,197,253,.45);padding:4px 8px;text-align:left}
    .bp .tb th{background:rgba(56,189,248,.12);color:#bfdbfe;font-weight:600}
    .bp .tol{color:#fbbf24;font-family:ui-monospace,Consolas,monospace}
  </style>

  <h3>直齿圆柱齿轮传动 · 参数计算</h3>
  <p class="sub">输入模数与齿数，其余参数即时重算。默认 m=2、z₁=20、z₂=40、n₁=1440 r/min。</p>

  $$d=mz,\qquad a=\frac{m\left(z_1+z_2\right)}{2},\qquad i=\frac{z_2}{z_1},\qquad n_2=\frac{n_1}{i}$$

  <div class="grid">
    <label>模数 m (mm)<input id="gm" type="number" value="2" min="0.1" step="0.25"></label>
    <label>小齿轮齿数 z₁<input id="gz1" type="number" value="20" min="6" step="1"></label>
    <label>大齿轮齿数 z₂<input id="gz2" type="number" value="40" min="6" step="1"></label>
    <label>小齿轮转速 n₁ (r/min)<input id="gn1" type="number" value="1440" min="1" step="10"></label>
  </div>

  <div class="out">
    <div class="cell"><span class="k">分度圆 d₁</span><span class="v" id="gd1">40<small>mm</small></span></div>
    <div class="cell"><span class="k">分度圆 d₂</span><span class="v" id="gd2">80<small>mm</small></span></div>
    <div class="cell"><span class="k">中心距 a</span><span class="v" id="ga">60<small>mm</small></span></div>
    <div class="cell"><span class="k">传动比 i</span><span class="v" id="gi">2.000</span></div>
    <div class="cell"><span class="k">从动轮转速 n₂</span><span class="v" id="gn2">720<small>r/min</small></span></div>
  </div>
  <p class="hint" id="ghint">参数在常用区间内。</p>

  <svg viewBox="0 0 320 160" role="img" aria-label="齿轮传动简图：两分度圆相切，标注中心距">
    <circle cx="80" cy="80" r="30"></circle>
    <circle cx="170" cy="80" r="60"></circle>
    <circle class="pitch" cx="80" cy="80" r="30"></circle>
    <circle class="pitch" cx="170" cy="80" r="60"></circle>
    <line x1="80" y1="80" x2="170" y2="80"></line>
    <circle class="center" cx="80" cy="80" r="2.6"></circle>
    <circle class="center" cx="170" cy="80" r="2.6"></circle>
    <text x="96" y="72">a</text>
    <text x="46" y="140">主动轮 z₁</text>
    <text x="146" y="152">从动轮 z₂</text>
    <text x="12" y="20">分度圆相切 · 标准中心距 a = m(z₁+z₂)/2</text>
  </svg>

  <table class="tb">
    <tr><th>配合</th><th>孔 (H7)</th><th>轴 (g6 / k6)</th><th>类别</th><th>典型用途</th></tr>
    <tr><td>H7/g6</td><td class="tol">+0.021 / 0</td><td class="tol">−0.007 / −0.020</td><td>间隙配合</td><td>滑移齿轮、定位套</td></tr>
    <tr><td>H7/h6</td><td class="tol">+0.021 / 0</td><td class="tol">0 / −0.013</td><td>最小间隙为零</td><td>精密定位、可拆连接</td></tr>
    <tr><td>H7/k6</td><td class="tol">+0.021 / 0</td><td class="tol">+0.015 / +0.002</td><td>过渡配合</td><td>齿轮与轴、需拆装</td></tr>
    <tr><td>H7/p6</td><td class="tol">+0.021 / 0</td><td class="tol">+0.029 / +0.016</td><td>过盈配合</td><td>压装、传递较大扭矩</td></tr>
  </table>
</div>
<script>
(function () {
  var ids = ['gm', 'gz1', 'gz2', 'gn1'];
  var el = {};
  ids.forEach(function (id) { el[id] = document.getElementById(id); });
  var out = {
    d1: document.getElementById('gd1'),
    d2: document.getElementById('gd2'),
    a: document.getElementById('ga'),
    i: document.getElementById('gi'),
    n2: document.getElementById('gn2')
  };
  var hint = document.getElementById('ghint');

  function num(id, def) {
    var v = parseFloat(el[id].value);
    return isFinite(v) ? v : def;
  }

  function calc() {
    var m = num('gm', 2), z1 = num('gz1', 20), z2 = num('gz2', 40), n1 = num('gn1', 1440);
    if (m <= 0 || z1 < 6 || z2 < 6 || n1 <= 0) {
      hint.textContent = '模数需为正数，齿数不小于 6，转速需为正数。';
      hint.className = 'hint warn';
      return;
    }
    var d1 = m * z1, d2 = m * z2, a = (d1 + d2) / 2, i = z2 / z1, n2 = n1 / i;
    out.d1.innerHTML = d1.toFixed(1) + '<small>mm</small>';
    out.d2.innerHTML = d2.toFixed(1) + '<small>mm</small>';
    out.a.innerHTML = a.toFixed(1) + '<small>mm</small>';
    out.i.textContent = i.toFixed(3);
    out.n2.innerHTML = n2.toFixed(0) + '<small>r/min</small>';

    var msgs = [];
    if (i > 6) { msgs.push('传动比 ' + i.toFixed(2) + ' 偏大，单级直齿建议 ≤ 6，否则考虑两级传动。'); }
    if (z1 < 17) { msgs.push('z₁ = ' + z1 + ' < 17，标准直齿存在根切风险，需变位或增大齿数。'); }
    if (a > 500) { msgs.push('中心距 ' + a.toFixed(0) + ' mm 偏大，请复核箱体尺寸。'); }
    if (msgs.length) {
      hint.textContent = msgs.join(' ');
      hint.className = 'hint warn';
    } else {
      hint.textContent = '参数在常用区间内（i ≤ 6、z₁ ≥ 17、中心距适中）。';
      hint.className = 'hint';
    }
  }

  ids.forEach(function (id) { el[id].addEventListener('input', calc); });
  calc();
})();
</script>
```
````

## 这里演示了什么

| 能力 | 对应写法 |
|---|---|
| 交互计算 | `<input type="number">` + `addEventListener('input')`，全部本地，无网络 |
| 块级公式 | `$$…$$` 中的 `\frac` / `\qquad`，由本地 KaTeX 渲染 |
| 机构简图 | 内联 `<svg viewBox>`：两个分度圆（虚线）+ 中心距标注 + 铰点圆点 |
| 公差表 | 表格 + 等宽黄色 `.tol` 突出极限偏差 |
| 主题安全 | 面板自带深蓝底（有意出跳的"蓝图"风格），不依赖宿主的深浅主题 |
