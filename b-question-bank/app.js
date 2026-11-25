(function () {
  'use strict';

  const BANK = window.QUESTION_BANK;
  const main = document.getElementById('main');
  if (!BANK || !BANK.questions || !BANK.questions.length) {
    main.innerHTML = '<div class="card"><h2>题库数据加载失败</h2><p>请确认 questions.js 与 index.html 在同一目录。</p></div>';
    return;
  }

  const QUESTIONS = BANK.questions;
  const META = BANK.meta;
  const QMAP = new Map(QUESTIONS.map(q => [q.id, q]));
  QUESTIONS.forEach((q, i) => { q.no = q.no || i + 1; });
  const ALL_IDS = QUESTIONS.map(q => q.id);
  const SECTIONS = Array.from(new Set(QUESTIONS.map(q => q.section))).sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  });
  const STORAGE_KEY = 'bquiz_state_v1';
  const LETTERS = ['A', 'B', 'C', 'D'];
  const EXPLANATIONS = window.QUESTION_EXPLANATIONS || {};
  const INLINE_IMAGES = window.QUESTION_IMAGES || {};
  function figureSrc(name) {
    return INLINE_IMAGES[name] || ('images/' + encodeURIComponent(name));
  }

  // ===== 选项乱序 =====
  // 题库原始答案多落在 A，按原顺序展示等于把答案摆好。这里按题目 id 做确定性打乱后重新编号 A/B/C/D，
  // q.options/q.answer 仍保留原始字母键（数据不动），所有展示与判分走 disp/dispAnswer。
  // 例外：解析里点名了选项字母（如“C 项……”）的题保持原顺序，避免解析文字与选项错位。
  const LETTER_REF = /(?:选项\s*[ABCD]|[ABCD]\s*项|[ABCD]\s*[、．.）)]|[（(]\s*[ABCD]\s*[）)])/;

  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  QUESTIONS.forEach(q => {
    const exp = EXPLANATIONS[q.id] || '';
    const order = LETTERS.slice();
    if (!LETTER_REF.test(exp)) {
      const rand = makeRng(hashSeed(q.id));
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = order[i]; order[i] = order[j]; order[j] = t;
      }
      if (order.join('') === LETTERS.join('')) { const t = order[0]; order[0] = order[1]; order[1] = t; }
    }
    const disp = {}, map = {}, dispAnswer = [];
    order.forEach((origLetter, i) => {
      const dl = LETTERS[i];
      if (q.options[origLetter] == null) return;
      disp[dl] = q.options[origLetter];
      map[dl] = origLetter;
      if (q.answer.includes(origLetter)) dispAnswer.push(dl);
    });
    q.disp = disp;
    q.dispMap = map;
    q.dispAnswer = dispAnswer;
  });

  // 展示用选项字母（按显示顺序，缺项则跳过）与判分
  function dispLetters(q) { return LETTERS.filter(l => q.disp && q.disp[l] != null); }
  function isRight(q, letter) { return (q.dispAnswer || []).includes(letter); }

  let state = loadState();
  let session = null;
  let view = 'home';
  let autoSubmitTimer = null;
  const STUDY_PAGE_SIZES = [10, 20, 50, 100, 'all'];
  const DEFAULT_STUDY_PAGE_SIZE = 20;
  const ui = {
    wrongFilter: 'active', wrongQuery: '', searchQuery: '', trashQuery: '',
    focusMode: false, studyView: 'card', studyScope: 'all', studyPage: 0,
    studyPageSize: DEFAULT_STUDY_PAGE_SIZE
  };
  if (state.study) {
    if (state.study.view === 'card' || state.study.view === 'list') ui.studyView = state.study.view;
    if (['all', 'weak', 'starred'].includes(state.study.scope)) ui.studyScope = state.study.scope;
    if (STUDY_PAGE_SIZES.includes(state.study.pageSize)) ui.studyPageSize = state.study.pageSize;
  }
  function studySize() { return ui.studyPageSize === 'all' ? session.ids.length : ui.studyPageSize; }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.records) {
          if (!parsed.study) parsed.study = { pos: 0, view: 'card', scope: 'all' };
          if (!parsed.marks || typeof parsed.marks !== 'object' || Array.isArray(parsed.marks)) parsed.marks = {};
          if (typeof parsed.showMarks !== 'boolean') parsed.showMarks = true;
          if (!parsed.detailFlags || typeof parsed.detailFlags !== 'object' || Array.isArray(parsed.detailFlags)) parsed.detailFlags = {};
          if (!parsed.memos || typeof parsed.memos !== 'object' || Array.isArray(parsed.memos)) parsed.memos = {};
          if (!parsed.answerMarks || typeof parsed.answerMarks !== 'object' || Array.isArray(parsed.answerMarks)) parsed.answerMarks = {};
          if (!parsed.trash || typeof parsed.trash !== 'object' || Array.isArray(parsed.trash)) parsed.trash = {};
          // v1 → v2：旧版把题号徽章（如 695）算进了题干文本，导致标记整体右移「题号位数」个字。
          // 一次性回正，避免历史标记错位。
          if (parsed.marksVersion !== 2) {
            const fixedMarks = {};
            Object.keys(parsed.marks).forEach(qid => {
              const q = QMAP.get(qid);
              const d = q ? String(q.no).length : 0;
              const len = q ? String(q.question || '').length : Infinity;
              const ranges = Array.isArray(parsed.marks[qid]) ? parsed.marks[qid] : [];
              const fixed = ranges.map(r => {
                const s = Number(r.s) - d, e = Number(r.e) - d;
                return { s: Math.max(0, Math.min(s, len)), e: Math.max(0, Math.min(e, len)) };
              }).filter(r => r.e > r.s);
              if (fixed.length) fixedMarks[qid] = fixed;
            });
            parsed.marks = fixedMarks;
            parsed.marksVersion = 2;
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)); } catch (e) { /* 忽略 */ }
          }
          return parsed;
        }
      }
    } catch (e) { /* 存储不可用时退回内存 */ }
    return {
      records: {}, study: { pos: 0, view: 'card', scope: 'all' },
      marks: {}, showMarks: true, detailFlags: {}, marksVersion: 2,
      memos: {}, answerMarks: {}, trash: {}, updatedAt: null
    };
  }

  function saveState() {
    state.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('浏览器禁止本地存储，本次进度仅在当前页面有效');
    }
  }

  function ensureRec(qid) {
    if (!state.records[qid]) {
      state.records[qid] = {
        attempts: 0, correct: 0, wrong: 0, streak: 0,
        wrongCount: 0, wrongAt: null, resolved: false,
        starred: false, lastAt: null, lastResult: null
      };
    }
    return state.records[qid];
  }

  function getRec(qid) { return state.records[qid] || null; }

  function wrongIds() {
    return Object.keys(state.records)
      .filter(id => QMAP.has(id) && !isTrashed(id) && state.records[id].wrongCount > 0 && !state.records[id].resolved)
      .sort((a, b) => new Date(state.records[b].wrongAt || 0) - new Date(state.records[a].wrongAt || 0));
  }

  function masteredIds() {
    return Object.keys(state.records)
      .filter(id => QMAP.has(id) && !isTrashed(id) && state.records[id].wrongCount > 0 && state.records[id].resolved)
      .sort((a, b) => new Date(state.records[b].lastAt || 0) - new Date(state.records[a].lastAt || 0));
  }

  // 智能练习：连续答对 2 次及以上视为已掌握，自动跳过
  function isMastered(id) { return ((state.records[id] || {}).streak || 0) >= 2; }
  function smartIds() { return activeIds().filter(id => !isMastered(id)); }

  // ===== 回收站：被删除的题目不进入任何刷题/速览/检索范围 =====
  function isTrashed(id) { return !!(state.trash && state.trash[id]); }
  function activeIds() { return ALL_IDS.filter(id => !isTrashed(id)); }
  function trashedIds() {
    return Object.keys(state.trash || {})
      .filter(id => QMAP.has(id) && state.trash[id])
      .sort((a, b) => new Date(state.trash[b]) - new Date(state.trash[a]));
  }
  function trashCount() { return trashedIds().length; }

  // ===== 记忆标注 =====
  function memoText(qid) { return String((state.memos && state.memos[qid]) || ''); }
  function answerMarkRanges(qid, origLetter) {
    const byLetter = state.answerMarks && state.answerMarks[qid];
    const ranges = byLetter && byLetter[origLetter];
    return Array.isArray(ranges) ? ranges : [];
  }
  function memoKeyFragments(q) {
    const byLetter = (state.answerMarks && state.answerMarks[q.id]) || {};
    const out = [];
    dispLetters(q).forEach(dl => {
      if (!isRight(q, dl)) return;
      const orig = q.dispMap[dl], text = String(q.disp[dl] || '');
      normalizeRanges(answerMarkRanges(q.id, orig), text.length).forEach(r => {
        const frag = text.slice(r.s, r.e).trim();
        if (frag) out.push(frag);
      });
    });
    return out;
  }
  function hasMemo(qid) {
    const q = QMAP.get(qid);
    if (!q) return false;
    return !!memoText(qid).trim() || memoKeyFragments(q).length > 0;
  }

  // 在答案文字中标出记忆关键点；editable 时关键点可点击取消（仅编辑弹窗内）
  function answerMarkedHTML(q, dl, editable, rangesOverride) {
    const text = String(q.disp[dl] || '');
    const orig = q.dispMap[dl];
    const ranges = normalizeRanges(rangesOverride || answerMarkRanges(q.id, orig), text.length);
    if (!ranges.length) return esc(text);
    let html = '', pos = 0;
    for (const r of ranges) {
      if (r.s > pos) html += esc(text.slice(pos, r.s));
      const attrs = editable
        ? ` data-letter="${esc(orig)}" data-s="${r.s}" data-e="${r.e}" title="点击取消关键点"` : '';
      html += `<mark class="akey"${attrs}>${esc(text.slice(r.s, r.e))}</mark>`;
      pos = r.e;
    }
    if (pos < text.length) html += esc(text.slice(pos));
    return html;
  }

  // 标注展示块：答题后 / 揭晓后 / 速览中显示
  function memoBoxHTML(q) {
    const text = memoText(q.id), keys = memoKeyFragments(q);
    if (!text.trim() && !keys.length) return '';
    return `<div class="memo-box">
      <div class="memo-head"><b>记忆标注</b><button class="memo-edit" data-action="memo-edit" data-id="${esc(q.id)}">编辑</button></div>
      ${text.trim() ? `<div class="memo-text">${esc(text)}</div>` : ''}
      ${keys.length ? `<div class="memo-keys"><span>答案关键</span>${keys.map(k => `<em>${esc(k)}</em>`).join('')}</div>` : ''}
    </div>`;
  }

  function memoBtnHTML(q) {
    const on = hasMemo(q.id);
    return `<button class="memo-btn ${on ? 'on' : ''}" data-action="memo-edit" data-id="${esc(q.id)}" title="记忆标注">${on ? '记忆 ✓' : '＋记忆'}</button>`;
  }

  function toast(msg, action) {
    const el = document.getElementById('toast');
    el.textContent = '';
    el.appendChild(document.createTextNode(msg));
    if (action && action.label && typeof action.onAction === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => { el.classList.remove('show'); action.onAction(); });
      el.appendChild(btn);
    }
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), action ? 6000 : 2400);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // ===== 题干标记：把题干中的关键文字标红，帮助从关键点推断答案 =====
  function getMarks(qid) {
    return (state.marks && Array.isArray(state.marks[qid])) ? state.marks[qid] : [];
  }

  // 将一组区间裁剪到 [0, len] 并合并重叠，返回 {s,e} 列表
  function normalizeRanges(ranges, len) {
    const valid = ranges
      .map(r => ({ s: Math.max(0, Math.min(Number(r.s), len)), e: Math.max(0, Math.min(Number(r.e), len)) }))
      .filter(r => r.e > r.s)
      .sort((a, b) => a.s - b.s);
    const out = [];
    for (const r of valid) {
      const last = out[out.length - 1];
      if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
      else out.push({ s: r.s, e: r.e });
    }
    return out;
  }

  // 渲染题干：按标记区间把文字切成 <mark class="qmark">，未开启显示则输出纯文本
  function questionTextHTML(q) {
    const text = String(q.question || '');
    const ranges = (state.showMarks !== false) ? normalizeRanges(getMarks(q.id), text.length) : [];
    if (!ranges.length) return esc(text);
    let html = '', pos = 0;
    for (const r of ranges) {
      if (r.s > pos) html += esc(text.slice(pos, r.s));
      html += `<mark class="qmark" data-qid="${esc(q.id)}" data-s="${r.s}" data-e="${r.e}" title="点击取消标记">${esc(text.slice(r.s, r.e))}</mark>`;
      pos = r.e;
    }
    if (pos < text.length) html += esc(text.slice(pos));
    return html;
  }

  // 题号徽章：单选蓝、多选紫（颜色即题型标识，省去单独徽章）
  function qNoHTML(q) {
    const multi = q.type === 'multiple';
    const tip = `第 ${q.no} 题 · ${multi ? '多选' : '单选'}${q.bankId ? ' · ' + q.bankId : ''}`;
    return `<span class="qno ${multi ? 'multi' : 'single'}" title="${esc(tip)}">${q.no}</span>`;
  }

  // 题型标签：多选题在题干前标出【多选题】
  function typeTagHTML(q) {
    return q.type === 'multiple' ? '<span class="type-tag">【多选题】</span>' : '';
  }

  // 题干行：题号 + 题干（同一行，节约纵向空间），末尾挂「需详细解析」标注
  // 注意：题号/题型标签必须放在 data-qmark-host 之外，否则标记坐标会把这些字算进去导致错位
  function questionRowHTML(q, extraHTML) {
    return `<div class="qtext-row">
      <div class="qline">
        ${qNoHTML(q)}${typeTagHTML(q)}
        <div class="qtext-main">
          <div class="question-text" data-qmark-host="${esc(q.id)}">${questionTextHTML(q)}</div>
        </div>
      </div>
      ${extraHTML || ''}
    </div>`;
  }

  // 其余选项（错误答案）手动展开，practice/速览通用
  function othersAnswersHTML(q) {
    const others = dispLetters(q).filter(l => !isRight(q, l));
    if (!others.length) return '';
    const open = !!(session && session.othersOpen && session.othersOpen[q.id]);
    return `<div class="others-block">
      <button class="others-toggle" data-action="toggle-others" data-id="${esc(q.id)}">${open ? '收起其他答案 ▴' : '展开其他答案 ▾'}</button>
      ${open ? `<div class="others-list">${others.map(l => `<div class="other-item"><span>${esc(q.disp[l])}</span></div>`).join('')}</div>` : ''}
    </div>`;
  }

  // 解析区：默认收起，点击展开；只有该题有解析且有解析价值时才显示
  // defaultOpen 为 true 时默认展开（速览、答题后），用户手动收起过则以其操作为准
  function explanationHTML(q, defaultOpen) {
    const text = EXPLANATIONS[q.id];
    if (!text) return '';
    const box = session && session.explOpen;
    const open = box && Object.prototype.hasOwnProperty.call(box, q.id) ? !!box[q.id] : !!defaultOpen;
    return `<div class="explanation ${open ? 'open' : ''}">
      <button class="expl-toggle" data-action="toggle-expl" data-id="${esc(q.id)}" data-open="${open ? '1' : '0'}">${open ? '收起解析 ▴' : '查看解析 ▾'}</button>
      ${open ? `<div class="expl-body">${esc(text)}</div>` : ''}
    </div>`;
  }

  // 详解按钮暂时隐藏（逻辑与数据保留，届时把 return 改回按钮即可）
  function detailFlagHTML(q) {
    return '';
  }

  // 计算选区在某个文本容器内相对于纯文本的字符偏移
  // 用文本节点遍历计数，避免 Range.toString() 在不同浏览器（尤其移动端）对块级/换行处理不一致
  function offsetInHost(host, node, offset) {
    if (node === host) {
      let total = 0;
      for (let i = 0; i < offset && i < host.childNodes.length; i++) total += host.childNodes[i].textContent.length;
      return total;
    }
    if (node.nodeType === 3) {
      let total = 0;
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
      let t;
      while ((t = walker.nextNode())) {
        if (t === node) return total + offset;
        total += t.nodeValue.length;
      }
      return null;
    }
    // 选区端点落在元素上：退回 Range 方式
    try {
      const r = document.createRange();
      r.setStart(host, 0);
      r.setEnd(node, offset);
      return r.toString().length;
    } catch (e) { return null; }
  }

  function selectionOffsets(container) {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
    const s = offsetInHost(container, range.startContainer, range.startOffset);
    const e = offsetInHost(container, range.endContainer, range.endOffset);
    if (s == null || e == null || e <= s) return null;
    return { s: Math.min(s, e), e: Math.max(s, e), text: range.toString() };
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function answerText(q) { return (q.dispAnswer || []).join(''); }

  function render() {
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.view === view);
    });
    document.body.classList.toggle('focus-mode', view === 'practice' && !!ui.focusMode);
    const attempted = Object.values(state.records).filter(r => r.attempts > 0).length;
    const totalCorrect = Object.values(state.records).reduce((s, r) => s + r.correct, 0);
    const totalWrong = Object.values(state.records).reduce((s, r) => s + r.wrong, 0);
    const acc = totalCorrect + totalWrong ? Math.round(totalCorrect / (totalCorrect + totalWrong) * 100) : null;

    document.getElementById('topMeta').innerHTML = `
      <span class="meta-chip">总题数 <b>${activeIds().length}</b>${trashCount() ? `<small>（回收站 ${trashCount()}）</small>` : ''}</span>
      <span class="meta-chip">单选 <b>${META.single}</b></span>
      <span class="meta-chip">多选 <b>${META.multiple}</b></span>
      <span class="meta-chip">已练 <b>${attempted}</b></span>`;
    document.getElementById('navWrongCount').textContent = wrongIds().length;
    const navFlagEl = document.getElementById('navFlagCount');
    if (navFlagEl) navFlagEl.textContent = Object.keys(state.detailFlags || {}).length;
    const navMemoEl = document.getElementById('navMemoCount');
    if (navMemoEl) navMemoEl.textContent = activeIds().filter(hasMemo).length;
    const navTrashEl = document.getElementById('navTrashCount');
    if (navTrashEl) navTrashEl.textContent = trashCount();
    document.getElementById('quickStats').innerHTML = `
      <h3>学习概览</h3>
      <div class="mini-stat"><span>已练题目</span><b>${attempted}</b></div>
      <div class="mini-stat"><span>累计作答</span><b>${totalCorrect + totalWrong}</b></div>
      <div class="mini-stat"><span>正确率</span><b>${acc === null ? '—' : acc + '%'}</b></div>
      <div class="mini-stat"><span>待复习错题</span><b style="color:var(--danger)">${wrongIds().length}</b></div>`;

    if (view === 'home') main.innerHTML = renderHome();
    else if (view === 'practice') main.innerHTML = renderPractice();
    else if (view === 'wrong') main.innerHTML = renderWrong();
    else if (view === 'search') main.innerHTML = renderSearch();
    else if (view === 'stats') main.innerHTML = renderStats();
    else if (view === 'flags') main.innerHTML = renderFlags();
    else if (view === 'memos') main.innerHTML = renderMemos();
    else if (view === 'trash') main.innerHTML = renderTrash();
  }

  function renderHome() {
    const recs = Object.values(state.records);
    const attempted = recs.filter(r => (r.attempts || 0) > 0).length;
    const totalAns = recs.reduce((s, r) => s + (r.attempts || 0), 0);
    const totalCorrect = recs.reduce((s, r) => s + (r.correct || 0), 0);
    const acc = totalAns ? Math.round(totalCorrect / totalAns * 100) : null;
    const wrongN = wrongIds().length;
    const activeCount = activeIds().length;
    const everWrong = recs.filter(r => (r.wrongCount || 0) > 0).length;
    const masteredN = activeIds().length - smartIds().length;
    const skimmed = !!(state.study && state.study.skimmed);
    const flaggedN = Object.keys(state.detailFlags || {}).length;
    const fuIdx = firstUnansweredIdx(activeIds());
    const nextNo = fuIdx >= 0 ? ((QMAP.get(activeIds()[fuIdx]) || {}).no || fuIdx + 1) : 0;

    const s1 = skimmed ? 'done' : (attempted ? 'todo' : 'active');
    const s2 = attempted >= activeCount ? 'done' : (attempted ? 'active' : 'todo');
    const s3 = (everWrong && !wrongN) ? 'done' : (wrongN ? 'active' : 'todo');
    const s4 = (s1 === 'done' && s2 === 'done' && s3 === 'done') ? 'active' : 'todo';

    let recN = 1;
    if (skimmed) recN = 2;
    if (attempted >= activeCount) recN = wrongN ? 3 : 4;
    else if (wrongN >= 5 && attempted > 0) recN = 3;
    const recText = {
      1: '先花十几分钟速览一遍，知道考什么、答案长什么样，不用刻意记。',
      2: '按智能练习顺序刷题，答对两次的题会自动移出，越刷越少。',
      3: `错题库还有 ${wrongN} 题待复习，连对两次就能彻底剔除。`,
      4: '用随机练习检验真实水平，再用速览快速回顾错题和收藏。'
    }[recN];
    const recBtn = {
      1: '<button class="btn primary" data-action="study-skim">去速览 →</button>',
      2: '<button class="btn primary" data-action="start" data-mode="smart">开始智能练习 →</button>',
      3: '<button class="btn primary" data-action="start" data-mode="wrong">清理错题 →</button>',
      4: '<button class="btn primary" data-action="start" data-mode="random">随机检验 →</button>'
    }[recN];

    const statusText = s => s === 'done' ? '已完成 ✓' : (s === 'active' ? '现在做' : '待进行');
    const step = (n, st, title, desc, data, btns) => `
      <section class="road-step ${st}">
        <div class="step-num">${n}</div>
        <div class="step-body">
          <div class="step-head"><h3>${title}</h3><span class="step-status ${st}">${statusText(st)}</span></div>
          <p>${desc}</p>
          <div class="step-foot"><div class="step-data">${data}</div><div class="btn-row">${btns}</div></div>
        </div>
      </section>`;

    return `<div class="view">
      <section class="hero">
        <h2>你的四步备考路线</h2>
        <p>考试全是选择题、答案顺序固定。按下面四步走：先建印象，再系统刷，然后清空错题，最后随机巩固。进度自动保存，随时接着学。</p>
      </section>

      <section class="card road-dashboard">
        <div class="dash-grid">
          <div><span>速览</span><b style="color:${skimmed ? 'var(--success)' : 'var(--muted)'}">${skimmed ? '已完成' : '未开始'}</b></div>
          <div><span>已练题目</span><b>${attempted} / ${activeCount}</b></div>
          <div><span>待复习错题</span><b style="color:${wrongN ? 'var(--danger)' : 'var(--success)'}">${wrongN}</b></div>
          <div><span>已掌握</span><b style="color:var(--success)">${masteredN}</b></div>
        </div>
        <div class="road-track">
          ${[s1, s2, s3, s4].map((st, i) => `<span class="road-node ${st}">${i + 1}</span>${i < 3 ? `<i class="road-line ${st === 'done' ? 'done' : ''}"></i>` : ''}`).join('')}
        </div>
        <div class="next-up">
          <span class="next-label">下一步建议</span>
          <span class="next-text">${recText}</span>
          ${recBtn}
        </div>
      </section>

      <div class="roadmap">
        ${step(1, s1, '速览一遍 · 建立印象', '一页 20 题滚动看题干和答案，只求眼熟、不求记住。先扫一遍，后面刷题会快很多。', `共 ${Math.ceil(activeCount / 20)} 页 · ${skimmed ? '已开始' : '未开始'}`, `
          <button class="btn primary" data-action="study-skim">进入速览 →</button>
          <button class="btn" data-action="start" data-mode="study">卡片背题</button>`)}
        ${step(2, s2, '系统刷题 · 主力', '智能练习自动跳过已掌握的题，只练还没拿下的。单选点一下自动提交，多选选完提交；答错自动进错题库。', `已练 ${attempted} 题 · 正确率 ${acc === null ? '—' : acc + '%'}${nextNo ? ` · 下一道未答第 ${nextNo} 题` : ''}`, `
          <button class="btn primary" data-action="start" data-mode="smart">智能练习 →</button>
          <button class="btn" data-action="start" data-mode="sequential">完整顺序</button>
          <span class="start-at">
            <span>从第</span>
            <input id="startAtInput" type="number" min="1" max="${META.total}" inputmode="numeric" placeholder="${nextNo || 1}" aria-label="起始题号">
            <span>题开始</span>
            <button class="btn small" data-action="start-at">跳转</button>
          </span>`)}
        ${step(3, s3, '清空错题 · 剔除不会的', '只练错题库里的题，连续答对两次自动标记“已掌握”并移出。这样剔除可靠，不会把蒙对的当会做。', `待复习 ${wrongN} 题 · 曾错 ${everWrong} 题`, `
          <button class="btn ${wrongN ? 'primary' : ''}" data-action="start" data-mode="wrong" ${wrongN ? '' : 'disabled'}>${wrongN ? '错题重练 →' : '暂无错题'}</button>`)}
        ${step(4, s4, '考前巩固 · 随机检验', '随机打乱全库检验真实水平，再用速览快速回顾错题和收藏。答案顺序不变，刷题时形成的眼熟感这时最管用。', `全库 ${activeCount} 题随机`, `
          <button class="btn primary" data-action="start" data-mode="random">随机练习 →</button>
          <button class="btn" data-action="study-skim">速览回顾</button>`)}
      </div>

      <section class="card">
        <div class="card-header"><div><h2>按需工具</h2><p>不在主路线上，需要时再用</p></div></div>
        <div class="btn-row">
          <button class="btn" data-action="nav" data-view="search">题目检索</button>
          <button class="btn" data-action="nav" data-view="stats">学习统计</button>
          <button class="btn" data-action="nav" data-view="wrong">错题库</button>
          <button class="btn" data-action="nav" data-view="flags">已标注详解 ${flaggedN ? `<b style="color:#b45309">${flaggedN}</b>` : '(0)'}</button>
          <button class="btn" data-action="nav" data-view="memos">记忆标注 ${activeIds().filter(hasMemo).length ? `<b style="color:#b45309">${activeIds().filter(hasMemo).length}</b>` : '(0)'}</button>
          <button class="btn" data-action="nav" data-view="trash">题目管理 / 回收站 ${trashCount() ? `<b style="color:var(--danger)">${trashCount()}</b>` : ''}</button>
        </div>
        <div class="inline-form" style="margin-top:16px">
          <div class="field"><label for="chapterSelect">按章节练习</label>
            <select id="chapterSelect">${SECTIONS.map(s => {
              const n = QUESTIONS.filter(q => q.section === s).length;
              return `<option value="${esc(s)}">${esc(s)} · ${n} 题</option>`;
            }).join('')}</select>
          </div>
          <button class="btn" data-action="start" data-mode="chapter">开始本章练习</button>
        </div>
      </section>

      <section class="card">
        <div class="card-header"><div><h2>数据管理</h2><p>进度与错题保存在本机浏览器；可导出备份后在其他设备导入</p></div></div>
        <div class="btn-row">
          <button class="btn" data-action="export-json">导出进度备份</button>
          <button class="btn" data-action="import-json">导入进度备份</button>
          <button class="btn danger" data-action="reset-progress">清空全部进度</button>
        </div>
      </section>
    </div>`;
  }

  function renderPractice() {
    if (!session) {
      return `<div class="view"><section class="card"><div class="empty-state">
        <div class="big">✎</div><h3>还没有进行中的练习</h3><p>从练习首页选择一种模式开始刷题。</p>
        <button class="btn primary" data-action="nav" data-view="home">返回练习首页</button>
      </div></section></div>`;
    }
    if (session.pos >= session.ids.length) return renderCompletion();
    if (session.mode === 'study') return renderStudy();

    const qid = session.ids[session.pos];
    const q = QMAP.get(qid);
    if (!q) return '<div class="card">题目数据异常</div>';
    const selected = session.selected[qid] || [];
    const submitted = !!session.submitted[qid];
    const rec = getRec(qid);
    const modeNames = { sequential: '顺序练习', random: '随机练习', chapter: `章节练习 · ${session.title || ''}`, wrong: '错题重练', review: '单题精练' };
    const answered = Object.keys(session.submitted).length;
    const percent = session.ids.length ? Math.round(answered / session.ids.length * 100) : 0;

    const isMulti = q.type === 'multiple';
    const optionsHTML = dispLetters(q).map(letter => {
      let cls = 'option';
      if (selected.includes(letter)) cls += ' selected';
      if (submitted) {
        cls += ' locked';
        const isAnswer = isRight(q, letter);
        const isSelected = selected.includes(letter);
        if (isAnswer) cls += ' is-answer';
        if (isAnswer && isSelected) cls += ' is-correct';
        else if (isAnswer && !isSelected) cls += ' is-missed';
        else if (!isAnswer && isSelected) cls += ' is-wrong';
      }
      const mark = submitted && isRight(q, letter)
        ? `<span class="answer-flag">✓ 正确答案</span>` : '';
      const bodyHTML = submitted && isRight(q, letter) ? answerMarkedHTML(q, letter, false) : esc(q.disp[letter]);
      return `<button class="${cls}" data-action="toggle-option" data-letter="${letter}" ${submitted ? 'disabled' : ''}>
        <span class="letter">${letter}</span><span class="body">${bodyHTML}${mark}</span>
      </button>`;
    }).join('');

    return `<div class="view">
      <section class="card practice-bar">
        <div class="practice-bar-top">
          <h2>${esc(modeNames[session.mode] || '练习')}</h2>
          <div class="tag-row">
            <span class="tag blue">第 ${session.pos + 1} / ${session.ids.length} 题</span>
            <span class="tag">本轮正确 ${session.correct}</span>
            <span class="tag red">本轮错误 ${session.wrong}</span>
            <button class="star-btn ${rec && rec.starred ? 'on' : ''}" data-action="star" title="收藏本题">★</button>
            ${memoBtnHTML(q)}
            <button class="mark-toggle ${state.showMarks !== false ? 'on' : ''}" data-action="toggle-marks" title="开启/关闭题干标记显示">${state.showMarks !== false ? '标记 开' : '标记 关'}</button>
            <button class="fold-btn" data-action="toggle-focus" title="折叠/展开顶部内容">${ui.focusMode ? '展开上方 ▾' : '折叠上方 ▴'}</button>
          </div>
        </div>
        <div class="progress"><i style="width:${percent}%"></i></div>
      </section>
      <section class="card question-card">
        ${rec && rec.wrongCount ? `<div class="tag-row" style="margin-bottom:8px"><span class="tag red">历史错误 ${rec.wrongCount} 次</span></div>` : ''}
        ${questionRowHTML(q, detailFlagHTML(q))}
        ${q.figure ? `<div class="figure-wrap"><img src="${figureSrc(q.figure)}" alt="题目附图"></div>` : ''}
        <div class="options no-letter">${optionsHTML}</div>
        ${submitted ? explanationHTML(q, true) : ''}
        ${submitted ? memoBoxHTML(q) : ''}
        <div class="btn-row spread practice-actions" style="margin-top:20px">
          <div class="btn-row">
            <button class="btn" data-action="prev" ${session.pos === 0 ? 'disabled' : ''}>← 上一题</button>
            <button class="btn" data-action="skip" ${submitted ? 'disabled' : ''}>跳过</button>
          </div>
          <div class="btn-row">
            ${submitted
              ? `<button class="btn primary" data-action="next">${session.pos === session.ids.length - 1 ? '查看本轮结果' : '下一题 →'}</button>`
              : (isMulti
                  ? `<button class="btn primary" data-action="submit">提交答案（已选 ${selected.length}）</button>`
                  : `<span class="submit-hint">点击选项即可作答</span>`)}
          </div>
        </div>
      </section>
    </div>`;
  }

  function studyIds(scope) {
    if (scope === 'starred') return QUESTIONS.filter(q => (state.records[q.id] || {}).starred).map(q => q.id);
    if (scope === 'weak') {
      const set = new Set();
      QUESTIONS.forEach(q => {
        const rec = state.records[q.id] || {};
        if ((rec.wrongCount > 0 && !rec.resolved) || rec.starred) set.add(q.id);
      });
      return activeIds().filter(id => set.has(id));
    }
    return activeIds().slice();
  }

  function saveStudyPos() {
    if (!state.study) state.study = { pos: 0, view: 'card', scope: 'all' };
    state.study.pos = (session && session.mode === 'study' && session.pos < session.ids.length) ? session.pos : 0;
    state.study.view = ui.studyView;
    state.study.scope = ui.studyScope;
    state.study.pageSize = ui.studyPageSize;
    saveState();
  }

  function studyPageCount() {
    const size = studySize();
    return Math.max(1, Math.ceil(session.ids.length / (size || 1)));
  }

  function setStudyPage(n) {
    const pages = studyPageCount();
    ui.studyPage = Math.max(0, Math.min(pages - 1, n));
  }

  function renderStudy() {
    const scopeNames = { all: '全部题目', weak: '错题 + 收藏', starred: '我的收藏' };
    const pages = studyPageCount();
    if (ui.studyPage >= pages) ui.studyPage = pages - 1;
    const shown = ui.studyView === 'card'
      ? `第 ${session.pos + 1} / ${session.ids.length} 题`
      : `第 ${ui.studyPage + 1} / ${pages} 页`;
    const percent = ui.studyView === 'card'
      ? (session.ids.length ? Math.round((session.pos + 1) / session.ids.length * 100) : 0)
      : Math.round((ui.studyPage + 1) / pages * 100);
    return `<div class="view">
      <section class="card practice-bar">
        <div class="practice-bar-top">
          <h2>学习模式 · ${ui.studyView === 'card' ? '主动回忆' : '速览'}</h2>
          <div class="tag-row">
            <span class="tag blue">${shown}</span>
            <button class="mark-toggle ${state.showMarks !== false ? 'on' : ''}" data-action="toggle-marks" title="开启/关闭题干标记显示">${state.showMarks !== false ? '标记 开' : '标记 关'}</button>
            <button class="fold-btn" data-action="toggle-focus" title="折叠/展开顶部内容">${ui.focusMode ? '展开上方 ▾' : '折叠上方 ▴'}</button>
          </div>
        </div>
        <div class="progress"><i style="width:${percent}%"></i></div>
      </section>
      <div class="card study-tools">
        <div class="study-seg">
          ${Object.keys(scopeNames).map(s => `<button class="study-seg-btn ${ui.studyScope === s ? 'active' : ''}" data-action="study-scope" data-scope="${s}">${scopeNames[s]}</button>`).join('')}
        </div>
        <div class="study-seg">
          <button class="study-seg-btn ${ui.studyView === 'card' ? 'active' : ''}" data-action="study-view" data-view="card">▤ 卡片</button>
          <button class="study-seg-btn ${ui.studyView === 'list' ? 'active' : ''}" data-action="study-view" data-view="list">☰ 速览</button>
        </div>
      </div>
      ${ui.studyView === 'card' ? renderStudyCard() : renderStudyList()}
    </div>`;
  }

  function renderStudyCard() {
    const qid = session.ids[session.pos];
    const q = QMAP.get(qid);
    if (!q) return '<div class="card">题目数据异常</div>';
    const rec = getRec(qid);
    const isMulti = q.type === 'multiple';
    const revealed = !!session.revealed[qid];

    const optionsHTML = dispLetters(q).map(letter => {
      const isAnswer = isRight(q, letter);
      const cls = 'option locked' + (isAnswer ? ' is-answer is-correct' : '');
      const mark = isAnswer ? `<span class="answer-flag">✓ 正确答案</span>` : '';
      const bodyHTML = isAnswer ? answerMarkedHTML(q, letter, false) : esc(q.disp[letter]);
      return `<div class="${cls}"><span class="letter">${letter}</span><span class="body">${bodyHTML}${mark}</span></div>`;
    }).join('');

    return `<section class="card question-card study-card">
      ${questionRowHTML(q, `<div class="qside-btns"><button class="star-btn ${rec && rec.starred ? 'on' : ''}" data-action="star" title="收藏本题">★</button>${memoBtnHTML(q)}${detailFlagHTML(q)}</div>`)}
      ${q.figure ? `<div class="figure-wrap"><img src="${figureSrc(q.figure)}" alt="题目附图"></div>` : ''}
      ${revealed
        ? `<div class="options">${optionsHTML}</div>
           ${explanationHTML(q, true)}
           ${memoBoxHTML(q)}`
        : `<div class="recall-hint">
             <b>先自己想一想</b>，想好了再揭晓 —— 回忆过的题记得更牢。
             <span>按 <kbd>空格</kbd> 揭晓答案</span>
           </div>`}
      <div class="btn-row spread practice-actions" style="margin-top:20px">
        <div class="btn-row">
          <button class="btn" data-action="prev" ${session.pos === 0 ? 'disabled' : ''}>← 上一题</button>
        </div>
        <div class="btn-row">
          ${revealed
            ? `<button class="btn primary" data-action="next">${session.pos === session.ids.length - 1 ? '完成本轮 ✓' : '下一题 →'}</button>`
            : `<button class="btn primary" data-action="study-reveal">揭晓答案 <span class="key-hint">空格</span></button>`}
        </div>
      </div>
    </section>`;
  }

  function studyPagerHTML(where) {
    const pages = studyPageCount();
    const sizeLabel = ui.studyPageSize === 'all' ? '全部' : String(ui.studyPageSize);
    const sizeOptions = STUDY_PAGE_SIZES.map(s =>
      `<option value="${s}" ${ui.studyPageSize === s ? 'selected' : ''}>${s === 'all' ? '全部' : s + ' 题'}</option>`).join('');
    const pageOptions = Array.from({ length: pages }, (_, i) =>
      `<option value="${i}" ${ui.studyPage === i ? 'selected' : ''}>第 ${i + 1} 页</option>`).join('');
    return `<div class="study-pager">
      <div class="pager-row">
        <label class="pager-label">每页显示</label>
        <select class="pager-select" data-change="study-page-size-change" aria-label="每页显示题数">${sizeOptions}</select>
        <span class="pager-count">共 ${session.ids.length} 题 / ${pages} 页</span>
      </div>
      <div class="pager-row">
        <button class="pager-btn" data-action="study-page-first" ${ui.studyPage === 0 ? 'disabled' : ''} title="首页">«</button>
        <button class="pager-btn" data-action="study-page-prev" ${ui.studyPage === 0 ? 'disabled' : ''} title="上一页">‹</button>
        <select class="pager-select page-select" data-change="study-page-jump-select" aria-label="跳转到指定页">${pageOptions}</select>
        <span class="pager-slash">/ ${pages}</span>
        <button class="pager-btn" data-action="study-page-next" ${ui.studyPage >= pages - 1 ? 'disabled' : ''} title="下一页">›</button>
        <button class="pager-btn" data-action="study-page-last" ${ui.studyPage >= pages - 1 ? 'disabled' : ''} title="末页">»</button>
      </div>
      <div class="pager-row pager-goto">
        <input type="number" class="pager-input" min="1" max="${pages}" value="${ui.studyPage + 1}" data-page-input="${where}" aria-label="页码">
        <button class="btn small" data-action="study-page-goto" data-where="${where}">跳到该页</button>
        <span class="pager-label">当前每页 ${sizeLabel}</span>
      </div>
    </div>`;
  }

  function renderStudyList() {
    const start = ui.studyPage * studySize();
    const items = session.ids.slice(start, start + studySize());
    const rows = items.map((qid, i) => {
      const q = QMAP.get(qid);
      if (!q) return '';
      // 正确答案逐行展示；选项已被打乱，字母不再有固定含义，故不显示 A/B/C/D
      const answerList = (q.dispAnswer || []).map(l =>
        `<div class="al-item"><span class="at">${answerMarkedHTML(q, l, false)}</span></div>`).join('');
      return `<article class="study-list-item">
        <div class="study-list-qrow">
          <div class="study-list-qline">
            ${qNoHTML(q)}${typeTagHTML(q)}
            <div class="study-list-q" data-qmark-host="${esc(q.id)}">${questionTextHTML(q)}</div>
          </div>
          ${memoBtnHTML(q)}${detailFlagHTML(q)}
        </div>
        ${q.figure ? `<img class="study-list-fig" src="${figureSrc(q.figure)}" alt="题目附图">` : ''}
        <div class="study-list-a"><div class="al-title">答案</div>${answerList}</div>
        ${othersAnswersHTML(q)}
        ${explanationHTML(q, true)}
        ${memoBoxHTML(q)}
      </article>`;
    }).join('');
    return `<section class="card study-list">
      <p class="section-note" style="margin:0 0 12px">滚动浏览题干与答案，可手动调整每页题数并快速跳页。按 <kbd>空格</kbd> 翻下一页。</p>
      ${studyPagerHTML('top')}
      <div class="study-list-body">${rows}</div>
      ${studyPagerHTML('bottom')}
    </section>`;
  }

  function renderCompletion() {
    if (session.mode === 'study') {
      return `<div class="view"><section class="card">
        <div class="completion">
          <div class="big" style="font-size:36px">✓</div>
          <h2 style="margin:6px 0">学习模式浏览完成</h2>
          <p class="section-note">共浏览 ${session.ids.length} 道题。学习模式只看题目和正确答案，不计分、不进错题库。</p>
          <div class="btn-row" style="justify-content:center;margin-top:20px">
            <button class="btn primary" data-action="completion-retry">再浏览一轮</button>
            <button class="btn ghost" data-action="completion-home">返回首页</button>
          </div>
        </div>
      </section></div>`;
    }
    const total = session.correct + session.wrong;
    const rate = total ? Math.round(session.correct / total * 100) : 0;
    return `<div class="view"><section class="card">
      <div class="completion">
        <div class="big" style="font-size:36px">✓</div>
        <h2 style="margin:6px 0">本轮练习完成</h2>
        <div class="score">${rate}%</div>
        <p class="section-note">共作答 ${total} 题 · 正确 ${session.correct} 题 · 错误 ${session.wrong} 题 · 跳过 ${session.skipped} 题</p>
        <div class="btn-row" style="justify-content:center;margin-top:20px">
          <button class="btn primary" data-action="completion-retry">再练一轮</button>
          <button class="btn" data-action="completion-wrong">查看错题库</button>
          <button class="btn ghost" data-action="completion-home">返回首页</button>
        </div>
      </div>
    </section></div>`;
  }

  function filteredWrongIds() {
    const ids = ui.wrongFilter === 'active' ? wrongIds() : ui.wrongFilter === 'mastered' ? masteredIds() : wrongIds().concat(masteredIds());
    const kw = ui.wrongQuery.trim().toLowerCase();
    if (!kw) return ids;
    return ids.filter(id => {
      const q = QMAP.get(id);
      const hay = [q.id, q.bankId, q.section, q.question, ...LETTERS.map(l => q.options[l])].join(' ').toLowerCase();
      return hay.includes(kw);
    });
  }

  function wrongRowsHTML() {
    const ids = filteredWrongIds();
    if (!ids.length) {
      return `<tr><td colspan="6"><div class="empty-state"><div class="big">⚑</div><h3>没有符合条件的题目</h3><p>答错的题目会自动出现在这里。</p></div></td></tr>`;
    }
    return ids.map(id => {
      const q = QMAP.get(id), r = getRec(id);
      return `<tr>
        <td><span class="title-cell">${esc(q.question)}</span><span class="sub-cell">${esc(q.id)}${q.bankId ? ' · ' + esc(q.bankId) : ''}${q.figure ? ' · 附图题' : ''}</span></td>
        <td class="nowrap">${esc(q.section)}</td>
        <td class="nowrap"><span class="tag ${q.type === 'multiple' ? 'amber' : ''}">${q.type === 'multiple' ? '多选' : '单选'}</span></td>
        <td class="nowrap"><b style="color:var(--danger)">${r.wrongCount}</b></td>
        <td class="nowrap">${formatDate(r.wrongAt)}</td>
        <td class="nowrap">
          <button class="btn ghost" data-action="review-wrong" data-id="${esc(id)}">练习</button>
          ${r.resolved
            ? `<button class="btn ghost" data-action="restore-wrong" data-id="${esc(id)}">恢复</button>`
            : `<button class="btn ghost" data-action="remove-wrong" data-id="${esc(id)}">移除</button>`}
        </td>
      </tr>`;
    }).join('');
  }

  function renderWrong() {
    const active = wrongIds().length, mastered = masteredIds().length;
    return `<div class="view">
      <section class="card">
        <div class="card-header">
          <div><h2>错题库</h2><p>答错自动收录；在“错题重练”中连续答对两次会自动标记已掌握</p></div>
          <div class="btn-row">
            <button class="btn primary" data-action="start" data-mode="wrong" ${active ? '' : 'disabled'}>开始错题练习</button>
            <button class="btn" data-action="export-html">生成错题库网页</button>
            <button class="btn" data-action="preview-html">预览错题库</button>
            <button class="btn" data-action="export-json">导出 JSON</button>
            <button class="btn" data-action="import-json">导入 JSON</button>
          </div>
        </div>
        <div class="stat-grid" style="margin-bottom:16px">
          <div class="stat-box"><span>待复习</span><b style="color:var(--danger)">${active}</b></div>
          <div class="stat-box"><span>已掌握</span><b style="color:var(--success)">${mastered}</b></div>
          <div class="stat-box"><span>错题总数</span><b>${active + mastered}</b></div>
        </div>
        <div class="btn-row spread" style="margin-bottom:12px">
          <div class="btn-row">
            <button class="btn ${ui.wrongFilter === 'active' ? 'primary' : ''}" data-action="wrong-filter" data-filter="active">待复习 ${active}</button>
            <button class="btn ${ui.wrongFilter === 'mastered' ? 'primary' : ''}" data-action="wrong-filter" data-filter="mastered">已掌握 ${mastered}</button>
            <button class="btn ${ui.wrongFilter === 'all' ? 'primary' : ''}" data-action="wrong-filter" data-filter="all">全部</button>
          </div>
          <div class="search-box" style="flex:0 1 320px">
            <input type="search" id="wrongQueryInput" value="${esc(ui.wrongQuery)}" placeholder="在错题中搜索…">
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>题目</th><th>章节</th><th>题型</th><th>错误次数</th><th>最近错误</th><th>操作</th></tr></thead>
          <tbody id="wrongBody">${wrongRowsHTML()}</tbody>
        </table></div>
        <p class="section-note" style="margin-top:12px">提示：生成的错题库网页为独立 HTML；若错题含附图，请把 images 文件夹与该 HTML 放在同一目录。</p>
      </section>
      ${active + mastered ? `<section class="card"><div class="card-header"><div><h2>危险操作</h2></div></div>
        <button class="btn danger" data-action="clear-wrong">清空错题库（不影响其他作答统计）</button></section>` : ''}
    </div>`;
  }

  // 已标注「需要更详细解析」的题目清单
  function renderFlags() {
    const flagged = activeIds().map(id => QMAP.get(id)).filter(q => state.detailFlags && state.detailFlags[q.id]);
    const rows = flagged.map(q => {
      const exp = EXPLANATIONS[q.id];
      return `<div class="result-item" data-action="review-result" data-id="${esc(q.id)}" style="cursor:pointer">
        <div class="r-top">
          <span class="r-title" data-qmark-host="${esc(q.id)}">${qNoHTML(q)}${questionTextHTML(q)}</span>
          <span class="tag ${exp ? 'blue' : 'red'}">${exp ? '已有解析' : '暂无解析'}</span>
        </div>
        <div class="r-snippet">${exp ? esc(exp) : '（本题尚未生成解析，把清单发给助手即可补上）'}</div>
      </div>`;
    }).join('');
    return `<div class="view"><section class="card">
      <div class="card-header"><div><h2>已标注「需要更详细解析」</h2>
        <p>共 ${flagged.length} 题。点「复制标注清单」把题号贴给助手，就能为你补写或加深解析；点题目可直接单题复习。</p></div></div>
      <div class="btn-row" style="margin-bottom:14px">
        <button class="btn primary" data-action="copy-flag-list" ${flagged.length ? '' : 'disabled'}>复制标注清单</button>
        <button class="btn" data-action="nav" data-view="home">返回首页</button>
      </div>
      ${flagged.length ? `<div class="result-list">${rows}</div>`
        : `<div class="empty-state"><div class="big">☆</div><h3>还没有标注的题目</h3><p>在刷题或速览页点题目右上角的「＋ 详解」即可标注。</p></div>`}
    </section></div>`;
  }

  // ===== 记忆标注清单 =====
  function copyMemoList() {
    const lines = activeIds().filter(hasMemo).map(id => {
      const q = QMAP.get(id), keys = memoKeyFragments(q);
      return `第${q.no}题\t${q.question.replace(/\s+/g, ' ')}\t记忆：${memoText(id).replace(/\s+/g, ' ')}${keys.length ? '\t答案关键：' + keys.join('、') : ''}`;
    });
    const text = lines.join('\n');
    const done = () => toast('记忆清单已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => { download('记忆标注清单.txt', text, 'text/plain'); toast('已下载 记忆标注清单.txt'); });
    } else {
      download('记忆标注清单.txt', text, 'text/plain'); toast('已下载 记忆标注清单.txt');
    }
  }

  function renderMemos() {
    const ids = activeIds().filter(hasMemo).sort((a, b) => QMAP.get(a).no - QMAP.get(b).no);
    const rows = ids.map(id => {
      const q = QMAP.get(id);
      return `<article class="memo-list-item">
        <div class="memo-list-head">
          <span class="memo-list-title">${qNoHTML(q)} ${esc(q.question)}</span>
          <span class="btn-row">
            <button class="btn small ghost" data-action="review-result" data-id="${esc(id)}">单题练习</button>
          </span>
        </div>
        ${memoBoxHTML(q)}
      </article>`;
    }).join('');
    return `<div class="view"><section class="card">
      <div class="card-header"><div><h2>记忆标注</h2>
        <p>共 ${ids.length} 题。标注的口诀与答案关键点会跟着题目走；答题提交后与速览中自动显示。</p></div></div>
      <div class="btn-row" style="margin-bottom:14px">
        <button class="btn primary" data-action="copy-memo-list" ${ids.length ? '' : 'disabled'}>复制记忆清单</button>
        <button class="btn" data-action="nav" data-view="home">返回首页</button>
      </div>
      ${ids.length ? `<div class="memo-list">${rows}</div>`
        : `<div class="empty-state"><div class="big">✎</div><h3>还没有记忆标注</h3><p>刷题页点「＋记忆」，写口诀或在正确答案上划出关键点即可。</p></div>`}
    </section></div>`;
  }

  // ===== 题目管理与回收站 =====
  function renderTrash() {
    const trashed = trashedIds();
    const kw = ui.trashQuery.trim().toLowerCase();
    const candidates = activeIds().map(id => QMAP.get(id)).filter(q => {
      if (!kw) return true;
      return [q.no, q.id, q.bankId, q.question, ...LETTERS.map(l => q.options[l])].join(' ').toLowerCase().includes(kw);
    }).slice(0, 60);
    const candidateRows = candidates.map(q => `<div class="manage-row">
      <span class="manage-title">${qNoHTML(q)} ${esc(q.question)}</span>
      <button class="btn small danger" data-action="trash-delete" data-id="${esc(q.id)}">移入回收站</button>
    </div>`).join('');
    const trashRows = trashed.map(id => {
      const q = QMAP.get(id);
      return `<div class="manage-row trashed">
        <span class="manage-title">${qNoHTML(q)} ${esc(q.question)}<small>删除于 ${formatDate(state.trash[id])}</small></span>
        <button class="btn small primary" data-action="trash-restore" data-id="${esc(id)}">恢复</button>
      </div>`;
    }).join('');
    return `<div class="view">
      <section class="card">
        <div class="card-header"><div><h2>题目管理</h2>
          <p>这里删除的题目不进入速览、刷题、错题重练、考前巩固与检索；误删可在回收站恢复，删除后也能立刻「撤回」。</p></div></div>
        <div class="stat-grid" style="margin-bottom:16px">
          <div class="stat-box"><span>在库题目</span><b>${activeIds().length}</b></div>
          <div class="stat-box"><span>回收站</span><b style="color:var(--danger)">${trashed.length}</b></div>
        </div>
        <div class="search-box" style="margin-bottom:12px">
          <input type="search" id="trashQueryInput" value="${esc(ui.trashQuery)}" placeholder="输入题号或关键词筛选要删除的题目…">
        </div>
        ${candidateRows ? `<div class="manage-list">${candidateRows}</div>` : `<p class="section-note">没有匹配的题目。默认只列出前 60 条，输入题号可精确定位。</p>`}
      </section>
      <section class="card">
        <div class="card-header"><div><h2>回收站</h2><p>共 ${trashed.length} 题，点「恢复」即可放回全部练习范围。</p></div></div>
        ${trashRows ? `<div class="manage-list">${trashRows}</div>` : `<p class="section-note">回收站是空的。</p>`}
      </section>
    </div>`;
  }

  function trashQuestion(id) {
    const q = QMAP.get(id);
    if (!q || isTrashed(id)) return;
    state.trash[id] = new Date().toISOString();
    if (session) {
      session.ids = session.ids.filter(x => x !== id);
      if (session.pos >= session.ids.length) session.pos = Math.max(0, session.ids.length - 1);
    }
    saveState(); render();
    toast(`第 ${q.no} 题已移入回收站`, { label: '撤回', onAction: () => restoreQuestion(id, true) });
  }

  function restoreQuestion(id, undone) {
    if (!state.trash || !state.trash[id]) return;
    delete state.trash[id];
    saveState(); render();
    const q = QMAP.get(id);
    toast(undone ? `已撤回，第 ${q ? q.no : ''} 题已恢复` : `第 ${q ? q.no : ''} 题已恢复`);
  }

  function renderSearch() {
    const kw = ui.searchQuery.trim();
    let results = [];
    if (kw) {
      const lower = kw.toLowerCase();
      results = activeIds().map(id => QMAP.get(id)).filter(q => {
        const hay = [q.id, q.bankId, q.section, q.question, ...LETTERS.map(l => q.options[l])].join(' ').toLowerCase();
        return hay.includes(lower);
      }).slice(0, 80);
    }
    return `<div class="view"><section class="card">
      <div class="card-header"><div><h2>题目检索</h2><p>支持题干、选项、题号、题库编号、章节号；最多显示 80 条</p></div></div>
      <div class="search-box"><input type="search" id="searchInput" value="${esc(kw)}" placeholder="例如：无线电管理 / MC1-0004 / 3.3.1"></div>
      <div id="searchResults" style="margin-top:12px">${searchResultsHTML(results, kw)}</div>
    </section></div>`;
  }

  function searchResultsHTML(results, kw) {
    if (!kw) return `<div class="empty-state"><div class="big">⌕</div><h3>输入关键词开始检索</h3><p>点击结果可单独练习该题。</p></div>`;
    if (!results.length) return `<div class="empty-state"><div class="big">∅</div><h3>没有找到匹配的题目</h3></div>`;
    return results.map(q => `<div class="result-item" data-action="review-result" data-id="${esc(q.id)}" style="cursor:pointer">
      <div class="r-top">
        <span class="r-title" data-qmark-host="${esc(q.id)}">${questionTextHTML(q)}</span>
        <span class="tag blue">${esc(q.id)}</span><span class="tag">${esc(q.section)}</span>
        <span class="tag ${q.type === 'multiple' ? 'amber' : ''}">${q.type === 'multiple' ? '多选' : '单选'}</span>
      </div>
      <div class="r-snippet">${esc(dispLetters(q).map(l => l + '. ' + q.disp[l]).join('　'))}</div>
    </div>`).join('');
  }

  function renderStats() {
    const recs = Object.values(state.records).filter(r => r.attempts > 0);
    const totalCorrect = recs.reduce((s, r) => s + r.correct, 0);
    const totalWrong = recs.reduce((s, r) => s + r.wrong, 0);
    const acc = totalCorrect + totalWrong ? Math.round(totalCorrect / (totalCorrect + totalWrong) * 100) : 0;
    const starred = Object.values(state.records).filter(r => r.starred).length;

    const chapterStats = SECTIONS.map(s => {
      const ids = activeIds().filter(id => (QMAP.get(id) || {}).section === s);
      let done = 0, c = 0, w = 0;
      ids.forEach(id => { const r = getRec(id); if (r && r.attempts) { done++; c += r.correct; w += r.wrong; } });
      return { section: s, total: ids.length, done, correct: c, wrong: w, rate: c + w ? Math.round(c / (c + w) * 100) : null };
    }).sort((a, b) => b.wrong - a.wrong || a.section.localeCompare(b.section));

    return `<div class="view">
      <section class="card">
        <div class="card-header"><div><h2>学习统计</h2><p>数据来自本机记录，按实际作答实时更新</p></div></div>
        <div class="stat-grid">
          <div class="stat-box"><span>已练习题目</span><b>${recs.length}</b></div>
          <div class="stat-box"><span>累计作答</span><b>${totalCorrect + totalWrong}</b></div>
          <div class="stat-box"><span>总正确率</span><b style="color:var(--success)">${acc}%</b></div>
          <div class="stat-box"><span>答错次数</span><b style="color:var(--danger)">${totalWrong}</b></div>
          <div class="stat-box"><span>待复习错题</span><b>${wrongIds().length}</b></div>
          <div class="stat-box"><span>收藏题目</span><b>${starred}</b></div>
        </div>
      </section>
      <section class="card">
        <div class="card-header"><div><h2>分章节掌握情况</h2><p>按错误次数排序，优先攻克薄弱章节</p></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>章节</th><th>题数</th><th>已练</th><th>正确</th><th>错误</th><th>正确率</th><th>掌握度</th></tr></thead>
          <tbody>${chapterStats.map(x => `<tr>
            <td class="nowrap"><b>${esc(x.section)}</b></td><td>${x.total}</td><td>${x.done}</td><td>${x.correct}</td>
            <td style="color:${x.wrong ? 'var(--danger)' : 'inherit'}">${x.wrong}</td><td>${x.rate === null ? '—' : x.rate + '%'}</td>
            <td style="min-width:130px"><div class="bar-row"><div class="bar-track"><i style="width:${x.total ? Math.round(x.done / x.total * 100) : 0}%"></i></div><span class="section-note">${x.total ? Math.round(x.done / x.total * 100) : 0}%</span></div></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </section>
    </div>`;
  }

  // 未答过的题（attempts 为 0）在列表中的位置，全部答过则返回 -1
  function firstUnansweredIdx(ids) {
    return ids.findIndex(id => !((state.records[id] || {}).attempts > 0));
  }

  // 从首页输入框指定题号开始顺序练习
  function startAtInput() {
    const inp = document.getElementById('startAtInput');
    const raw = (inp && inp.value || '').trim();
    const n = parseInt(raw, 10);
    if (!raw || !isFinite(n) || n < 1 || n > META.total) {
      toast(`请输入 1–${META.total} 之间的题号`);
      if (inp) inp.focus();
      return;
    }
    startSession('sequential', { from: n });
  }

  function startSession(mode, opts) {
    opts = opts || {};
    let ids = [], title = '';
    if (mode === 'sequential') ids = activeIds().slice();
    else if (mode === 'smart') ids = smartIds();
    else if (mode === 'random') ids = shuffle(activeIds().slice());
    else if (mode === 'chapter') {
      const sel = document.getElementById('chapterSelect');
      const section = opts.section || (sel && sel.value);
      if (!section) { toast('请先选择章节'); return; }
      title = section;
      ids = activeIds().filter(id => (QMAP.get(id) || {}).section === section);
    } else if (mode === 'wrong') ids = wrongIds();
    else if (mode === 'study') {
      const scope = opts.scope || ui.studyScope || 'all';
      ui.studyScope = scope;
      ids = opts.ids || studyIds(scope);
      if (!ids.length) { toast('该范围暂无题目，已切换到全部题目'); ui.studyScope = 'all'; ids = activeIds().slice(); }
    }
    else if (mode === 'review') ids = (opts.ids || (opts.id ? [opts.id] : [])).filter(id => !isTrashed(id));
    if (!ids.length) { toast(mode === 'wrong' ? '错题库暂无待复习题目' : '没有可练习的题目'); return; }
    let initialPos = 0;
    let jumpNote = '';
    if (mode === 'study' && !opts.ids && state.study) {
      initialPos = Math.min(Math.max(0, state.study.pos || 0), ids.length - 1);
    } else if (opts.from) {
      // 手动指定起始题号：按题目在题库中的序号查找，不在本轮范围则提示
      const idx = ids.findIndex(id => (QMAP.get(id) || {}).no === opts.from);
      if (idx < 0) { toast(`第 ${opts.from} 题不在本轮练习范围内`); return; }
      initialPos = idx;
    } else if (mode === 'sequential' || mode === 'smart' || mode === 'chapter') {
      // 系统刷题默认落到第一道还没答过的题
      const fu = firstUnansweredIdx(ids);
      if (fu > 0) {
        initialPos = fu;
        const q = QMAP.get(ids[fu]);
        jumpNote = `已跳到第 ${q ? q.no : fu + 1} 题（第一道未答过的题）`;
      }
    }
    ui.studyPage = 0;
    session = { mode, title, ids, pos: initialPos, selected: {}, submitted: {}, answers: {}, correct: 0, wrong: 0, skipped: 0, revealed: {} };
    view = 'practice';
    render();
    if (jumpNote) toast(jumpNote);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleOption(letter) {
    if (!session || session.pos >= session.ids.length) return;
    if (session.mode === 'study') return;
    const qid = session.ids[session.pos];
    if (session.submitted[qid]) return;
    const q = QMAP.get(qid);
    const cur = (session.selected[qid] || []).slice();
    if (q.type === 'single') {
      session.selected[qid] = [letter];
      render();
      if (autoSubmitTimer) clearTimeout(autoSubmitTimer);
      autoSubmitTimer = setTimeout(() => {
        autoSubmitTimer = null;
        if (!session || session.ids[session.pos] !== qid || session.submitted[qid]) return;
        submitAnswer();
      }, 220);
      return;
    }
    const i = cur.indexOf(letter);
    if (i >= 0) cur.splice(i, 1); else cur.push(letter);
    session.selected[qid] = LETTERS.filter(l => cur.includes(l));
    render();
  }

  function submitAnswer() {
    if (!session || session.pos >= session.ids.length) return;
    if (session.mode === 'study') return;
    const qid = session.ids[session.pos],
      q = QMAP.get(qid),
      sel = session.selected[qid] || [];
    if (!sel.length) { toast('请先选择答案'); return; }
    const correct = sel.length === (q.dispAnswer || []).length && sel.every(x => isRight(q, x));
    session.submitted[qid] = true;
    session.answers[qid] = sel.slice();
    if (correct) session.correct++; else session.wrong++;

    const rec = ensureRec(qid);
    const now = new Date().toISOString();
    rec.attempts++;
    rec.lastAt = now;
    rec.lastResult = correct ? 'correct' : 'wrong';
    if (correct) {
      rec.correct++;
      rec.streak = (rec.streak || 0) + 1;
      if (rec.wrongCount > 0 && rec.streak >= 2) {
        rec.resolved = true;
        rec.resolvedAt = now;
        toast('连续答对两次，本题已标记为已掌握');
      }
    } else {
      rec.wrong++;
      rec.streak = 0;
      rec.wrongCount = (rec.wrongCount || 0) + 1;
      rec.wrongAt = now;
      rec.resolved = false;
    }
    saveState();
    render();
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function exportJSON() {
    const payload = {
      app: 'B题库本地刷题', version: 1, exportedAt: new Date().toISOString(),
      records: state.records, study: state.study,
      marks: state.marks || {}, showMarks: state.showMarks !== false,
      marksVersion: 2,
      detailFlags: state.detailFlags || {},
      memos: state.memos || {}, answerMarks: state.answerMarks || {}, trash: state.trash || {}
    };
    download(`B类题库进度_${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    toast('进度备份已导出');
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.records || typeof data.records !== 'object') throw new Error('格式不符');
        let n = 0;
        Object.keys(data.records).forEach(id => {
          if (!QMAP.has(id)) return;
          const inc = data.records[id], cur = ensureRec(id);
          ['attempts', 'correct', 'wrong', 'wrongCount'].forEach(k => {
            cur[k] = Math.max(cur[k] || 0, inc[k] || 0);
          });
          ['wrongAt', 'lastAt', 'resolvedAt'].forEach(k => {
            if (inc[k] && (!cur[k] || new Date(inc[k]) > new Date(cur[k]))) cur[k] = inc[k];
          });
          cur.starred = cur.starred || !!inc.starred;
          cur.resolved = cur.resolved || !!inc.resolved;
          if (cur.wrongCount > 0 && !cur.wrongAt) cur.wrongAt = cur.lastAt;
          n++;
        });
        if (data.study && typeof data.study === 'object') {
          if (!state.study) state.study = { pos: 0, view: 'card', scope: 'all' };
          if (typeof data.study.pos === 'number') state.study.pos = Math.max(0, Math.floor(data.study.pos));
          if (data.study.view === 'card' || data.study.view === 'list') { state.study.view = data.study.view; ui.studyView = data.study.view; }
          if (['all', 'weak', 'starred'].includes(data.study.scope)) { state.study.scope = data.study.scope; ui.studyScope = data.study.scope; }
          if (STUDY_PAGE_SIZES.includes(data.study.pageSize)) { state.study.pageSize = data.study.pageSize; ui.studyPageSize = data.study.pageSize; }
        }
        if (data.marks && typeof data.marks === 'object' && !Array.isArray(data.marks)) {
          state.marks = {};
          Object.keys(data.marks).forEach(id => {
            if (!QMAP.has(id) || !Array.isArray(data.marks[id])) return;
            const len = (QMAP.get(id).question || '').length;
            const rng = normalizeRanges(data.marks[id], len);
            if (rng.length) state.marks[id] = rng;
          });
        }
        if (typeof data.showMarks === 'boolean') state.showMarks = data.showMarks;
        if (data.detailFlags && typeof data.detailFlags === 'object' && !Array.isArray(data.detailFlags)) {
          state.detailFlags = {};
          Object.keys(data.detailFlags).forEach(id => { if (QMAP.has(id) && data.detailFlags[id]) state.detailFlags[id] = true; });
        }
        if (data.memos && typeof data.memos === 'object' && !Array.isArray(data.memos)) {
          state.memos = {};
          Object.keys(data.memos).forEach(id => {
            const text = String(data.memos[id] || '').trim();
            if (QMAP.has(id) && text) state.memos[id] = text;
          });
        }
        if (data.answerMarks && typeof data.answerMarks === 'object' && !Array.isArray(data.answerMarks)) {
          state.answerMarks = {};
          Object.keys(data.answerMarks).forEach(id => {
            if (!QMAP.has(id)) return;
            const q = QMAP.get(id), byLetter = data.answerMarks[id], clean = {};
            if (!byLetter || typeof byLetter !== 'object') return;
            Object.keys(byLetter).forEach(letter => {
              const text = String(q.options[letter] || '');
              const rng = normalizeRanges(Array.isArray(byLetter[letter]) ? byLetter[letter] : [], text.length);
              if (rng.length) clean[letter] = rng;
            });
            if (Object.keys(clean).length) state.answerMarks[id] = clean;
          });
        }
        if (data.trash && typeof data.trash === 'object' && !Array.isArray(data.trash)) {
          state.trash = {};
          Object.keys(data.trash).forEach(id => { if (QMAP.has(id)) state.trash[id] = data.trash[id] || new Date().toISOString(); });
          if (session) session.ids = session.ids.filter(id => !isTrashed(id));
        }
        saveState();
        render();
        toast(`已导入 ${n} 条题目记录`);
      } catch (e) {
        toast('导入失败：文件不是有效的进度备份');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  function openWrongHTML() {
    const html = buildWrongHTML();
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const win = window.open(url, '_blank');
    if (!win) toast('浏览器阻止了弹窗，请改用“生成错题库网页”下载');
    else toast('错题库预览已在新标签页打开');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function buildWrongHTML() {
    const ids = filteredWrongIds();
    const rows = ids.map((id, i) => {
      const q = QMAP.get(id), r = getRec(id);
      const opts = dispLetters(q).map(l => `<div class="opt ${isRight(q, l) ? 'right' : ''}"><b>${l}</b><span>${esc(q.disp[l])}</span></div>`).join('');
      return `<article>
        <div class="qhead"><span>${i + 1}. ${questionTextHTML(q)}</span><span class="meta">${esc(q.id)} · 章节 ${esc(q.section)} · ${q.type === 'multiple' ? '多选' : '单选'} · 错 ${r.wrongCount} 次 · ${formatDate(r.wrongAt)}</span></div>
        ${q.figure ? `<img src="${figureSrc(q.figure)}" alt="题目附图">` : ''}
        <div class="opts">${opts}</div>
        <div class="ans">正确答案：<b>${esc(answerText(q))}</b></div>
        ${EXPLANATIONS[q.id] ? `<div class="exp">解析：${esc(EXPLANATIONS[q.id])}</div>` : ''}
      </article>`;
    }).join('');
    const title = ui.wrongFilter === 'active' ? '待复习错题' : ui.wrongFilter === 'mastered' ? '已掌握错题' : '全部错题';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>B类题库 · ${title}</title><style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1e293b;max-width:900px;margin:0 auto;padding:32px 20px;line-height:1.7;background:#fff}
h1{font-size:24px;margin:0 0 4px}.sub{color:#64748b;font-size:13px;margin:0 0 24px}
article{border-top:1px solid #e2e8f0;padding:18px 0;break-inside:avoid}
.qhead{font-weight:650;margin-bottom:10px}.qhead span{display:block}.meta{font-size:12px;color:#64748b;font-weight:400;margin-top:2px}
.opts{display:grid;gap:6px}.opt{display:flex;gap:10px;padding:7px 10px;border-radius:8px;background:#f8fafc}
.opt b{color:#64748b}.opt.right{background:#ecfdf5}.opt.right b{color:#059669}
.ans{margin-top:8px;color:#059669;font-size:14px}.exp{margin-top:6px;padding:8px 12px;background:#f5f3ff;border-left:3px solid #7c3aed;color:#4c1d95;border-radius:0 6px 6px 0;font-size:13px}.qmark{color:#dc2626;font-weight:700;background:#fee2e2;border-radius:3px}img{max-width:100%;max-height:320px;display:block;margin:10px 0;border:1px dashed #cbd5e1;border-radius:8px;padding:8px}
@media print{body{padding:0}h1{font-size:18px}}
</style></head><body>
<h1>B 类题库 · ${title}</h1>
<p class="sub">生成时间：${formatDate(new Date().toISOString())} · 共 ${ids.length} 题 · 答案已标注</p>
${rows || '<p>暂无错题</p>'}
</body></html>`;
  }

  document.addEventListener('click', e => {
    // 记忆标注弹窗：点击已标出的答案关键字取消该区间
    const ak = e.target.closest('.akey[data-letter]');
    if (ak && memoDraft) {
      const letter = ak.dataset.letter, s = Number(ak.dataset.s), en = Number(ak.dataset.e);
      const rest = (memoDraft.marks[letter] || []).filter(r => !(Number(r.s) === s && Number(r.e) === en));
      if (rest.length) memoDraft.marks[letter] = rest; else delete memoDraft.marks[letter];
      renderMemoBody(); toast('已取消该处关键点'); return;
    }
    // 点击已标记的红色文字：移除该题对应区间
    const mk = e.target.closest('.qmark');
    if (mk) {
      const qid = mk.dataset.qid, s = Number(mk.dataset.s), en = Number(mk.dataset.e);
      const before = getMarks(qid).length;
      const rest = getMarks(qid).filter(r => !(Number(r.s) === s && Number(r.e) === en));
      if (!state.marks) state.marks = {};
      state.marks[qid] = rest;
      if (!rest.length) delete state.marks[qid];
      saveState(); render();
      toast(before !== rest.length ? '已移除该处标记' : '标记未变化');
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'toggle-marks') {
      state.showMarks = state.showMarks === false;
      saveState(); render();
      toast(state.showMarks ? '题干标记已开启' : '题干标记已关闭（标记内容保留）');
      return;
    }
    if (action === 'toggle-others') {
      if (!session) return;
      const id = el.dataset.id || session.ids[session.pos];
      if (!session.othersOpen) session.othersOpen = {};
      session.othersOpen[id] = !session.othersOpen[id];
      render(); return;
    }
    if (action === 'toggle-expl') {
      if (!session) return;
      if (!session.explOpen) session.explOpen = {};
      // 以按钮上的当前状态取反，兼容"默认展开"的场景
      session.explOpen[el.dataset.id] = el.dataset.open !== '1';
      render(); return;
    }
    if (action === 'toggle-detail') {
      const id = el.dataset.id;
      if (!state.detailFlags) state.detailFlags = {};
      state.detailFlags[id] = !state.detailFlags[id];
      if (!state.detailFlags[id]) delete state.detailFlags[id];
      saveState(); render();
      toast(state.detailFlags[id] ? '已标注：需进一步解析' : '已取消标注');
      return;
    }
    if (action === 'memo-edit') { openMemo(el.dataset.id); return; }
    if (action === 'memo-close') { closeMemo(); return; }
    if (action === 'memo-save') { saveMemo(); return; }
    if (action === 'memo-clear') {
      if (!memoDraft) return;
      memoDraft.text = ''; memoDraft.marks = {}; renderMemoBody(); return;
    }
    if (action === 'copy-memo-list') { copyMemoList(); return; }
    if (action === 'trash-delete') { trashQuestion(el.dataset.id); return; }
    if (action === 'trash-restore') { restoreQuestion(el.dataset.id, false); return; }
    if (action === 'toggle-focus') { ui.focusMode = !ui.focusMode; render(); return; }
    if (action === 'study-skim') {
      startSession('study');
      ui.studyView = 'list'; ui.studyPage = 0;
      if (state.study) { state.study.view = 'list'; state.study.skimmed = true; saveState(); }
      render(); return;
    }
    if (action === 'study-view') {
      ui.studyView = el.dataset.view; ui.studyPage = 0;
      if (state.study) {
        state.study.view = ui.studyView;
        if (ui.studyView === 'list') state.study.skimmed = true;
        saveState();
      }
      render(); return;
    }
    if (action === 'study-scope') {
      ui.studyScope = el.dataset.scope; ui.studyPage = 0;
      if (state.study) { state.study.scope = ui.studyScope; state.study.pos = 0; saveState(); }
      startSession('study', { scope: ui.studyScope }); return;
    }
    if (action === 'study-reveal') {
      if (!session || session.mode !== 'study') return;
      session.revealed[session.ids[session.pos]] = true; render(); return;
    }
    if (action === 'study-page-prev') { setStudyPage(ui.studyPage - 1); render(); return; }
    if (action === 'study-page-next') { setStudyPage(ui.studyPage + 1); render(); return; }
    if (action === 'study-page-first') { setStudyPage(0); render(); return; }
    if (action === 'study-page-last') { setStudyPage(studyPageCount() - 1); render(); return; }
    if (action === 'study-page-goto') {
      const input = document.querySelector(`[data-page-input="${el.dataset.where}"]`);
      const val = parseInt(input && input.value, 10);
      if (Number.isFinite(val)) { setStudyPage(val - 1); render(); toast('已跳转到第 ' + (ui.studyPage + 1) + ' 页'); }
      return;
    }
    if (action === 'nav') { view = el.dataset.view; render(); }
    else if (action === 'start') startSession(el.dataset.mode, { section: el.dataset.section });
    else if (action === 'start-at') startAtInput();
    else if (action === 'toggle-option') toggleOption(el.dataset.letter);
    else if (action === 'submit') submitAnswer();
    else if (action === 'next') { if (autoSubmitTimer) { clearTimeout(autoSubmitTimer); autoSubmitTimer = null; } session.pos++; if (session.mode === 'study') saveStudyPos(); render(); }
    else if (action === 'prev') { if (autoSubmitTimer) { clearTimeout(autoSubmitTimer); autoSubmitTimer = null; } session.pos = Math.max(0, session.pos - 1); if (session.mode === 'study') saveStudyPos(); render(); }
    else if (action === 'skip') { if (autoSubmitTimer) { clearTimeout(autoSubmitTimer); autoSubmitTimer = null; } session.skipped++; session.pos++; render(); }
    else if (action === 'star') {
      if (!session || session.pos >= session.ids.length) return;
      const rec = ensureRec(session.ids[session.pos]);
      rec.starred = !rec.starred;
      saveState(); render();
      toast(rec.starred ? '已收藏本题' : '已取消收藏');
    }
    else if (action === 'wrong-filter') { ui.wrongFilter = el.dataset.filter; render(); }
    else if (action === 'review-wrong' || action === 'review-result') startSession('review', { id: el.dataset.id });
    else if (action === 'remove-wrong') {
      const rec = getRec(el.dataset.id);
      if (rec) { rec.resolved = true; rec.resolvedAt = new Date().toISOString(); saveState(); render(); toast('已移出错题库（标记为已掌握）'); }
    }
    else if (action === 'restore-wrong') {
      const rec = getRec(el.dataset.id);
      if (rec) { rec.resolved = false; rec.streak = 0; rec.wrongAt = new Date().toISOString(); saveState(); render(); toast('已恢复到待复习'); }
    }
    else if (action === 'clear-wrong') {
      if (!confirm('确定清空错题库吗？其他作答统计不会删除。')) return;
      Object.values(state.records).forEach(r => { r.wrongCount = 0; r.wrongAt = null; r.resolved = false; r.streak = 0; });
      saveState(); render(); toast('错题库已清空');
    }
    else if (action === 'reset-progress') {
      if (!confirm('确定清空全部进度、错题与收藏吗？此操作不可撤销。')) return;
      state = { records: {}, study: { pos: 0, view: 'card', scope: 'all', pageSize: ui.studyPageSize }, marks: {}, showMarks: true, detailFlags: {}, marksVersion: 2, memos: {}, answerMarks: {}, trash: {}, updatedAt: null };
      ui.studyView = 'card'; ui.studyScope = 'all'; ui.studyPage = 0;
      session = null; saveState(); render(); toast('全部进度已清空');
    }
    else if (action === 'export-json') exportJSON();
    else if (action === 'copy-flag-list') {
      const list = QUESTIONS.filter(q => state.detailFlags && state.detailFlags[q.id])
        .map(q => `${q.id}\t第${q.no}题\t${q.question.replace(/\s+/g, ' ')}`)
        .join('\n');
      const done = () => toast('标注清单已复制，粘贴给助手即可');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(list).then(done).catch(() => { download('标注清单.txt', list, 'text/plain'); toast('已下载 标注清单.txt'); });
      } else {
        download('标注清单.txt', list, 'text/plain'); toast('已下载 标注清单.txt');
      }
    }
    else if (action === 'import-json') document.getElementById('importInput').click();
    else if (action === 'export-html') { download(`B类错题库_${stamp()}.html`, buildWrongHTML(), 'text/html;charset=utf-8'); toast('错题库网页已生成'); }
    else if (action === 'preview-html') openWrongHTML();
    else if (action === 'completion-home') { view = 'home'; session = null; render(); }
    else if (action === 'completion-wrong') { view = 'wrong'; session = null; render(); }
    else if (action === 'completion-retry') { const mode = session.mode, title = session.title, ids = session.ids.slice(); startSession(mode, { section: title, ids }); }
  });

  document.addEventListener('change', e => {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    const change = el.dataset.change;
    if (change === 'study-page-size-change') {
      const firstId = (session && session.ids[ui.studyPage * studySize()]) || null;
      const raw = el.value;
      ui.studyPageSize = raw === 'all' ? 'all' : parseInt(raw, 10);
      if (!STUDY_PAGE_SIZES.includes(ui.studyPageSize)) ui.studyPageSize = DEFAULT_STUDY_PAGE_SIZE;
      // 尽量停留在当前所在题目
      let targetPage = 0;
      if (firstId) {
        const idx = session.ids.indexOf(firstId);
        if (idx >= 0) targetPage = Math.floor(idx / studySize());
      }
      setStudyPage(targetPage);
      if (state.study) { state.study.pageSize = ui.studyPageSize; saveStudyPos(); }
      render();
      toast('每页显示已切换为 ' + (ui.studyPageSize === 'all' ? '全部题目' : ui.studyPageSize + ' 题'));
    } else if (change === 'study-page-jump-select') {
      setStudyPage(parseInt(el.value, 10) || 0);
      render();
    }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'wrongQueryInput') {
      ui.wrongQuery = e.target.value;
      const body = document.getElementById('wrongBody');
      if (body) body.innerHTML = wrongRowsHTML();
    } else if (e.target.id === 'trashQueryInput') {
      ui.trashQuery = e.target.value;
      const card = e.target.closest('.card');
      if (card) {
        const kw = ui.trashQuery.trim().toLowerCase();
        const candidates = activeIds().map(id => QMAP.get(id)).filter(q => {
          if (!kw) return true;
          return [q.no, q.id, q.bankId, q.question, ...LETTERS.map(l => q.options[l])].join(' ').toLowerCase().includes(kw);
        }).slice(0, 60);
        const box = card.querySelector('.manage-list');
        if (box) box.innerHTML = candidates.map(q => `<div class="manage-row">
          <span class="manage-title">${qNoHTML(q)} ${esc(q.question)}</span>
          <button class="btn small danger" data-action="trash-delete" data-id="${esc(q.id)}">移入回收站</button>
        </div>`).join('');
      }
    } else if (e.target.id === 'searchInput') {
      ui.searchQuery = e.target.value;
      const kw = ui.searchQuery.trim().toLowerCase();
      const results = kw ? activeIds().map(id => QMAP.get(id)).filter(q => {
        const hay = [q.id, q.bankId, q.section, q.question, ...LETTERS.map(l => q.options[l])].join(' ').toLowerCase();
        return hay.includes(kw);
      }).slice(0, 80) : [];
      const box = document.getElementById('searchResults');
      if (box) box.innerHTML = searchResultsHTML(results, ui.searchQuery);
    }
  });

  document.getElementById('importInput').addEventListener('change', e => {
    if (e.target.files && e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value = '';
  });

  // ===== 记忆标注编辑弹窗 =====
  const memoModal = document.getElementById('memoModal');
  let memoDraft = null; // {qid, text, marks:{原始字母:[{s,e}]}}

  function openMemo(qid) {
    const q = QMAP.get(qid);
    if (!q || !memoModal) return;
    memoDraft = {
      qid: qid,
      text: memoText(qid),
      marks: JSON.parse(JSON.stringify((state.answerMarks && state.answerMarks[qid]) || {}))
    };
    const noEl = document.getElementById('memoNo');
    if (noEl) noEl.textContent = q.no;
    renderMemoBody();
    memoModal.hidden = false;
    document.body.classList.add('modal-open');
  }

  function closeMemo() {
    memoDraft = null;
    if (memoModal) memoModal.hidden = true;
    document.body.classList.remove('modal-open');
    if (markToolbarEl) markToolbarEl.hidden = true;
  }

  function renderMemoBody() {
    if (!memoDraft || !memoModal) return;
    const q = QMAP.get(memoDraft.qid);
    const rows = dispLetters(q).filter(dl => isRight(q, dl)).map(dl => `
      <div class="akey-row">
        <span class="akey-letter">${dl}</span>
        <div class="akey-text" data-answer-host="${esc(q.dispMap[dl])}" data-answer-qid="${esc(q.id)}">${answerMarkedHTML(q, dl, true, memoDraft.marks[q.dispMap[dl]] || [])}</div>
      </div>`).join('');
    const body = document.getElementById('memoBody');
    body.innerHTML = `
      <label class="memo-label" for="memoTextInput">记忆口诀 / 提醒</label>
      <textarea id="memoTextInput" class="memo-textarea" rows="4" placeholder="例如：只有“XXX”是错的；选项关键字记忆——开头是：双，结尾是：绝">${esc(memoDraft.text)}</textarea>
      <p class="memo-help">写给自己看的提示即可，不一定要完整句子。</p>
      <label class="memo-label">答案记忆关键点 <small>在下面正确答案上划选文字，再点「标为记忆关键」</small></label>
      <div class="akey-list">${rows}</div>
      <p class="memo-help">已标出的关键字再点一下即可取消。</p>`;
    const ta = document.getElementById('memoTextInput');
    if (ta) { ta.value = memoDraft.text; ta.addEventListener('input', () => { if (memoDraft) memoDraft.text = ta.value; }); }
  }

  function saveMemo() {
    if (!memoDraft) return;
    const qid = memoDraft.qid, q = QMAP.get(qid);
    const ta = document.getElementById('memoTextInput');
    const text = String((ta && ta.value != null ? ta.value : memoDraft.text) || '').trim();
    if (!state.memos) state.memos = {};
    if (text) state.memos[qid] = text; else delete state.memos[qid];
    if (!state.answerMarks) state.answerMarks = {};
    const clean = {};
    Object.keys(memoDraft.marks || {}).forEach(letter => {
      const full = String((q.options || {})[letter] || '');
      const rng = normalizeRanges(memoDraft.marks[letter], full.length);
      if (rng.length) clean[letter] = rng;
    });
    if (Object.keys(clean).length) state.answerMarks[qid] = clean; else delete state.answerMarks[qid];
    saveState();
    closeMemo();
    render();
    toast(text || Object.keys(clean).length ? '记忆标注已保存' : '记忆标注已清空');
  }

  if (memoModal) {
    memoModal.addEventListener('click', e => { if (e.target === memoModal) closeMemo(); });
  }

  // ===== 题干标记交互：选中题干文字后弹出工具条 =====
  let markSel = null; // {qid, s, e} 或 {qid, letter, s, e, type:'answer'}
  let suppressHide = false; // 手指点在工具条上时不要因选区收起而误关工具条（移动端必备）
  let suppressTimer = null;
  const markToolbarEl = document.getElementById('markToolbar');

  function keepToolbar() {
    suppressHide = true;
    if (suppressTimer) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppressHide = false; }, 900);
  }

  function hideMarkToolbar() {
    if (markToolbarEl) markToolbarEl.hidden = true;
    markSel = null;
  }

  function onSelectionChange() {
    if (!markToolbarEl) return;
    if (suppressHide) return; // 正在点工具条，保留当前选区与工具条
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideMarkToolbar(); return; }
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType !== 1) node = node.parentElement;
    const answerHost = node && node.closest ? node.closest('[data-answer-host]') : null;
    const qHost = node && node.closest ? node.closest('[data-qmark-host]') : null;
    const host = answerHost || qHost;
    if (!host) { hideMarkToolbar(); return; }
    // 题干标记只在练习视图生效；答案关键点只在记忆标注弹窗内生效
    if (answerHost ? !memoDraft : (view !== 'practice' || !session)) { hideMarkToolbar(); return; }
    // 确保选区起止都在同一容器内
    const endNode = range.endContainer.nodeType !== 1 ? range.endContainer.parentElement : range.endContainer;
    if (!endNode || !host.contains(range.endContainer)) { hideMarkToolbar(); return; }
    const off = selectionOffsets(host);
    if (!off) { hideMarkToolbar(); return; }
    if (answerHost) markSel = { qid: host.dataset.answerQid, letter: host.dataset.answerHost, s: off.s, e: off.e, type: 'answer' };
    else markSel = { qid: host.dataset.qmarkHost, s: off.s, e: off.e, type: 'question' };
    const hint = markToolbarEl.querySelector('.mt-hint');
    if (hint) hint.textContent = `已选中 ${off.e - off.s} 字`;
    const addBtn = markToolbarEl.querySelector('[data-mark-action="add"]');
    if (addBtn) addBtn.textContent = answerHost ? '标为记忆关键' : '标红关键内容';
    markToolbarEl.hidden = false;
    // 定位到选区下方；下方放不开时改为选区上方，避免被屏幕边缘截断
    try {
      const rect = range.getBoundingClientRect();
      const mw = markToolbarEl.offsetWidth || 260;
      const mh = markToolbarEl.offsetHeight || 44;
      const vw = window.innerWidth || 800;
      const vh = window.innerHeight || 800;
      let left = rect.left + rect.width / 2 - mw / 2;
      left = Math.max(8, Math.min(left, vw - mw - 8));
      let top = rect.bottom + 10;
      if (top + mh > vh - 8) top = Math.max(8, rect.top - mh - 10);
      markToolbarEl.style.left = left + 'px';
      markToolbarEl.style.top = top + 'px';
    } catch (e) { markToolbarEl.style.left = '12px'; markToolbarEl.style.top = '12px'; }
  }

  if (markToolbarEl) {
    // 桌面：阻止 mousedown 抢走焦点；移动端：手指按下时冻结选区收起逻辑
    markToolbarEl.addEventListener('mousedown', e => { e.preventDefault(); keepToolbar(); });
    markToolbarEl.addEventListener('touchstart', () => { keepToolbar(); }, { passive: true });
    markToolbarEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-mark-action]');
      if (!btn) return;
      const action = btn.dataset.markAction;
      if (action === 'cancel') { suppressHide = false; hideMarkToolbar(); const s = window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges(); return; }
      if (action === 'add' && markSel) {
        if (markSel.type === 'answer') {
          if (!memoDraft || memoDraft.qid !== markSel.qid) { hideMarkToolbar(); return; }
          const q = QMAP.get(markSel.qid);
          const full = String((q.options || {})[markSel.letter] || '');
          const cur = memoDraft.marks[markSel.letter] || [];
          memoDraft.marks[markSel.letter] = normalizeRanges(cur.concat([{ s: markSel.s, e: markSel.e }]), full.length);
          const s = window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges();
          suppressHide = false; hideMarkToolbar(); renderMemoBody();
          toast('已标记为答案记忆关键点');
          return;
        }
        if (!state.marks) state.marks = {};
        const next = getMarks(markSel.qid).concat([{ s: markSel.s, e: markSel.e }]);
        state.marks[markSel.qid] = normalizeRanges(next, (QMAP.get(markSel.qid) || {}).question?.length || 1e9);
        state.showMarks = true; // 标红后自动确保可见
        saveState();
        const s = window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges();
        suppressHide = false;
        hideMarkToolbar(); render();
        toast('已标红关键内容');
      }
    });
  }
  document.addEventListener('mouseup', () => { setTimeout(onSelectionChange, 0); });
  document.addEventListener('touchend', () => { setTimeout(onSelectionChange, 150); });
  document.addEventListener('selectionchange', () => { setTimeout(onSelectionChange, 0); });

  // 首页起始题号输入框：回车即开始
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (t && t.id === 'startAtInput') { e.preventDefault(); startAtInput(); }
  });

  document.addEventListener('keydown', e => {
    if (view !== 'practice' || !session || session.pos >= session.ids.length) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if (session.mode === 'study') {
      if (ui.studyView === 'list') {
        if (k === ' ' || k === 'enter' || k === 'arrowright') { e.preventDefault(); ui.studyPage = Math.min(studyPageCount() - 1, ui.studyPage + 1); render(); }
        else if (k === 'arrowleft') { e.preventDefault(); ui.studyPage = Math.max(0, ui.studyPage - 1); render(); }
        return;
      }
      const qid = session.ids[session.pos];
      if (k === ' ' || k === 'enter') {
        e.preventDefault();
        if (!session.revealed[qid]) { session.revealed[qid] = true; render(); }
        else if (session.pos < session.ids.length - 1) { session.pos++; saveStudyPos(); render(); }
      } else if (k === 'arrowright') {
        e.preventDefault();
        if (session.pos < session.ids.length - 1) { session.pos++; saveStudyPos(); render(); }
      } else if (k === 'arrowleft') {
        e.preventDefault(); session.pos = Math.max(0, session.pos - 1); saveStudyPos(); render();
      }
      return;
    }
    const idx = LETTERS.indexOf(k.toUpperCase());
    if (idx >= 0) { e.preventDefault(); toggleOption(LETTERS[idx]); }
    else if (k === 'enter') { e.preventDefault(); if (!session.submitted[session.ids[session.pos]]) submitAnswer(); else { session.pos++; render(); } }
    else if (k === 'arrowright') { e.preventDefault(); if (session.pos < session.ids.length - 1) { session.pos++; render(); } }
    else if (k === 'arrowleft') { e.preventDefault(); session.pos = Math.max(0, session.pos - 1); render(); }
  });

  render();
})();
