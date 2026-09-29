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
let selectedProvider = 'dnspod-token';
let searchText = '';
let certificateFilter = 'all';
let certificateSort = 'attention';
let logFilter = 'all';
let validationVisible = false;
let confirmResolve;
let selectedCertificate = '';
let preflightRunning = false;

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
  const runtime = state.runtime ?? {};
  $('runtime-status').hidden = !runtime.running && !runtime.error;
  $('runtime-status').textContent = runtime.running ? `正在${state.config?.environment === 'production' ? '正式' : '测试'}环境检查${runtime.only ? `任务 ${runtime.only}` : '全部任务'}。DNS 验证可能需要几分钟，可在活动记录中查看结果。` : runtime.error ? `上次执行未完成：${runtime.error}` : '';
  updateControls();
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
  if (state.runtime?.running && (state.runtime.only === job.id || !state.runtime.only && job.enabled !== false)) return ['检查中', 'blue'];
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
  const index = draft?.jobs.findIndex((job) => job.id === id);
  if (index >= 0) { selectedEditor = index; selectEditor(index); }
  switchView('config');
}
function showExports(id) {
  $('export-job').value = id;
  exportSignature = '';
  renderExports(state.config.jobs, state.statuses ?? []);
  switchView('exports');
}
function renderCertificates(jobs, statuses) {
  if (!state) return;
  const signature = JSON.stringify([jobs, statuses, state.credentials, state.runtime?.running, state.runtime?.only, state.statusError, state.config?.email, state.config?.environment, searchText, certificateFilter, certificateSort, selectedCertificate]);
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
  $('validation-summary').hidden = true;
  draft = structuredClone(config ?? { email: '', acceptTerms: false, environment: 'staging', legoPath: 'lego', dataDir: './data', jobs: [freshJob('my-domain')] });
  for (const job of draft.jobs) {
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
function markDirty() { dirty = true; updateControls(); if (validationVisible) validateDraft(false); }
function updateEnvironmentHelp() {
  $('environment-help').textContent = $('config-environment').value === 'staging'
    ? '测试证书不被浏览器信任，不能自动部署。'
    : '正式证书可用于实际服务。切换环境后会显示该环境独立的证书与记录。';
}
function selectEditor(index) {
  selectedEditor = Math.max(0, Math.min(index, draft.jobs.length - 1));
  for (const [i, panel] of [...$('job-editors').children].entries()) panel.hidden = i !== selectedEditor;
  for (const [i, node] of [...$('job-selector').children].entries()) { node.classList.toggle('selected', i === selectedEditor); node.setAttribute('aria-current', i === selectedEditor ? 'true' : 'false'); }
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
  $('job-editors').replaceChildren(...draft.jobs.map((job, index) => {
    const prefix = `job-${index}`;
    const panel = el('section', 'panel job-editor');
    const heading = el('div', 'section-heading');
    const title = el('div', 'editor-heading');
    title.append(el('span', 'editor-number', String(index + 1).padStart(2, '0')), el('h3', '', '证书任务'));
    const remove = button('移除任务', 'text-button danger-text', async () => {
      if (!await confirmAction(`移除任务 ${job.id || '未命名'}？`, '此操作会从配置草稿中移除任务，保存后生效。已签发的证书文件会保留。', '移除任务')) return;
      draft.jobs.splice(index, 1); selectedEditor = Math.max(0, index - 1); markDirty(); renderEditors();
      ($(`job-${selectedEditor}-id`) ?? $('add-job')).focus();
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
    const id = field(`${prefix}-id`, '任务 ID', { value: job.id, placeholder: 'nas-home', required: true, help: '小写字母、数字、短横线或下划线。修改已有 ID 会使用新的证书存储目录。', onInput: (value) => { job.id = value; $(`editor-label-${index}`).textContent = value || '未命名任务'; } });
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
    advanced.open = Boolean(job.deployment);
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
    return panel;
  }));
  $('job-selector').replaceChildren(...draft.jobs.map((job, index) => {
    const choice = button('', 'job-choice', () => selectEditor(index));
    choice.replaceChildren();
    const label = el('strong', '', job.id || '未命名任务'); label.id = `editor-label-${index}`;
    choice.append(el('span', 'editor-number', String(index + 1).padStart(2, '0')), label, el('small', '', job.domains[0] ?? '填写域名开始配置'));
    return choice;
  }));
  selectEditor(selectedEditor);
  if (!draft.jobs.length) {
    const empty = el('div', 'panel empty-state'); empty.append(icon('file'), el('h3', '', '至少需要一个证书任务'), el('p', '', '点击「新增任务」填写需要签发证书的域名。'));
    $('job-editors').append(empty);
  }
  updateControls();
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
function validateDraft(focusFirst = true) {
  for (const node of $('config-form').querySelectorAll('.field-error')) node.remove();
  for (const node of $('config-form').querySelectorAll('[aria-invalid]')) node.removeAttribute('aria-invalid');
  const errors = [];
  function invalid(id, message) {
    const node = $(id); if (!node) return;
    node.setAttribute('aria-invalid', 'true');
    const error = el('span', 'field-error', message); error.id = `${id}-error`;
    node.setAttribute('aria-describedby', [$( `${id}-help`) && `${id}-help`, error.id].filter(Boolean).join(' '));
    node.closest('.field')?.append(error);
    errors.push({ id, message });
  }
  const email = $('config-email');
  if (!email.value.trim() || !email.validity.valid) invalid('config-email', '请输入有效的联系邮箱。');
  if (!draft.jobs.length) errors.push({ message: '请至少添加一个证书任务。' });
  const ids = new Set();
  draft.jobs.forEach((job, index) => {
    const prefix = `job-${index}`;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(job.id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(job.id)) invalid(`${prefix}-id`, '使用 1–64 位小写字母、数字、短横线或下划线，且不能使用系统保留名称。');
    else if (ids.has(job.id)) invalid(`${prefix}-id`, '此任务 ID 已存在，请使用不同的名称。');
    ids.add(job.id);
    const domains = job.__domainsText.trim().split(/[\s,，]+/).filter(Boolean);
    if (!domains.length || domains.length > 100) invalid(`${prefix}-domains`, '请填写 1–100 个域名。');
    else {
      const malformed = domains.some((name) => {
        const bare = name.startsWith('*.') ? name.slice(2) : name;
        if (/[\s/:#?@\\*]/.test(bare) || !bare.includes('.')) return true;
        try { const normalized = new URL(`https://${bare}`).hostname; return normalized.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)); } catch { return true; }
      });
      if (malformed) invalid(`${prefix}-domains`, '请输入完整域名，例如 home.example.com；不要包含协议、端口或路径。');
      else if (job.challenge.type === 'http' && domains.some((name) => name.startsWith('*.'))) invalid(`${prefix}-domains`, '通配符证书需要选择 DNS 验证。');
    }
    if (job.challenge.type === 'http' && !job.challenge.webroot?.trim()) invalid(`${prefix}-webroot`, '请填写网站根目录。');
    if (job.deployment) {
      if ($('config-environment').value !== 'production') errors.push({ id: `${prefix}-deploy-enabled`, message: `任务 ${job.id}：自动部署需要正式环境。` });
      if (!job.__directory.trim()) invalid(`${prefix}-directory`, '请填写证书部署目录。');
      for (const [suffix, value] of [['check', job.__checkText], ['reload', job.__reloadText]]) {
        try { const args = JSON.parse(value); if (!Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== 'string' || !arg.trim())) throw new Error(); }
        catch { invalid(`${prefix}-${suffix}`, '请输入非空 JSON 参数数组，例如 ["nginx", "-t"]。'); }
      }
    }
  });
  const summary = $('validation-summary');
  summary.hidden = !errors.length;
  summary.textContent = errors.length ? `还有 ${errors.length} 处需要修改：${errors[0].message}` : '';
  if (errors.length && focusFirst) {
    const first = errors.find((error) => error.id);
    const matched = first?.id.match(/^job-(\d+)-/);
    if (matched) selectEditor(Number(matched[1]));
    if (first) { $(first.id).closest('details')?.setAttribute('open', ''); $(first.id).focus(); }
    else summary.scrollIntoView({ block: 'center' });
  }
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
  selectedEditor = draft.jobs.length - 1;
  dirty = true; renderEditors();
  $(`job-${draft.jobs.length - 1}-id`).focus();
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
