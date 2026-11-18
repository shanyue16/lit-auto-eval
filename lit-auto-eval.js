// ==UserScript==
// @name         洛阳理工学院·随堂评价自动提交
// @namespace    lljw-lit-auto-eval
// @version      1.1.2
// @description  随堂评价列表逐条自动填写并提交：总分在区间内随机、评语多条随机取一（默认“无”）、可拖动/最小化悬浮面板（评分区间/评语池/重试/上限均在面板设置）、提交后确认弹窗自动点、可中止，提交不可逆。
// @match        https://lljw.lit.edu.cn/*
// @allFrames    true
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== 用户配置（可在悬浮窗设置，存 localStorage） ===================== */
  const DEFAULT_CFG = {
    scoreMin: 80,        // 目标总分下限（会与页面 data-zdf 取大者）
    scoreMax: 100,       // 目标总分上限（会与页面 data-zgf 取小者）
    comments: ['无'],    // 评语池：每次提交随机取一条；页面无评语框时自动跳过
    maxTry: 2,           // 单条最多尝试次数（含首次）
    maxItems: 200        // 单次运行最多处理条数（保护上限）
  };
  function loadCfg() {
    try {
      const s = JSON.parse(localStorage.getItem('lit-pj-cfg'));
      if (s && typeof s === 'object') return Object.assign({}, DEFAULT_CFG, s);
    } catch (e) {}
    return Object.assign({}, DEFAULT_CFG);
  }
  let CFG = loadCfg();
  function saveCfg() { try { localStorage.setItem('lit-pj-cfg', JSON.stringify(CFG)); } catch (e) {} }
  /* ========================================================================== */

  if (window.__LIT_PJ_LOADED__) return;
  window.__LIT_PJ_LOADED__ = true;

  const S = {
    running: false, abort: false, fatal: '',
    ok: 0, fail: 0, unverified: 0,
    done: new Set(),      // 已成功提交的 key
    failed: new Set(),    // 已判失败的 key
    tries: new Map()      // key -> 尝试次数
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(fn, timeout = 10000, iv = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(iv);
    }
    return null;
  }

  /* ---------- 行定位 ---------- */
  function parsePjArgs(a) {
    const m = (a.getAttribute('onclick') || '').match(
      /^pj\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/);
    if (!m) return null;
    return { dgksdm: m[1], teadm: m[2], teaxm: m[3], kcmc: m[4], jxhjmc: m[5], wjdm: m[6],
             key: m[1] + '|' + m[2] + '|' + m[6] };
  }
  function findNextTarget(doc) {
    for (const a of doc.querySelectorAll('a[onclick^="pj(\'"]')) {
      const info = parsePjArgs(a);
      if (!info) continue;
      if (S.done.has(info.key) || S.failed.has(info.key)) continue;
      return { link: a, info };
    }
    return null;
  }
  function countRemaining(doc) {
    let n = 0;
    for (const a of doc.querySelectorAll('a[onclick^="pj(\'"]')) {
      const info = parsePjArgs(a);
      if (info && !S.done.has(info.key) && !S.failed.has(info.key)) n++;
    }
    return n;
  }

  /* ---------- 评分区间 → 选项 ---------- */
  // 返回 {ok, msg, target, effMin, effMax, total}；点击 radio 后以 #wjpf 实测值做硬校验
  function fillForm(doc) {
    const cfg = doc.querySelector('#thisQuestionnaireHasR');
    const zdf = parseFloat((cfg && cfg.getAttribute('data-zdf')) || '-Infinity');
    const zgf = parseFloat((cfg && cfg.getAttribute('data-zgf')) || 'Infinity');
    const effMin = Math.max(CFG.scoreMin, zdf);
    const effMax = Math.min(CFG.scoreMax, zgf);
    if (!(effMin <= effMax)) return { ok: false, msg: '评分区间无效: eff=[' + effMin + ',' + effMax + ']' };

    const qs = [...doc.querySelectorAll('#pj-form .question')];
    if (!qs.length) return { ok: false, msg: '未找到题目' };
    // 只作答单选题；必答且非单选的题才拒绝（可选填空题如 txdm=3 textarea 由 fillComment 处理）
    const single = qs.filter(q => q.getAttribute('data-txdm') === '1');
    const badReq = qs.find(q => q.getAttribute('data-txdm') !== '1' && q.getAttribute('data-sfbt') === '1');
    if (badReq) return { ok: false, msg: '存在必答非单选题(txdm=' + badReq.getAttribute('data-txdm') + ')，拒绝作答' };
    if (!single.length) return { ok: false, msg: '无单选题可作答' };

    const target = effMin + Math.floor(Math.random() * (effMax - effMin + 1));
    const st = single.map(q => {
      const opts = [...q.querySelectorAll('input.radio.pjzb')]
        .sort((a, b) => (+a.dataset.index) - (+b.dataset.index));
      if (!opts.length) return null;
      return { opts, pos: 0 };
    });
    if (st.some(x => !x)) return { ok: false, msg: '题目缺选项' };

    let total = st.reduce((s, x) => s + parseFloat(x.opts[0].dataset.fz || '0'), 0);
    // 逐档下调逼近 target（轮转，保证各题降档均匀）
    let guard = 0;
    while (total > target + 1e-9 && guard++ < 500) {
      let moved = false;
      for (const x of st) {
        if (total <= target + 1e-9) break;
        if (x.pos < x.opts.length - 1) {
          const old = parseFloat(x.opts[x.pos].dataset.fz);
          const nw = parseFloat(x.opts[x.pos + 1].dataset.fz);
          x.pos++; total += nw - old; moved = true;
        }
      }
      if (!moved) break;
    }
    // 低于下限时回抬
    guard = 0;
    while (total < effMin - 1e-9 && guard++ < 500) {
      let moved = false;
      for (const x of st) {
        if (total >= effMin - 1e-9) break;
        if (x.pos > 0) {
          const old = parseFloat(x.opts[x.pos].dataset.fz);
          const nw = parseFloat(x.opts[x.pos - 1].dataset.fz);
          x.pos--; total += nw - old; moved = true;
        }
      }
      if (!moved) break;
    }
    if (total < effMin - 1e-9 || total > effMax + 1e-9)
      return { ok: false, msg: '无法落入区间: 凑出 ' + total + ' ∉ [' + effMin + ',' + effMax + ']' };

    for (const x of st) x.opts[x.pos].click();  // 原生 click → change → calcuteWjpf → #wjpf

    const wjpf = parseFloat((doc.querySelector('#wjpf') || {}).textContent);
    if (!isFinite(wjpf)) return { ok: false, msg: '#wjpf 无法解析' };
    if (wjpf < effMin || wjpf > effMax)
      return { ok: false, msg: '#wjpf=' + wjpf + ' 越界 [' + effMin + ',' + effMax + ']，未提交' };
    const unchecked = st.filter(x => !x.opts[x.pos].checked).length;
    if (unchecked > 0) return { ok: false, msg: unchecked + ' 题未选中，未提交' };
    return { ok: true, target, effMin, effMax, total: wjpf };
  }

  function fillComment(doc) {
    const ta = doc.querySelector('#pfsm textarea') ||
      doc.querySelector('#pj-form .question[data-txdm="3"] textarea.pjzb');
    if (!ta) return null;
    const pool = (CFG.comments && CFG.comments.length) ? CFG.comments : ['无'];
    const pick = pool[Math.floor(Math.random() * pool.length)] || '无';
    ta.value = pick;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return pick;
  }

  /* ---------- 弹窗结果监听 ---------- */
  function installAlertTap(win) {
    const captured = [];
    const $ = win.jQuery || win.$;
    const origM = ($ && $.messager) ? $.messager.alert : null;
    const origW = win.alert;
    if (origM) {
      $.messager.alert = function (title, msg, icon, cb) {
        captured.push(String(msg == null ? '' : msg).replace(/&nbsp;/g, ' '));
        if (typeof cb === 'function') try { cb(); } catch (e) {}
        return { close() {} };
      };
    }
    win.alert = function (m) { captured.push(String(m)); };
    return {
      captured,
      restore() {
        if (origM) $.messager.alert = origM;
        win.alert = origW;
      }
    };
  }

  function findSurveyConfirm(doc) {
    // 1) 已知文案（指标调查）
    const cands = [...doc.querySelectorAll('div,td')].filter(el =>
      el.textContent.indexOf('愿意进行指标调查') >= 0 && el.textContent.length < 300);
    if (cands.length) {
      cands.sort((a, b) => a.textContent.length - b.textContent.length);
      for (const c of cands) {
        let n = c;
        for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
          if (n.querySelector && n.querySelector('a.l-btn, button')) return n;
        }
      }
    }
    // 2) 通用兜底：提交后任意带按钮的确认弹窗（排除评价框 #dlg / 调查问卷 #dc-dlg）
    const boxes = [...doc.querySelectorAll('div.window, div.messager-window, div.layui-layer, div[id="dlg"] ~ div')];
    for (const b of boxes) {
      if (b.id === 'dlg' || b.id === 'dc-dlg') continue;
      if (b.closest && b.closest('#dlg,#dc-dlg')) continue;
      if (!b.getClientRects || !b.getClientRects().length) continue; // 不可见不算
      const txt = (b.textContent || '').trim();
      if (!txt || txt.length > 500) continue;
      if (!b.querySelector('a.l-btn, button')) continue;
      return b;
    }
    return null;
  }

  async function dismissSurvey(doc, win) {
    // 调查问卷本身已打开 → 关掉
    if (doc.getElementById('dc-dlg')) {
      try { const $ = win.jQuery || win.$; if ($) $('#dc-dlg').dialog('close'); } catch (e) {}
      await sleep(300);
      return 'dc-dlg';
    }
    const box = findSurveyConfirm(doc);
    if (!box) return 'none';
    const btns = [...box.querySelectorAll('a.l-btn, button')].filter(b => !/l-btn-disabled|disabled/.test(b.className || ''));
    // 优先点「跳过/关闭/取消/否」类按钮
    const skip = btns.find(b => /^(取消|关闭|跳过|稍后|否|不用了|下次再说)/.test((b.textContent || '').trim()));
    if (skip) { skip.click(); await sleep(400); return 'skip'; }
    if (btns.length >= 2) { btns[1].click(); await sleep(400); return 'btn2'; }   // 第二个按钮 = 跳过/取消
    if (btns.length === 1) { btns[0].click(); await sleep(400); return 'btn1'; }   // 可能开出调查，下轮关 #dc-dlg
    const x = box.querySelector('.panel-tool-close');
    if (x) { x.click(); await sleep(300); return 'x'; }
    return 'stuck';
  }

  /* 「评价成功」提示框清扫：实测结构是 <dialog class="ui-dialog-container ...">（原生
     dialog，top layer 置显，z-index 盖不过）> div.ui-dialog > 按钮；站方 alertSetTimeout
     的自动关闭选择器(.messager-body)永远关不掉它 → 这里直接 dialog.close() */
  function sweepSuccessDlg(doc) {
    let n = 0;
    for (const dlg of doc.querySelectorAll('dialog.ui-dialog-container')) {
      if (!dlg.open) continue;
      const t = dlg.textContent || '';
      if (t.indexOf('评价成功') < 0) continue;   // 只清「评价成功」提示
      if (t.indexOf('指标调查') >= 0) continue;  // 调查确认框交给 dismissSurvey
      try { dlg.close(); n++; } catch (e) {
        const btn = dlg.querySelector('button.ui-button') || dlg.querySelector('button.ui-dialog-close');
        if (btn) { btn.click(); n++; }
      }
    }
    if (!n) { // 兼容非原生容器
      for (const d of doc.querySelectorAll('div.ui-dialog')) {
        const t = d.textContent || '';
        if (t.indexOf('评价成功') < 0 || t.indexOf('指标调查') >= 0) continue;
        if (!d.getBoundingClientRect().width) continue;
        const btn = d.querySelector('button.ui-button') || d.querySelector('button.ui-dialog-close');
        if (btn) { btn.click(); n++; }
      }
    }
    return n;
  }

  function closeDlg(win, doc) {
    try {
      const $ = win.jQuery || win.$;
      if ($ && $('#dlg').length) { $('#dlg').dialog('close'); return; }
    } catch (e) {}
    const d = doc.querySelector('#dlg');
    if (d) d.remove();
    if (!doc.querySelector('#dlg') && !findSurveyConfirm(doc)) {
      doc.querySelectorAll('.window-mask').forEach(m => m.remove());
    }
  }

  // 结果：{status:'alert'|'closed'|'timeout'|'confirm-stuck', msg?}
  async function waitOutcome(doc, win, tap, timeout) {
    const t0 = Date.now();
    let dismissTries = 0;
    while (Date.now() - t0 < timeout) {
      sweepSuccessDlg(doc); // 「评价成功」是原生 <dialog> 顶层置显，堆叠会盖住面板 → 每拍清一次
      if (tap.captured.length) return { status: 'alert', msg: tap.captured[0] };
      if (findSurveyConfirm(doc)) {
        if (dismissTries < 6) { dismissTries++; await dismissSurvey(doc, win); }
        else return { status: 'confirm-stuck' };
        continue;
      }
      if (!doc.querySelector('#dlg')) return { status: 'closed' };
      await sleep(250);
    }
    return { status: 'timeout' };
  }

  async function waitRowEvaluated(doc, info, timeout = 12000) {
    return await waitFor(() => {
      for (const tr of doc.querySelectorAll('tr[id^="datagrid-row"]')) {
        const cb = tr.querySelector('input[name="dgksdm"]');
        if (!cb || cb.value !== info.dgksdm) continue;
        const txt = tr.textContent;
        if (txt.indexOf(info.teaxm) < 0 || txt.indexOf(info.kcmc) < 0) continue;
        const links = [...tr.querySelectorAll('a')];
        if (links.some(a => a.textContent.indexOf('已评价') >= 0)) return true;
        // 行还在但未变已评价 → 继续等 reload
      }
      return null;
    }, timeout);
  }

  /* ---------- 分页 ---------- */
  function pageInfo(doc) {
    const num = parseInt((doc.querySelector('.pagination-num') || {}).value || '0', 10);
    const m = ((doc.querySelector('.pagination') || {}).textContent || '').match(/共(\d+)页/);
    return { num, total: m ? parseInt(m[1], 10) : 0 };
  }
  async function gotoPage(doc, which) {
    const sel = which === 'first' ? 'span.pagination-first' : 'span.pagination-next';
    const before = (doc.querySelector('.pagination-num') || {}).value;
    const span = doc.querySelector(sel);
    const a = span && span.closest('a');
    if (!a || /l-btn-disabled/.test(a.className)) return false;
    a.click();
    const changed = await waitFor(() => {
      const v = (doc.querySelector('.pagination-num') || {}).value;
      return v && v !== before ? v : null;
    }, 10000);
    if (!changed) return false;
    await waitFor(() => doc.querySelectorAll('tr[id^="datagrid-row"]').length > 0, 8000);
    await sleep(300);
    return true;
  }

  /* ---------- 单条流程 ---------- */
  async function evalOne(doc, win, target) {
    const info = target.info;
    const tap = installAlertTap(win);
    try {
      target.link.click();
      const qs = await waitFor(() => {
        const list = [...doc.querySelectorAll('#pj-form .question')];
        if (!list.length) return null;
        if (!doc.querySelector('#thisQuestionnaireHasR')) return null;
        if (typeof win.savePj !== 'function') return null;
        const singles = list.filter(q => q.getAttribute('data-txdm') === '1');
        if (!singles.length) return null;
        if (!singles.every(q => q.querySelectorAll('input.radio.pjzb').length > 0)) return null;
        return list;
      }, 10000);
      if (!qs) return { ok: false, msg: '表单未加载(10s)' };
      if (S.abort) { closeDlg(win, doc); return { ok: false, msg: '用户中止', abort: true }; }

      const f = fillForm(doc);
      if (!f.ok) { closeDlg(win, doc); return { ok: false, msg: f.msg }; }
      const cmt = fillComment(doc);

      win.savePj();
      const out = await waitOutcome(doc, win, tap, 15000);

      if (out.status === 'alert') { closeDlg(win, doc); return { ok: false, msg: '服务端/校验拒绝: ' + out.msg }; }
      if (out.status === 'timeout') { closeDlg(win, doc); return { ok: false, msg: '提交超时(15s)，弹窗已强制关闭' }; }
      if (out.status === 'confirm-stuck') { closeDlg(win, doc); return { ok: false, msg: '指标调查确认框无法自动关闭，请手动关闭', fatal: true }; }

      // closed：成功回调已跑（reload + 关弹窗）；再等行变「已评价」做实证
      await dismissSurvey(doc, win); // 兜底扫一次
      const verified = await waitRowEvaluated(doc, info);
      const log2 = '评分 ' + f.total + '（目标 ' + f.target + '，区间[' + f.effMin + ',' + f.effMax + ']）'
                 + (cmt ? '，评语「' + cmt + '」' : '，无评语框');
      if (verified) return { ok: true, msg: log2 };
      return { ok: false, msg: log2 + '；提交后行未变为已评价', unverified: true };
    } catch (e) {
      closeDlg(win, doc);
      return { ok: false, msg: '异常: ' + (e && e.message ? e.message : e) };
    } finally {
      tap.restore();
    }
  }

  /* ---------- 主循环 ---------- */
  async function run(doc, win, log, setState) {
    log('开始：评分 ' + CFG.scoreMin + '-' + CFG.scoreMax + '，评语池 ' + JSON.stringify(CFG.comments));
    const n0 = sweepSuccessDlg(doc);
    if (n0) log('已清理历史「评价成功」弹窗 ' + n0 + ' 个');
    // 原生 <dialog> 在 top layer，z-index 盖不过 → 运行期每秒清扫，保证面板/中止可点
    const sweeper = setInterval(() => { try { sweepSuccessDlg(doc); } catch (e) {} }, 1000);

    // 从第 1 页起扫，保证全量覆盖
    const p0 = pageInfo(doc);
    if (p0.num > 1) {
      log('当前第 ' + p0.num + ' 页，先跳回第 1 页');
      if (await gotoPage(doc, 'first')) log('已回到第 1 页');
      else log('⚠ 跳回第 1 页失败，仅向后扫描');
    }

    let items = 0, consecFail = 0;
    while (!S.abort) {
      if (++items > CFG.maxItems) { S.fatal = '达到保护上限 ' + CFG.maxItems + ' 条'; break; }

      const t = findNextTarget(doc);
      if (!t) {
        if (await gotoPage(doc, 'next')) { log('本页完成 → 下一页（当前第 ' + pageInfo(doc).num + ' 页）'); continue; }
        break; // 最后一页也没有目标
      }

      const n = (S.tries.get(t.info.key) || 0) + 1;
      S.tries.set(t.info.key, n);
      log('[' + n + '] ' + t.info.kcmc + ' · ' + t.info.teaxm + ' …');

      const r = await evalOne(doc, win, t);
      if (r.abort) break;
      if (r.ok) {
        S.done.add(t.info.key); S.ok++; consecFail = 0;
        log('  ✅ ' + r.msg);
      } else {
        if (r.unverified) S.unverified++;
        if (n < CFG.maxTry && !r.fatal) {
          S.retriesSeen = (S.retriesSeen || 0) + 1;
          log('  ⚠ ' + r.msg + ' → 重试');
          continue;
        }
        S.failed.add(t.info.key); S.fail++;
        log('  ❌ ' + r.msg);
        if (r.fatal) { S.fatal = r.msg; break; }
        consecFail++;
        S.fatal = '连续失败已停止：' + r.msg; // 单条耗尽重试即停（提交不可逆，宁停勿错）
        break;
      }
      await sleep(600);
    }

    const pi = pageInfo(doc);
    clearInterval(sweeper);
    const reason = S.abort ? '用户中止' : (S.fatal || '全部完成');
    log('结束（' + reason + '）：成功 ' + S.ok + '，失败 ' + S.fail
      + '，第 ' + pi.num + '/' + (pi.total || '?') + ' 页，本页剩余 ' + countRemaining(doc) + ' 条');
    setState(S.fatal ? '已停止' : '完成');
  }

  /* ---------- 面板（可拖动 / 可最小化 / 内置设置） ---------- */
  function injectPanel(doc, win) {
    if (doc.getElementById('lit-pj-panel')) return;
    const p = doc.createElement('div');
    p.id = 'lit-pj-panel';
    p.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#1f2937;color:#e5e7eb;'
      + 'border-radius:8px;font:12px/1.6 "Segoe UI",sans-serif;width:300px;overflow:hidden;'
      + 'box-shadow:0 4px 18px rgba(0,0,0,.45)';
    p.innerHTML =
      // 标题栏 = 拖动手柄
      '<div id="lit-pj-head" style="display:flex;align-items:center;justify-content:space-between;'
      + 'padding:8px 10px;background:#111827;cursor:move;user-select:none">'
      + '<span style="font-weight:600">随堂评价自动提交 <span id="lit-pj-state" style="color:#9ca3af;font-weight:400">待机</span></span>'
      + '<button id="lit-pj-min" title="最小化/还原" style="width:22px;height:18px;line-height:14px;padding:0;'
      + 'background:#374151;color:#e5e7eb;border:0;border-radius:4px;cursor:pointer">—</button>'
      + '</div>'
      + '<div id="lit-pj-body">'
      + '<div style="padding:8px 10px">'
      // 设置区
      + '<fieldset id="lit-pj-set" style="border:1px solid #374151;border-radius:5px;padding:6px 8px;margin-bottom:6px">'
      + '<legend style="color:#9ca3af;padding:0 4px">设置</legend>'
      + '<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">'
      + '<label style="width:52px;color:#d1d5db">评分区间</label>'
      + '<input id="lit-pj-smin" type="number" min="0" max="100" style="width:52px;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:2px 4px">'
      + '<span>-</span>'
      + '<input id="lit-pj-smax" type="number" min="0" max="100" style="width:52px;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:2px 4px">'
      + '</div>'
      + '<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">'
      + '<label style="width:52px;color:#d1d5db">重试/上限</label>'
      + '<input id="lit-pj-try" type="number" min="1" max="10" style="width:52px;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:2px 4px">'
      + '<input id="lit-pj-item" type="number" min="1" max="1000" style="width:64px;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:2px 4px">'
      + '</div>'
      + '<div style="margin-bottom:4px">'
      + '<label style="color:#d1d5db">评语（一行一条，随机取一）</label>'
      + '<textarea id="lit-pj-scmt" rows="2" style="width:100%;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:3px 5px;resize:vertical;box-sizing:border-box"></textarea>'
      + '</div>'
      + '<button id="lit-pj-save" style="width:100%;padding:4px 0;background:#059669;color:#fff;border:0;border-radius:5px;cursor:pointer;font-weight:600">保存设置</button>'
      + '</fieldset>'
      + '<div style="color:#d1d5db">评分 <b id="lit-pj-range"></b> · 评语池 <b id="lit-pj-cmts"></b></div>'
      + '<div id="lit-pj-stats" style="margin:4px 0;color:#93c5fd">成功 0 · 失败 0</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:6px">'
      + '<button id="lit-pj-start" style="flex:1;padding:5px 0;background:#2563eb;color:#fff;border:0;border-radius:5px;cursor:pointer;font-weight:600">开始</button>'
      + '<button id="lit-pj-stop" style="flex:1;padding:5px 0;background:#4b5563;color:#e5e7eb;border:0;border-radius:5px;cursor:pointer" disabled>中止</button>'
      + '</div>'
      + '<div id="lit-pj-log" style="height:150px;overflow:auto;background:#111827;padding:6px 8px;border-radius:5px;white-space:pre-wrap;word-break:break-all"></div>'
      + '</div>'
      + '</div>';
    doc.body.appendChild(p);

    const $ = id => doc.getElementById(id);
    const refresh = () => {
      $('lit-pj-range').textContent = CFG.scoreMin + '-' + CFG.scoreMax;
      $('lit-pj-cmts').textContent = JSON.stringify(CFG.comments);
    };
    // 设置区回填
    $('lit-pj-smin').value = CFG.scoreMin;
    $('lit-pj-smax').value = CFG.scoreMax;
    $('lit-pj-try').value = CFG.maxTry;
    $('lit-pj-item').value = CFG.maxItems;
    $('lit-pj-scmt').value = CFG.comments.join('\n');
    refresh();

    const log = msg => {
      const el = $('lit-pj-log');
      el.textContent += new Date().toTimeString().slice(0, 8) + ' ' + msg + '\n';
      el.scrollTop = el.scrollHeight;
      console.log('[lit-pj] ' + msg);
    };
    const setState = t => { $('lit-pj-state').textContent = t; };
    const paint = () => { $('lit-pj-stats').textContent = '成功 ' + S.ok + ' · 失败 ' + S.fail; };
    const origLog = log;
    const log2 = m => { origLog(m); paint(); };

    // 保存设置
    $('lit-pj-save').onclick = () => {
      if (S.running) { log('运行中不可改设置，请先中止'); return; }
      const a = parseInt($('lit-pj-smin').value, 10);
      const b = parseInt($('lit-pj-smax').value, 10);
      const t = parseInt($('lit-pj-try').value, 10);
      const m = parseInt($('lit-pj-item').value, 10);
      if (!(a >= 0 && a <= 100 && b >= 0 && b <= 100 && a <= b)) { log('⚠ 评分区间无效（0-100 且 min≤max）'); return; }
      if (!(t >= 1 && t <= 10) && !(m >= 1 && m <= 1000)) { log('⚠ 重试 1-10、上限 1-1000'); return; }
      if (!(t >= 1 && t <= 10)) { log('⚠ 重试次数须 1-10'); return; }
      if (!(m >= 1 && m <= 1000)) { log('⚠ 条数上限须 1-1000'); return; }
      const lines = $('lit-pj-scmt').value.split('\n').map(s => s.trim()).filter(Boolean);
      CFG = Object.assign({}, CFG, {
        scoreMin: a, scoreMax: b, maxTry: t, maxItems: m,
        comments: lines.length ? lines : ['无'],
      });
      saveCfg();
      refresh();
      log('设置已保存：评分 ' + a + '-' + b + '，评语池 ' + JSON.stringify(CFG.comments));
    };

    // 拖动：标题栏 mousedown → 转 left/right 后跟随
    $('lit-pj-head').addEventListener('mousedown', e => {
      if (e.target && e.target.id === 'lit-pj-min') return;
      const r = p.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      p.style.right = 'auto';
      p.style.left = r.left + 'px';
      p.style.top = r.top + 'px';
      const move = ev => {
        let nx = ev.clientX - ox, ny = ev.clientY - oy;
        nx = Math.max(0, Math.min(nx, doc.documentElement.clientWidth - 60));
        ny = Math.max(0, Math.min(ny, doc.documentElement.clientHeight - 24));
        p.style.left = nx + 'px';
        p.style.top = ny + 'px';
      };
      const up = () => { doc.removeEventListener('mousemove', move); doc.removeEventListener('mouseup', up); };
      doc.addEventListener('mousemove', move);
      doc.addEventListener('mouseup', up);
      e.preventDefault();
    });

    // 最小化 / 还原
    let minimized = false;
    $('lit-pj-min').onclick = e => {
      e.stopPropagation();
      minimized = !minimized;
      $('lit-pj-body').style.display = minimized ? 'none' : '';
      $('lit-pj-min').textContent = minimized ? '□' : '—';
    };

    $('lit-pj-start').onclick = () => {
      if (S.running) return;
      S.running = true; S.abort = false; S.fatal = '';
      $('lit-pj-start').disabled = true; $('lit-pj-stop').disabled = false;
      setState('运行中');
      run(doc, win, log2, setState)
        .catch(e => log2('异常终止: ' + (e && e.message ? e.message : e)))
        .finally(() => {
          S.running = false;
          $('lit-pj-start').disabled = false; $('lit-pj-stop').disabled = true;
          paint();
        });
    };
    $('lit-pj-stop').onclick = () => { S.abort = true; setState('中止中…'); $('lit-pj-stop').disabled = true; };
    const ns = sweepSuccessDlg(doc);
    if (ns) log('已清理「评价成功」弹窗 ' + ns + ' 个');
    log('面板就绪（v1.1.2：拖动/最小化/设置/评价成功弹窗自动清）');
  }

  /* ---------- 入口：仅随堂评价列表 iframe ---------- */
  if (!/\/new\/student\/ktpj/.test(location.pathname)) return;
  waitFor(() => (document.querySelector('#datalist') && document.body) ? true : null, 15000, 250)
    .then(ok => { if (ok) injectPanel(document, window); });

  // 调试/自检钩子
  window.__LIT_PJ_TEST__ = { fillForm, fillComment, findNextTarget, pageInfo, parsePjArgs, waitRowEvaluated, waitOutcome, findSurveyConfirm, dismissSurvey, sweepSuccessDlg, saveCfg, S, cfg: () => CFG };
})();
