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
  const INLINE_IMAGES = window.QUESTION_IMAGES || {};
  function figureSrc(name) {
    return INLINE_IMAGES[name] || ('images/' + encodeURIComponent(name));
  }

  let state = loadState();
  let session = null;
  let view = 'home';
  let autoSubmitTimer = null;
  const STUDY_PAGE_SIZES = [10, 20, 50, 100, 'all'];
  const DEFAULT_STUDY_PAGE_SIZE = 20;
  const ui = {
    wrongFilter: 'active', wrongQuery: '', searchQuery: '',
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
          return parsed;
        }
      }
    } catch (e) { /* 存储不可用时退回内存 */ }
    return { records: {}, study: { pos: 0, view: 'card', scope: 'all' }, updatedAt: null };
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
      .filter(id => QMAP.has(id) && state.records[id].wrongCount > 0 && !state.records[id].resolved)
      .sort((a, b) => new Date(state.records[b].wrongAt || 0) - new Date(state.records[a].wrongAt || 0));
  }

  function masteredIds() {
    return Object.keys(state.records)
      .filter(id => QMAP.has(id) && state.records[id].wrongCount > 0 && state.records[id].resolved)
      .sort((a, b) => new Date(state.records[b].lastAt || 0) - new Date(state.records[a].lastAt || 0));
  }

  // 智能练习：连续答对 2 次及以上视为已掌握，自动跳过
  function isMastered(id) { return ((state.records[id] || {}).streak || 0) >= 2; }
  function smartIds() { return ALL_IDS.filter(id => !isMastered(id)); }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
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

  function answerText(q) { return q.answer.join(''); }

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
      <span class="meta-chip">总题数 <b>${META.total}</b></span>
      <span class="meta-chip">单选 <b>${META.single}</b></span>
      <span class="meta-chip">多选 <b>${META.multiple}</b></span>
      <span class="meta-chip">已练 <b>${attempted}</b></span>`;
    document.getElementById('navWrongCount').textContent = wrongIds().length;
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
  }

  function renderHome() {
    const recs = Object.values(state.records);
    const attempted = recs.filter(r => (r.attempts || 0) > 0).length;
    const totalAns = recs.reduce((s, r) => s + (r.attempts || 0), 0);
    const totalCorrect = recs.reduce((s, r) => s + (r.correct || 0), 0);
    const acc = totalAns ? Math.round(totalCorrect / totalAns * 100) : null;
    const wrongN = wrongIds().length;
    const everWrong = recs.filter(r => (r.wrongCount || 0) > 0).length;
    const masteredN = ALL_IDS.length - smartIds().length;
    const skimmed = !!(state.study && state.study.skimmed);

    const s1 = skimmed ? 'done' : (attempted ? 'todo' : 'active');
    const s2 = attempted >= META.total ? 'done' : (attempted ? 'active' : 'todo');
    const s3 = (everWrong && !wrongN) ? 'done' : (wrongN ? 'active' : 'todo');
    const s4 = (s1 === 'done' && s2 === 'done' && s3 === 'done') ? 'active' : 'todo';

    let recN = 1;
    if (skimmed) recN = 2;
    if (attempted >= META.total) recN = wrongN ? 3 : 4;
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
          <div><span>已练题目</span><b>${attempted} / ${META.total}</b></div>
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
        ${step(1, s1, '速览一遍 · 建立印象', '一页 20 题滚动看题干和答案，只求眼熟、不求记住。先扫一遍，后面刷题会快很多。', `共 ${Math.ceil(META.total / 20)} 页 · ${skimmed ? '已开始' : '未开始'}`, `
          <button class="btn primary" data-action="study-skim">进入速览 →</button>
          <button class="btn" data-action="start" data-mode="study">卡片背题</button>`)}
        ${step(2, s2, '系统刷题 · 主力', '智能练习自动跳过已掌握的题，只练还没拿下的。单选点一下自动提交，多选选完提交；答错自动进错题库。', `已练 ${attempted} 题 · 正确率 ${acc === null ? '—' : acc + '%'}`, `
          <button class="btn primary" data-action="start" data-mode="smart">智能练习 →</button>
          <button class="btn" data-action="start" data-mode="sequential">完整顺序</button>`)}
        ${step(3, s3, '清空错题 · 剔除不会的', '只练错题库里的题，连续答对两次自动标记“已掌握”并移出。这样剔除可靠，不会把蒙对的当会做。', `待复习 ${wrongN} 题 · 曾错 ${everWrong} 题`, `
          <button class="btn ${wrongN ? 'primary' : ''}" data-action="start" data-mode="wrong" ${wrongN ? '' : 'disabled'}>${wrongN ? '错题重练 →' : '暂无错题'}</button>`)}
        ${step(4, s4, '考前巩固 · 随机检验', '随机打乱全库检验真实水平，再用速览快速回顾错题和收藏。答案顺序不变，刷题时形成的眼熟感这时最管用。', `全库 ${META.total} 题随机`, `
          <button class="btn primary" data-action="start" data-mode="random">随机练习 →</button>
          <button class="btn" data-action="study-skim">速览回顾</button>`)}
      </div>

      <section class="card">
        <div class="card-header"><div><h2>按需工具</h2><p>不在主路线上，需要时再用</p></div></div>
        <div class="btn-row">
          <button class="btn" data-action="nav" data-view="search">题目检索</button>
          <button class="btn" data-action="nav" data-view="stats">学习统计</button>
          <button class="btn" data-action="nav" data-view="wrong">错题库</button>
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
    const optionsHTML = LETTERS.map(letter => {
      let cls = 'option';
      if (selected.includes(letter)) cls += ' selected';
      if (submitted) {
        cls += ' locked';
        const isAnswer = q.answer.includes(letter);
        const isSelected = selected.includes(letter);
        if (isAnswer) cls += ' is-answer';
        if (isAnswer && isSelected) cls += ' is-correct';
        else if (isAnswer && !isSelected) cls += ' is-missed';
        else if (!isAnswer && isSelected) cls += ' is-wrong';
      }
      const mark = submitted && q.answer.includes(letter)
        ? `<span class="answer-flag">✓ 正确答案</span>` : '';
      return `<button class="${cls}" data-action="toggle-option" data-letter="${letter}" ${submitted ? 'disabled' : ''}>
        <span class="letter">${letter}</span><span class="body">${esc(q.options[letter])}${mark}</span>
      </button>`;
    }).join('');

    let feedbackHTML = '';
    if (submitted) {
      const correct = selected.length === q.answer.length && selected.every(x => q.answer.includes(x));
      const answerTexts = q.answer.map(l => `${l}. ${q.options[l]}`).join('　');
      feedbackHTML = `<div class="feedback ${correct ? 'ok' : 'no'}">
        <strong>${correct ? '✓ 回答正确' : '✕ 回答错误'}</strong>
        <p>正确答案：<span class="answer-line">${esc(answerText(q))}</span>　<span class="answer-text">${esc(answerTexts)}</span></p>
        ${correct ? '<p>本题已计入正确统计。</p>' : '<p>本题已自动加入错题库，可在“错题重练”中复习。</p>'}
      </div>`;
    }

    return `<div class="view">
      <section class="card practice-bar">
        <div class="practice-bar-top">
          <h2>${esc(modeNames[session.mode] || '练习')}</h2>
          <div class="tag-row">
            <span class="tag blue">第 ${session.pos + 1} / ${session.ids.length} 题</span>
            <span class="tag">本轮正确 ${session.correct}</span>
            <span class="tag red">本轮错误 ${session.wrong}</span>
            <button class="star-btn ${rec && rec.starred ? 'on' : ''}" data-action="star" title="收藏本题">★</button>
            <button class="fold-btn" data-action="toggle-focus" title="折叠/展开顶部内容">${ui.focusMode ? '展开上方 ▾' : '折叠上方 ▴'}</button>
          </div>
        </div>
        <div class="progress"><i style="width:${percent}%"></i></div>
      </section>
      <section class="card question-card">
        <div class="tag-row" style="margin-bottom:10px">
          <span class="tag blue">${esc(q.id)}</span>
          <span class="tag">章节 ${esc(q.section)}</span>
          <span class="type-badge ${isMulti ? 'multi' : 'single'}">${isMulti ? '☑ 多选题 · 可多选，全部选对才得分' : '◉ 单选题 · 点击选项自动提交'}</span>
          ${q.bankId ? `<span class="tag">题库编号 ${esc(q.bankId)}</span>` : ''}
          ${rec && rec.wrongCount ? `<span class="tag red">历史错误 ${rec.wrongCount} 次</span>` : ''}
        </div>
        <div class="question-text">${esc(q.question)}</div>
        ${q.figure ? `<div class="figure-wrap"><img src="${figureSrc(q.figure)}" alt="题目附图"></div>` : ''}
        <div class="options no-letter">${optionsHTML}</div>
        ${feedbackHTML}
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
      return ALL_IDS.filter(id => set.has(id));
    }
    return ALL_IDS.slice();
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

    const optionsHTML = LETTERS.map(letter => {
      const isAnswer = q.answer.includes(letter);
      const cls = 'option locked' + (isAnswer ? ' is-answer is-correct' : '');
      const mark = isAnswer ? `<span class="answer-flag">✓ 正确答案</span>` : '';
      return `<div class="${cls}"><span class="letter">${letter}</span><span class="body">${esc(q.options[letter])}${mark}</span></div>`;
    }).join('');
    const answerTexts = q.answer.map(l => `${l}. ${q.options[l]}`).join('　');

    return `<section class="card question-card study-card">
      <div class="tag-row" style="margin-bottom:10px">
        <span class="tag blue">${esc(q.id)}</span>
        <span class="tag">章节 ${esc(q.section)}</span>
        <span class="type-badge ${isMulti ? 'multi' : 'single'}">${isMulti ? '☑ 多选题' : '◉ 单选题'}</span>
        ${q.bankId ? `<span class="tag">题库编号 ${esc(q.bankId)}</span>` : ''}
        <button class="star-btn ${rec && rec.starred ? 'on' : ''}" data-action="star" title="收藏本题">★</button>
      </div>
      <div class="question-text">${esc(q.question)}</div>
      ${q.figure ? `<div class="figure-wrap"><img src="${figureSrc(q.figure)}" alt="题目附图"></div>` : ''}
      ${revealed
        ? `<div class="options">${optionsHTML}</div>
           <div class="feedback ok study-answer">
             <strong>正确答案：<span class="answer-line">${esc(answerText(q))}</span></strong>
             <p class="answer-text">${esc(answerTexts)}</p>
           </div>`
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
      const answerTexts = q.answer.map(l => `${l}. ${q.options[l]}`).join('　');
      const isMulti = q.type === 'multiple';
      return `<article class="study-list-item">
        <div class="study-list-head">
          <span class="tag blue">${start + i + 1}</span>
          <span class="tag">${esc(q.id)}</span>
          <span class="type-badge ${isMulti ? 'multi' : 'single'}">${isMulti ? '☑ 多选' : '◉ 单选'}</span>
          <span class="tag">章节 ${esc(q.section)}</span>
        </div>
        <div class="study-list-q">${esc(q.question)}</div>
        ${q.figure ? `<img class="study-list-fig" src="${figureSrc(q.figure)}" alt="题目附图">` : ''}
        <div class="study-list-a"><b>答案 ${esc(answerText(q))}</b>　${esc(answerTexts)}</div>
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

  function renderSearch() {
    const kw = ui.searchQuery.trim();
    let results = [];
    if (kw) {
      const lower = kw.toLowerCase();
      results = QUESTIONS.filter(q => {
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
        <span class="r-title">${esc(q.question)}</span>
        <span class="tag blue">${esc(q.id)}</span><span class="tag">${esc(q.section)}</span>
        <span class="tag ${q.type === 'multiple' ? 'amber' : ''}">${q.type === 'multiple' ? '多选' : '单选'}</span>
      </div>
      <div class="r-snippet">${esc(LETTERS.map(l => l + '. ' + q.options[l]).join('　'))}</div>
    </div>`).join('');
  }

  function renderStats() {
    const recs = Object.values(state.records).filter(r => r.attempts > 0);
    const totalCorrect = recs.reduce((s, r) => s + r.correct, 0);
    const totalWrong = recs.reduce((s, r) => s + r.wrong, 0);
    const acc = totalCorrect + totalWrong ? Math.round(totalCorrect / (totalCorrect + totalWrong) * 100) : 0;
    const starred = Object.values(state.records).filter(r => r.starred).length;

    const chapterStats = SECTIONS.map(s => {
      const ids = QUESTIONS.filter(q => q.section === s).map(q => q.id);
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

  function startSession(mode, opts) {
    opts = opts || {};
    let ids = [], title = '';
    if (mode === 'sequential') ids = ALL_IDS.slice();
    else if (mode === 'smart') ids = smartIds();
    else if (mode === 'random') ids = shuffle(ALL_IDS.slice());
    else if (mode === 'chapter') {
      const sel = document.getElementById('chapterSelect');
      const section = opts.section || (sel && sel.value);
      if (!section) { toast('请先选择章节'); return; }
      title = section;
      ids = QUESTIONS.filter(q => q.section === section).map(q => q.id);
    } else if (mode === 'wrong') ids = wrongIds();
    else if (mode === 'study') {
      const scope = opts.scope || ui.studyScope || 'all';
      ui.studyScope = scope;
      ids = opts.ids || studyIds(scope);
      if (!ids.length) { toast('该范围暂无题目，已切换到全部题目'); ui.studyScope = 'all'; ids = ALL_IDS.slice(); }
    }
    else if (mode === 'review') ids = opts.ids || (opts.id ? [opts.id] : []);
    if (!ids.length) { toast(mode === 'wrong' ? '错题库暂无待复习题目' : '没有可练习的题目'); return; }
    let initialPos = 0;
    if (mode === 'study' && !opts.ids && state.study) {
      initialPos = Math.min(Math.max(0, state.study.pos || 0), ids.length - 1);
    }
    ui.studyPage = 0;
    session = { mode, title, ids, pos: initialPos, selected: {}, submitted: {}, answers: {}, correct: 0, wrong: 0, skipped: 0, revealed: {} };
    view = 'practice';
    render();
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
    const correct = sel.length === q.answer.length && sel.every(x => q.answer.includes(x));
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
      records: state.records, study: state.study
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
      const opts = LETTERS.map(l => `<div class="opt ${q.answer.includes(l) ? 'right' : ''}"><b>${l}</b><span>${esc(q.options[l])}</span></div>`).join('');
      return `<article>
        <div class="qhead"><span>${i + 1}. ${esc(q.question)}</span><span class="meta">${esc(q.id)} · 章节 ${esc(q.section)} · ${q.type === 'multiple' ? '多选' : '单选'} · 错 ${r.wrongCount} 次 · ${formatDate(r.wrongAt)}</span></div>
        ${q.figure ? `<img src="${figureSrc(q.figure)}" alt="题目附图">` : ''}
        <div class="opts">${opts}</div>
        <div class="ans">正确答案：<b>${esc(answerText(q))}</b></div>
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
.ans{margin-top:8px;color:#059669;font-size:14px}img{max-width:100%;max-height:320px;display:block;margin:10px 0;border:1px dashed #cbd5e1;border-radius:8px;padding:8px}
@media print{body{padding:0}h1{font-size:18px}}
</style></head><body>
<h1>B 类题库 · ${title}</h1>
<p class="sub">生成时间：${formatDate(new Date().toISOString())} · 共 ${ids.length} 题 · 答案已标注</p>
${rows || '<p>暂无错题</p>'}
</body></html>`;
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
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
      state = { records: {}, study: { pos: 0, view: 'card', scope: 'all', pageSize: ui.studyPageSize }, updatedAt: null };
      ui.studyView = 'card'; ui.studyScope = 'all'; ui.studyPage = 0;
      session = null; saveState(); render(); toast('全部进度已清空');
    }
    else if (action === 'export-json') exportJSON();
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
    } else if (e.target.id === 'searchInput') {
      ui.searchQuery = e.target.value;
      const kw = ui.searchQuery.trim().toLowerCase();
      const results = kw ? QUESTIONS.filter(q => {
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
