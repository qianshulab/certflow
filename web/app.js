'use strict';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const providers = {
  'dnspod-token': { name: 'DNSPod · ID / Token', subtitle: '适用于 DNSPod 控制台创建的 Token，不是腾讯云 SecretKey', fields: [['DNSPOD_API_ID', 'Token ID'], ['DNSPOD_API_TOKEN', 'Token']], link: 'https://console.dnspod.cn/account/token/token', linkLabel: '创建 DNSPod Token' },
  tencentcloud: { name: '腾讯云 DNSPod · 云 API', subtitle: '使用腾讯云访问管理中的 SecretId / SecretKey', fields: [['TENCENTCLOUD_SECRET_ID', 'SecretId'], ['TENCENTCLOUD_SECRET_KEY', 'SecretKey']], link: 'https://console.cloud.tencent.com/cam/capi', linkLabel: '管理腾讯云 API 密钥' },
  cloudflare: { name: 'Cloudflare', subtitle: '使用拥有 DNS 编辑权限的 API Token', fields: [['CF_DNS_API_TOKEN', 'DNS API Token']] },
  alidns: { name: '阿里云 DNS', subtitle: '使用阿里云 RAM 用户的访问密钥', fields: [['ALICLOUD_ACCESS_KEY', 'AccessKey ID'], ['ALICLOUD_SECRET_KEY', 'AccessKey Secret']] },
};
const exportKinds = [
  { kind: 'certificate', filename: 'cert.pem', label: '域名证书 · NAS 证书字段', icon: 'file' },
  { kind: 'privateKey', filename: 'privkey.pem', label: '证书私钥 · 请妥善保管', icon: 'key' },
  { kind: 'chain', filename: 'chain.pem', label: '中间证书 · NAS 中间证书字段', icon: 'link' },
  { kind: 'fullchain', filename: 'fullchain.pem', label: '完整证书链 · Nginx / Docker', icon: 'shield' },
];
const viewNames = { overview: '证书工作台', config: '证书配置', credentials: 'DNS 凭据', exports: '导出与部署' };
const phaseLabels = {
  preparing: '准备任务',
  credentials: '检查 DNS 凭据',
  client: '检查 ACME 客户端',
  acme: '等待 ACME 与 DNS 验证',
  certificate: '验证签发证书',
  export: '生成导出文件',
  deployment: '部署并重载服务',
};
let state = null;
let draft = null;
let draftVersion = null;
let dirty = false;
let pending = false;
let connected = false;
let currentView = 'overview';
let toastTimer;
let shutdownRequested = false;
let requestSequence = 0;
let appliedSequence = 0;
let renderSignature = '';
let logSignature = '';
let exportSignature = '';
let setupSignature = '';
let selectedEditor = 0;
let jobSearchText = '';
let selectedProvider = 'dnspod-token';
let searchText = '';
let certificateFilter = 'all';
let certificateSort = 'attention';
let logFilter = 'all';
let validationVisible = false;
let confirmResolve;
let selectedCertificate = '';
let preflightRunning = false;
let shownRunId = null;
let progressEventsSignature = '';
let progressAnnouncement = '';
const dismissedRunKey = 'certflow:dismissed-run-id';
let dismissedRunId;
try { dismissedRunId = sessionStorage.getItem(dismissedRunKey); } catch { dismissedRunId = null; }

