# dsh-html-ui 介绍页（效果展示）

> 粘贴到任意 DSH 会话即渲染。这是本插件渲染能力的自我介绍。

````markdown
```html
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .page { width: 100%; }
  .hero { width: 100%; padding: 18px 20px; border-radius: 14px; color: #f0f9ff;
    background: linear-gradient(135deg, #0b1220 0%, #12203a 55%, #1e3a5f 100%);
    border: 1px solid rgba(56,189,248,.35); position: relative; overflow: hidden; }
  .hero::after { content: ""; position: absolute; right: -60px; top: -60px; width: 200px; height: 200px;
    border-radius: 50%; background: radial-gradient(circle, rgba(56,189,248,.25), transparent 70%); }
  .hero .name { font: 700 22px/1.3 ui-monospace, Consolas, monospace; letter-spacing: .5px; }
  .hero .name span { color: #38bdf8; }
  .hero .sub { margin-top: 6px; font-size: 12.5px; color: #bae6fd; opacity: .9; }
  .hero .meta { margin-top: 10px; display: flex; gap: 14px; flex-wrap: wrap; font: 11px/1 ui-monospace, monospace; color: #7dd3fc; }
  .hero .meta b { color: #fbbf24; font-weight: 600; }
  .sec { margin-top: 12px; border: 1px solid light-dark(rgba(15,23,42,.1), rgba(255,255,255,.12));
    border-radius: 12px; padding: 12px 14px; background: light-dark(rgba(255,255,255,.7), rgba(17,20,30,.64)); }
  .sec h3 { margin: 0 0 8px; font-size: 13px; }
  .feats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .feat { border: 1px solid light-dark(rgba(15,23,42,.08), rgba(255,255,255,.1)); border-radius: 9px; padding: 8px 10px; }
  .feat .t { font-weight: 700; font-size: 12px; }
  .feat .d { font-size: 11px; opacity: .68; margin-top: 2px; }
  .fix { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { font: 11px/1.5 ui-monospace, monospace; border: 1px solid light-dark(rgba(15,23,42,.15), rgba(255,255,255,.18));
    border-radius: 999px; padding: 2px 10px; color: light-dark(#0f766e, #5eead4); }
  .chip b { color: #fbbf24; }
  code.cmd { display: block; margin: 6px 0; padding: 8px 12px; border-radius: 8px;
    font: 12px/1.6 ui-monospace, Consolas, monospace;
    background: light-dark(rgba(15,23,42,.05), rgba(255,255,255,.06)); overflow-x: auto; white-space: pre; }
</style>
<div class="page">
  <div class="hero">
    <div class="name">dsh-html-ui <span>v1.0.0</span></div>
    <div class="sub">DSH 聊天内联 HTML/KaTeX 渲染器 —— 模型写的 ```html 围栏，在聊天流里直接变成真 HTML</div>
    <div class="meta"><span>github.com/zgxaxdd/dsh-html-ui</span><span>MIT License</span><span>零运行时依赖</span></div>
  </div>
  <div class="sec">
    <h3>✨ 四大核心能力</h3>
    <div class="feats">
      <div class="feat"><div class="t">确定性接管</div><div class="d">assistant 行内 html/dsh-html 围栏一律接管，零内容猜测</div></div>
      <div class="feat"><div class="t">流式零闪烁</div><div class="d">未闭合前保持代码块，闭合后 1 帧内无缝切换</div></div>
      <div class="feat"><div class="t">零 CPU 空闲</div><div class="d">事件驱动测高（ResizeObserver），无定时器轮询</div></div>
      <div class="feat"><div class="t">安全沙箱</div><div class="d">不透明 iframe + CSP default-src 'none'，禁网络/禁父页</div></div>
    </div>
  </div>
  <div class="sec">
    <h3>🛠️ 修复了旧版 dsh-html-render 的 10 个缺陷</h3>
    <div class="fix">
      <span class="chip">F1 流式 srcdoc 零写入</span>
      <span class="chip">F2 确定性触发</span>
      <span class="chip">F3 <b>单 $</b> 永不误伤金额</span>
      <span class="chip">F4 测高零定时器</span>
      <span class="chip">F5 变更驱动 sweep</span>
      <span class="chip">F6 删除裸片段通道</span>
      <span class="chip">F7 默认禁外链图片</span>
      <span class="chip">F8 仅 assistant 行</span>
      <span class="chip">F9 无时间假结算</span>
      <span class="chip">F10 inject 最小化</span>
    </div>
  </div>
  <div class="sec">
    <h3>🚀 安装</h3>
    <code class="cmd">dsh plugin --profile web add link:&lt;仓库路径&gt;/bundle
# 或 npm 形态（发布后）：
dsh plugin --profile web add dsh-html-ui
# 重启 DSH host + 浏览器 Ctrl+F5</code>
  </div>
</div>
```
````
