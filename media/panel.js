// @ts-check
/* global acquireVsCodeApi */
(function () {
  // @ts-ignore provided by the webview host
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const tooltip = /** @type {HTMLElement} */ (document.getElementById('tooltip'));
  const UNKNOWN = '?';
  const ALL = '*';
  const RECORDS_DAYS = 7;
  const TOP_PROJECTS = 8;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** @typedef {{hour:number, project:string, account:string, model:string, effort:string, cost:number, input:number, output:number, cacheWrite:number, cacheRead:number, messages:number}} Rec */
  /** @typedef {{start:number, end:number, state:'past'|'today'|'future', used?:number, allowance?:number, partial:boolean}} QuotaDay */

  let state = vscode.getState() || {};
  /** @type {any} */
  let data = null;

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'loading') {
      app.classList.add('loading');
    } else if (msg.type === 'data') {
      data = msg.data;
      app.classList.remove('loading');
      app.classList.add('has-data');
      render();
    }
  });
  new ResizeObserver(() => data && renderCharts()).observe(document.body);
  vscode.postMessage({ type: 'ready' });

  // ---------- helpers ----------

  /** @param {string} tag @param {Record<string, any>} [attrs] @param {...any} children */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /** @param {string} tag @param {Record<string, any>} [attrs] */
  function s(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    return el;
  }

  const full = new Intl.NumberFormat('es');
  const pctFmt = (/** @type {number} */ n) => `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}%`;
  const dayFmt = new Intl.DateTimeFormat('es', { weekday: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });
  const dateTimeFmt = new Intl.DateTimeFormat('es', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  /** @param {number} ms */
  function when(ms) {
    const d = new Date(ms);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return `hoy ${timeFmt.format(d)}`;
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return `mañana ${timeFmt.format(d)}`;
    return dateTimeFmt.format(d);
  }

  /** @param {number} ms */
  function ago(ms) {
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    const hours = Math.round(min / 60);
    return hours < 48 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} días`;
  }

  /** @param {{pct:number, resetsAt?:number}|undefined} w */
  function effectivePct(w) {
    if (!w) return undefined;
    return w.resetsAt !== undefined && w.resetsAt <= Date.now() ? 0 : w.pct;
  }

  function accountColor(/** @type {string} */ id) {
    if (id === UNKNOWN) return 'var(--s-unknown)';
    const i = data.accounts.findIndex((/** @type {any} */ a) => a.id === id);
    return `var(--s${Math.min(Math.max(i, 0) + 1, 4)})`;
  }

  function activeAccount() {
    return data.accounts.find((/** @type {any} */ a) => a.active) || data.accounts[0];
  }

  /** Account the model and project sections show: the window's by default. */
  function selectedAccount() {
    const known = state.account === ALL || data.accounts.some((/** @type {any} */ a) => a.id === state.account);
    return known ? state.account : activeAccount().id;
  }

  function records() {
    const from = Date.now() - RECORDS_DAYS * 86_400_000;
    const acc = selectedAccount();
    return data.records.filter((/** @type {Rec} */ r) => r.hour >= from && (acc === ALL || r.account === acc));
  }

  /** "claude-opus-5-5" → "Opus 5.5" */
  function modelName(/** @type {string} */ id) {
    const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id);
    if (!m) return id;
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  }

  const EFFORTS = /** @type {Record<string,string>} */ ({ low: 'bajo', medium: 'medio', high: 'alto', xhigh: 'muy alto', max: 'máximo' });
  const effortName = (/** @type {string} */ e) => (e ? EFFORTS[e] || e : 'sin dato');
  const EFFORT_ORDER = ['max', 'xhigh', 'high', 'medium', 'low', ''];

  /** Short unique names: basename, or parent/basename when two projects share a basename. */
  function projectNames(/** @type {string[]} */ projects) {
    const base = (/** @type {string} */ p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
    const counts = new Map();
    for (const p of new Set(projects)) counts.set(base(p), (counts.get(base(p)) || 0) + 1);
    const names = new Map();
    for (const p of projects) {
      const parts = p.split(/[\\/]/).filter(Boolean);
      names.set(p, counts.get(base(p)) > 1 ? parts.slice(-2).join('/') : base(p));
    }
    return names;
  }

  // ---------- tooltip ----------

  /**
   * @param {MouseEvent|FocusEvent} event
   * @param {string} title
   * @param {{label:string, color:string, value:string}[]} rows
   */
  function showTooltip(event, title, rows) {
    tooltip.replaceChildren(h('div', { class: 'tt-title' }, title));
    for (const row of rows) {
      const key = h('span', { class: 'tt-key' });
      key.style.background = row.color;
      tooltip.append(h('div', { class: 'tt-row' }, key, h('strong', {}, row.value), h('span', {}, row.label)));
    }
    tooltip.hidden = false;
    let x;
    let y;
    if (event instanceof MouseEvent) {
      x = event.clientX + 14;
      y = event.clientY + 14;
    } else {
      const r = /** @type {Element} */ (event.target).getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top;
    }
    tooltip.style.left = `${Math.max(8, Math.min(x, window.innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(y, window.innerHeight - tooltip.offsetHeight - 8))}px`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  /** @param {Element} el @param {() => [string, {label:string, color:string, value:string}[]]} content */
  function hoverable(el, content) {
    el.setAttribute('tabindex', '0');
    el.addEventListener('pointermove', (e) => showTooltip(/** @type {MouseEvent} */ (e), ...content()));
    el.addEventListener('focus', (e) => showTooltip(/** @type {FocusEvent} */ (e), ...content()));
    el.addEventListener('pointerleave', hideTooltip);
    el.addEventListener('blur', hideTooltip);
  }

  // ---------- render ----------

  function render() {
    hideTooltip();
    app.replaceChildren();
    const active = activeAccount();
    app.append(
      h(
        'header',
        {},
        h(
          'div',
          {},
          h('h1', {}, 'Consumo de Claude'),
          h('p', { class: 'sub' }, `Cuenta ${active.label}${active.email ? ` (${active.email})` : ''} · actualizado ${timeFmt.format(new Date(data.generatedAt))}`),
        ),
        h('div', { class: 'controls' }, h('button', { title: 'Claude Code consulta el uso de la cuenta (su comando /usage)', onclick: () => vscode.postMessage({ type: 'update' }) }, 'Actualizar uso')),
      ),
    );
    if (data.error) {
      app.append(h('p', { class: 'empty' }, `No se pudo leer el historial: ${data.error}`));
      return;
    }
    app.append(renderToday(active));
    if (data.quota) {
      app.append(
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'Cuota semanal por día'),
          h('div', { class: 'legend' }, legendItem(accountColor(data.quota.account), 'Usado'), legendItem('wash', 'Disponible para seguir el ritmo')),
          h('div', { class: 'chart', id: 'chart-days' }),
          h(
            'p',
            { class: 'note' },
            'Medido con el % de la cuenta que guarda Claude Code, así que incluye lo que gastes en cualquier equipo o en claude.ai. ' +
              `Cada día termina a la hora del reinicio semanal (${timeFmt.format(new Date(data.quota.budget.resetsAt))}). ` +
              (data.quota.recordedSince ? `Registrado desde ${when(data.quota.recordedSince)}, cada vez que Claude Code actualiza ese dato en este equipo.` : 'Aún no hay registro.'),
          ),
        ),
      );
    }

    const filter = h(
      'select',
      {
        'aria-label': 'Cuenta',
        onchange: (/** @type {Event} */ e) => {
          state = { ...state, account: /** @type {HTMLSelectElement} */ (e.target).value };
          vscode.setState(state);
          render();
        },
      },
      data.accounts.map((/** @type {any} */ a) => h('option', { value: a.id, selected: a.id === selectedAccount() }, `${a.label}${a.active ? ' (esta ventana)' : ''}`)),
      h('option', { value: ALL, selected: selectedAccount() === ALL }, 'Todas las cuentas'),
    );
    app.append(
      h('div', { class: 'section-head' }, h('h2', {}, `En este equipo · últimos ${RECORDS_DAYS} días`), h('label', { class: 'controls' }, 'Cuenta', filter)),
    );
    const recs = records();
    if (recs.length === 0) {
      app.append(h('p', { class: 'empty' }, 'Sin actividad de esa cuenta en este equipo.'));
      return;
    }
    app.append(
      renderModels(recs),
      h('section', { class: 'card' }, h('h2', {}, 'Proyectos'), h('div', { class: 'chart', id: 'chart-projects' })),
      h(
        'p',
        { class: 'note' },
        `${data.files} archivos leídos en ${data.ms} ms. «Uso relativo» pondera los tokens con el precio de cada modelo en la API ` +
          '(lectura de caché a 0,1×, escritura a 1,25–2×): sirve para comparar, no es un costo. ' +
          'Esta parte solo ve el historial de este equipo; lo que hagas en otro equipo no aparece aquí.',
      ),
    );
    renderCharts();
  }

  /** @param {string} color @param {string} label */
  function legendItem(color, label) {
    const sw = h('i', { class: color === 'wash' ? 'swatch ghost' : 'swatch' });
    if (color !== 'wash') sw.style.background = color;
    return h('span', {}, sw, label);
  }

  /** @param {any} a */
  function renderToday(a) {
    const color = accountColor(a.id);
    const u = a.usage;
    const q = data.quota;
    const tiles = h('section', { class: 'tiles' });

    const usageCard = h('div', { class: 'card tile' }, h('div', { class: 'tile-head' }, h('span', { class: 'tile-name' }, 'Límites de la cuenta')));
    usageCard.append(meter('5 horas', effectivePct(u && u.fiveHour), u && u.fiveHour && u.fiveHour.resetsAt, color));
    usageCard.append(meter('Semanal', effectivePct(u && u.sevenDay), u && u.sevenDay && u.sevenDay.resetsAt, color));
    let source;
    if (!u || u.source === 'none') source = 'Claude Code todavía no guardó el uso de esta cuenta. Pulsa «Actualizar uso».';
    else
      source =
        `Dato que guardó Claude Code ${ago(u.fetchedAt)}.` +
        (Date.now() - u.fetchedAt > 30 * 60000 ? ' Pulsa «Actualizar uso» para pedirle a Claude Code uno nuevo.' : '');
    usageCard.append(h('div', { class: 'tile-source' }, source));
    tiles.append(usageCard);

    if (q) {
      const b = q.budget;
      const over = b.leftToday < 0;
      const card = h('div', { class: 'card tile' }, h('div', { class: 'tile-head' }, h('span', { class: 'tile-name' }, 'Presupuesto de hoy')));
      card.append(
        h(
          'div',
          { class: 'hero' },
          h('strong', {}, over ? `+${pctFmt(-b.leftToday)}` : pctFmt(b.leftToday)),
          h('span', {}, over ? 'por encima de lo de hoy' : `libre de ~${pctFmt(b.allowance)} para hoy`),
        ),
      );
      const bar = h('div', { class: 'meter', role: 'meter', 'aria-label': 'Usado hoy', 'aria-valuemin': 0, 'aria-valuemax': b.allowance, 'aria-valuenow': b.usedToday });
      const fill = h('div', { class: 'meter-fill' });
      const fillColor = over ? 'var(--warning)' : color;
      fill.style.width = `${Math.min(100, (b.usedToday / Math.max(b.allowance, 0.01)) * 100)}%`;
      fill.style.background = fillColor;
      bar.style.background = `color-mix(in srgb, ${fillColor} 18%, transparent)`;
      bar.append(fill);
      card.append(
        h('div', { class: 'meter-row' }, h('span', { class: 'meter-label' }, 'Hoy'), bar, h('span', { class: 'meter-value' }, `${over ? '⚠ ' : ''}${pctFmt(b.usedToday)}`)),
        h(
          'div',
          { class: 'tile-source' },
          `${pctFmt(100 - b.startPct)} de la cuota libre para ${b.daysLeft === 1 ? 'el último día' : `${b.daysLeft} días`} (reinicio ${when(b.resetsAt)}). ` +
            'Si un día usas menos, los siguientes tienen más; si usas más, tienen menos.' +
            (b.partial ? ' El registro empezó a mitad de este día: lo usado antes no cuenta.' : ''),
        ),
      );
      tiles.append(card);
    }
    return tiles;
  }

  /** @param {string} label @param {number|undefined} pct @param {number|undefined} resetsAt @param {string} accountColor */
  function meter(label, pct, resetsAt, accountColor) {
    const row = h('div', { class: 'meter-row' });
    const bar = h('div', { class: 'meter', role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct ?? '' });
    const fill = h('div', { class: 'meter-fill' });
    const color = pct === undefined ? 'var(--ink-2)' : pct >= 90 ? 'var(--critical)' : pct >= 75 ? 'var(--warning)' : accountColor;
    fill.style.width = `${Math.max(0, Math.min(100, pct ?? 0))}%`;
    fill.style.background = color;
    bar.style.background = `color-mix(in srgb, ${color} 18%, transparent)`;
    bar.append(fill);
    const value = pct === undefined ? '—' : `${pct >= 75 ? '⚠ ' : ''}${Math.round(pct)}%`;
    row.append(h('span', { class: 'meter-label' }, label), bar, h('span', { class: 'meter-value' }, value));
    if (resetsAt && pct !== undefined && resetsAt > Date.now()) {
      row.append(h('span', { class: 'meter-reset' }, `reinicia ${when(resetsAt)}`));
    }
    return row;
  }

  /** @param {Rec[]} recs */
  function renderModels(recs) {
    const groups = new Map();
    for (const r of recs) {
      const key = `${r.model}\u0000${r.effort}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { model: r.model, effort: r.effort, cost: 0, messages: 0 }));
      g.cost += r.cost;
      g.messages += r.messages;
    }
    const total = [...groups.values()].reduce((a, g) => a + g.cost, 0) || 1;
    const rows = [...groups.values()].sort((a, b) => b.cost - a.cost || EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort));
    const q = data.quota;
    // Only meaningful for the account whose quota was measured.
    const quotaShare = q && q.used7d > 0 && selectedAccount() === q.account ? q.used7d : undefined;
    const color = selectedAccount() === ALL ? 'var(--ink-2)' : accountColor(selectedAccount());
    const head = ['Modelo', 'Esfuerzo', 'Respuestas', 'Uso relativo', ...(quotaShare !== undefined ? ['≈ cuota semanal'] : [])];
    const table = h(
      'table',
      {},
      h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col' }, t)))),
      h(
        'tbody',
        {},
        rows.map((g) => {
          const share = g.cost / total;
          const bar = h('div', { class: 'share-bar' });
          const fill = h('div', {});
          fill.style.width = `${Math.max(1, share * 100)}%`;
          fill.style.background = color;
          bar.append(fill);
          return h(
            'tr',
            {},
            h('td', { title: g.model }, modelName(g.model)),
            h('td', {}, effortName(g.effort)),
            h('td', {}, full.format(g.messages)),
            h('td', { class: 'share-cell' }, bar, h('span', {}, pctFmt(share * 100))),
            quotaShare !== undefined ? h('td', {}, `~${pctFmt(share * quotaShare)}`) : null,
          );
        }),
      ),
    );
    return h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Modelos y esfuerzo'),
      h('div', { class: 'table-wrap' }, table),
      quotaShare !== undefined
        ? h(
            'p',
            { class: 'note' },
            `«≈ cuota semanal» reparte el ${pctFmt(quotaShare)} que la cuenta gastó en estos 7 días según el uso relativo de cada fila. ` +
              'Supone que todo salió de este equipo: si también usas la cuenta en otro, aquí sobreestima.',
          )
        : null,
    );
  }

  function renderCharts() {
    const days = document.getElementById('chart-days');
    const projects = document.getElementById('chart-projects');
    if (days && data.quota) renderQuotaDays(days);
    if (projects) renderProjects(projects);
  }

  /** Rect with rounded top corners (data end) and a square base. */
  function topRounded(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ hgt, r = 4) {
    const rr = Math.max(0, Math.min(r, hgt, w / 2));
    return `M${x},${y + hgt}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${y + hgt}Z`;
  }

  /** @param {HTMLElement} el */
  function renderQuotaDays(el) {
    const q = data.quota;
    /** @type {QuotaDay[]} */
    const days = q.days;
    const color = accountColor(q.account);
    const heights = days.map((d) => {
      const used = d.used ?? 0;
      return d.state === 'past' ? used : d.state === 'today' ? Math.max(used, d.allowance ?? 0) : d.allowance ?? 0;
    });
    const tallest = Math.max(...heights, 5);
    const step = tallest <= 10 ? 2 : tallest <= 25 ? 5 : tallest <= 50 ? 10 : 20;
    const top = Math.ceil(tallest / step) * step;

    const W = Math.max(320, el.clientWidth);
    const H = 220;
    const ml = 40;
    const mr = 8;
    const mt = 22;
    const mb = 26;
    const pw = W - ml - mr;
    const ph = H - mt - mb;
    const y = (/** @type {number} */ v) => mt + ph - (v / top) * ph;
    const slot = pw / days.length;
    const barW = Math.min(24, slot * 0.6);

    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Cuota semanal usada y disponible por día' });
    for (let v = 0; v <= top + 1e-9; v += step) {
      const line = s('line', { x1: ml, x2: W - mr, y1: y(v), y2: y(v), 'stroke-width': 1 });
      line.style.stroke = v === 0 ? 'var(--axis)' : 'var(--grid)';
      svg.append(line);
      const t = s('text', { x: ml - 6, y: y(v) + 4, 'text-anchor': 'end' });
      t.textContent = `${v}%`;
      svg.append(t);
    }
    days.forEach((d, i) => {
      const cx = ml + slot * i + slot / 2;
      const x = cx - barW / 2;
      const hit = s('rect', { class: 'hit', x: ml + slot * i + 2, y: mt - 16, width: slot - 4, height: ph + 16, rx: 4 });
      svg.append(hit);
      const used = d.used ?? 0;
      // What is still available that day: the whole allowance ahead, or what today has left.
      const free = d.state === 'past' ? 0 : Math.max(0, (d.allowance ?? 0) - (d.state === 'today' ? used : 0));
      if (free > 0) {
        const base = d.state === 'today' ? used : 0;
        const gap = base > 0 ? 2 : 0;
        const ghost = s('path', { d: topRounded(x + 0.5, y(base + free) + 0.5, barW - 1, Math.max(0, (free / top) * ph - gap - 1)) });
        ghost.style.fill = 'var(--wash)';
        ghost.style.stroke = 'var(--axis)';
        ghost.style.strokeDasharray = '3 2';
        ghost.style.pointerEvents = 'none';
        svg.append(ghost);
      }
      if (used > 0) {
        const bar = s('path', { d: topRounded(x, y(used), barW, (used / top) * ph) });
        bar.style.fill = d.state === 'today' && free === 0 && used > (d.allowance ?? 0) ? 'var(--warning)' : color;
        bar.style.pointerEvents = 'none';
        svg.append(bar);
      }
      if (d.state === 'today') {
        const cap = s('text', { class: 'cap', x: cx, y: y(Math.max(used, used + free)) - 6, 'text-anchor': 'middle' });
        cap.textContent = `${pctFmt(used)} de ${pctFmt(d.allowance ?? 0)}`;
        svg.append(cap);
      }
      const label = s('text', { class: d.state === 'today' ? 'today' : '', x: cx, y: H - 8, 'text-anchor': 'middle' });
      label.textContent = d.state === 'today' ? 'hoy' : dayFmt.format(new Date(d.start));
      svg.append(label);
      hoverable(hit, () => {
        const rows = [];
        if (d.state !== 'future') {
          rows.push({ label: d.used === undefined ? 'sin registro' : d.partial ? 'usado (registro parcial)' : 'usado', color, value: d.used === undefined ? '—' : pctFmt(used) });
        }
        if (d.state !== 'past') rows.push({ label: d.state === 'today' ? 'te queda hoy' : 'disponible ese día', color: 'var(--axis)', value: pctFmt(free) });
        return [`${dateTimeFmt.format(new Date(d.start))} → ${timeFmt.format(new Date(d.end))}`, rows];
      });
    });
    el.replaceChildren(svg);
  }

  /** @param {HTMLElement} el */
  function renderProjects(el) {
    const acc = selectedAccount();
    const series = acc === ALL ? [...data.accounts.map((/** @type {any} */ a) => a.id), UNKNOWN] : [acc];
    const byProject = new Map();
    for (const r of records()) {
      let row = byProject.get(r.project);
      if (!row) byProject.set(r.project, (row = new Map()));
      row.set(r.account, (row.get(r.account) || 0) + r.cost);
    }
    const total = [...byProject.values()].reduce((a, m) => a + [...m.values()].reduce((x, y) => x + y, 0), 0) || 1;
    /** @type {{project:string, values:number[], total:number, other?:boolean}[]} */
    let rows = [...byProject.entries()]
      .map(([project, m]) => ({ project, values: series.map((id) => m.get(id) || 0) }))
      .map((r) => ({ ...r, total: r.values.reduce((a, b) => a + b, 0) }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
    if (rows.length > TOP_PROJECTS + 1) {
      const rest = rows.slice(TOP_PROJECTS);
      const values = series.map((_, k) => rest.reduce((a, r) => a + r.values[k], 0));
      rows = [...rows.slice(0, TOP_PROJECTS), { project: `Otros (${rest.length})`, values, total: values.reduce((a, b) => a + b, 0), other: true }];
    }
    const names = projectNames(rows.map((r) => r.project));
    const max = Math.max(...rows.map((r) => r.total), 1e-9);
    const list = h('div', { role: 'list' });
    for (const r of rows) {
      const bar = h('div', { class: 'hbar-bar' });
      bar.style.width = `${(r.total / max) * 100}%`;
      r.values.forEach((v, k) => {
        if (v <= 0) return;
        const seg = h('div', { class: 'hbar-seg' });
        seg.style.flex = `${v} 1 0`;
        seg.style.background = accountColor(series[k]);
        bar.append(seg);
      });
      const name = r.other ? r.project : names.get(r.project);
      const row = h(
        'div',
        { class: 'hbar-row', role: 'listitem' },
        h('div', { class: 'hbar-label', title: r.project }, name),
        h('div', {}, bar),
        h('div', { class: 'hbar-value' }, pctFmt((r.total / total) * 100)),
      );
      hoverable(row, () => [
        r.project,
        series
          .map((id, k) => ({ id, v: r.values[k] }))
          .filter((x) => x.v > 0)
          .map((x) => ({
            label: x.id === UNKNOWN ? 'Sin identificar' : (data.accounts.find((/** @type {any} */ a) => a.id === x.id) || { label: x.id }).label,
            color: accountColor(x.id),
            value: pctFmt((x.v / total) * 100),
          })),
      ]);
      list.append(row);
    }
    el.replaceChildren(list);
  }
})();