function hasCredentialDraft() { return [...document.querySelectorAll('.credential-panel input[name]')].some((input) => input.value); }
function normalizeProvider(value) { return value === 'dnspod' ? 'tencentcloud' : value; }
function confirmAction(title, detail, action = '确认') {
  if (confirmResolve) return Promise.resolve(false);
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = detail;
  $('confirm-action').textContent = action;
  $('confirm-dialog').showModal();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function button(label, className, click, iconName) {
  const node = el('button', className);
  node.type = 'button';
  if (iconName) node.append(icon(iconName));
  node.append(el('span', '', label));
  if (click) node.addEventListener('click', click);
  return node;
}
function pill(label, tone = 'neutral') { return el('span', `pill ${tone}-pill`, label); }
function date(value, short = false) {
  const timestamp = new Date(value);
  if (!value || Number.isNaN(timestamp.valueOf())) return '尚无记录';
  return new Intl.DateTimeFormat('zh-CN', short
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp);
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8500 : 4500);
}
function switchView(view, focus = true) {
  if (!viewNames[view]) view = 'overview';
  currentView = view;
  for (const name of Object.keys(viewNames)) $(`view-${name}`).hidden = name !== view;
  for (const node of document.querySelectorAll('[data-view]')) {
    const active = node.dataset.view === view;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
  $('breadcrumb-current').textContent = viewNames[view];
  document.title = `${viewNames[view]} · CertFlow`;
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  $('draft-banner').hidden = !dirty || view === 'config';
  if (focus) $(`view-${view}`).querySelector('h1')?.focus({ preventScroll: true });
  if (view === 'config') requestAnimationFrame(() => revealSelectedJob());
}
function isExample(config = state?.config) {
  return config?.email === 'you@example.com';
}
function credentialsReady(job) {
  return job.challenge?.type === 'http' || Boolean(state?.credentials?.[job.challenge?.provider === 'dnspod' ? 'tencentcloud' : job.challenge?.provider]?.configured);
}
function canRetryDeployment(job, status = state?.statuses?.find((item) => item.id === job.id)) {
  return Boolean(job.deployment && status?.certificate?.status === 'valid' && status.state?.issuedFingerprint === status.certificate.fingerprint && status.state?.deployedFingerprint !== status.state?.issuedFingerprint);
}
function runBlocked(job) {
  if (!connected || !state) return '管理服务尚未连接';
  if (state.stopping || shutdownRequested) return '工具正在退出';
  if (pending || state.runtime?.running) return '请等待当前操作完成';
  if (!state.config || state.configError) return '请先保存有效的证书配置';
  if (isExample()) return '请先将示例邮箱和域名改为你的实际配置';
  if (!state.config.acceptTerms) return '请先在证书配置中阅读并同意服务条款';
  const runnable = job ? [job] : state.config.jobs.filter((item) => item.enabled !== false);
  if (!runnable.length) return '所有任务已暂停，请在证书配置中启用任务';
  if (!runnable.every((item) => credentialsReady(item) || canRetryDeployment(item))) return '请先在 DNS 凭据中配置对应服务商';
  return '';
}
function editBlocked() {
  if (!connected || !state) return '等待连接管理服务';
  if (shutdownRequested || state.stopping) return '工具正在退出';
  if (pending || state.runtime?.running) return '任务正在运行，请等待完成后修改';
  return '';
}
async function responseError(response) {
  let body;
  try { body = await response.json(); } catch { /* Show a bounded generic error for non-JSON replies. */ }
  const error = new Error(typeof body?.error === 'string' ? body.error : `管理服务请求失败（HTTP ${response.status}）`);
  error.status = response.status;
  return error;
}
async function post(endpoint, body = {}, asBlob = false) {
  if (!state?.csrfToken) throw new Error('请等待管理服务连接完成。');
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken },
    credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(body),
  });
  if (response.status === 401) { location.assign('/login'); throw new Error('登录已过期，请重新登录。'); }
  if (!response.ok) throw await responseError(response);
  return asBlob ? response.blob() : response.json();
}
async function operate(operation) {
  if (pending) return;
  pending = true;
  updateControls();
  try { await operation(); }
  catch (error) { toast(error.message || '操作失败，请重试。', true); }
  finally { pending = false; renderState(); }
}
async function refresh() {
  const sequence = ++requestSequence;
  try {
    const response = await fetch('/api/state', { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) { location.assign('/login'); return; }
    if (!response.ok) throw await responseError(response);
    const next = await response.json();
    if (sequence < appliedSequence) return;
    appliedSequence = sequence;
    connected = true;
    state = next;
    if (!draft || !dirty && draftVersion !== next.configVersion) loadDraft(next.config, next.configVersion);
    renderState();
  } catch (error) {
    if (sequence < appliedSequence) return;
    connected = false;
    $('connection-banner').hidden = false;
    $('connection-banner').textContent = shutdownRequested
      ? '工具已退出，自动续期已停止。需要继续使用时，请重新启动图形界面。'
      : '无法连接管理服务。请确认图形界面工具仍在运行，页面会自动尝试重新连接。';
    $('connection-label').textContent = shutdownRequested ? '服务已退出' : '连接已断开';
    $('connection-dot').classList.add('offline');
    renderProgress();
    updateControls();
  }
}
async function poll() {
  await refresh();
  if (!shutdownRequested || connected) setTimeout(poll, 3000);
}
function adopt(next) {
  appliedSequence = ++requestSequence;
  connected = true;
  state = next;
  renderState();
}
function renderState() {
  if (!state) return updateControls();
  $('connection-banner').hidden = connected && !state.stopping && !shutdownRequested;
  if (state.stopping || shutdownRequested) $('connection-banner').textContent = '已停止自动续期调度，工具将在当前任务完成后退出。';
  $('connection-label').textContent = state.stopping || shutdownRequested ? '正在退出' : connected ? '管理服务已连接' : '连接已断开';
  $('connection-dot').classList.toggle('offline', !connected);
  $('app-version').textContent = `CertFlow v${state.app?.version ?? '—'}`;
  $('environment-badge').textContent = state.config?.environment === 'production' ? '正式环境' : '测试环境 · 证书不受信任';
  $('environment-badge').className = `pill ${state.config?.environment === 'production' ? 'teal' : 'amber'}-pill`;
  $('logout-tool').hidden = !state.app?.authentication;
  $('shutdown-tool').hidden = Boolean(state.app?.authentication);
  document.querySelector('.local-mark').textContent = state.app?.authentication ? 'SERVER' : 'LOCAL';
  document.querySelector('.avatar').textContent = state.app?.authentication ? '管' : '本';
  document.querySelector('.avatar').setAttribute('aria-label', state.app?.authentication ? '管理员' : '本地用户');
  const configError = [state.configError && `配置需要修正：${state.configError}`, state.statusError && `证书状态读取失败：${state.statusError}`, state.historyError && `活动记录保存异常：${state.historyError}`].filter(Boolean).join(' ');
  $('config-error-banner').hidden = !configError;
  $('config-error-banner').textContent = configError;
  $('config-path').textContent = `配置文件：${state.configPath ?? '—'}`;
  const jobs = state.config?.jobs ?? [];
  const statuses = state.statuses ?? [];
  const valid = statuses.filter((item) => item.certificate?.status === 'valid' && Date.parse(item.certificate.validTo) > Date.now()).length;
  const attention = jobs.filter((job) => {
    const status = statuses.find((item) => item.id === job.id);
    return taskNeedsAttention(job, status);
  }).length;
  $('metric-total').textContent = jobs.length;
  $('metric-total-caption').textContent = isExample() ? '示例任务 · 请先完善配置' : `${jobs.filter((job) => job.enabled !== false).length} 个已启用 / ${jobs.filter((job) => job.enabled === false).length} 个已暂停`;
  metric('metric-valid', state.statusError ? '—' : valid, '份');
  $('metric-valid-caption').textContent = state.statusError ? '状态读取失败' : state.config?.environment === 'staging' ? '测试证书不被浏览器信任' : valid ? '服务端证书在有效期内' : '尚未签发有效证书';
  metric('metric-attention', state.statusError ? '—' : attention, '项');
  $('metric-attention-caption').textContent = state.statusError ? '请检查服务端状态文件' : attention ? '待申请、临近到期或需处理' : '暂无待处理事项';
  $('jobs-count').textContent = jobs.length;
  renderSetup(jobs, statuses);
  renderCertificates(jobs, statuses);
  renderLogs();
  renderCredentialsStatus();
  renderExports(jobs, statuses);
  const enabled = Boolean(state.scheduler?.enabled);
  $('scheduler-toggle').checked = enabled;
  $('scheduler-badge').textContent = enabled ? '已开启' : '未开启';
  $('scheduler-badge').className = `pill ${enabled ? 'teal' : 'neutral'}-pill`;
  $('scheduler-detail').textContent = enabled
    ? state.scheduler.resumeError ? `恢复调度失败：${state.scheduler.resumeError}` : state.runtime?.running ? '正在检查证书；本轮结束后安排下一次检查。' : `下次检查：${date(state.scheduler.nextRunAt)}。重启工具后自动恢复。`
    : '开启后立即检查，设置会长期保存。自动续期需要工具服务持续运行。';
  renderProgress();
  updateControls();
}
function elapsedSince(startedAt, finishedAt) {
  const start = Date.parse(startedAt);
  const finish = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return '—';
  const seconds = Math.max(0, Math.floor((finish - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`;
}
function updateProgressElapsed() {
  if (!state?.runtime?.runId || $('run-progress').hidden) return;
  const runtime = state.runtime;
  const stale = !connected && runtime.running;
  $('progress-elapsed').textContent = stale ? '等待重新连接' : elapsedSince(runtime.startedAt, runtime.running ? null : runtime.finishedAt);
  $('progress-phase-elapsed').textContent = runtime.running && runtime.currentPhase
    ? stale ? '当前阶段状态暂未更新。' : `当前阶段已持续 ${elapsedSince(runtime.phaseStartedAt)}。`
    : '';
}
function renderProgress() {
  const panel = $('run-progress');
  const runtime = state?.runtime;
  if (!runtime?.runId || runtime.runId === dismissedRunId) {
    panel.hidden = true;
    if (!runtime?.runId) shownRunId = null;
    document.body.classList.remove('has-run-progress');
    return;
  }
  panel.hidden = false;
  document.body.classList.add('has-run-progress');
  if (shownRunId !== runtime.runId) {
    shownRunId = runtime.runId;
    progressEventsSignature = '';
    progressAnnouncement = '';
    panel.open = true;
  }
  const results = Array.isArray(runtime.results) ? runtime.results : [];
  const failed = results.filter((result) => !result.ok && result.action !== 'backoff');
  const delayed = results.filter((result) => result.action === 'backoff');
  const complete = Math.min(Number(runtime.completedCount) || 0, Number(runtime.totalJobs) || 0);
  const total = Number(runtime.totalJobs) || 0;
  const phase = phaseLabels[runtime.currentPhase] ?? (runtime.running ? '等待下一阶段' : '本轮已结束');
  const outcome = !connected && runtime.running ? '连接中断' : runtime.running ? '运行中'
    : runtime.error || failed.length ? '有失败' : delayed.length ? '等待重试' : '已完成';
  $('progress-state').textContent = outcome;
  $('progress-state').className = `pill ${outcome === '有失败' || outcome === '连接中断' ? 'red' : outcome === '等待重试' ? 'amber' : outcome === '已完成' ? 'teal' : 'blue'}-pill`;
  panel.dataset.status = outcome === '有失败' || outcome === '连接中断' ? 'error' : outcome === '已完成' ? 'complete' : 'running';
  const heading = runtime.running
    ? `${complete} / ${total} 个任务 · ${runtime.currentJob || runtime.only || '正在开始'} · ${phase}`
    : `${complete} / ${total} 个任务 · ${outcome}`;
  $('progress-summary').textContent = heading;
  $('progress-job').textContent = runtime.currentJob || (runtime.running ? '等待任务启动' : '本轮任务已结束');
  $('progress-phase').textContent = runtime.running ? phase : outcome;
  $('progress-count').textContent = `${complete} / ${total} 个任务`;
  $('progress-actions').hidden = Boolean(runtime.running);
  updateProgressElapsed();

  const resultBox = $('progress-results');
  resultBox.hidden = !runtime.error && !failed.length && !delayed.length;
  if (!resultBox.hidden) {
    const notices = [];
    if (runtime.error) notices.push({ title: '批次执行中断', message: runtime.error, tone: 'error' });
    for (const result of failed.slice(0, 3)) notices.push({ title: `${result.id} · 执行失败`, message: result.error || '请查看工作台活动记录。', tone: 'error' });
    if (failed.length > 3) notices.push({ title: `另有 ${failed.length - 3} 个任务失败`, message: '请在证书工作台查看各任务结果。', tone: 'error' });
    if (delayed.length) notices.push({ title: `${delayed.length} 个任务等待重试`, message: '任务处于失败退避期；可查看各任务的下次重试时间。', tone: 'warning' });
    const signature = JSON.stringify(notices);
    if (resultBox.dataset.signature !== signature) {
      resultBox.dataset.signature = signature;
      resultBox.replaceChildren(...notices.map((notice) => {
        const row = el('div', `run-progress-result ${notice.tone}`);
        row.append(el('strong', '', notice.title), el('span', '', notice.message));
        return row;
      }));
    }
  }

  const events = (Array.isArray(runtime.phaseHistory) ? runtime.phaseHistory : []).slice(0, 8);
  const signature = JSON.stringify(events);
  if (signature !== progressEventsSignature) {
    progressEventsSignature = signature;
    $('progress-events').replaceChildren(...(events.length ? events.map((event) => {
      const row = el('li', 'run-progress-event');
      row.append(el('time', '', date(event.at, true)), el('span', 'run-progress-event-job', event.jobId || '任务'), el('span', '', phaseLabels[event.phase] || '执行阶段'));
      row.querySelector('time').dateTime = event.at;
      return row;
    }) : [el('li', 'run-progress-empty', runtime.running ? '等待阶段更新…' : '本轮没有阶段记录。')]));
  }
  const announcement = `${outcome}。${heading}${failed.length ? `。${failed.length} 个任务失败` : ''}${runtime.error ? `。${runtime.error}` : ''}`;
  if (announcement !== progressAnnouncement) {
    progressAnnouncement = announcement;
    $('progress-announcement').textContent = announcement;
  }
}
function metric(id, value, unit) { $(id).replaceChildren(document.createTextNode(String(value)), el('small', '', unit)); }
function renderSetup(jobs, statuses) {
  const configured = jobs.length > 0 && !isExample();
  const credentials = configured && jobs.filter((job) => job.enabled !== false).every(credentialsReady);
  const accepted = configured && Boolean(state.config?.acceptTerms);
  const issued = statuses.some((status) => Boolean(status.state?.exportFiles));
  const steps = [
    { title: '填写域名', detail: '设置邮箱与证书任务', view: 'config', done: configured },
    { title: '连接 DNS', detail: '保存域名验证凭据', view: 'credentials', done: credentials },
    { title: '确认并申请', detail: accepted ? '回到工作台开始检查' : '阅读条款后开始签发', view: accepted ? 'overview' : 'config', done: issued },
    { title: '部署到服务', detail: '下载证书或自动部署', view: 'exports', done: issued && statuses.some((status) => status.state?.lastDeployedAt) },
  ];
  const signature = JSON.stringify(steps);
  if (signature === setupSignature) return;
  setupSignature = signature;
  $('onboarding').hidden = issued;
  $('setup-progress').textContent = `${steps.filter((step) => step.done).length} / 4 已完成`;
  const active = steps.findIndex((step) => !step.done);
  const nodes = steps.map((step, index) => {
    const node = button('', `setup-step${step.done ? ' complete' : index === active ? ' current' : ''}`, () => switchView(step.view));
    node.replaceChildren();
    const number = el('span', 'step-number');
    number.append(step.done ? icon('check') : document.createTextNode(String(index + 1).padStart(2, '0')));
    const copy = el('span', 'step-copy');
    copy.append(el('strong', '', step.title), el('small', '', step.detail));
    node.append(number, copy);
    return node;
  });
  $('setup-steps').replaceChildren(...nodes);
}
function certificateStatus(job, status) {
  if (isExample()) return ['待配置', 'neutral'];
  const runtime = state.runtime;
  if (runtime?.running && (runtime.only === job.id || !runtime.only && job.enabled !== false)) {
    const result = runtime.results?.find((item) => item.id === job.id);
    if (result) return result.action === 'backoff' ? ['退避等待', 'amber'] : [result.ok ? '本轮完成' : '本轮失败', result.ok ? 'teal' : 'red'];
    if (runtime.currentJob === job.id) return ['检查中', 'blue'];
    return [runtime.totalJobs > 0 ? '等待执行' : runtime.only ? '任务执行中' : '批次执行中', 'neutral'];
  }
  if (status?.state?.lastError) return ['需要关注', 'red'];
  if (state.statusError) return ['状态未知', 'amber'];
  if (status?.certificate?.validTo && Date.parse(status.certificate.validTo) <= Date.now()) return ['已过期', 'red'];
  if (status?.certificate?.status !== 'valid') return [status?.certificate?.status === 'not-issued' || !status?.certificate ? '待申请' : '证书异常', status?.certificate?.status === 'not-issued' || !status?.certificate ? 'neutral' : 'red'];
  if (Date.parse(status.certificate.validTo) <= Date.now()) return ['已过期', 'red'];
  if (status.certificate.remainingDays <= 30 && state.config.environment === 'production') return ['即将到期', 'amber'];
  return [state.config.environment === 'staging' ? '测试证书' : '有效', state.config.environment === 'staging' ? 'amber' : 'teal'];
}
function taskNeedsAttention(job, status) {
  return job.enabled !== false && (isExample() || status?.certificate?.status !== 'valid' || Date.parse(status.certificate.validTo) <= Date.now() || status?.state?.lastError || status?.state?.lastWarning || status?.state?.dnsCleanupPendingCount > 0 || status?.certificate?.remainingDays <= 30 || !credentialsReady(job));
}
function editJob(id) {
  let index = draft?.jobs.findIndex((job) => job.__originalId === id) ?? -1;
  if (index < 0 && !state?.config?.jobs.some((job) => job.id === id)) index = draft?.jobs.findIndex((job) => job.id === id) ?? -1;
  switchView('config');
  if (index >= 0) selectEditor(index, { focusField: 'id' });
  else toast(`任务 ${id} 已从当前草稿移除。请先保存或撤销修改，当前草稿已保留。`, true);
}
function showExports(id) {
  $('export-job').value = id;
  exportSignature = '';
  renderExports(state.config.jobs, state.statuses ?? []);
  switchView('exports');
}
function renderCertificates(jobs, statuses) {
  if (!state) return;
  const signature = JSON.stringify([jobs, statuses, state.credentials, state.runtime, state.statusError, state.config?.email, state.config?.environment, searchText, certificateFilter, certificateSort, selectedCertificate]);
  if (signature === renderSignature) return;
  renderSignature = signature;
  const filtered = jobs.filter((job) => {
    const status = statuses.find((item) => item.id === job.id);
    const valid = status?.certificate?.status === 'valid' && Date.parse(status.certificate.validTo) > Date.now();
    const matching = `${job.id} ${job.domains.join(' ')}`.toLowerCase().includes(searchText);
    return matching && (certificateFilter === 'all' || certificateFilter === 'attention' && taskNeedsAttention(job, status) || certificateFilter === 'pending' && status?.certificate?.status === 'not-issued' || certificateFilter === 'valid' && valid || certificateFilter === 'expiring' && valid && status.certificate.remainingDays <= 30 || certificateFilter === 'disabled' && job.enabled === false);
  });
  filtered.sort((a, b) => {
    const sa = statuses.find((item) => item.id === a.id), sb = statuses.find((item) => item.id === b.id);
    if (certificateSort === 'name') return (a.domains[0] ?? a.id).localeCompare(b.domains[0] ?? b.id);
    if (certificateSort === 'attention') {
      const difference = Number(Boolean(taskNeedsAttention(b, sb))) - Number(Boolean(taskNeedsAttention(a, sa)));
      if (difference) return difference;
    }
    return (Date.parse(sa?.certificate?.validTo) || Infinity) - (Date.parse(sb?.certificate?.validTo) || Infinity);
  });
  $('certificate-results').textContent = `显示 ${filtered.length} / ${jobs.length} 个任务 · 选择任务查看详情`;
  if (!filtered.length) {
    const empty = el('div', 'empty-state');
    empty.append(icon('file'), el('h3', '', jobs.length ? '没有匹配的证书' : '还没有证书任务'), el('p', '', jobs.length ? '调整搜索或状态筛选，查看其他任务。' : '添加域名与验证方式，开始管理证书。'));
    empty.append(jobs.length ? button('清除筛选', 'button secondary', () => { searchText = ''; certificateFilter = 'all'; $('certificate-search').value = ''; $('certificate-filter').value = 'all'; renderSignature = ''; renderCertificates(jobs, statuses); updateControls(); }) : button('创建证书任务', 'button secondary', () => switchView('config'), 'plus'));
    $('certificate-list').replaceChildren(empty); return;
  }
  if (!filtered.some((job) => job.id === selectedCertificate)) selectedCertificate = filtered[0].id;
  const activeElement = document.activeElement;
  const focusedTask = activeElement?.dataset?.selectJob;
  const scrollBefore = $('certificate-list').querySelector('.certificate-table-scroll')?.scrollLeft ?? 0;
  const verticalScrollBefore = $('certificate-list').querySelector('.certificate-table-scroll')?.scrollTop ?? 0;
  const table = el('table', 'certificate-table');
  const caption = el('caption', 'sr-only', '证书任务。点击域名查看选中任务详情。');
  const head = el('thead'); const header = el('tr');
  for (const label of ['域名 / 任务', '证书状态', '到期时间', '调度', '操作']) { const th = el('th', '', label); th.scope = 'col'; header.append(th); }
  head.append(header); const body = el('tbody');
  for (const job of filtered) {
    const status = statuses.find((item) => item.id === job.id);
    const row = el('tr', job.id === selectedCertificate ? 'selected' : '');
    const name = el('td', 'certificate-cell-domain');
    const choose = button('', 'certificate-select', () => { selectedCertificate = job.id; renderSignature = ''; renderCertificates(jobs, statuses); updateControls(); });
    choose.dataset.selectJob = job.id;
    choose.title = `${job.id}\n${job.domains.join('\n')}`;
    choose.setAttribute('aria-pressed', String(job.id === selectedCertificate));
    choose.replaceChildren(el('strong', '', job.domains[0] ?? job.id), el('small', '', `${job.id}${job.domains.length > 1 ? ` · +${job.domains.length - 1} 个域名` : ''}`));
    name.append(choose);
    const statusCell = el('td'); const [label, tone] = certificateStatus(job, status); statusCell.append(pill(label, tone));
    const expiry = el('td', 'certificate-cell-expiry', status?.certificate?.validTo ? date(status.certificate.validTo).split(' ')[0] : '—');
    if (status?.certificate?.status === 'valid') expiry.append(el('small', '', `剩余 ${status.certificate.remainingDays} 天`));
    const schedule = el('td'); schedule.append(pill(job.enabled === false ? '已暂停' : '已启用', job.enabled === false ? 'neutral' : 'teal'));
    const actionCell = el('td');
    const run = button(canRetryDeployment(job, status) ? '重试部署' : status?.state?.lastError ? '重试' : status?.certificate?.status === 'valid' ? '检查续期' : '申请', 'text-button', () => runJobs(job.id, Boolean(status?.state?.lastError)));
    run.dataset.runJob = job.id; run.setAttribute('aria-label', `${run.textContent} ${job.id}`); actionCell.append(run);
    row.append(name, statusCell, expiry, schedule, actionCell); body.append(row);
  }
  table.append(caption, head, body);
  const wrapper = el('div', 'certificate-table-scroll'); wrapper.append(table);
  const job = filtered.find((item) => item.id === selectedCertificate);
  const status = statuses.find((item) => item.id === job.id);
  const inspector = el('section', 'certificate-inspector'); inspector.setAttribute('aria-label', `任务 ${job.id} 的详情`);
  const heading = el('div', 'inspector-heading');
  const title = el('div'); title.append(el('span', 'section-kicker', '选中任务'), el('h3', '', job.id));
  const actions = el('div', 'button-group');
  const inspect = button('环境检查', 'text-button', () => checkEnvironment(job.id), 'check'); inspect.dataset.preflightJob = job.id;
  actions.append(inspect, button('编辑任务', 'text-button', () => editJob(job.id), 'file'));
  if (status?.certificate?.status === 'valid' && status?.state?.exportFiles) actions.append(button('下载证书', 'button secondary small-button', () => showExports(job.id), 'download'));
  heading.append(title, actions); inspector.append(heading);
  const domains = el('div', 'domain-tags'); domains.append(...job.domains.map((domain) => el('span', 'domain-tag', domain))); inspector.append(domains);
  if (job.enabled === false) inspector.append(el('div', 'banner info', '任务已暂停：自动续期和“检查全部”会跳过此任务。仍可在列表中手动申请或检查。'));
  if (canRetryDeployment(job, status)) inspector.append(el('div', 'banner info', '已有有效的新证书等待部署。“重试部署”会使用此证书恢复部署，无需重新申请。'));
  if (!credentialsReady(job) && !canRetryDeployment(job, status)) {
    const notice = el('div', 'next-action');
    notice.append(el('span', '', '尚未配置此任务的 DNS 凭据'), button('配置凭据', 'text-button', () => { selectProvider(normalizeProvider(job.challenge.provider)); switchView('credentials'); })); inspector.append(notice);
  }
  if (status?.state?.lastError) inspector.append(el('div', 'card-error', `${status.state.lastError}${status.state.nextAttemptAt ? ` 下次可重试：${date(status.state.nextAttemptAt)}` : ''}`));
  if (status?.certificate?.status !== 'valid' && status?.certificate?.status !== 'not-issued' && status?.certificate?.error) inspector.append(el('div', 'card-error', status.certificate.error));
  if (status?.state?.lastWarning || status?.state?.dnsCleanupPendingCount > 0) inspector.append(el('div', 'card-warning', status.state.lastWarning || `有 ${status.state.dnsCleanupPendingCount} 条 DNS 验证记录等待清理。`));
  const details = el('dl', 'detail-grid');
  const deployed = job.deployment ? status?.state?.deployedFingerprint && status.state.deployedFingerprint === status.state.issuedFingerprint ? '上次部署成功' : '等待部署' : '下载后手动导入';
  for (const [label, value] of [
    ['验证方式', job.challenge.type === 'dns' ? providers[normalizeProvider(job.challenge.provider)]?.name ?? job.challenge.provider : 'HTTP 文件验证'],
    ['部署状态', deployed], ['最近检查', date(status?.state?.lastAttemptAt)], ['最近成功', date(status?.state?.lastSuccessAt)],
    ['最近部署', job.deployment ? date(status?.state?.lastDeployedAt) : '手动导入'], ['到期时间', date(status?.certificate?.validTo)],
    ['部署目录', job.deployment?.directory ?? '在“导出与部署”下载 PEM 文件'], ['续期策略', 'ACME 客户端按证书生命周期自动判断'],
  ]) details.append(el('dt', '', label), el('dd', '', value));
  inspector.append(details);
  if (status?.certificate?.fingerprint) { const fingerprint = el('div', 'fingerprint'); fingerprint.append(el('span', '', 'SHA-256 指纹'), el('code', '', status.certificate.fingerprint)); inspector.append(fingerprint); }
  $('certificate-list').replaceChildren(wrapper, inspector);
  wrapper.scrollLeft = scrollBefore;
  wrapper.scrollTop = verticalScrollBefore;
  if (focusedTask) [...$('certificate-list').querySelectorAll('[data-select-job]')].find((node) => node.dataset.selectJob === focusedTask)?.focus({ preventScroll: true });
}
function renderLogs() {
  if (!state) return;
  const logs = (state.logs ?? []).filter((log) => logFilter === 'all' || ['error', 'warn', 'warning'].includes(log.level));
  const signature = JSON.stringify(logs);
  if (signature === logSignature) return;
  logSignature = signature;
  if (!logs.length) { $('activity-list').replaceChildren(el('p', 'quiet-empty', logFilter === 'error' ? '没有错误或警告记录。' : '暂无活动记录。保存配置或开始申请后，运行结果会显示在这里。')); return; }
  $('activity-list').replaceChildren(...logs.slice(0, 30).map((log) => {
    const row = el('div', 'activity-row');
    const allowedLevel = log.level === 'warning' ? 'warn' : ['success', 'error', 'warn'].includes(log.level) ? log.level : '';
    const time = el('time', 'activity-time', date(log.at, true));
    time.dateTime = log.at;
    row.append(el('span', `activity-dot ${allowedLevel}`), el('span', 'activity-message', log.message), time);
    return row;
  }));
}
function updateControls() {
  const reason = runBlocked();
  $('run-all').disabled = Boolean(reason);
  $('run-all').title = reason || '检查所有任务，需要签发或续期时才申请新证书';
  $('run-all').classList.toggle('is-running', Boolean(state?.runtime?.running));
  $('run-all').querySelector('span').textContent = state?.runtime?.running ? '正在检查证书…' : '检查并申请 / 续期';
  for (const node of document.querySelectorAll('[data-run-job]')) {
    const job = state?.config?.jobs.find((item) => item.id === node.dataset.runJob);
    const blocked = runBlocked(job);
    node.disabled = Boolean(blocked);
    node.title = blocked;
  }
  const block = editBlocked();
  for (const node of $('config-form').querySelectorAll('input,select,textarea,button')) node.disabled = Boolean(block);
  $('reset-config').disabled = Boolean(block) || !draft;
  $('preview-plan').disabled = !connected || !state?.config || pending || shutdownRequested || Boolean(state?.stopping);
  for (const node of [$('preflight-all'), ...document.querySelectorAll('[data-preflight-job]')]) node.disabled = !connected || pending || !state?.config || Boolean(state?.runtime?.running) || shutdownRequested || Boolean(state?.stopping);
  $('preflight-all').classList.toggle('is-running', preflightRunning);
  for (const node of $('credential-panels').querySelectorAll('input,button')) {
    node.disabled = Boolean(block) || (node.dataset.clearProvider && !['saved', 'session'].includes(state?.credentials?.[node.dataset.clearProvider]?.source));
    node.title = block || '';
  }
  $('scheduler-toggle').disabled = !connected || pending || Boolean(state?.stopping) || shutdownRequested || (!state?.scheduler?.enabled && Boolean(reason));
  $('scheduler-toggle').title = state?.scheduler?.enabled ? '关闭后当前任务仍会完成' : reason || '立即检查并在后台持续运行';
  for (const node of document.querySelectorAll('[data-download-kind]')) node.disabled = node.dataset.available !== 'true' || !connected || pending || Boolean(state?.runtime?.running) || Boolean(state?.stopping) || shutdownRequested;
  $('export-job').disabled = !state?.config?.jobs.length || pending;
  $('shutdown-tool').disabled = !connected || pending || shutdownRequested || Boolean(state?.stopping);
  $('save-hint').textContent = block || (draftVersion !== state?.configVersion
    ? '配置已被其他窗口更新。请先撤销修改以载入最新版，再重新编辑。'
    : dirty ? '有未保存的修改 · 保存不会触发签发。' : '保存不会修改 DNS 或申请证书。');
  $('save-config').disabled = Boolean(block) || !dirty || draftVersion !== state?.configVersion;
  $('reset-config').disabled = Boolean(block) || !draft || !dirty && draftVersion === state?.configVersion;
  $('clear-job-search').disabled = Boolean(block) || !jobSearchText;
  $('draft-banner').hidden = !dirty || currentView === 'config';
  document.querySelector('[data-view="config"]').classList.toggle('has-draft', dirty);
}
function freshJob(id = '') {
  return { id, enabled: true, domains: [], challenge: { type: 'dns', provider: 'dnspod-token' }, deployment: null, __checkText: '["nginx", "-t"]', __reloadText: '["nginx", "-s", "reload"]', __directory: '', __domainsText: '' };
}
function loadDraft(config, version) {
  draftVersion = version;
  dirty = false;
  validationVisible = false;
  jobSearchText = '';
  $('job-search').value = '';
  $('validation-summary').hidden = true;
  draft = structuredClone(config ?? { email: '', acceptTerms: false, environment: 'staging', legoPath: 'lego', dataDir: './data', jobs: [freshJob('my-domain')] });
  for (const job of draft.jobs) {
    job.__originalId = job.id;
    job.__domainsText = job.domains.join('\n');
    job.__checkText = JSON.stringify(job.deployment?.checkCommand ?? ['nginx', '-t']);
    job.__reloadText = JSON.stringify(job.deployment?.reloadCommand ?? ['nginx', '-s', 'reload']);
    job.__directory = job.deployment?.directory ?? '';
  }
  $('config-email').value = draft.email;
  $('config-environment').value = draft.environment ?? 'staging';
  $('config-terms').checked = draft.acceptTerms === true;
  $('config-lego').value = draft.legoPath ?? 'lego';
  $('config-data').value = draft.dataDir ?? './data';
  updateEnvironmentHelp();
  renderEditors();
}
function markDirty() {
  dirty = true;
  if (validationVisible) validateDraft(false);
  else renderTaskNavigation();
  updateControls();
}
function updateEnvironmentHelp() {
  $('environment-help').textContent = $('config-environment').value === 'staging'
    ? '测试证书不被浏览器信任，不能自动部署。'
    : '正式证书可用于实际服务。切换环境后会显示该环境独立的证书与记录。';
}
function selectEditor(index, { focusField, focusHeading = false } = {}) {
  rememberEditorUi();
  selectedEditor = Math.max(0, Math.min(index, draft.jobs.length - 1));
  const job = draft.jobs[selectedEditor];
  if (job && !jobMatchesSearch(job)) { jobSearchText = ''; $('job-search').value = ''; }
  renderEditors();
  requestAnimationFrame(() => {
    revealSelectedJob();
    if (focusField) focusEditorField(`job-${selectedEditor}-${focusField}`);
    else if (focusHeading) {
      const heading = $('job-editor-title');
      heading?.focus({ preventScroll: true });
      if (matchMedia('(max-width:650px)').matches) heading?.scrollIntoView({ block: 'start' });
    }
  });
}
function rememberEditorUi() {
  const panel = $('job-editors').querySelector('.job-editor');
  const job = panel?.jobDraft;
  if (!job || !draft.jobs.includes(job)) return;
  job.__deployOpen = Boolean(panel.querySelector('.advanced-deploy')?.open);
  job.__textareaScroll = Object.fromEntries([...panel.querySelectorAll('textarea')].map((node) => [node.id.replace(/^job-\d+-/, ''), { top: node.scrollTop, left: node.scrollLeft }]));
}
function jobMatchesSearch(job) {
  return `${job.id} ${job.__domainsText}`.toLowerCase().includes(jobSearchText);
}
function revealSelectedJob(index = selectedEditor) {
  const list = $('job-selector');
  const selected = list.querySelector(`[data-editor-index="${index}"]`);
  if (!selected || list.clientHeight === 0) return;
  const bounds = list.getBoundingClientRect(), item = selected.getBoundingClientRect();
  if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
  else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
}
function focusEditorField(id) {
  const node = $(id);
  if (!node) return;
  node.closest('details')?.setAttribute('open', '');
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: 'center' });
}
function renderTaskNavigation(errors = []) {
  if (!draft) return;
  const list = $('job-selector');
  const scrollTop = list.scrollTop;
  const focusedIndex = list.contains(document.activeElement) ? document.activeElement.dataset.editorIndex : null;
  const matches = draft.jobs.map((job, index) => ({ job, index })).filter(({ job }) => jobMatchesSearch(job));
  const selectedInResults = matches.some((item) => item.index === selectedEditor);
  const invalidTasks = new Set(errors.map((error) => error.id?.match(/^job-(\d+)-/)?.[1]).filter(Boolean));
  $('job-navigation-count').textContent = draft.jobs.length;
  const current = draft.jobs[selectedEditor];
  $('job-search-status').textContent = `显示 ${matches.length} / ${draft.jobs.length} 个任务${current ? ` · 当前第 ${selectedEditor + 1} 个` : ''}`;
  list.replaceChildren(...matches.map(({ job, index }) => {
    const choice = button('', `job-choice${index === selectedEditor ? ' selected' : ''}${invalidTasks.has(String(index)) ? ' has-errors' : ''}`, () => selectEditor(index, { focusHeading: true }));
    choice.dataset.editorIndex = String(index);
    choice.tabIndex = index === selectedEditor || !selectedInResults && index === matches[0]?.index ? 0 : -1;
    choice.setAttribute('aria-current', index === selectedEditor ? 'true' : 'false');
    choice.setAttribute('aria-controls', 'job-editors');
    const domains = job.__domainsText.trim().split(/[\s,，]+/).filter(Boolean);
    const fullName = job.id || '未命名任务';
    choice.title = `${fullName}\n${domains.join('\n') || '尚未填写域名'}`;
    choice.setAttribute('aria-label', `任务 ${index + 1}：${fullName}${domains.length ? `，${domains.join('，')}` : '，尚未填写域名'}${invalidTasks.has(String(index)) ? '，配置需要修正' : ''}`);
    const label = el('strong', '', fullName);
    const domainSummary = domains.length ? `${domains[0]}${domains.length > 1 ? ` · +${domains.length - 1}` : ''}` : '填写域名开始配置';
    choice.replaceChildren(el('span', 'editor-number', String(index + 1).padStart(2, '0')), label, el('small', '', domainSummary));
    return choice;
  }));
  if (!matches.length) {
    const empty = el('div', 'job-search-empty', draft.jobs.length ? '没有匹配的任务。清除搜索可查看全部任务；当前编辑内容会保留。' : '暂无任务。点击“新增任务”开始配置。');
    list.append(empty);
  }
  list.scrollTop = scrollTop;
  if (focusedIndex !== null) list.querySelector(`[data-editor-index="${focusedIndex}"]`)?.focus({ preventScroll: true });
}
function field(id, labelText, { type = 'text', value = '', placeholder = '', help = '', required = false, rows, options, onInput } = {}) {
  const wrapper = el('div', 'field');
  const label = el('label', '', labelText); label.htmlFor = id;
  const input = document.createElement(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  input.id = id;
  if (options) for (const [optionValue, optionLabel] of options) { const option = el('option', '', optionLabel); option.value = optionValue; input.append(option); }
  else if (type !== 'textarea') input.type = type;
  input.value = value;
  input.required = required;
  if (placeholder) input.placeholder = placeholder;
  if (rows) input.rows = rows;
  input.spellcheck = false;
  if (onInput) input.addEventListener(options ? 'change' : 'input', () => { onInput(input.value); markDirty(); });
  wrapper.append(label, input);
  if (help) { const hint = el('small', '', help); hint.id = `${id}-help`; input.setAttribute('aria-describedby', hint.id); wrapper.append(hint); }
  return { wrapper, input };
}
function renderEditors() {
  selectedEditor = Math.max(0, Math.min(selectedEditor, draft.jobs.length - 1));
  const index = selectedEditor;
  const job = draft.jobs[index];
  if (!job) {
    const empty = el('div', 'panel empty-state');
    empty.append(icon('file'), el('h3', '', '至少需要一个证书任务'), el('p', '', '点击“新增任务”填写需要签发证书的域名。'));
    $('job-editors').replaceChildren(empty);
    renderTaskNavigation();
    if (validationVisible) applyDraftErrors(collectDraftErrors());
    updateControls();
    return;
  }
    const prefix = `job-${index}`;
    const panel = el('section', 'panel job-editor');
    panel.jobDraft = job;
    const heading = el('div', 'section-heading');
    const title = el('div', 'editor-heading');
    const editorTitle = el('h3', '', `编辑任务 ${index + 1} / ${draft.jobs.length}`); editorTitle.id = 'job-editor-title'; editorTitle.tabIndex = -1;
    title.append(el('span', 'editor-number', String(index + 1).padStart(2, '0')), editorTitle);
    const remove = button('移除任务', 'text-button danger-text', async () => {
      if (!await confirmAction(`移除任务 ${job.id || '未命名'}？`, '此操作会从配置草稿中移除任务，保存后生效。已签发的证书文件会保留。', '移除任务')) return;
      const removedIndex = draft.jobs.indexOf(job);
      if (removedIndex < 0) return;
      draft.jobs.splice(removedIndex, 1);
      dirty = true;
      jobSearchText = ''; $('job-search').value = '';
      selectEditor(Math.min(removedIndex, draft.jobs.length - 1), { focusField: 'id' });
      if (!draft.jobs.length) $('add-job').focus();
    });
    heading.append(title, remove);
    const scheduling = el('div', 'job-scheduling');
    const schedulingLabel = el('label', 'checkbox-line');
    const scheduleEnabled = el('input'); scheduleEnabled.type = 'checkbox'; scheduleEnabled.id = `${prefix}-enabled`; scheduleEnabled.checked = job.enabled !== false;
    schedulingLabel.htmlFor = scheduleEnabled.id;
    schedulingLabel.append(scheduleEnabled, el('span', '', '启用此任务，加入自动续期和“检查全部”'));
    scheduling.append(schedulingLabel, el('small', '', '暂停任务不会删除证书，仍可单独手动检查。'));
    scheduleEnabled.addEventListener('change', () => { job.enabled = scheduleEnabled.checked; markDirty(); });
    const grid = el('div', 'form-grid');
    const id = field(`${prefix}-id`, '任务 ID', { value: job.id, placeholder: 'nas-home', required: true, help: '小写字母、数字、短横线或下划线。修改已有 ID 会使用新的证书存储目录。', onInput: (value) => { job.id = value; } });
    id.input.pattern = '[a-z0-9][a-z0-9_-]{0,63}';
    const domains = field(`${prefix}-domains`, '域名', { type: 'textarea', value: job.__domainsText, placeholder: 'example.com\n*.example.com', required: true, help: '每行一个域名，也可以用空格或逗号分隔。无需 https://。', rows: 3, onInput: (value) => { job.__domainsText = value; } });
    grid.append(id.wrapper, domains.wrapper);
    const challengeRow = el('div', 'job-challenge-row');
    const challengeFields = el('div');
    const method = field(`${prefix}-method`, '域名验证方式', { value: job.challenge.type, options: [['dns', 'DNS 验证 · 支持通配符'], ['http', 'HTTP 文件验证']], help: 'DNS 验证适用于 NAS 和内网服务。', onInput: (value) => {
      job.challenge = value === 'dns' ? { type: 'dns', provider: 'dnspod-token' } : { type: 'http', webroot: '' };
      renderChallenge();
    } });
    function renderChallenge() {
      const challenge = job.challenge.type === 'dns'
        ? field(`${prefix}-provider`, 'DNS 服务商', { value: job.challenge.provider === 'dnspod' ? 'tencentcloud' : job.challenge.provider, options: Object.entries(providers).map(([value, provider]) => [value, provider.name]), help: 'API 密钥在「DNS 凭据」页面单独填写。', onInput: (value) => { job.challenge.provider = value; } })
        : field(`${prefix}-webroot`, '网站根目录（webroot）', { value: job.challenge.webroot ?? '', placeholder: '/var/www/html', required: true, help: '公网需能通过 80 端口访问此目录；不支持通配符。', onInput: (value) => { job.challenge.webroot = value; } });
      challengeFields.replaceChildren(challenge.wrapper);
    }
    renderChallenge();
    challengeRow.append(method.wrapper, challengeFields);
    const advanced = el('details', 'advanced-deploy');
    const summary = el('summary', '', '自动部署'); summary.append(el('span', '', '宝塔 / Nginx / Docker'));
    advanced.open = job.__deployOpen ?? Boolean(job.deployment);
    const label = el('label', 'checkbox-line');
    const enabled = el('input'); enabled.type = 'checkbox'; enabled.id = `${prefix}-deploy-enabled`; enabled.checked = Boolean(job.deployment);
    label.htmlFor = enabled.id;
    label.append(enabled, el('span', '', '签发或续期成功后，自动更新证书并重载服务'));
    const deploy = el('div', 'deploy-fields');
    deploy.hidden = !job.deployment;
    const note = el('div', 'deploy-note', '仅正式环境可启用。命令将在运行本工具的主机上执行，填写前请确认目标目录和命令正确。NAS 管理页面请使用手动导入。');
    const directory = field(`${prefix}-directory`, '证书部署目录', { value: job.__directory, placeholder: '/srv/https-certs/nas-home', help: '工具将写入 fullchain.pem 和 privkey.pem；目录需有写入权限。', onInput: (value) => { job.__directory = value; } });
    const commands = el('div', 'form-grid');
    const check = field(`${prefix}-check`, '配置检查命令', { type: 'textarea', value: job.__checkText, rows: 2, help: 'JSON 参数数组，例如 ["nginx", "-t"]。', onInput: (value) => { job.__checkText = value; } });
    const reload = field(`${prefix}-reload`, '服务重载命令', { type: 'textarea', value: job.__reloadText, rows: 2, help: '例如 ["docker", "exec", "web-nginx", "nginx", "-s", "reload"]。', onInput: (value) => { job.__reloadText = value; } });
    commands.append(check.wrapper, reload.wrapper);
    deploy.append(note, directory.wrapper, commands);
    enabled.addEventListener('change', () => { job.deployment = enabled.checked ? {} : null; deploy.hidden = !enabled.checked; markDirty(); });
    advanced.append(summary, label, deploy);
    panel.append(heading, scheduling, grid, challengeRow, advanced);
  $('job-editors').replaceChildren(panel);
  const errors = validationVisible ? collectDraftErrors() : [];
  renderTaskNavigation(errors);
  if (validationVisible) applyDraftErrors(errors);
  updateControls();
  requestAnimationFrame(() => {
    revealSelectedJob();
    for (const node of panel.querySelectorAll('textarea')) {
      const saved = job.__textareaScroll?.[node.id.replace(/^job-\d+-/, '')];
      if (saved) { node.scrollTop = saved.top; node.scrollLeft = saved.left; }
    }
  });
}
function configFromDraft() {
  const jobs = draft.jobs.map((job) => {
    let deployment = null;
    if (job.deployment) {
      let checkCommand, reloadCommand;
      try { checkCommand = JSON.parse(job.__checkText); reloadCommand = JSON.parse(job.__reloadText); }
      catch { throw new Error(`任务 ${job.id || '未命名'} 的部署命令必须是 JSON 参数数组，例如 ["nginx", "-t"]。`); }
      if (![checkCommand, reloadCommand].every((args) => Array.isArray(args) && args.length && args.every((arg) => typeof arg === 'string' && arg.trim()))) throw new Error(`任务 ${job.id} 的部署命令必须包含有效的字符串参数。`);
      deployment = { directory: job.__directory.trim(), checkCommand, reloadCommand };
    }
    return { id: job.id.trim(), enabled: job.enabled !== false, domains: job.__domainsText.trim().split(/[\s,，]+/).filter(Boolean), challenge: structuredClone(job.challenge), deployment };
  });
  return { email: $('config-email').value.trim(), environment: $('config-environment').value, acceptTerms: $('config-terms').checked, legoPath: $('config-lego').value.trim() || 'lego', dataDir: $('config-data').value.trim() || './data', jobs };
}
function deploymentDirectoryKey(value) {
  // Use the server's path rules, never the browser's operating system. This key
  // is only for validation; the original directory remains in the draft.
  const base = state?.app?.baseDir || '';
  const normalizeParts = (tail, separator, allowAboveRoot = false) => {
    const parts = [];
    for (const part of tail.split(separator)) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (parts.length && parts.at(-1) !== '..') parts.pop();
        else if (allowAboveRoot) parts.push(part);
      } else parts.push(part);
    }
    return parts.join(separator);
  };
  if (state?.app?.platform !== 'win32') {
    const resolved = value.startsWith('/') ? value : `${base}/${value}`;
    const absolute = value.startsWith('/') || base.startsWith('/');
    return `${absolute ? '/' : '\0relative/'}${normalizeParts(resolved, '/', !absolute)}`;
  }
  const parse = (input) => {
    const path = input.replaceAll('/', '\\');
    const unc = path.match(/^\\\\([^\\]+)\\+([^\\]+)(?:\\|$)/);
    if (unc) return { device: `\\\\${unc[1]}\\${unc[2]}`, absolute: true, tail: path.slice(unc[0].length) };
    const drive = path.match(/^([a-z]:)(\\)?/i);
    if (drive) return { device: drive[1], absolute: Boolean(drive[2]), tail: path.slice(drive[0].length) };
    return { device: '', absolute: path.startsWith('\\'), tail: path };
  };
  const target = parse(value);
  const origin = parse(base);
  const device = target.device || origin.device;
  let absolute = target.absolute;
  let tail = target.tail;
  if (!absolute) {
    if (!target.device || target.device.toLowerCase() === origin.device.toLowerCase()) {
      tail = `${origin.tail}\\${tail}`;
      absolute = origin.absolute;
    } else {
      // Other-drive relative paths depend on the server's per-drive working
      // directory. Keep them distinct from absolute paths; the server validates
      // their final destinations when saving.
      return `\0drive-relative:${target.device}\\${normalizeParts(tail, '\\', true)}`.toLowerCase();
    }
  }
  return `${absolute ? device + '\\' : '\0relative:' + device}${normalizeParts(tail, '\\', !absolute)}`.toLowerCase();
}
function collectDraftErrors() {
  const errors = [];
  const seenIds = new Map();
  const seenDirectories = new Map();
  const invalid = (id, message) => {
    if (!errors.some((error) => error.id === id && error.message === message)) errors.push({ id, message });
  };
  const email = $('config-email');
  if (!email.value.trim() || !email.validity.valid) invalid('config-email', '请输入有效的联系邮箱。');
  if (!draft.jobs.length) errors.push({ message: '请至少添加一个证书任务。' });
  draft.jobs.forEach((job, index) => {
    const prefix = `job-${index}`;
    const id = job.id.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) invalid(`${prefix}-id`, '使用 1–64 位小写字母、数字、短横线或下划线，且不能使用系统保留名称。');
    if (seenIds.has(id)) {
      invalid(`${prefix}-id`, '此任务 ID 与其他任务重复，请使用不同的名称。');
      invalid(`job-${seenIds.get(id)}-id`, '此任务 ID 与其他任务重复，请使用不同的名称。');
    } else seenIds.set(id, index);
    const domains = job.__domainsText.trim().split(/[\s,，]+/).filter(Boolean);
    if (!domains.length || domains.length > 100) invalid(`${prefix}-domains`, '请填写 1–100 个域名。');
    else {
      const malformed = domains.some((name) => {
        const bare = name.startsWith('*.') ? name.slice(2) : name;
        if (/[\x00-\x20\s/:#?@%\\*]/.test(bare)) return true;
        try {
          const normalized = new URL(`https://${bare}`).hostname.toLowerCase();
          const labels = normalized.split('.');
          return normalized.length > 253 || labels.length < 2 || !/[a-z]/.test(labels.at(-1)) || labels.some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
        } catch { return true; }
      });
      if (malformed) invalid(`${prefix}-domains`, '请输入完整域名，例如 home.example.com；不要包含协议、端口或路径。');
      else if (job.challenge.type === 'http' && domains.some((name) => name.startsWith('*.'))) invalid(`${prefix}-domains`, '通配符证书需要选择 DNS 验证。');
    }
    if (job.challenge.type === 'http' && (!job.challenge.webroot?.trim() || /[\x00-\x1f]/.test(job.challenge.webroot))) invalid(`${prefix}-webroot`, '请填写有效的网站根目录，不能包含控制字符。');
    if (job.deployment) {
      if ($('config-environment').value !== 'production') invalid(`${prefix}-deploy-enabled`, '自动部署需要正式环境。');
      const directory = job.__directory.trim();
      if (!directory || /[\x00-\x1f]/.test(directory)) invalid(`${prefix}-directory`, '请填写有效的证书部署目录，不能包含控制字符。');
      else {
        const directoryKey = deploymentDirectoryKey(directory);
        if (seenDirectories.has(directoryKey)) {
          invalid(`${prefix}-directory`, '该部署目录与其他任务指向相同位置，请为每张证书指定独立目录。');
          invalid(`job-${seenDirectories.get(directoryKey)}-directory`, '该部署目录与其他任务指向相同位置，请为每张证书指定独立目录。');
        } else seenDirectories.set(directoryKey, index);
      }
      for (const [suffix, value] of [['check', job.__checkText], ['reload', job.__reloadText]]) {
        try { const args = JSON.parse(value); if (!Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== 'string' || !arg.trim() || /[\x00-\x1f]/.test(arg))) throw new Error(); }
        catch { invalid(`${prefix}-${suffix}`, '请输入非空 JSON 参数数组，例如 ["nginx", "-t"]。'); }
      }
    }
  });
  const taskIndex = (error) => { const match = error.id?.match(/^job-(\d+)-/); return match ? Number(match[1]) : -1; };
  return errors.sort((a, b) => taskIndex(a) - taskIndex(b));
}
function focusDraftError(error) {
  const matched = error.id?.match(/^job-(\d+)-(.+)$/);
  if (matched) selectEditor(Number(matched[1]), { focusField: matched[2] });
  else if (error.id) focusEditorField(error.id);
  else $('add-job').focus();
}
function applyDraftErrors(errors) {
  for (const node of $('config-form').querySelectorAll('.field-error')) node.remove();
  for (const node of $('config-form').querySelectorAll('[aria-invalid]')) {
    node.removeAttribute('aria-invalid');
    if ($(`${node.id}-help`)) node.setAttribute('aria-describedby', `${node.id}-help`);
    else node.removeAttribute('aria-describedby');
  }
  for (const error of errors) {
    const node = $(error.id);
    if (!node || node.getAttribute('aria-invalid') === 'true') continue;
    node.setAttribute('aria-invalid', 'true');
    const message = el('span', 'field-error', error.message); message.id = `${error.id}-error`;
    node.setAttribute('aria-describedby', [$(`${error.id}-help`) && `${error.id}-help`, message.id].filter(Boolean).join(' '));
    const field = node.closest('.field');
    if (field) field.append(message);
    else node.closest('label')?.after(message);
  }
  const summary = $('validation-summary');
  summary.hidden = !errors.length;
  if (!errors.length) { summary.replaceChildren(); return; }
  const first = errors[0];
  const firstTask = first.id?.match(/^job-(\d+)-/);
  const context = firstTask ? `任务 ${Number(firstTask[1]) + 1}（${draft.jobs[Number(firstTask[1])]?.id || '未命名'}）：` : '';
  const message = el('span', '', `还有 ${errors.length} 处需要修改：${context}${first.message}`);
  summary.replaceChildren(message, button('定位首个问题', 'text-button', () => focusDraftError(first)));
}
function validateDraft(focusFirst = true) {
  const errors = collectDraftErrors();
  applyDraftErrors(errors);
  renderTaskNavigation(errors);
  if (errors.length && focusFirst) focusDraftError(errors[0]);
  return !errors.length;
}
function createCredentialPanels() {
  for (const [key, provider] of Object.entries(providers)) {
    const choice = button('', 'provider-choice', () => selectProvider(key));
    choice.id = `provider-choice-${key}`;
    choice.replaceChildren(el('strong', '', provider.name));
    const choiceStatus = el('small', '', '未配置'); choiceStatus.id = `provider-choice-status-${key}`;
    choice.append(choiceStatus); $('provider-selector').append(choice);
    const form = el('form', 'panel credential-panel'); form.id = `credentials-${key}`; form.autocomplete = 'off';
    const heading = el('div', 'section-heading');
    const title = el('div', 'credential-provider');
    const logo = el('span', 'provider-logo'); logo.append(icon(key === 'tencentcloud' ? 'server' : 'key'));
    const copy = el('div'); copy.append(el('h2', '', provider.name), el('small', '', provider.subtitle));
    title.append(logo, copy);
    const badge = pill('未配置'); badge.id = `credential-status-${key}`;
    heading.append(title, badge);
    const grid = el('div', 'form-grid');
    for (const [name, label] of provider.fields) {
      const item = field(`credential-${name}`, label, { type: name === 'DNSPOD_API_ID' ? 'text' : 'password', value: '', placeholder: `输入 ${label}`, required: true, help: name === 'DNSPOD_API_ID' ? '创建 Token 时显示的数字 ID，与 Token 分开填写。' : '' });
      item.input.autocomplete = 'new-password';
      item.input.minLength = name === 'DNSPOD_API_ID' ? 1 : 8;
      if (name === 'DNSPOD_API_ID') { item.input.pattern = '[0-9]+'; item.input.inputMode = 'numeric'; }
      item.input.maxLength = 4096;
      item.input.name = name;
      if (item.input.type === 'password') {
        const reveal = button('显示', 'text-button reveal-secret', () => {
          const showing = item.input.type === 'password'; item.input.type = showing ? 'text' : 'password'; reveal.textContent = showing ? '隐藏' : '显示'; reveal.setAttribute('aria-pressed', String(showing));
        });
        reveal.setAttribute('aria-label', `显示或隐藏 ${label}`); reveal.setAttribute('aria-pressed', 'false');
        const secretWrapper = el('div', 'secret-input'); item.input.replaceWith(secretWrapper); secretWrapper.append(item.input, reveal);
      }
      grid.append(item.wrapper);
    }
    const persistence = el('label', 'checkbox-line persistence-option');
    const persist = el('input'); persist.type = 'checkbox'; persist.id = `credential-persist-${key}`; persist.checked = true; persist.defaultChecked = true;
    persistence.append(persist, el('span', '', '长期保存在服务端，重启工具后自动读取'));
    const bottom = el('div', 'credential-bottom');
    const source = el('p', '', '尚未配置'); source.id = `credential-source-${key}`;
    const actions = el('div', 'button-group');
    const clear = button('移除凭据', 'text-button danger-text', async () => {
      if (!await confirmAction(`移除 ${provider.name} 凭据？`, '会移除已长期保存的凭据及本次会话凭据。对应任务需要重新配置后才能申请或续期；环境变量中的凭据仍可使用。', '移除凭据')) return;
      operate(async () => { adopt(await post('/api/credentials/clear', { provider: key })); form.reset(); toast('已移除保存的凭据。'); });
    });
    clear.dataset.clearProvider = key;
    const submit = button('保存凭据', 'button primary', null, 'check'); submit.type = 'submit';
    actions.append(clear, submit); bottom.append(source, actions);
    const instructions = el('div', 'credential-instructions');
    instructions.append(el('p', '', '首次配置时完整填写；更换密钥时填写一组新凭据。保存不会修改 DNS。'));
    if (provider.link) { const link = el('a', 'text-button', provider.linkLabel); link.href = provider.link; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.append(icon('link')); instructions.append(link); }
    form.append(heading, instructions, grid, persistence, bottom);
    form.addEventListener('submit', (event) => { event.preventDefault(); operate(async () => {
      const values = Object.fromEntries(provider.fields.map(([name]) => [name, $(`credential-${name}`).value.trim()]));
      const persistent = persist.checked;
      const next = await post('/api/credentials', { provider: key, values, persist: persistent });
      form.reset();
      for (const input of form.querySelectorAll('.secret-input input')) input.type = 'password';
      for (const toggle of form.querySelectorAll('.reveal-secret')) { toggle.textContent = '显示'; toggle.setAttribute('aria-pressed', 'false'); }
      adopt(next);
      toast(`${provider.name} 凭据已${persistent ? '长期保存，重启后会自动读取' : '保存至本次服务会话'}。`);
    }); });
    $('credential-panels').append(form);
  }
  selectProvider(selectedProvider);
}
function selectProvider(key) {
  if (!providers[key]) return;
  selectedProvider = key;
  for (const provider of Object.keys(providers)) {
    $(`credentials-${provider}`).hidden = provider !== key;
    $(`provider-choice-${provider}`).classList.toggle('selected', provider === key);
    $(`provider-choice-${provider}`).setAttribute('aria-current', provider === key ? 'true' : 'false');
  }
}
function renderCredentialsStatus() {
  const storage = state.credentialStorage;
  $('credential-storage-text').textContent = storage?.error ? `凭据存储需要处理：${storage.error}` : `凭据默认长期保存在服务端，重启后自动读取。${storage?.label ? `${storage.label}。` : ''}页面不会回显已保存的密钥。`;
  $('credential-storage-notice').className = `banner ${storage?.error ? 'warning' : 'info'}`;
  $('credential-storage-badge').textContent = storage?.error ? '存储需要处理' : '支持长期保存';
  for (const key of Object.keys(providers)) {
    const status = state.credentials?.[key];
    const badge = $(`credential-status-${key}`);
    const sourceLabel = status?.source === 'saved' ? '已长期保存' : status?.source === 'session' ? '仅本次会话' : status?.source === 'environment' ? '使用环境变量' : '未配置';
    badge.textContent = sourceLabel;
    badge.className = `pill ${status?.configured ? 'teal' : 'neutral'}-pill`;
    const usages = state.config?.jobs.filter((job) => normalizeProvider(job.challenge?.provider) === key).length ?? 0;
    $(`provider-choice-status-${key}`).textContent = `${sourceLabel}${usages ? ` · ${usages} 个任务` : ''}`;
    $(`credential-source-${key}`).textContent = status?.source === 'saved' ? '重启服务后会自动读取' : status?.source === 'session' ? '关闭服务后清除 · 可重新填写并长期保存' : status?.source === 'environment' ? '来自运行服务的环境变量' : '填写后可自动完成 DNS 验证';
  }
}
function renderExports(jobs, statuses) {
  const selected = $('export-job').value || jobs[0]?.id || '';
  const signature = JSON.stringify([jobs.map((job) => [job.id, job.domains]), statuses, selected, state.config?.environment, state.statusError]);
  if (signature === exportSignature) return;
  exportSignature = signature;
  const previous = selected;
  $('export-job').replaceChildren(...jobs.map((job) => { const option = el('option', '', `${job.id} · ${job.domains[0] ?? ''}`); option.value = job.id; return option; }));
  if (jobs.some((job) => job.id === previous)) $('export-job').value = previous;
  if (!jobs.length) { const option = el('option', '', '暂无证书任务'); option.value = ''; $('export-job').append(option); }
  const jobId = $('export-job').value;
  const status = statuses.find((item) => item.id === jobId);
  const available = Boolean(status?.state?.exportFiles && status?.certificate?.status === 'valid' && Date.parse(status.certificate.validTo) > Date.now());
  $('export-status').textContent = available
    ? `${state.config.environment === 'staging' ? '当前为测试环境证书，不适用于正式服务。' : '可下载当前已签发的证书文件。'}证书到期：${date(status.certificate.validTo)}。${status.state?.lastError ? '最近检查存在错误，请结合活动记录确认部署情况。' : ''}`
    : state.statusError ? '证书状态读取失败，暂时无法确认可导出的文件。' : '此任务尚无可用导出文件。请先在工作台中成功申请证书。';
  const bundle = button('下载全部 PEM（ZIP）', 'button primary', () => downloadExport(jobId, 'bundle', 'certificates.zip'), 'download');
  bundle.dataset.downloadKind = 'bundle'; bundle.dataset.available = String(available);
  const bundleBar = el('div', 'export-bundle'); bundleBar.append(el('div', '', '包含证书、私钥、中间证书与完整证书链。'), bundle);
  $('export-files').replaceChildren(bundleBar, ...exportKinds.map((item) => {
    const card = el('div', 'export-file');
    const copy = el('div', 'export-file-copy'); copy.append(el('strong', '', item.filename), el('small', '', item.label));
    const download = button('下载', 'button secondary small-button', () => downloadExport(jobId, item.kind, item.filename), 'download');
    download.dataset.downloadKind = item.kind;
    download.dataset.available = String(available && Boolean(status?.state?.exportFiles?.[item.kind]));
    download.setAttribute('aria-label', `下载 ${item.filename}`);
    card.append(icon(item.icon), copy, download);
    return card;
  }));
}
async function downloadExport(jobId, kind, filename) {
  await operate(async () => {
    const blob = await post('/api/export', { id: jobId, kind }, true);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${jobId}-${filename}`; anchor.hidden = true;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`${filename} 已下载。`);
  });
}
async function checkEnvironment(only) {
  await operate(async () => {
    preflightRunning = true; updateControls();
    $('preflight-title').textContent = only ? `运行环境检查 · ${only}` : '运行环境检查';
    $('preflight-summary').textContent = '正在检查，请稍候…';
    $('preflight-results').replaceChildren();
    $('preflight-dialog').showModal();
    try {
      const result = await post('/api/preflight', only ? { only } : {});
      const failed = result.checks.filter((item) => item.status === 'fail').length;
      const warnings = result.checks.filter((item) => item.status === 'warning').length;
      $('preflight-summary').textContent = `${failed ? `${failed} 项未通过` : '基础检查通过'}${warnings ? ` · ${warnings} 项提示` : ''} · ${date(result.checkedAt)}`;
      $('preflight-results').replaceChildren(...result.checks.map((check) => {
        const row = el('div', 'preflight-check'); const info = el('div');
        info.append(el('strong', '', check.label), el('p', '', check.detail));
        row.append(pill(check.status === 'pass' ? '通过' : check.status === 'warning' ? '提示' : '未通过', check.status === 'pass' ? 'teal' : check.status === 'warning' ? 'amber' : 'red'), info);
        return row;
      }));
    } catch (error) { $('preflight-summary').textContent = `检查未完成：${error.message}`; }
    finally { preflightRunning = false; }
  });
}
async function runJobs(only, retry = false) {
  if (dirty && !await confirmAction('使用已保存的配置运行？', '证书配置还有未保存的修改。本次将使用之前保存的配置，草稿会保留。', '运行已保存配置')) return;
  await operate(async () => {
    await post('/api/run', { ...(only ? { only } : {}), ...(retry ? { retry: true } : {}) });
    toast('证书检查已开始，可在活动记录中查看结果。');
    await refresh();
  });
}

// Forms are built once. Polling updates only status text and controls, never entered secrets.
createCredentialPanels();
const logout = button('退出登录', 'text-button', async () => {
  if ((dirty || hasCredentialDraft()) && !await confirmAction('退出登录？', '当前页面还有未保存的配置或凭据输入。退出登录会丢弃这些草稿，后台续期会继续运行。', '退出登录')) return;
  try { const response = await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (!response.ok) throw new Error('退出登录失败，请重试。'); dirty = false; for (const input of document.querySelectorAll('.credential-panel input[name]')) input.value = ''; location.assign('/login'); } catch (error) { toast(error.message, true); }
});
logout.id = 'logout-tool'; logout.hidden = true;
document.querySelector('.topbar-right').append(logout);
const shutdown = button('退出工具', 'text-button shutdown-button', () => {
  $('shutdown-dialog').showModal();
});
shutdown.id = 'shutdown-tool';
document.querySelector('.topbar-right').append(shutdown);
const shutdownDialog = el('dialog'); shutdownDialog.id = 'shutdown-dialog';
const shutdownTitle = el('h2', '', '退出 CertFlow？'); shutdownTitle.id = 'shutdown-title';
shutdownDialog.setAttribute('aria-labelledby', 'shutdown-title');
shutdownDialog.append(shutdownTitle, el('p', '', '服务将在当前证书任务完成后退出。服务退出期间不会自动续期；已保存的凭据与续期设置会保留。'));
const shutdownActions = el('div', 'dialog-footer button-group');
shutdownActions.append(button('继续运行', 'button secondary', () => shutdownDialog.close()), button('停止并退出', 'button primary', () => {
  shutdownDialog.close();
  operate(async () => {
    await post('/api/shutdown');
    shutdownRequested = true;
    if (state) { state.stopping = true; state.scheduler = { enabled: false, nextRunAt: null }; }
    toast('已停止自动续期，将在当前任务完成后退出。');
  });
}));
shutdownDialog.append(shutdownActions); document.body.append(shutdownDialog);

for (const node of document.querySelectorAll('[data-view]')) node.addEventListener('click', () => switchView(node.dataset.view));
for (const node of document.querySelectorAll('[data-goto]')) node.addEventListener('click', () => switchView(node.dataset.goto));
window.addEventListener('hashchange', () => switchView(location.hash.slice(1)));
window.addEventListener('beforeunload', (event) => { if ((dirty || hasCredentialDraft()) && !shutdownRequested) { event.preventDefault(); event.returnValue = ''; } });
for (const id of ['confirm-cancel', 'confirm-action']) $(id).addEventListener('click', () => {
  const resolve = confirmResolve; confirmResolve = null;
  $('confirm-dialog').close(); resolve?.(id === 'confirm-action');
});
$('confirm-dialog').addEventListener('cancel', () => { const resolve = confirmResolve; confirmResolve = null; resolve?.(false); });
$('certificate-search').addEventListener('input', () => { searchText = $('certificate-search').value.trim().toLowerCase(); renderCertificates(state?.config?.jobs ?? [], state?.statuses ?? []); updateControls(); });
$('certificate-filter').addEventListener('change', () => { certificateFilter = $('certificate-filter').value; renderCertificates(state?.config?.jobs ?? [], state?.statuses ?? []); updateControls(); });
$('certificate-sort').addEventListener('change', () => { certificateSort = $('certificate-sort').value; renderCertificates(state?.config?.jobs ?? [], state?.statuses ?? []); updateControls(); });
$('log-filter').addEventListener('change', () => { logFilter = $('log-filter').value; logSignature = ''; renderLogs(); });
for (const id of ['config-email', 'config-terms', 'config-lego', 'config-data']) $(id).addEventListener('input', markDirty);
$('config-environment').addEventListener('change', () => { updateEnvironmentHelp(); markDirty(); });
$('add-job').addEventListener('click', () => {
  if (!draft) return;
  const ids = new Set(draft.jobs.map((job) => job.id));
  let suffix = draft.jobs.length + 1;
  while (ids.has(`certificate-${suffix}`)) suffix++;
  draft.jobs.push(freshJob(`certificate-${suffix}`));
  dirty = true;
  jobSearchText = ''; $('job-search').value = '';
  selectEditor(draft.jobs.length - 1, { focusField: 'id' });
});
$('job-search').addEventListener('input', () => {
  jobSearchText = $('job-search').value.trim().toLowerCase();
  renderTaskNavigation(validationVisible ? collectDraftErrors() : []);
  updateControls();
});
$('job-search').addEventListener('keydown', (event) => {
  if (!['Enter', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const first = $('job-selector').querySelector('[data-editor-index]');
  if (!first) return;
  if (event.key === 'Enter') selectEditor(Number(first.dataset.editorIndex), { focusHeading: true });
  else { first.focus({ preventScroll: true }); revealSelectedJob(Number(first.dataset.editorIndex)); }
});
$('job-selector').addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...$('job-selector').querySelectorAll('[data-editor-index]')];
  const current = items.indexOf(event.target.closest('[data-editor-index]'));
  if (current < 0) return;
  event.preventDefault();
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
  items[target].focus({ preventScroll: true }); revealSelectedJob(Number(items[target].dataset.editorIndex));
});
$('clear-job-search').addEventListener('click', () => {
  jobSearchText = ''; $('job-search').value = '';
  renderTaskNavigation(validationVisible ? collectDraftErrors() : []);
  revealSelectedJob(); updateControls(); $('job-search').focus();
});
$('reset-config').addEventListener('click', async () => {
  if (dirty && !await confirmAction('撤销未保存的修改？', '将重新读取已经保存的配置，当前草稿中的修改会被丢弃。', '撤销修改')) return;
  operate(async () => {
  await refresh();
  if (!connected) throw new Error('无法读取最新配置，请先恢复管理服务连接。');
  loadDraft(state.config, state.configVersion);
  toast('已载入最新保存的配置。');
  });
});
$('config-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (editBlocked()) return;
  validationVisible = true;
  if (!validateDraft()) return;
  operate(async () => {
    const config = configFromDraft();
    const next = await post('/api/config', { config, version: draftVersion });
    adopt(next); loadDraft(next.config, next.configVersion);
    toast('配置已保存。准备好凭据后，可在工作台中开始申请。');
  });
});
$('preview-plan').addEventListener('click', () => operate(async () => {
  const plan = await post('/api/plan');
  $('plan-content').textContent = JSON.stringify(plan, null, 2);
  $('plan-dialog').showModal();
}));
$('plan-dialog').setAttribute('aria-label', '已保存配置的执行计划');
for (const id of ['close-plan', 'close-plan-footer']) $(id).addEventListener('click', () => $('plan-dialog').close());
$('run-all').addEventListener('click', () => runJobs());
$('preflight-all').addEventListener('click', () => checkEnvironment());
for (const id of ['close-preflight', 'close-preflight-footer']) $(id).addEventListener('click', () => $('preflight-dialog').close());
const pausedFilter = el('option', '', '已暂停任务'); pausedFilter.value = 'disabled'; $('certificate-filter').append(pausedFilter);
$('scheduler-toggle').addEventListener('change', () => {
  const enabled = $('scheduler-toggle').checked;
  operate(async () => {
    adopt(await post('/api/scheduler', { enabled }));
    toast(enabled ? '自动续期已开启，重启服务后会恢复。请保持服务或容器运行。' : '自动续期已关闭。正在执行的任务仍会完成。');
  });
});
$('export-job').addEventListener('change', () => { exportSignature = ''; renderExports(state?.config?.jobs ?? [], state?.statuses ?? []); updateControls(); });
switchView(location.hash.slice(1) || 'overview', false);
updateControls();
void poll();
setInterval(updateProgressElapsed, 1000);
$('progress-dismiss').addEventListener('click', () => {
  if (!state?.runtime?.runId || state.runtime.running) return;
  dismissedRunId = state.runtime.runId;
  try { sessionStorage.setItem(dismissedRunKey, dismissedRunId); } catch { /* In-memory dismissal still works. */ }
  renderProgress();
  document.querySelector('.nav-item.active')?.focus({ preventScroll: true });
});
