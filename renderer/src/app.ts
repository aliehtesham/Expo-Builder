/* Expo Builder — renderer application logic */
(() => {
  'use strict';

  const $ = <E extends HTMLElement = HTMLElement>(sel: string): E => document.querySelector(sel) as E;
  const $$ = <E extends HTMLElement = HTMLElement>(sel: string): E[] => Array.from(document.querySelectorAll(sel)) as E[];

  const PHASES: Record<string, string> = {
    init: 'Starting',
    dependencies: 'Installing dependencies',
    prebuild: 'Expo prebuild',
    prepare: 'Preparing workspace',
    keystore: 'Configuring keystore',
    gradle: 'Gradle build',
    collect: 'Collecting outputs',
    verify: 'Verifying signature',
    done: 'Completed',
  };

  interface ProjectEntry {
    dir: string;
    name: string;
    ts: number;
  }

  interface AppState {
    project: ProjectInfo | null;
    appName: string | null;
    pendingProject: ProjectInfo | null;
    projects: ProjectEntry[];
    page: string;
    format: BuildFormat;
    archs: Set<string>;
    signed: boolean;
    country: string;
    relocate: boolean;
    targetSdk: string;
    artifacts: ArtifactInfo[];
    keystore: KeystoreInfo | null;
    phase: string | null;
    lastPhase: string | null;
    buildRunning: boolean;
    buildCfg: BuildMetaCfg | null;
    lastDebug: boolean;
    /** Set when the build aborted because the keystore rejected the passwords. */
    keyFailPath: string | null;
    versionCodeDirty: boolean;
    elapsedTimer?: ReturnType<typeof setInterval>;
    buildStart: number;
    logLines: string[];
    stick: boolean;
  }

  const state: AppState = {
    project: null,
    appName: null,
    pendingProject: null,
    projects: [],
    page: 'select',
    format: (localStorage.getItem('ab.format') as BuildFormat) || 'apk',
    archs: new Set(JSON.parse(localStorage.getItem('ab.archs') || 'null') || ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']),
    signed: (localStorage.getItem('ab.signed') ?? '1') === '1',
    country: localStorage.getItem('ab.country') || 'IR',
    relocate: (localStorage.getItem('ab.relocate') ?? '1') === '1',
    targetSdk: localStorage.getItem('ab.targetsdk') || '',
    artifacts: [],
    keystore: null,
    phase: null,
    lastPhase: null,
    buildRunning: false,
    buildCfg: null,
    lastDebug: false,
    keyFailPath: null,
    versionCodeDirty: false,
    elapsedTimer: undefined,
    buildStart: 0,
    logLines: [],
    stick: true,
  };

  // ─────────────────────────────── utilities ───────────────────────────────
  function fmtSize(bytes: number | null | undefined): string {
    if (bytes == null) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function fmtDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(ts: number): string {
    const d = new Date(ts);
    return `${fmtDate(ts)}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  }

  const basename = (p: string) => String(p).split(/[\\/]/).pop() || '';

  // ───────────────────────── saved project list ────────────────────────────
  const PROJECTS_KEY = 'ab.projects';
  const PROJECTS_MAX = 30;

  function loadProjects(): void {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]');
      state.projects = Array.isArray(parsed) ? parsed.filter((p: ProjectEntry) => p && p.dir) : [];
    } catch {
      state.projects = [];
    }
  }

  function saveProjects(): void {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(state.projects.slice(0, PROJECTS_MAX)));
  }

  function findProject(dir: string): ProjectEntry | undefined {
    const key = String(dir).toLowerCase();
    return state.projects.find((p) => p.dir.toLowerCase() === key);
  }

  function upsertProject(dir: string, name: string): void {
    state.projects = state.projects.filter((p) => p.dir.toLowerCase() !== String(dir).toLowerCase());
    state.projects.unshift({ dir, name, ts: Date.now() });
    saveProjects();
  }

  function removeProject(dir: string): void {
    state.projects = state.projects.filter((p) => p.dir.toLowerCase() !== String(dir).toLowerCase());
    saveProjects();
    renderProjectsCard();
  }

  // ─────────────────────────── per-project build history ───────────────────
  // Every finished build (success, failure, cancel) is recorded per project
  // folder, newest first — this is the app's version control for a project.
  const BUILDS_KEY = 'ab.builds';
  const BUILDS_MAX = 50;
  let demoBuilds: Record<string, BuildRecord[]> | null = null; // smoke-test in-memory override, never touches localStorage

  const buildKey = (dir: string) => String(dir || '').toLowerCase();

  function readAllBuilds(): Record<string, BuildRecord[]> {
    if (demoBuilds) return demoBuilds;
    try {
      const parsed = JSON.parse(localStorage.getItem(BUILDS_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAllBuilds(all: Record<string, BuildRecord[]>): void {
    if (demoBuilds) {
      demoBuilds = all;
      return;
    }
    localStorage.setItem(BUILDS_KEY, JSON.stringify(all));
  }

  function loadBuilds(dir: string): BuildRecord[] {
    const arr = readAllBuilds()[buildKey(dir)];
    return Array.isArray(arr) ? arr.filter((b) => b && b.version) : [];
  }

  function persistBuilds(dir: string, builds: BuildRecord[]): void {
    const all = readAllBuilds();
    all[buildKey(dir)] = builds.slice(0, BUILDS_MAX);
    writeAllBuilds(all);
  }

  function recordBuild(rec: BuildRecord): void {
    if (!rec || !rec.projectDir) return;
    const builds = loadBuilds(rec.projectDir);
    builds.unshift({ ...rec, id: `${rec.ts}-${Math.random().toString(36).slice(2, 8)}` });
    persistBuilds(rec.projectDir, builds);
    renderHistoryCard();
  }

  function clearBuilds(dir: string): void {
    persistBuilds(dir, []);
  }

  function successfulBuilds(dir: string): BuildRecord[] {
    return loadBuilds(dir).filter((b) => b.status === 'success');
  }

  function lastSuccessBuild(dir: string): BuildRecord | null {
    return successfulBuilds(dir)[0] || null;
  }

  function findSuccessByVersion(dir: string, version: string): BuildRecord | null {
    return successfulBuilds(dir).find((b) => b.version === String(version)) || null;
  }

  /** Semver-ish compare of two x.y.z strings: -1 if a < b, 1 if a > b, 0 if equal. */
  function compareVersions(a: string, b: string): number {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  function renderProjectsCard(): void {
    const card = $('#projects-card');
    const list = $('#projects-list');
    list.innerHTML = '';
    // The list is the picker's companion: hide it while a project is active.
    const show = state.projects.length > 0 && !state.project;
    card.classList.toggle('hidden', !show);
    if (!show) return;
    $('#projects-count').textContent = `${state.projects.length} saved`;
    for (const p of state.projects) list.append(projectRow(p));
  }

  const TRASH_SVG =
    '<svg viewBox="0 0 24 24" class="icon"><path d="M6 19c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
  const CHEV_RIGHT_SVG =
    '<svg viewBox="0 0 24 24" class="icon chev"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>';

  function projectRow(p: ProjectEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'project-row';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'project-row-main';
    main.title = `Open ${p.name}`;

    const avatar = document.createElement('span');
    avatar.className = 'project-avatar sm';
    avatar.textContent = (p.name || '?').trim().charAt(0).toUpperCase();

    const text = document.createElement('span');
    text.className = 'project-row-text';
    const nm = document.createElement('strong');
    nm.textContent = p.name;
    const dir = document.createElement('small');
    dir.className = 'mono dim';
    dir.textContent = p.dir;
    text.append(nm, dir);
    const builds = loadBuilds(p.dir);
    if (builds.length) {
      const hint = document.createElement('small');
      hint.className = 'mono dim';
      hint.textContent = `${builds.length} build${builds.length === 1 ? '' : 's'} · latest v${builds[0].version} · ${fmtDate(builds[0].ts)}`;
      text.append(hint);
    }

    main.append(avatar, text);
    main.insertAdjacentHTML('beforeend', CHEV_RIGHT_SVG);
    main.addEventListener('click', () => openListedProject(p));

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'icon-btn';
    rm.title = `Remove ${p.name} from the list`;
    rm.setAttribute('aria-label', rm.title);
    rm.innerHTML = TRASH_SVG;
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      removeProject(p.dir);
      snack(`Removed “${p.name}” from the project list.`);
    });

    row.append(main, rm);
    return row;
  }

  async function openListedProject(entry: ProjectEntry): Promise<void> {
    let res: ValidateResult;
    try {
      res = await window.builder.validateProject(entry.dir);
    } catch (err) {
      res = { ok: false, error: String(err) };
    }
    if (!res.ok) {
      snack(`Can't open “${entry.name}”: ${res.error}`);
      return;
    }
    state.project = res.info;
    state.appName = entry.name || res.info.name;
    renderProjectCard(res.info);
    $('#project-card').classList.remove('hidden');
    $('#select-card').classList.add('hidden');
    $('#select-card').classList.remove('selecting');
    $('#project-error').classList.add('hidden');
    renderProjectsCard();
  }

  // ─────────────────────────── build history card (page 1) ─────────────────
  const STATUS_BADGE: Record<string, [string, string]> = {
    success: ['ok', 'success'],
    failed: ['fail', 'failed'],
    canceled: ['dim', 'canceled'],
  };

  function renderHistoryCard(): void {
    const card = $('#history-card');
    if (!state.project) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const builds = loadBuilds(state.project.dir);
    $('#history-count').textContent = builds.length
      ? `${builds.length} build${builds.length === 1 ? '' : 's'}`
      : 'no builds yet';
    const list = $('#history-list');
    list.innerHTML = '';
    if (!builds.length) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.style.margin = '0';
      empty.textContent = 'Every build of this project is recorded here — version, files and settings. None yet.';
      list.append(empty);
      return;
    }
    for (const b of builds) list.append(historyRow(b));
  }

  function historyRow(b: BuildRecord): HTMLElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-row';
    row.title = 'View build details';

    const ver = document.createElement('span');
    ver.className = 'history-version mono';
    ver.textContent = `v${b.version}`;

    const info = document.createElement('span');
    info.className = 'history-info';
    const badges = document.createElement('span');
    badges.className = 'history-badges';
    const fmt = document.createElement('span');
    fmt.className = 'badge sm dim';
    fmt.textContent = String(b.format || 'apk').toUpperCase();
    const sign = document.createElement('span');
    sign.className = 'badge sm dim';
    sign.textContent = b.signed ? 'signed' : 'unsigned';
    const [cls, label] = STATUS_BADGE[b.status] || ['dim', b.status];
    const st = document.createElement('span');
    st.className = `badge sm ${cls}`;
    st.textContent = label;
    badges.append(fmt, sign, st);
    const meta = document.createElement('small');
    meta.className = 'dim mono';
    const n = (b.artifacts || []).length + (b.keystore ? 1 : 0);
    meta.textContent = `${fmtDateTime(b.ts)} · ${fmtElapsed(b.durationMs || 0)} · ${n} file${n === 1 ? '' : 's'}`;
    info.append(badges, meta);

    row.append(ver, info);
    row.insertAdjacentHTML('beforeend', CHEV_RIGHT_SVG);
    row.addEventListener('click', () => openHistoryDialog(b));
    return row;
  }

  interface FileEntry extends ArtifactInfo {
    kind: 'apk' | 'aab' | 'jks';
    note: string;
  }

  function openHistoryDialog(b: BuildRecord): void {
    $('#dlg-history-title').textContent = `${b.appName || 'App'} v${b.version}`;
    const statusWord = (STATUS_BADGE[b.status] || [null, b.status])[1];
    $('#dlg-history-sub').textContent =
      `Built ${fmtDateTime(b.ts)} · took ${fmtElapsed(b.durationMs || 0)} · ${statusWord}` +
      (b.debug ? ' · debug run' : '');

    const meta: Array<[string, string]> = [
      ['Version', `v${b.version}`],
      ['versionCode', String(b.versionCode ?? '—')],
      ['Format', String(b.format || 'apk').toUpperCase()],
      ['Architectures', b.format === 'aab' ? '— (bundle)' : (b.archs || []).join(', ') || '—'],
      ['Signing', b.signed ? 'signed release' : 'unsigned'],
      ['Target SDK', b.targetSdk ? `API ${b.targetSdk}` : 'Project default'],
      ['App name', b.appName || '—'],
    ];
    const dl = $('#history-meta');
    dl.innerHTML = '';
    for (const [k, v] of meta) {
      const div = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      div.append(dt, dd);
      dl.append(div);
    }

    const files = $('#history-files');
    files.innerHTML = '';
    const entries: FileEntry[] = [
      ...(b.artifacts || []).map((a): FileEntry => ({
        ...a,
        kind: String(a.path).endsWith('.aab') ? 'aab' : 'apk',
        note: String(a.path).endsWith('.aab') ? 'Play Store bundle' : 'installable APK',
      })),
    ];
    if (b.keystore) entries.push({ ...b.keystore, kind: 'jks', note: 'persistent signing key' });

    if (!entries.length) {
      const none = document.createElement('p');
      none.className = 'note';
      none.textContent = b.status === 'success' ? 'No output files were recorded.' : 'No output files — the build did not finish.';
      files.append(none);
    } else {
      const rows = entries.map((en) =>
        artifactRow({ name: basename(en.path), size: en.size, kind: en.kind, path: en.path, note: en.note })
      );
      rows.forEach((r) => files.append(r));
      refreshFileExistence(b, entries, rows);
    }

    $('#scrim').classList.remove('hidden');
    $('#dlg-history').classList.remove('hidden');
  }

  async function refreshFileExistence(build: BuildRecord, entries: FileEntry[], rows: HTMLElement[]): Promise<void> {
    if (build.demo) return; // smoke-test records point at fake paths
    for (let i = 0; i < entries.length; i++) {
      let st: StatResult = { exists: true, size: 0, mtime: 0 };
      try {
        st = await window.builder.statPath(entries[i].path);
      } catch {
        /* keep the optimistic state */
      }
      if (!st || !st.exists) {
        rows[i].classList.add('missing');
        const metaEl = rows[i].querySelector('.artifact-meta');
        if (metaEl) metaEl.textContent = 'no longer on disk';
        const save = rows[i].querySelector('.actions .btn');
        if (save) (save as HTMLButtonElement).disabled = true;
      }
    }
  }

  function closeHistoryDialog(): void {
    $('#scrim').classList.add('hidden');
    $('#dlg-history').classList.add('hidden');
  }
  let snackTimer: ReturnType<typeof setTimeout> | undefined;
  function snack(text: string): void {
    $('#snackbar-text').textContent = text;
    $('#snackbar').classList.remove('hidden');
    clearTimeout(snackTimer);
    snackTimer = setTimeout(() => $('#snackbar').classList.add('hidden'), 3200);
  }

  function computeVersionCode(version: string | null | undefined): string {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
    if (!m) return '';
    return String(Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]));
  }

  // ──────────────────────────────── routing ────────────────────────────────
  const PAGES = ['deps', 'select', 'config', 'build', 'result'];

  function setPage(id: string): void {
    state.page = id;
    PAGES.forEach((p) => $(`#page-${p}`).classList.toggle('active', p === id));
    const idx = PAGES.indexOf(id) + 1;
    $$('#stepper .step').forEach((el) => {
      const n = Number(el.dataset.step);
      el.classList.toggle('active', n === idx);
      el.classList.toggle('done', n < idx);
      el.querySelector('.step-dot')!.textContent = n < idx ? '✓' : String(n);
    });
    ($('#main .page.active') as HTMLElement).scrollTop = 0;
  }

  // ───────────────────────── page 0 · environment ──────────────────────────
  const isDemo = () => new URLSearchParams(location.search).has('demo');

  const ENV_ICONS: Record<string, string> = {
    ok: '<svg viewBox="0 0 24 24" class="icon"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
    missing:
      '<svg viewBox="0 0 24 24" class="icon"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
    warn: '<svg viewBox="0 0 24 24" class="icon"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  };

  /** A check row, or the placeholder row shown with spinners while probing. */
  type EnvRow = Omit<Partial<CheckResult>, 'status' | 'label'> & { label: string; status: string };

  interface EnvState extends EnvCheckResult {
    checking: boolean;
    /** Newest-release info per dependency (null = check failed / not run). */
    updates: UpdatesResult | null;
    updatesBusy: boolean;
  }

  const freshEnvBase = () => ({
    checks: [] as CheckResult[], ok: false, optionalMissing: [] as string[], requiredFailed: [] as string[],
    os: { platform: '', arch: '', release: '' }, sdk: null as string | null, bash: '',
  });

  let envState: EnvState = {
    ...freshEnvBase(), checking: true, updates: null, updatesBusy: true,
  };

  /** Mock result set for the smoke screenshots (never touches the real probes). */
  function demoEnvResults(withMissing: boolean): EnvCheckResult {
    const mk = (id: string, label: string, required: boolean, status: CheckStatus, version: string | null = null, detail?: string, hint?: string): CheckResult =>
      ({ id, label, required, status, version, detail, hint });
    const good = [
      mk('node', 'Node.js', true, 'ok', 'v22.14.0'),
      mk('npm', 'npm', false, 'ok', '10.9.2'),
      mk('yarn', 'Yarn (optional)', false, withMissing ? 'missing' : 'ok', '1.22.22', withMissing ? 'yarn was not found on PATH.' : undefined),
      mk('pnpm', 'pnpm (optional)', false, 'missing', null, 'pnpm was not found on PATH.'),
      mk('bun', 'Bun (optional)', false, 'missing', null, 'bun was not found on PATH.'),
      mk('bash', 'Git Bash', true, 'ok', '5.2.37', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'),
      mk('jdk', 'Java JDK (17+)', true, 'ok', '17.0.16', 'F:\\Tools\\jdk-17.0.16'),
      mk('sdk', 'Android SDK', true, 'ok', null, 'F:\\Tools\\AndroidSDK'),
      mk('platform-tools', 'SDK platform-tools', true, 'ok', '36.0.0', 'F:\\Tools\\AndroidSDK\\platform-tools\\adb.exe'),
      mk('build-tools', 'SDK build-tools', true, 'ok', '37.0.0', 'F:\\Tools\\AndroidSDK\\build-tools\\37.0.0'),
      mk('platforms', 'Android platform', true, 'ok', 'android-36', 'android-36 (newest of 2 installed)'),
      mk('ndk', 'Android NDK', true, withMissing ? 'missing' : 'ok', withMissing ? null : '27.1.12297006', withMissing ? 'F:\\Tools\\AndroidSDK\\ndk has no NDK installations.' : undefined),
      mk('cmake', 'CMake (SDK)', true, withMissing ? 'missing' : 'ok', withMissing ? null : '3.31.6', withMissing ? 'F:\\Tools\\AndroidSDK\\cmake has no CMake installations.' : undefined),
    ];
    return {
      ok: !withMissing,
      os: { platform: 'win32', arch: 'x64', release: '10.0.26300' },
      requiredFailed: withMissing ? ['ndk', 'cmake'] : [],
      optionalMissing: ['pnpm', 'bun'],
      sdk: 'F:\\Tools\\AndroidSDK',
      bash: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      checks: good,
    };
  }

  /** Mock newest-release data matching demoEnvResults (real values, 2026-10). */
  function demoUpdates(): UpdatesResult {
    const mk = (id: string, label: string, current: string | null, latest: string | null, preview: string | null, source: string): DepUpdateInfo =>
      ({ id, label, current, latest, preview, newer: !!(current && latest && current !== latest), source, error: null });
    return {
      when: Date.now(),
      deps: [
        mk('platform-tools', 'SDK platform-tools', '36.0.0', '37.0.1', null, 'dl.google.com · repository2-3.xml'),
        mk('build-tools', 'SDK build-tools', '37.0.0', '37.0.0', '37.0.0-rc2', 'dl.google.com · repository2-3.xml'),
        mk('platforms', 'Android platform', 'android-36', 'android-37.2', null, 'dl.google.com · repository2-3.xml'),
        mk('ndk', 'Android NDK', '27.1.12297006', '30.0.16248370', '30.0.16138531', 'dl.google.com · repository2-3.xml'),
        mk('cmake', 'CMake (SDK)', '3.31.6', '4.1.2', null, 'dl.google.com · repository2-3.xml'),
        mk('node', 'Node.js', '22.14.0', '24.22.0', null, 'nodejs.org · LTS'),
        mk('jdk', 'Java JDK (17+)', '17.0.16', '21.0.12', null, 'adoptium.net · Temurin 21 LTS'),
      ],
    };
  }

  function applyEnvResults(res: EnvCheckResult): void {
    envState = { ...res, checking: false, updates: null, updatesBusy: true };
    renderEnvChecks();
    // Newest-release detection starts only after the local probes are done so
    // the rows paint instantly; the "…available" chips appear when the (slower,
    // online) version check lands.
    if (isDemo()) {
      envState.updates = demoUpdates();
      envState.updatesBusy = false;
      renderEnvChecks();
    } else {
      void loadUpdates(true);
    }
  }

  async function loadUpdates(force = false): Promise<void> {
    try {
      envState.updates = await window.builder.checkUpdates(force);
    } catch {
      envState.updates = null;
    } finally {
      envState.updatesBusy = false;
      renderEnvChecks();
    }
  }

  async function runEnvCheck(): Promise<void> {
    envState = {
      checks: [], checking: true, ok: false, optionalMissing: [], requiredFailed: [],
      os: { platform: '', arch: '', release: '' }, sdk: null, bash: '',
      updates: null, updatesBusy: true,
    };
    $<HTMLButtonElement>('#btn-env-continue').disabled = true;
    $('#env-summary').textContent = 'Checking your machine…';
    $('#env-summary-info').textContent = 'Running the checks…';
    renderEnvChecks();

    let res: EnvCheckResult;
    try {
      res = isDemo() ? demoEnvResults(false) : await window.builder.checkEnvironment();
    } catch (err) {
      res = {
        ok: false, checks: [], requiredFailed: [], optionalMissing: [],
        os: { platform: '', arch: '', release: '' }, sdk: null, bash: '',
        fatal: String(err),
      };
    }
    applyEnvResults(res);
  }

  function envRow(c: EnvRow): HTMLElement {
    // A missing optional tool (yarn/pnpm/bun) is informational, not an error.
    const optMissing = !c.required && c.status === 'missing';
    const cls = optMissing ? 'opt-missing' : c.status;
    const row = document.createElement('div');
    row.className = `env-row ${cls}`;

    const status = document.createElement('span');
    status.className = 'env-status';
    status.innerHTML = c.status && ENV_ICONS[c.status] ? ENV_ICONS[c.status] : ENV_ICONS.missing;

    const info = document.createElement('div');
    info.className = 'env-info';
    const label = document.createElement('div');
    label.className = 'env-label';
    label.textContent = c.label;
    if (c.required) {
      const req = document.createElement('span');
      req.className = 'badge sm dim';
      req.textContent = 'required';
      label.append(req);
    }
    info.append(label);

    const detailText = c.detail || c.path || '';
    if (detailText && detailText !== c.version) {
      const detail = document.createElement('div');
      detail.className = 'env-detail mono';
      detail.textContent = detailText;
      info.append(detail);
    }
    if (c.status !== 'ok' && c.hint) {
      const fix = document.createElement('div');
      fix.className = 'env-fix';
      fix.textContent = c.hint;
      info.append(fix);
    }

    const version = document.createElement('span');
    version.className = `env-version mono ${cls}`;
    version.textContent = envState.checking ? '…' : c.status === 'ok' ? c.version || 'installed' : c.status === 'warn' ? c.version || 'check' : 'not found';

    // Newest-release chip: only for detected (ok/warn) rows whose latest stable
    // release is newer than what is installed. Missing rows already carry a
    // fix hint — a version chip there would be noise.
    const verBlock = document.createElement('div');
    verBlock.className = 'env-version-block';
    verBlock.append(version);
    const upd = envState.updates && !envState.checking && c.status !== 'missing'
      ? envState.updates.deps.find((d) => d.id === c.id)
      : undefined;
    if (upd && upd.newer) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ver-chip';
      chip.title = 'A newer stable release is available — click for details';
      chip.innerHTML =
        '<svg viewBox="0 0 24 24" class="icon"><path d="M12 4l-5 5 1.41 1.41L11 7.83V16h2V7.83l2.59 2.58L17 9zm-7 14h14v2H5z"/></svg>' +
        `<span>${upd.latest}</span>`;
      chip.addEventListener('click', () => openVersionDialog(upd));
      verBlock.append(chip);
    }

    row.append(status, info, verBlock);
    return row;
  }

  function renderEnvChecks(): void {
    const list = $('#env-list');
    list.innerHTML = '';
    // While probing, show the expected tool list with spinners so the card
    // doesn't collapse into nothing.
    const checks: EnvRow[] = envState.checking
      ? ['Node.js', 'npm', 'Yarn', 'pnpm', 'Bun', 'Git Bash', 'Java JDK (17+)', 'Android SDK', 'SDK platform-tools', 'SDK build-tools', 'Android platform', 'Android NDK', 'CMake (SDK)'].map((label) => ({ label, status: 'checking' }))
      : envState.checks || [];
    for (const c of checks) list.append(envRow(c));
    renderUpdatesStatus();

    if (envState.checking) {
      $('#env-summary').textContent = 'Checking your machine…';
      $('#env-summary-info').textContent = 'Running the checks…';
      $<HTMLButtonElement>('#btn-env-continue').disabled = true;
      return;
    }

    const failedRequired = checks.filter((c) => c.required && c.status !== 'ok');
    const warned = checks.filter((c) => c.status === 'warn');
    const missingOptional = checks.filter((c) => !c.required && c.status !== 'ok');
    const passed = checks.filter((c) => c.status === 'ok').length;

    if (envState.fatal) {
      $('#env-summary').textContent = 'Check failed';
      $('#env-summary-info').textContent = `The check itself failed: ${envState.fatal}`;
      $<HTMLButtonElement>('#btn-env-continue').disabled = true;
      return;
    }

    const allOk = failedRequired.length === 0;
    $<HTMLButtonElement>('#btn-env-continue').disabled = !allOk;

    let summary: string;
    if (allOk) {
      summary = warned.length
        ? `${passed}/${checks.length} passed · ${warned.length} need${warned.length === 1 ? 's' : ''} attention`
        : `All ${checks.length} checks passed`;
    } else {
      summary = `${failedRequired.length} required tool${failedRequired.length === 1 ? '' : 's'} missing`;
    }
    $('#env-summary').textContent = summary;

    const names = (arr: EnvRow[]) => arr.map((c) => c.label.replace(' (optional)', '')).join(', ');
    let infoText: string;
    if (!allOk) {
      infoText = `Install ${names(failedRequired)} — Continue unlocks once every required tool is detected.`;
    } else if (missingOptional.length) {
      infoText = `Ready. Optional: ${names(missingOptional)} — only needed for projects using those package managers.`;
    } else {
      infoText = 'Everything needed to build, sign and ship is installed on this machine.';
    }
    $('#env-summary-info').textContent = infoText;
  }

  /** One-line "newer versions" status under the deps card title. */
  function renderUpdatesStatus(): void {
    const box = $('#env-updates');
    const status = $('#env-updates-status');
    if (!box || !status) return;
    box.classList.remove('busy', 'has-new', 'all-ok', 'failed');

    if (envState.checking || envState.updatesBusy) {
      box.classList.add('busy');
      status.textContent = 'Checking for newer versions…';
      return;
    }
    if (!envState.updates) {
      box.classList.add('failed');
      status.textContent = 'Newer-version check unavailable — offline, blocked, or no sources reached.';
      return;
    }
    const n = envState.updates.deps.filter((d) => d.newer).length;
    if (n > 0) {
      box.classList.add('has-new');
      status.textContent = `${n} newer stable release${n === 1 ? '' : 's'} available — click a version chip for details`;
    } else {
      box.classList.add('all-ok');
      status.textContent = 'Every dependency is on the newest stable release it can use.';
    }
  }

  // ───────────────── newer-version dialog (read-only info) ─────────────────
  const UPGRADE_HINTS: Record<string, string> = {
    'platform-tools': 'sdk',
    'build-tools': 'sdk',
    platforms: 'sdk',
    ndk: 'sdk',
    cmake: 'sdk',
    node: 'Download the LTS installer from nodejs.org, run it, and reopen Expo Builder.',
    jdk: 'Install Temurin JDK 21 LTS from adoptium.net and point JAVA_HOME at it (Android Studio\'s bundled JDK is detected automatically too).',
  };

  function sdkPkgOf(upd: DepUpdateInfo): string {
    // platform-tools has no version in its package path; platforms uses the
    // full "android-XX[.Y]" suffix as the version.
    return upd.id === 'platform-tools' ? 'platform-tools' : `${upd.id};${upd.latest}`;
  }

  function openVersionDialog(upd: DepUpdateInfo): void {
    dialogUpd = upd;
    const isSdk = UPGRADE_HINTS[upd.id] === 'sdk';
    $('#dlg-version-title').textContent = upd.label;
    $('#dlg-version-sub').textContent = upd.newer
      ? isSdk
        ? 'A newer stable release is available — your installed version keeps working, and SDK components install side-by-side.'
        : 'A newer stable release is available — the official installer will be downloaded and opened for you.'
      : 'Release information for this dependency.';

    const meta = $('#dlg-version-meta');
    meta.innerHTML = '';
    const row = (k: string, v: string) => {
      const r = document.createElement('div');
      r.className = 'ver-row';
      const key = document.createElement('span');
      key.className = 'k';
      key.textContent = k;
      const val = document.createElement('span');
      val.className = 'v mono';
      val.textContent = v;
      r.append(key, val);
      meta.append(r);
    };
    row('Installed', upd.current || 'not detected');
    row('Latest stable', upd.latest || 'unknown');
    if (upd.preview) row('Preview channel', `${upd.preview} — not recommended for release builds`);
    row('Checked against', upd.source || upd.error || '—');

    const cmd = $('#dlg-version-cmd');
    cmd.classList.toggle('hidden', !isSdk || !upd.latest);
    if (isSdk && upd.latest) cmd.textContent = `sdkmanager "${sdkPkgOf(upd)}"`;

    $('#dlg-version-hint').textContent = isSdk
      ? 'Install it from Android Studio → SDK Manager (SDK Tools / SDK Platforms), or right here: Update now runs the same sdkmanager install with progress and cancel.'
      : UPGRADE_HINTS[upd.id] || '';
    $('#dlg-version-disclaimer').innerHTML = isSdk
      ? 'SDK components install side-by-side through Google\'s <code>sdkmanager</code> — your current version stays usable the whole time.'
      : 'The official installer is downloaded into your Downloads folder and opened — nothing is installed silently.';

    // Fresh dialog: info mode.
    $('#dlg-version-progress').classList.add('hidden');
    $('#btn-install-update').classList.toggle('hidden', !upd.newer || !upd.latest);
    $('#scrim').classList.remove('hidden');
    $('#dlg-version').classList.remove('hidden');
  }

  function closeVersionDialog(): void {
    if (installState.running) {
      snack('An update is running — cancel it first.');
      return;
    }
    $('#scrim').classList.add('hidden');
    $('#dlg-version').classList.add('hidden');
  }

  // ───────────────────── update action (download + install) ─────────────────
  const PHASE_TEXT: Record<string, string> = {
    license: 'Accepting SDK licenses…',
    download: 'Downloading…',
    install: 'Downloading & installing…',
  };

  let dialogUpd: DepUpdateInfo | null = null;
  let installState: { running: boolean; kind: 'sdk' | 'installer' | null; failed: boolean } = {
    running: false, kind: null, failed: false,
  };

  function enterInstallMode(kind: 'sdk' | 'installer'): void {
    installState = { running: true, kind, failed: false };
    // Collapse info-only blocks so the progress view always fits the window.
    $('#dlg-version-cmd').classList.add('hidden');
    $('#dlg-version-hint').classList.add('hidden');
    $('#dlg-version-progress').classList.remove('hidden');
    $('#btn-install-update').classList.add('hidden');
    $('#dlg-version-phase').textContent = 'Preparing…';
    $('#dlg-version-pct').textContent = '—';
    $('#dlg-version-bar').style.width = '0%';
    $('#dlg-version-bar').classList.remove('done', 'failed');
    $('#dlg-version-bar').classList.toggle('ind', kind === 'sdk'); // indeterminate until sdkmanager reports %
    $('#dlg-version-log').innerHTML = '';
    $('#dlg-version-log').classList.add('hidden');
    $('#btn-install-cancel').classList.remove('hidden');
    $('#btn-version-close').classList.add('hidden');
  }

  function setInstallProgress(percent: number | null, text: string): void {
    const bar = $('#dlg-version-bar');
    bar.classList.remove('ind');
    if (percent == null) {
      bar.classList.add('ind');
      $('#dlg-version-pct').textContent = text || '…';
    } else {
      bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      $('#dlg-version-pct').textContent = `${percent}%`;
    }
    if (text) $('#dlg-version-phase').textContent = text.length > 64 ? text.slice(0, 64) + '…' : text;
  }

  function appendInstallLog(text: string): void {
    const log = $('#dlg-version-log');
    log.classList.remove('hidden');
    const line = document.createElement('div');
    line.textContent = text;
    log.append(line);
    while (log.childElementCount > 6) log.firstElementChild!.remove();
    log.scrollTop = log.scrollHeight;
  }

  function finishInstall(ok: boolean, message: string): void {
    installState.running = false;
    const bar = $('#dlg-version-bar');
    bar.classList.remove('ind');
    bar.classList.toggle('done', ok);
    bar.classList.toggle('failed', !ok);
    if (ok) bar.style.width = '100%';
    $('#dlg-version-phase').textContent = message;
    $('#dlg-version-pct').textContent = ok ? '✓' : '✕';
    $('#btn-install-cancel').classList.add('hidden');
    $('#btn-version-close').classList.remove('hidden');
    // Bring the info blocks back now that height allows it again.
    const isSdk = dialogUpd ? UPGRADE_HINTS[dialogUpd.id] === 'sdk' : false;
    $('#dlg-version-cmd').classList.toggle('hidden', !isSdk || !(dialogUpd && dialogUpd.latest));
    $('#dlg-version-hint').classList.remove('hidden');
  }

  function onUpdateEvent(evt: UpdateEvent): void {
    if (!dialogUpd) return;
    if (evt.type === 'phase') {
      $('#dlg-version-phase').textContent = PHASE_TEXT[evt.id] || 'Working…';
    } else if (evt.type === 'progress') {
      setInstallProgress(evt.percent, evt.text);
    } else if (evt.type === 'line') {
      appendInstallLog(evt.text);
    } else if (evt.type === 'installer-launched') {
      $('#dlg-version-phase').textContent = 'Installer downloaded and opened — finish the setup wizard.';
    } else if (evt.type === 'exit') {
      if (evt.canceled) {
        finishInstall(false, 'Update canceled.');
        snack('Update canceled.');
      } else if (evt.code === 0) {
        finishInstall(true, installState.kind === 'installer' ? 'Installer opened — finish the wizard, then use Check again.' : 'Installed. Re-checking your tools…');
        snack(`${dialogUpd.label}: update finished.`);
        void runEnvCheck();
      } else {
        finishInstall(false, 'Update failed — see the log above.');
        snack(`${dialogUpd.label}: update failed.`);
      }
    }
  }

  async function startInstall(): Promise<void> {
    const upd = dialogUpd;
    if (!upd || !upd.latest || installState.running) return;
    if (isDemo()) {
      snack('Demo mode — installs are disabled.');
      return;
    }
    const res = await window.builder.installUpdate(upd.id, upd.latest);
    if (!res.ok) {
      snack(res.error);
      return;
    }
    enterInstallMode(res.kind);
  }

  // ─────────────────────────────── page 1 ──────────────────────────────────
  async function pickDirectory(): Promise<void> {
    const dir = await window.builder.selectDirectory();
    if (!dir) return;
    await validateAndShow(dir);
  }

  async function validateAndShow(dir: string): Promise<void> {
    $('#project-error').classList.add('hidden');
    $('#project-card').classList.add('hidden');
    $('#select-card').classList.add('selecting');

    let res: ValidateResult;
    try {
      res = await window.builder.validateProject(dir);
    } catch (err) {
      res = { ok: false, error: String(err) };
    }

    if (!res.ok) {
      $('#project-error-msg').textContent = res.error || 'Unknown error.';
      $('#project-error').classList.remove('hidden');
      $('#select-card').classList.remove('selecting');
      return;
    }

    // The chosen folder becomes a project as soon as it is named.
    state.pendingProject = res.info;
    openNameDialog(res.info);
  }

  function openNameDialog(info: ProjectInfo): void {
    const saved = findProject(info.dir);
    $<HTMLInputElement>('#field-projectname').value = saved ? saved.name : (info.name || '');
    clearError('projectname');
    $('#dlg-name-dir').textContent = info.dir;
    $('#scrim').classList.remove('hidden');
    $('#dlg-name').classList.remove('hidden');
    setTimeout(() => {
      const input = $<HTMLInputElement>('#field-projectname');
      input.focus();
      input.select();
    }, 40);
  }

  function closeNameDialog(): void {
    $('#scrim').classList.add('hidden');
    $('#dlg-name').classList.add('hidden');
  }

  function confirmProjectName(): void {
    const name = $<HTMLInputElement>('#field-projectname').value.trim();
    if (!name) {
      setError('projectname', 'A project name is required.');
      $<HTMLInputElement>('#field-projectname').focus();
      return;
    }
    const info = state.pendingProject;
    state.pendingProject = null;
    if (!info) return;
    closeNameDialog();
    state.appName = name;
    state.project = info;
    upsertProject(info.dir, name);
    renderProjectCard(info);
    $('#project-card').classList.remove('hidden');
    $('#select-card').classList.add('hidden');
    $('#select-card').classList.remove('selecting');
  }

  function cancelProjectName(): void {
    state.pendingProject = null;
    closeNameDialog();
    $('#select-card').classList.remove('selecting');
  }

  function renderProjectCard(info: ProjectInfo): void {
    const display = state.appName || info.name;
    $('#project-avatar').textContent = (display || '?').trim().charAt(0).toUpperCase();
    $('#project-name').textContent = display;
    $('#project-dir').textContent = info.dir;

    const meta: Array<[string, string]> = [
      ['App name', display],
      ['Detected name', info.name],
      ['Version', `${info.version}  (code ${info.versionCode})`],
      ['Android package', info.androidPackage || '— (set after prebuild)'],
      ['Expo SDK', info.expoRange],
      ['Dependencies', `${info.pm} · ${info.lockfile}`],
      ['android/ folder', info.hasAndroidDir ? 'exists (will be regenerated)' : 'will be generated'],
      ['Signing key', info.hasPersistentKey ? 'android-key/ found — it will be reused' : 'none yet — will be generated'],
    ];
    if (info.appConfigName) meta.push(['Config', `${info.appConfigName} (dynamic — version edits apply to package.json only)`]);
    const builds = loadBuilds(info.dir);
    if (builds.length) {
      meta.push(['Last build', `v${builds[0].version} · ${fmtDate(builds[0].ts)} · ${builds.length} build${builds.length === 1 ? '' : 's'} recorded`]);
    }

    const dl = $('#project-meta');
    dl.innerHTML = '';
    for (const [k, v] of meta) {
      const div = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      div.append(dt, dd);
      dl.append(div);
    }

    renderHistoryCard();
  }

  function repick(): void {
    $('#project-card').classList.add('hidden');
    $('#select-card').classList.remove('hidden');
    state.project = null;
    state.appName = null;
    renderProjectsCard();
    renderHistoryCard();
  }

  function goToConfig(): void {
    if (!state.project) return;
    prefillForm(state.project);
    $('#config-project-label').textContent = `${state.appName || state.project.name} — ${state.project.dir}`;
    const identity = $('#identity-note');
    identity.innerHTML = '';
    identity.append(
      'App name: ',
      Object.assign(document.createElement('b'), { textContent: state.appName || state.project.name }),
      ' — set when the project was defined. '
    );
    identity.append('Rename it with “Change folder” on the Project page.');
    if (state.project.appConfigName) {
      $('#version-note').innerHTML = '';
      $('#version-note').append(
        'Heads up: this project uses ',
        Object.assign(document.createElement('code'), { textContent: state.project.appConfigName }),
        ' — the version is written to package.json; update the config file yourself if it hardcodes one.'
      );
    }
    setPage('config');
    updateSummary();
    // Saved signing passwords: unlock with Windows Hello and autofill, and
    // sync the forget-button visibility with what the vault holds.
    unlockVault();
    refreshVaultUI();
  }

  // ─────────────────── encrypted signing-password vault ──────────────────────
  // Generated or typed signing passwords are saved encrypted (Windows DPAPI,
  // per project) whenever they are applied or a build starts. Opening the form
  // again asks for Windows Hello (fingerprint / PIN / face) and autofills.

  const vaultFields = ['keypass', 'storepass'] as const;
  type VaultField = (typeof vaultFields)[number];

  const vaultInput = (field: VaultField) => $<HTMLInputElement>(`#field-${field}`);

  async function refreshVaultUI(): Promise<void> {
    const forgetBtn = $('#btn-vault-forget');
    if (!state.project || isDemo()) {
      forgetBtn.classList.add('hidden');
      return;
    }
    try {
      const st = await window.builder.secretStatus(state.project.dir);
      forgetBtn.classList.toggle('hidden', !st.has);
    } catch {
      forgetBtn.classList.add('hidden');
    }
  }

  async function saveSecrets(fields: readonly VaultField[]): Promise<void> {
    if (!state.project || isDemo()) return;
    const secrets: VaultSecrets = {};
    for (const f of fields) {
      const v = vaultInput(f).value;
      if (v) secrets[f] = v;
    }
    if (!Object.keys(secrets).length) return;
    try {
      await window.builder.saveSecrets(state.project.dir, secrets);
      $('#btn-vault-forget').classList.remove('hidden');
    } catch {
      /* the vault is a convenience — never block a build over it */
    }
  }

  // ── Windows Hello unlock overlay ────────────────────────────────────────
  // While the OS consent prompt is on screen the whole app freezes behind a
  // blurred layer; it fades away on pass/fail/cancel. A short grace period
  // before showing keeps quick outcomes (Hello not configured, probe errors)
  // from ever flashing the overlay.
  let vaultAuthCanceled = false;
  let vaultAuthShowTimer: ReturnType<typeof setTimeout> | undefined;
  let vaultAuthHideTimer: ReturnType<typeof setTimeout> | undefined;

  function showVaultAuth(): void {
    const el = $('#vault-auth');
    clearTimeout(vaultAuthHideTimer);
    el.classList.remove('hidden');
    // Next frame so the opacity transition runs from 0.
    requestAnimationFrame(() => el.classList.add('show'));
    $('#main').inert = true;
    $('.topbar').inert = true;
    // Keyboard users get Cancel focused; the OS consent prompt reclaims
    // foreground focus right after anyway.
    $('#btn-vault-cancel').focus();
  }

  function hideVaultAuth(): void {
    clearTimeout(vaultAuthShowTimer);
    const el = $('#vault-auth');
    if (el.classList.contains('hidden')) return;
    el.classList.remove('show');
    $('#main').inert = false;
    $('.topbar').inert = false;
    clearTimeout(vaultAuthHideTimer);
    vaultAuthHideTimer = setTimeout(() => el.classList.add('hidden'), 300);
  }

  async function unlockVault({ manual = false }: { manual?: boolean } = {}): Promise<void> {
    if (!state.project || isDemo()) return;
    vaultAuthCanceled = false;
    let res: VaultLoadResult;
    try {
      res = await window.builder.loadSecrets(state.project.dir);
    } catch {
      hideVaultAuth();
      return;
    }
    hideVaultAuth();
    if (!res.ok) {
      if (res.reason === 'denied' && vaultAuthCanceled) {
        snack('Unlock canceled — the saved passwords stay locked.');
        return;
      }
      if (manual || res.reason === 'denied') {
        const msgs: Record<Extract<VaultLoadResult, { ok: false }>['reason'], string> = {
          empty: 'No passwords saved for this project yet.',
          denied: 'Locked — Windows Hello did not verify.',
          'no-encryption': 'Windows refused to decrypt the saved passwords.',
          corrupt: 'Saved passwords could not be decrypted — forget them and re-enter.',
        };
        snack(msgs[res.reason]);
      }
      return;
    }
    for (const f of vaultFields) {
      const v = res.secrets[f];
      if (!v) continue;
      const input = vaultInput(f);
      input.value = v;
      input.dispatchEvent(new Event('input'));
      // Flash the field so the (dotted) value landing is visible.
      const wrap = input.closest<HTMLElement>('.field');
      if (wrap) {
        wrap.classList.remove('vault-filled');
        void wrap.offsetWidth; // restart the animation
        wrap.classList.add('vault-filled');
        setTimeout(() => wrap.classList.remove('vault-filled'), 1800);
      }
    }
    if (res.auth === 'verified') snack('Saved passwords unlocked with Windows Hello.');
    else if (res.auth === 'unavailable') snack('Filled from the encrypted vault — Windows Hello is not set up on this PC.');
    else snack('Filled saved passwords.');
  }

  // ─────────────────────────────── page 2 ──────────────────────────────────
  function prefillForm(info: ProjectInfo): void {
    $<HTMLInputElement>('#field-version').value = info.version;
    state.versionCodeDirty = false;
    $<HTMLInputElement>('#field-versioncode').value = String(info.versionCode || computeVersionCode(info.version));
    if (info.hasPersistentKey) {
      // Suggest an alias derived from the project so keys stay distinguishable.
      if (!$<HTMLInputElement>('#field-alias').value) $<HTMLInputElement>('#field-alias').value = `${(info.slug || 'app').toLowerCase()}.release`;
    }
    clearAllErrors();
    updateVersionWarnings();
  }

  // Live version-field warnings from the project's build history:
  // rebuilding a version replaces its previous files, and going lower than the
  // last built version can block updates for installed users.
  function updateVersionWarnings(): void {
    const box = $('#version-warn');
    const list = $('#version-warn-list');
    list.innerHTML = '';
    if (!state.project) {
      box.classList.add('hidden');
      return;
    }
    const version = $<HTMLInputElement>('#field-version').value.trim();
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)) {
      box.classList.add('hidden');
      return;
    }
    const prev = findSuccessByVersion(state.project.dir, version);
    const last = lastSuccessBuild(state.project.dir);
    const lines: string[] = [];
    if (prev) {
      lines.push(`v${version} was already built (${fmtDate(prev.ts)}) — building the same version again replaces that build's output files.`);
    }
    if (last && compareVersions(version, last.version) < 0) {
      lines.push(`v${version} is lower than the last built version v${last.version} (${fmtDate(last.ts)}) — a lower versionCode can block updates for installed users.`);
    }
    if (!lines.length) {
      box.classList.add('hidden');
      return;
    }
    for (const l of lines) {
      const li = document.createElement('li');
      li.textContent = l;
      list.append(li);
    }
    box.classList.remove('hidden');
  }

  function initForm(): void {
    // Format segmented control
    const seg = $('#seg-format');
    const setFormat = (fmt: string) => {
      state.format = fmt as BuildFormat;
      localStorage.setItem('ab.format', fmt);
      seg.dataset.active = fmt === 'aab' ? '1' : '0';
      $$('#seg-format .seg-option').forEach((o) => {
        const active = o.dataset.value === fmt;
        o.classList.toggle('active', active);
        o.setAttribute('aria-checked', String(active));
      });
      $('#arch-block').classList.toggle('collapsed', fmt !== 'apk');
      updateSummary();
      clearError('archs');
    };
    $$('#seg-format .seg-option').forEach((o) =>
      o.addEventListener('click', () => setFormat(o.dataset.value || ''))
    );
    setFormat(state.format);

    // Arch chips
    const renderChips = () => {
      $$('#arch-chips .chip').forEach((c) => {
        c.classList.toggle('selected', !!c.dataset.arch && state.archs.has(c.dataset.arch));
        updateSummary();
      });
    };
    $$('#arch-chips .chip').forEach((c) =>
      c.addEventListener('click', () => {
        const a = c.dataset.arch;
        if (!a) return;
        if (state.archs.has(a)) state.archs.delete(a);
        else state.archs.add(a);
        localStorage.setItem('ab.archs', JSON.stringify([...state.archs]));
        renderChips();
        clearError('archs');
      })
    );
    renderChips();

    // Signed checkbox
    const signedInput = $<HTMLInputElement>('#field-signed');
    const syncSigned = () => {
      state.signed = signedInput.checked;
      localStorage.setItem('ab.signed', state.signed ? '1' : '0');
      $('#signed-checkbox').classList.toggle('on', state.signed);
      $('#sign-fields').classList.toggle('collapsed', !state.signed);
      updateSummary();
      if (!state.signed) ['alias', 'keypass', 'storepass', 'country'].forEach(clearError);
    };
    signedInput.addEventListener('change', syncSigned);
    signedInput.checked = state.signed;
    syncSigned();

    // Relocate checkbox
    const relocateInput = $<HTMLInputElement>('#field-relocate');
    relocateInput.addEventListener('change', () => {
      state.relocate = relocateInput.checked;
      localStorage.setItem('ab.relocate', state.relocate ? '1' : '0');
      $('#relocate-checkbox').classList.toggle('on', state.relocate);
    });
    relocateInput.checked = state.relocate;
    $('#relocate-checkbox').classList.toggle('on', state.relocate);

    // Target SDK select (Advanced)
    const sdkSelect = $<HTMLSelectElement>('#field-targetsdk');
    sdkSelect.addEventListener('change', () => {
      state.targetSdk = sdkSelect.value;
      localStorage.setItem('ab.targetsdk', state.targetSdk);
      updateSummary();
    });
    sdkSelect.value = state.targetSdk;
    if (sdkSelect.value !== state.targetSdk) {
      // Stored level is no longer in the list — fall back to the default.
      state.targetSdk = '';
      localStorage.removeItem('ab.targetsdk');
    }

    // Version ↔ versionCode sync
    $<HTMLInputElement>('#field-version').addEventListener('input', () => {
      state.versionCodeDirty = false;
      $<HTMLInputElement>('#field-versioncode').value = computeVersionCode($<HTMLInputElement>('#field-version').value);
      clearError('version');
      clearError('versioncode');
      updateVersionWarnings();
      updateSummary();
    });
    $<HTMLInputElement>('#field-versioncode').addEventListener('input', () => {
      state.versionCodeDirty = true;
      clearError('versioncode');
      updateSummary();
    });
    $<HTMLInputElement>('#field-alias').addEventListener('input', () => clearError('alias'));
    $<HTMLInputElement>('#field-keypass').addEventListener('input', () => clearError('keypass'));
    $<HTMLInputElement>('#field-storepass').addEventListener('input', () => clearError('storepass'));

    // Password visibility toggles
    $$('[data-toggle-pass]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const id = btn.dataset.togglePass;
        const input = id ? document.getElementById(id) : null;
        if (!(input instanceof HTMLInputElement)) return;
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        btn.classList.toggle('revealed', reveal);
      })
    );

    // Password generators
    $$('[data-gen]').forEach((btn) =>
      btn.addEventListener('click', () => openGenerator(btn.dataset.gen === 'storepass' ? 'field-storepass' : 'field-keypass'))
    );

    // Advanced disclosure
    $('#btn-advanced').addEventListener('click', () => {
      const open = $('#advanced-block').classList.toggle('hidden');
      $('#btn-advanced').setAttribute('aria-expanded', String(!open));
    });

    // Check values / submit
    $('#btn-validate').addEventListener('click', () => {
      const res = validateForm();
      if (res.ok) snack('All values look good — ready to build.');
      else focusFirstInvalid(res.fields);
    });

    $('#build-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const res = validateForm();
      if (!res.ok) {
        snack('Please fix the highlighted fields first.');
        focusFirstInvalid(res.fields);
        return;
      }
      maybeConfirmRebuild().then((proceed) => {
        if (proceed) startBuild(false);
      });
    });

    $('#btn-back-select').addEventListener('click', () => setPage('select'));
  }

  const ERR_EL: Record<string, [string | null, string]> = {
    projectname: ['#wrap-name', '#err-projectname'],
    version: ['#wrap-version', '#err-version'],
    versioncode: ['#wrap-versioncode', '#err-versioncode'],
    alias: ['#wrap-alias', '#err-alias'],
    keypass: ['#wrap-keypass', '#err-keypass'],
    storepass: ['#wrap-storepass', '#err-storepass'],
    country: ['#wrap-country', '#err-country'],
    archs: [null, '#err-archs'],
  };

  function setError(field: string, msg: string): void {
    const [wrap, err] = ERR_EL[field];
    if (wrap) $(wrap).classList.add('invalid');
    $(err).textContent = msg;
  }

  function clearError(field: string): void {
    const [wrap, err] = ERR_EL[field];
    if (wrap) $(wrap).classList.remove('invalid');
    $(err).textContent = '';
  }

  function clearAllErrors(): void {
    Object.keys(ERR_EL).forEach(clearError);
  }

  function focusFirstInvalid(fields: string[]): void {
    if (!fields.length) return;
    const [wrap] = ERR_EL[fields[0]];
    const input = wrap && $(wrap).querySelector('input, button');
    if (input) (input as HTMLElement).focus({ preventScroll: false });
  }

  function validateForm(): { ok: boolean; fields: string[] } {
    const bad: string[] = [];
    const version = $<HTMLInputElement>('#field-version').value.trim();
    const versionCode = $<HTMLInputElement>('#field-versioncode').value.trim();

    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)) {
      setError('version', 'Enter a semantic version like 1.37.18.');
      bad.push('version');
    }
    if (!/^\d+$/.test(versionCode) || Number(versionCode) < 1 || Number(versionCode) > 2100000000) {
      setError('versioncode', 'versionCode must be an integer between 1 and 2100000000.');
      bad.push('versioncode');
    }

    if (state.signed) {
      if (!$<HTMLInputElement>('#field-alias').value.trim()) { setError('alias', 'Key alias is required for signed builds.'); bad.push('alias'); }
      if ($<HTMLInputElement>('#field-keypass').value.length < 6) { setError('keypass', 'At least 6 characters (keytool requirement).'); bad.push('keypass'); }
      if ($<HTMLInputElement>('#field-storepass').value.length < 6) { setError('storepass', 'At least 6 characters (keytool requirement).'); bad.push('storepass'); }
      if (!state.country) { setError('country', 'Pick the country for the signing certificate.'); bad.push('country'); }
    }

    if (state.format === 'apk' && state.archs.size === 0) {
      setError('archs', 'Select at least one architecture.');
      bad.push('archs');
    }

    return { ok: bad.length === 0, fields: bad };
  }

  // ───────────────────── rebuild-same-version confirmation ─────────────────
  // Building a version that was already built replaces that build's output
  // files (the build script writes the same Name.vX.Y.Z[.abi] filenames into
  // the project root) — ask first, and offer to remove the old files.
  let rebuildResolve: ((proceed: boolean) => void) | null = null;

  async function maybeConfirmRebuild(): Promise<boolean> {
    if (!$('#dlg-rebuild').classList.contains('hidden')) return false;
    const version = $<HTMLInputElement>('#field-version').value.trim();
    const prev = state.project ? findSuccessByVersion(state.project.dir, version) : null;
    if (!prev) return true;

    const files = [...(prev.artifacts || [])];
    const states: StatResult[] = prev.demo
      ? files.map(() => ({ exists: true, size: 0, mtime: 0 }))
      : await Promise.all(files.map(async (f): Promise<StatResult> => {
          try {
            return await window.builder.statPath(f.path);
          } catch {
            return { exists: false };
          }
        }));
    const existing = files.filter((_f, i) => states[i].exists);

    $('#dlg-rebuild-title').textContent = `Rebuild v${version}?`;
    $('#dlg-rebuild-text').textContent =
      `${prev.appName || 'This app'} v${version} was already built successfully (${fmtDate(prev.ts)}). ` +
      `A new build of the same version replaces the previous build's output files:`;

    const lower = $('#dlg-rebuild-lower');
    const last = state.project ? lastSuccessBuild(state.project.dir) : null;
    if (last && compareVersions(version, last.version) < 0) {
      lower.textContent = `Heads up: v${version} is also lower than the last built version v${last.version}.`;
      lower.classList.remove('hidden');
    } else {
      lower.classList.add('hidden');
    }

    const list = $('#rebuild-files');
    list.innerHTML = '';
    if (!files.length) {
      const none = document.createElement('div');
      none.className = 'rebuild-file';
      none.textContent = 'The previous build recorded no output files.';
      list.append(none);
    }
    for (let i = 0; i < files.length; i++) {
      const row = document.createElement('div');
      row.className = `rebuild-file${states[i].exists ? '' : ' gone'}`;
      const nm = document.createElement('span');
      nm.className = 'mono';
      nm.textContent = basename(files[i].path);
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = states[i].exists ? fmtSize(files[i].size) : 'already gone';
      row.append(nm, tag);
      list.append(row);
    }

    $('#btn-rebuild-delete').classList.toggle('hidden', existing.length === 0);
    $('#scrim').classList.remove('hidden');
    $('#dlg-rebuild').classList.remove('hidden');

    return new Promise((resolve) => {
      rebuildResolve = resolve;
    });
  }

  function closeRebuildDialog(proceed: boolean): void {
    $('#scrim').classList.add('hidden');
    $('#dlg-rebuild').classList.add('hidden');
    if (rebuildResolve) {
      rebuildResolve(proceed);
      rebuildResolve = null;
    }
  }

  async function deleteRebuildFiles(): Promise<void> {
    const version = $<HTMLInputElement>('#field-version').value.trim();
    const prev = state.project ? findSuccessByVersion(state.project.dir, version) : null;
    if (!prev) return;
    for (const f of prev.artifacts || []) {
      try {
        await window.builder.trashPath(f.path);
      } catch {
        /* best effort — a locked file just gets overwritten by the build */
      }
    }
    snack('Previous build files moved to the Recycle Bin.');
  }

  function updateSummary(): void {
    if (state.page !== 'config' && !window.__demo) return;
    const name = state.appName || (state.project ? state.project.name : 'App');
    const version = $<HTMLInputElement>('#field-version').value.trim() || '…';
    const fmt = state.format === 'aab' ? 'AAB bundle' : `APK · ${state.archs.size || 0} architecture${state.archs.size === 1 ? '' : 's'}`;
    const sdkTxt = state.targetSdk ? ` · API ${state.targetSdk}` : '';
    $('#summary-info').innerHTML = '';
    const b = document.createElement('b');
    b.textContent = `${name} v${version}`;
    $('#summary-info').append(b, ` — ${state.signed ? 'signed release' : 'unsigned release'} · ${fmt}${sdkTxt}`);
  }

  function collectConfig(debug?: boolean): BuildConfig {
    return {
      projectDir: state.project!.dir,
      appName: state.appName || (state.project && state.project.name) || 'App',
      version: $<HTMLInputElement>('#field-version').value.trim(),
      versionCode: Number($<HTMLInputElement>('#field-versioncode').value.trim()),
      signed: state.signed,
      keyAlias: $<HTMLInputElement>('#field-alias').value.trim(),
      keyPassword: $<HTMLInputElement>('#field-keypass').value,
      keystorePassword: $<HTMLInputElement>('#field-storepass').value,
      countryCode: state.country,
      format: state.format,
      archs: [...state.archs],
      relocate: state.relocate,
      debug: !!debug,
      targetSdk: state.targetSdk ? Number(state.targetSdk) : undefined,
    };
  }

  // ─────────────────────────────── page 3 ──────────────────────────────────
  function clearConsole(): void {
    $('#console-body').innerHTML = '';
    state.logLines = [];
    state.stick = true;
  }

  function appendLog(text: string, cls?: string): void {
    const body = $('#console-body');
    const div = document.createElement('div');
    div.className = `log-line${cls ? ` ${cls}` : ''}`;
    div.textContent = text;
    body.append(div);
    state.logLines.push(text);
    if (state.logLines.length > 4000) {
      state.logLines.splice(0, 500);
      while (body.children.length > 3500) body.firstElementChild!.remove();
    }
    if (state.stick) body.scrollTop = body.scrollHeight;
  }

  function classifyLine(text: string, stream: string): string {
    if (stream === 'err') return 'err';
    if (/^Running:|^\$ |command line/i.test(text)) return 'cmd';
    if (/BUILD SUCCESSFUL|Built:|VALID|Keystore is VALID/i.test(text)) return 'ok';
    if (/^WARNING|⚠|multiple|deprecated/i.test(text)) return 'warn';
    return '';
  }

  function setPhase(id: string, pillClass?: 'ok' | 'fail'): void {
    state.phase = id;
    if (id !== 'done') state.lastPhase = id;
    const label = PHASES[id] || id;
    $('#phase-label').textContent = label;
    const pill = $('#phase-pill');
    pill.classList.remove('ok', 'fail');
    if (pillClass) pill.classList.add(pillClass);
    const spin = $('#phase-spinner');
    if (pillClass) {
      spin.style.background = 'none';
      spin.textContent = pillClass === 'ok' ? '✓' : '✕';
      spin.style.fontSize = '15px';
      spin.style.fontWeight = '700';
      spin.style.color = pillClass === 'ok' ? 'var(--success)' : 'var(--error)';
    } else {
      spin.textContent = '';
      spin.style.background = '';
      spin.style.fontSize = '';
    }
    if (PHASES[id]) appendLog(PHASES[id], 'phase');
  }

  function startTimer(): void {
    state.buildStart = Date.now();
    $('#elapsed').textContent = '00:00';
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = setInterval(() => {
      $('#elapsed').textContent = fmtElapsed(Date.now() - state.buildStart);
    }, 1000);
  }

  function stopTimer(): void {
    clearInterval(state.elapsedTimer);
  }

  function renderBuildChips(cfg: BuildMetaCfg): void {
    const chips: string[] = [];
    chips.push(cfg.format === 'aab' ? 'AAB' : 'APK');
    if (cfg.format === 'apk') chips.push(cfg.archs.join(', '));
    chips.push(cfg.signed ? 'Signed' : 'Unsigned');
    if (cfg.targetSdk) chips.push(`API ${cfg.targetSdk}`);
    if (cfg.debug) chips.push('DEBUG');
    const box = $('#build-chips');
    box.innerHTML = '';
    for (const c of chips) {
      const el = document.createElement('span');
      el.className = 'chip selected';
      el.textContent = c;
      box.append(el);
    }
  }

  async function startBuild(debug: boolean): Promise<void> {
    if (state.buildRunning) return;
    const cfg = collectConfig(debug);
    state.buildCfg = cfg;
    state.lastDebug = !!debug;
    state.artifacts = [];
    state.keystore = null;
    state.keyFailPath = null;
    state.phase = null;
    state.lastPhase = null;
    state.buildRunning = true;

    clearConsole();
    renderBuildChips(cfg);
    $('#build-title').textContent = debug ? 'Building release (debug mode)…' : 'Building release…';
    $('#console-title').textContent = debug ? 'build log — debug mode' : 'build log';
    $('#console-live').classList.remove('hidden');
    $('#btn-cancel').classList.remove('hidden');
    $<HTMLButtonElement>('#btn-cancel').disabled = false;
    $('#btn-back-projects').classList.add('hidden');
    setPhase('init');
    startTimer();
    setPage('build');

    // Remember the signing passwords (encrypted, per project) so the next
    // build of this project can autofill them after a Windows Hello check.
    if (cfg.signed) {
      await saveSecrets(['keypass', 'storepass']);
    }

    const res = await window.builder.startBuild(cfg);
    if (!res.ok) {
      state.buildRunning = false;
      stopTimer();
      setPhase('done', 'fail');
      $('#phase-label').textContent = 'Could not start';
      appendLog(`Failed to start the build: ${res.error}`, 'err');
      $('#console-live').classList.add('hidden');
      $('#btn-back-projects').classList.remove('hidden');
      showFailDialog();
    }
  }

  function onBuildEvent(evt: BuildEvent): void {
    switch (evt.type) {
      case 'meta': {
        for (const note of evt.notes || []) appendLog(note, 'warn');
        if (evt.debug) appendLog('Debug mode: gradle --stacktrace --info + shell tracing enabled.', 'cmd');
        if (evt.cfg) {
          state.buildCfg = evt.cfg;
          if (!state.buildStart) state.buildStart = Date.now();
        }
        break;
      }
      case 'phase':
        setPhase(evt.id);
        break;
      case 'line':
        appendLog(evt.text, classifyLine(evt.text, evt.stream));
        break;
      case 'artifact':
        state.artifacts.push({ path: evt.path, size: evt.size });
        appendLog(`✓ Output ready: ${basename(evt.path)}${evt.size != null ? ` (${fmtSize(evt.size)})` : ''}`, 'ok');
        break;
      case 'keystore':
        state.keystore = { path: evt.path, size: evt.size };
        appendLog(`✓ Keystore: ${basename(evt.path)}`, 'ok');
        break;
      case 'keyfail':
        state.keyFailPath = evt.path;
        appendLog(`✗ Keystore rejected the configured passwords: ${evt.path}`, 'err');
        break;
      case 'exit':
        state.buildRunning = false;
        stopTimer();
        recordBuildFromExit(evt);
        $('#console-live').classList.add('hidden');
        $('#btn-cancel').classList.add('hidden');
        if (evt.canceled) {
          setPhase('done', 'fail');
          $('#phase-label').textContent = 'Canceled';
          appendLog('Build canceled by user.', 'warn');
          snack('Build canceled.');
          $('#btn-back-projects').classList.remove('hidden');
        } else if (evt.code === 0) {
          setPhase('done', 'ok');
          appendLog('BUILD SUCCESSFUL', 'ok');
          setTimeout(() => finishBuild(), 700);
        } else {
          setPhase('done', 'fail');
          const where = state.lastPhase && PHASES[state.lastPhase] ? `during ${PHASES[state.lastPhase].toLowerCase()}` : `exit code ${evt.code}`;
          $('#phase-label').textContent = `Failed (${where})`;
          appendLog(`Process exited with code ${evt.code}.`, 'err');
          $('#btn-back-projects').classList.remove('hidden');
          // A keystore mismatch gets its own asking-mode dialog: archive the
          // old key and build with a fresh one, or keep everything as-is.
          if (state.keyFailPath) showKeyResetDialog();
          else showFailDialog();
        }
        break;
      case 'error':
        appendLog(evt.message, 'err');
        break;
    }
  }

  /** Persist the finished build (success / failure / cancel) in the project's history. */
  function recordBuildFromExit(evt: Extract<BuildEvent, { type: 'exit' }>): void {
    const cfg = state.buildCfg;
    if (!cfg || !cfg.projectDir) return;
    recordBuild({
      projectDir: cfg.projectDir,
      ts: Date.now(),
      durationMs: Date.now() - state.buildStart,
      status: evt.canceled ? 'canceled' : evt.code === 0 ? 'success' : 'failed',
      appName: cfg.appName,
      version: cfg.version,
      versionCode: cfg.versionCode,
      format: cfg.format,
      archs: [...(cfg.archs || [])],
      signed: !!cfg.signed,
      debug: !!cfg.debug,
      targetSdk: cfg.targetSdk || undefined,
      artifacts: state.artifacts.map((a) => ({ path: a.path, size: a.size })),
      keystore: state.keystore ? { path: state.keystore.path, size: state.keystore.size } : null,
    });
  }

  function showFailDialog(): void {
    const wasDebug = state.lastDebug;
    $('#dlg-debug-text').textContent = wasDebug
      ? 'The debug run failed too. Run it one more time in debug mode, or inspect the log above.'
      : 'Do you want to run it again in debug mode with stack-trace and more details?';
    ($('#btn-fail-debug').lastChild as Text).textContent = wasDebug ? ' Run again' : ' Run in debug mode';
    $('#scrim').classList.remove('hidden');
    $('#dlg-debug').classList.remove('hidden');
  }

  function closeFailDialog(): void {
    $('#scrim').classList.add('hidden');
    $('#dlg-debug').classList.add('hidden');
  }

  // ── keystore reset (asking mode) ─────────────────────────────────────────
  // Shown when a build aborted because the saved passwords don't unlock the
  // project's keystore. Confirming archives android-key/ as
  // android-key-old[-N] (nothing deleted) and rebuilds with a fresh key.
  function showKeyResetDialog(): void {
    const dir = state.buildCfg?.projectDir || '';
    const sep = dir.includes('\\') ? '\\' : '/';
    const oldPath = state.keyFailPath || `${dir}${sep}android-key`;
    $('#keyreset-old-path').textContent = oldPath;
    $('#keyreset-new-path').textContent = `${dir}${sep}android-key-old`;
    $('#scrim').classList.remove('hidden');
    $('#dlg-keyreset').classList.remove('hidden');
  }

  function closeKeyResetDialog(): void {
    $('#scrim').classList.add('hidden');
    $('#dlg-keyreset').classList.add('hidden');
    state.keyFailPath = null;
  }

  async function confirmKeyReset(): Promise<void> {
    const dir = state.buildCfg?.projectDir;
    if (!dir) return;
    const btn = $<HTMLButtonElement>('#btn-keyreset-confirm');
    btn.disabled = true;
    let res: KeyResetResult;
    try {
      res = await window.builder.renameKeystore(dir);
    } catch (err) {
      res = { ok: false, error: String(err) };
    }
    btn.disabled = false;
    closeKeyResetDialog();
    if (!res.ok) {
      snack(`Could not archive the old key: ${res.error}`);
      return;
    }
    snack(`Old key archived as ${basename(res.to)} — building with a fresh key.`);
    // The user just confirmed this rebuild: skip the version-warning dialog.
    void startBuild(false);
  }

  function finishBuild(): void {
    renderResult();
    setPage('result');
  }

  // ─────────────────────────────── page 4 ──────────────────────────────────
  function artifactRow({ name, size, kind, path, note }: { name: string; size: number | null; kind: string; path: string; note: string }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'artifact';

    const icon = document.createElement('div');
    icon.className = `artifact-icon ${kind}`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.classList.add('icon');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', kind === 'jks'
      ? 'M12.65 10C11.83 7.67 9.61 6 7 6a6 6 0 1 0 5.65 8H17v4h4v-4h2v-4H12.65zM7 14a2 2 0 1 1 2-2 2 2 0 0 1-2 2z'
      : 'M6 18c0 .55.45 1 1 1h1v3.5a1.5 1.5 0 0 0 3 0V19h2v3.5a1.5 1.5 0 0 0 3 0V19h1c.55 0 1-.45 1-1V9H6v9zM3.5 9A1.5 1.5 0 0 0 2 10.5v5A1.5 1.5 0 0 0 5 15.5v-5A1.5 1.5 0 0 0 3.5 9zm17 0A1.5 1.5 0 0 0 19 10.5v5a1.5 1.5 0 0 0 3 0v-5A1.5 1.5 0 0 0 20.5 9zM16.53 3.16l1.3-1.3-.8-.8-1.32 1.27A6.9 6.9 0 0 0 12 1.6c-1.05 0-1.9.27-2.71.73L7.97 1.06l-.8.8 1.3 1.3A5.9 5.9 0 0 0 6 8h12a5.9 5.9 0 0 0-1.47-4.84zM9.5 6.6a.9.9 0 1 1 .9-.9.9.9 0 0 1-.9.9zm5 0a.9.9 0 1 1 .9-.9.9.9 0 0 1-.9.9z');
    svg.append(p);
    icon.append(svg);

    const info = document.createElement('div');
    const nm = document.createElement('div');
    nm.className = 'artifact-name';
    nm.textContent = name;
    const meta = document.createElement('div');
    meta.className = 'artifact-meta';
    meta.textContent = [size != null ? fmtSize(size) : '', note].filter(Boolean).join(' · ');
    info.append(nm, meta);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const save = document.createElement('button');
    save.className = 'btn tonal sm';
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', async () => {
      const res = await window.builder.saveFile(path, name);
      if (res.ok) snack(`Saved to ${res.path}`);
    });
    const reveal = document.createElement('button');
    reveal.className = 'icon-btn';
    reveal.type = 'button';
    reveal.title = 'Show in folder';
    reveal.innerHTML =
      '<svg viewBox="0 0 24 24" class="icon"><path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm0 12H4V8h16v10z"/></svg>';
    reveal.addEventListener('click', () => window.builder.revealPath(path));
    actions.append(save, reveal);

    row.append(icon, info, actions);
    return row;
  }

  function renderResult(): void {
    const cfg = state.buildCfg;
    const list = $('#artifact-list');
    list.innerHTML = '';

    for (const a of state.artifacts) {
      list.append(artifactRow({
        name: basename(a.path),
        size: a.size,
        kind: a.path.endsWith('.aab') ? 'aab' : 'apk',
        path: a.path,
        note: a.path.endsWith('.aab') ? 'Play Store bundle' : 'installable APK',
      }));
    }

    if (state.keystore) {
      list.append(artifactRow({
        name: 'android-key.jks',
        size: state.keystore.size,
        kind: 'jks',
        path: state.keystore.path,
        note: 'persistent signing key — keep it safe',
      }));
    }

    const count = state.artifacts.length + (state.keystore ? 1 : 0);
    $('#zip-key-note').textContent = state.keystore ? 'plus the keystore ' : '';
    $('#result-title').textContent = state.artifacts.length > 1 ? 'Build complete — all architectures' : 'Build complete';
    $('#result-sub').textContent =
      `${cfg?.appName || 'App'} v${cfg?.version || ''} · ${cfg?.format === 'aab' ? 'AAB' : 'APK'} · ` +
      `${cfg?.signed ? 'signed' : 'unsigned'} · finished in ${fmtElapsed(Date.now() - state.buildStart)}`;
  }

  async function downloadZip(): Promise<void> {
    if (!state.artifacts.length) return;
    const cfg = state.buildCfg;
    const entries: ZipEntry[] = state.artifacts.map((a) => ({ path: a.path, name: basename(a.path) }));
    if (state.keystore) entries.push({ path: state.keystore.path, name: 'android-key.jks' });

    const safeName = (cfg?.appName || 'app').replace(/[\\/:*?"<>|]/g, '_').replace(/ /g, '_');
    const zipName = `${safeName}-v${cfg?.version || '0.0.0'}-${cfg?.format || 'apk'}.zip`;

    const btn = $<HTMLButtonElement>('#btn-download-zip');
    btn.disabled = true;
    try {
      const made = await window.builder.makeZip(entries);
      if (!made.ok) throw new Error(made.error || 'zip failed');
      const saved = await window.builder.saveFile(made.path, zipName);
      if (saved.ok) snack(`ZIP saved to ${saved.path}`);
      else snack('Download canceled.');
    } catch (err) {
      snack(`Could not create ZIP: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  function startOver(): void {
    $<HTMLInputElement>('#field-keypass').value = '';
    $<HTMLInputElement>('#field-storepass').value = '';
    state.artifacts = [];
    state.keystore = null;
    state.buildCfg = null;
    repick();
    setPage('select');
  }

  // ───────────────────────── country combobox ──────────────────────────────
  function initCountryCombo(): void {
    const wrap = $('#wrap-country');
    const menu = $('#country-menu');
    const search = $<HTMLInputElement>('#country-search');
    const listEl = $('#country-list');
    let hlIndex = -1;
    let filtered: Array<[string, string]> = [...window.COUNTRIES];

    const renderList = () => {
      listEl.innerHTML = '';
      if (!filtered.length) {
        const none = document.createElement('button');
        none.type = 'button';
        none.className = 'combo-item none';
        none.textContent = 'No matching country';
        listEl.append(none);
        return;
      }
      filtered.forEach(([cc, name], i) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `combo-item${i === hlIndex ? ' hl' : ''}`;
        item.setAttribute('role', 'option');
        const badge = document.createElement('span');
        badge.className = 'cc-badge';
        badge.textContent = cc;
        const label = document.createElement('span');
        label.textContent = name;
        const code = document.createElement('span');
        code.className = 'cc';
        code.textContent = cc;
        item.append(badge, label, code);
        item.addEventListener('click', () => select(cc));
        listEl.append(item);
      });
    };

    const applyFilter = () => {
      const q = search.value.trim().toLowerCase();
      filtered = window.COUNTRIES.filter(
        ([cc, name]) => !q || name.toLowerCase().includes(q) || cc.toLowerCase().includes(q)
      );
      hlIndex = filtered.length ? 0 : -1;
      renderList();
    };

    const syncButton = () => {
      const value = $('#country-value');
      if (!state.country) {
        value.className = 'combo-value';
        value.textContent = '';
        wrap.classList.remove('has-value');
      } else {
        value.className = 'combo-value';
        value.innerHTML = '';
        const badge = document.createElement('span');
        badge.className = 'cc-badge';
        badge.textContent = state.country;
        const name = document.createElement('span');
        name.textContent = window.countryName(state.country) || state.country;
        value.append(badge, name);
        wrap.classList.add('has-value');
      }
    };

    const select = (cc: string) => {
      state.country = cc;
      localStorage.setItem('ab.country', cc);
      syncButton();
      close();
      clearError('country');
    };

    const open = () => {
      wrap.classList.remove('open-up');
      wrap.classList.add('open');
      search.value = '';
      applyFilter(); // populate the list before measuring the menu's real height
      // Flip the menu above the button when it would overflow the viewport.
      const btnRect = $('#country-btn').getBoundingClientRect();
      const menuH = menu.offsetHeight;
      if (btnRect.bottom + menuH + 8 > window.innerHeight && btnRect.top - menuH - 8 > 0) {
        wrap.classList.add('open-up');
      }
      setTimeout(() => search.focus(), 40);
    };

    const close = () => {
      wrap.classList.remove('open');
      wrap.classList.remove('open-up');
      wrap.classList.toggle('invalid', !!$('#err-country').textContent);
    };

    $('#country-btn').addEventListener('click', () => (wrap.classList.contains('open') ? close() : open()));
    search.addEventListener('input', applyFilter);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!filtered.length) return;
        hlIndex = (hlIndex + (e.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length;
        renderList();
        listEl.children[hlIndex]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[hlIndex]) select(filtered[hlIndex][0]);
      } else if (e.key === 'Escape') {
        close();
      }
    });

    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target as Node)) close();
    });

    syncButton();
  }

  // ───────────────────────── password generator ────────────────────────────
  const gen = {
    target: null as string | null,
    len: 16,
    upper: true,
    lower: true,
    digit: true,
    symbol: true,
    ambiguous: false,
    value: '',
  };
  type GenToggleKey = 'upper' | 'lower' | 'digit' | 'symbol';

  const SETS: Record<GenToggleKey, string> = {
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower: 'abcdefghijklmnopqrstuvwxyz',
    digit: '0123456789',
    symbol: '!@#$%^&*()-_=+[]{};:,.?/',
  };
  const AMBIGUOUS = 'O0oIl1|`\'"~,;:.';

  function generatePassword(): string {
    const classes = (['upper', 'lower', 'digit', 'symbol'] as GenToggleKey[]).filter((k) => gen[k]);
    if (!classes.length) return '';
    let pool = classes.map((k) => SETS[k]).join('');
    if (!gen.ambiguous) pool = [...pool].filter((c) => !AMBIGUOUS.includes(c)).join('');

    const rand = new Uint32Array(gen.len);
    crypto.getRandomValues(rand);
    const chars = classes.map((k) => {
      const set = [...SETS[k]].filter((c) => gen.ambiguous || !AMBIGUOUS.includes(c));
      return set[rand[classes.indexOf(k)] % set.length];
    });
    while (chars.length < gen.len) chars.push(pool[rand[chars.length] % pool.length]);

    // Fisher–Yates with fresh entropy
    const sh = new Uint32Array(chars.length);
    crypto.getRandomValues(sh);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = sh[i] % (i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    gen.value = chars.join('');
    return gen.value;
  }

  function strengthOf(pw: string): { bits: number; label: string; pct: number } {
    if (!pw) return { bits: 0, label: '—', pct: 0 };
    let pool = 0;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/\d/.test(pw)) pool += 10;
    if (/[^A-Za-z0-9]/.test(pw)) pool += 24;
    const bits = Math.round(pw.length * Math.log2(pool || 2));
    const label = bits < 50 ? 'Weak' : bits < 75 ? 'Fair' : bits < 100 ? 'Strong' : 'Excellent';
    return { bits, label, pct: Math.min(100, Math.round((bits / 128) * 100)) };
  }

  function refreshGenerator(): void {
    const pw = generatePassword();
    $('#gen-output').textContent = pw || 'Enable at least one character set';
    const st = strengthOf(pw);
    $('#gen-strength').style.width = `${st.pct}%`;
    $('#gen-strength-label').textContent = pw ? `${st.label} · ${st.bits} bits` : '—';
  }

  function openGenerator(targetField: string): void {
    gen.target = targetField;
    refreshGenerator();
    $('#scrim').classList.remove('hidden');
    $('#dlg-generator').classList.remove('hidden');
  }

  function closeGenerator(): void {
    $('#scrim').classList.add('hidden');
    $('#dlg-generator').classList.add('hidden');
  }

  function initGenerator(): void {
    const syncToggles = () => {
      $$('.gen-toggles .checkbox').forEach((box) => {
        const k = box.dataset.gt as GenToggleKey | undefined;
        box.classList.toggle('on', !!k && gen[k]);
      });
    };
    $$('.gen-toggles .checkbox').forEach((box) =>
      box.addEventListener('click', () => {
        const k = box.dataset.gt as GenToggleKey | undefined;
        if (!k) return;
        gen[k] = !gen[k];
        syncToggles();
        refreshGenerator();
      })
    );
    syncToggles();

    const slider = $<HTMLInputElement>('#gen-len');
    const syncSlider = () => {
      $('#gen-len-out').textContent = slider.value;
      slider.style.setProperty('--fill', `${((Number(slider.value) - 8) / 24) * 100}%`);
    };
    slider.addEventListener('input', () => {
      gen.len = Number(slider.value);
      syncSlider();
      refreshGenerator();
    });
    syncSlider();

    $('#btn-gen-refresh').addEventListener('click', refreshGenerator);
    $('#btn-gen-cancel').addEventListener('click', closeGenerator);
    $('#btn-gen-use').addEventListener('click', () => {
      const target = gen.target;
      const value = gen.value;
      if (target && value) {
        const input = document.getElementById(target);
        if (input instanceof HTMLInputElement) {
          input.value = value;
          input.dispatchEvent(new Event('input'));
        }
      }
      closeGenerator();
      if (!(target && value)) {
        snack('Password applied.');
        return;
      }
      // The generated password goes straight into the encrypted vault.
      const field: VaultField = target === 'field-storepass' ? 'storepass' : 'keypass';
      saveSecrets([field]).then(() => snack('Password applied and saved encrypted.'));
    });
  }

  // ─────────────────────────────── wiring ──────────────────────────────────
  function init(): void {
    if (!window.builder) {
      document.body.innerHTML = '<p style="padding:40px">This page must run inside the Expo Builder app.</p>';
      return;
    }

    $('#btn-pick').addEventListener('click', pickDirectory);
    $('#btn-repick').addEventListener('click', repick);
    $('#btn-continue').addEventListener('click', goToConfig);

    // environment gate (page 0)
    $('#btn-env-continue').addEventListener('click', () => setPage('select'));
    $('#btn-env-recheck').addEventListener('click', runEnvCheck);
    $('#btn-env-recheck2').addEventListener('click', runEnvCheck);
    $('#btn-version-close').addEventListener('click', closeVersionDialog);
    $('#btn-install-update').addEventListener('click', () => void startInstall());
    $('#btn-install-cancel').addEventListener('click', async () => {
      $<HTMLButtonElement>('#btn-install-cancel').disabled = true;
      $('#dlg-version-phase').textContent = 'Canceling…';
      await window.builder.cancelInstall();
      $<HTMLButtonElement>('#btn-install-cancel').disabled = false;
    });

    // signing-password vault (page 2): fingerprint = unlock & autofill
    $('#btn-vault-fill').addEventListener('click', () => unlockVault({ manual: true }));
    $('#btn-vault-forget').addEventListener('click', async () => {
      if (!state.project) return;
      try {
        await window.builder.forgetSecrets(state.project.dir);
      } catch { /* ignore */ }
      $('#btn-vault-forget').classList.add('hidden');
      snack('Saved passwords forgotten for this project.');
    });
    // The OS consent prompt appearing freezes the app behind the unlock
    // overlay; Cancel dismisses the prompt itself (main kills the probe).
    window.builder.onVaultAuthEvent(() => {
      clearTimeout(vaultAuthShowTimer);
      vaultAuthShowTimer = setTimeout(showVaultAuth, 250);
    });
    $('#btn-vault-cancel').addEventListener('click', () => {
      vaultAuthCanceled = true;
      void window.builder.cancelVaultAuth();
      hideVaultAuth();
    });

    // custom frameless-window controls
    $('#win-minimize').addEventListener('click', () => window.builder.minimizeWindow());
    $('#win-close').addEventListener('click', () => window.builder.closeWindow());

    // name-the-project dialog (page 1)
    $('#btn-name-ok').addEventListener('click', confirmProjectName);
    $('#btn-name-cancel').addEventListener('click', cancelProjectName);
    $<HTMLInputElement>('#field-projectname').addEventListener('input', () => clearError('projectname'));
    $<HTMLInputElement>('#field-projectname').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmProjectName();
      }
    });

    initForm();
    initCountryCombo();
    initGenerator();

    // build page
    $('#btn-cancel').addEventListener('click', async () => {
      $<HTMLButtonElement>('#btn-cancel').disabled = true;
      appendLog('Canceling build…', 'warn');
      await window.builder.cancelBuild();
    });
    $('#btn-back-projects').addEventListener('click', () => setPage('select'));
    $('#btn-copy-log').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.logLines.join('\n'));
        snack('Log copied to clipboard.');
      } catch {
        snack('Could not access the clipboard.');
      }
    });

    // result page
    $('#btn-download-zip').addEventListener('click', downloadZip);
    $('#btn-open-project').addEventListener('click', () => state.project && window.builder.openPath(state.project.dir));
    $('#btn-start-over').addEventListener('click', startOver);

    // build history (project page + dialogs)
    $('#history-clear').addEventListener('click', () => {
      if (!state.project) return;
      clearBuilds(state.project.dir);
      renderHistoryCard();
      renderProjectsCard();
      snack('Build history cleared.');
    });
    $('#btn-history-close').addEventListener('click', closeHistoryDialog);
    $('#btn-rebuild-cancel').addEventListener('click', () => closeRebuildDialog(false));
    $('#btn-rebuild-keep').addEventListener('click', () => closeRebuildDialog(true));
    $('#btn-rebuild-delete').addEventListener('click', async () => {
      await deleteRebuildFiles();
      closeRebuildDialog(true);
    });

    // fail dialog
    $('#btn-fail-close').addEventListener('click', closeFailDialog);
    $('#btn-fail-log').addEventListener('click', closeFailDialog);
    $('#btn-fail-debug').addEventListener('click', () => {
      closeFailDialog();
      startBuild(true);
    });

    // keystore-reset dialog (asking mode)
    $('#btn-keyreset-cancel').addEventListener('click', closeKeyResetDialog);
    $('#btn-keyreset-debug').addEventListener('click', () => {
      closeKeyResetDialog();
      startBuild(true);
    });
    $('#btn-keyreset-confirm').addEventListener('click', () => void confirmKeyReset());

    // console stick-to-bottom detection
    const body = $('#console-body');
    body.addEventListener('scroll', () => {
      state.stick = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // While the Windows Hello unlock overlay is up the app is frozen;
        // the OS prompt (or its Cancel button) is the only way out.
        if (!$('#vault-auth').classList.contains('hidden')) return;
        if (!$('#dlg-name').classList.contains('hidden')) cancelProjectName();
        if (!$('#dlg-rebuild').classList.contains('hidden')) closeRebuildDialog(false);
        else if (!$('#dlg-history').classList.contains('hidden')) closeHistoryDialog();
        if (!$('#dlg-keyreset').classList.contains('hidden')) closeKeyResetDialog();
        if (!$('#dlg-version').classList.contains('hidden')) closeVersionDialog();
        closeFailDialog();
        closeGenerator();
      }
    });

    window.builder.onBuildEvent(onBuildEvent);
    window.builder.onUpdateEvent(onUpdateEvent);
    loadProjects();
    setPage('deps');
    runEnvCheck();
    renderProjectsCard();
    initDemo();
  }

  // ───────────────────── demo hooks (smoke test only) ──────────────────────
  function initDemo(): void {
    if (!new URLSearchParams(location.search).has('demo')) return;

    window.__demo = {
      envCheck() {
        applyEnvResults(demoEnvResults(false));
      },
      envMissing() {
        applyEnvResults(demoEnvResults(true));
      },
      projects() {
        setPage('select');
        // In-memory only so smoke shots never touch the real saved list.
        state.projects = [
          { dir: 'F:\\Mahameh (App)', name: 'Mahameh', ts: Date.now() - 86400000 },
          { dir: 'D:\\Dev\\NoteTaker', name: 'Note Taker', ts: Date.now() - 2 * 86400000 },
          { dir: 'C:\\Code\\FocusTimer', name: 'Focus Timer', ts: Date.now() - 6 * 86400000 },
        ];
        renderProjectsCard();
      },
      config() {
        state.project = {
          dir: 'F:\\Mahameh (App)',
          name: 'Mahameh',
          slug: 'mahameh',
          version: '1.37.18',
          versionCode: 13718,
          androidPackage: 'com.devorev.mahameh',
          expoRange: '~58.0.7',
          pm: 'yarn',
          lockfile: 'yarn.lock',
          hasAndroidDir: true,
          hasPersistentKey: true,
          appConfigName: null,
          appJsonWritable: true,
        };
        renderProjectCard(state.project);
        $('#project-card').classList.remove('hidden');
        $('#select-card').classList.add('hidden');
        state.appName = 'Mahameh';
        prefillForm(state.project);
        $('#config-project-label').textContent = 'Mahameh — F:\\Mahameh (App)';
        $('#identity-note').textContent = 'App name: Mahameh — set when the project was defined.';
        $<HTMLInputElement>('#field-version').value = '1.37.19';
        $<HTMLInputElement>('#field-versioncode').value = computeVersionCode('1.37.19');
        $('#field-version').dispatchEvent(new Event('input'));
        $<HTMLInputElement>('#field-alias').value = 'mahameh.faslevasl';
        $<HTMLInputElement>('#field-keypass').value = 'nL54qLNBP2o8';
        $<HTMLInputElement>('#field-storepass').value = 'k8hi0d9x4E6O';
        setPage('config');
        updateSummary();
      },
      build() {
        state.buildCfg = collectConfig(false);
        state.buildStart = Date.now();
        clearConsole();
        renderBuildChips(state.buildCfg);
        setPhase('init');
        startTimer();
        setPage('build');
        const script: Array<['meta' | 'line' | 'phase' | 'artifact' | 'keystore', string | null]> = [
          ['meta', null],
          ['line', 'Detected package manager: yarn'],
          ['line', "yarn install v1.22.22"],
          ['line', 'info No lockfile found.'],
          ['line', 'success Saved lockfile.'],
          ['phase', 'dependencies'], ['phase', 'prebuild'],
          ['line', '⧗ Starting Metro Bundler'],
          ['line', 'Android project generated at ./android'],
          ['phase', 'keystore'],
          ['line', '🔑 Using keystore \'android-key/android-key.jks\'...'],
          ['line', '✅ Keystore is VALID and matches the credentials. Proceeding...'],
          ['phase', 'gradle'],
          ['line', 'Running: ./gradlew assembleRelease --no-daemon --console=plain'],
          ['line', '> Task :app:preBuild UP-TO-DATE'],
          ['line', '> Task :app:bundleReleaseJsAndAssets'],
          ['line', 'info Writing bundle output to: assets/index.android.bundle'],
          ['line', '> Task :app:packageRelease'],
          ['line', '> Task :app:assembleRelease'],
          ['line', 'BUILD SUCCESSFUL in 4m 12s'],
          ['phase', 'collect'],
          ['artifact', 'Mahameh.v1.37.19.arm64-v8a.apk'],
          ['artifact', 'Mahameh.v1.37.19.armeabi-v7a.apk'],
          ['keystore', 'android-key.jks'],
        ];
        script.forEach(([type, val], i) => {
          setTimeout(() => {
            if (type === 'line') appendLog(val as string, classifyLine(val as string, 'out'));
            else if (type === 'phase') setPhase(val as string);
            else if (type === 'artifact') {
              state.artifacts.push({ path: `F:\\Mahameh (App)\\${val}`, size: 52428800 + i * 1024 * 1024 });
              appendLog(`✓ Output ready: ${val}`, 'ok');
            } else if (type === 'keystore') {
              state.keystore = { path: 'F:\\Mahameh (App)\\android-key\\android-key.jks', size: 2070 };
              appendLog('✓ Keystore: android-key.jks', 'ok');
            }
          }, 220 * i);
        });
      },
      // Build page after the process stopped (failed/canceled) — the state
      // where the Back-to-projects button matters. No history write: the
      // demo project dir is fake.
      buildStopped() {
        state.buildCfg = collectConfig(false);
        state.buildRunning = false;
        state.buildStart = Date.now() - 95000;
        clearConsole();
        renderBuildChips(state.buildCfg);
        setPhase('gradle');
        appendLog('Running: ./gradlew assembleRelease --no-daemon --console=plain', 'cmd');
        appendLog('> Task :app:bundleReleaseJsAndAssets');
        appendLog('> Task :app:packageRelease', '');
        appendLog('FAILURE: Build failed with an exception.', 'err');
        appendLog('Process exited with code 1.', 'err');
        stopTimer();
        $('#elapsed').textContent = fmtElapsed(Date.now() - state.buildStart);
        setPhase('done', 'fail');
        $('#phase-label').textContent = 'Failed (during gradle build)';
        $('#console-live').classList.add('hidden');
        $('#btn-cancel').classList.add('hidden');
        $('#btn-back-projects').classList.remove('hidden');
        setPage('build');
      },
      // Keystore-reset dialog (screenshots only): failed build + the
      // asking-mode archive-and-rebuild dialog on top.
      keyResetDialog() {
        window.__demo?.buildStopped();
        state.keyFailPath = 'F:\\Mahameh (App)\\android-key\\android-key.jks';
        showKeyResetDialog();
      },
      result() {
        state.buildCfg = state.buildCfg || collectConfig(false);
        if (!state.artifacts.length) {
          state.artifacts = [
            { path: 'F:\\Mahameh (App)\\Mahameh.v1.37.19.arm64-v8a.apk', size: 52428800 },
            { path: 'F:\\Mahameh (App)\\Mahameh.v1.37.19.armeabi-v7a.apk', size: 45298483 },
          ];
          state.keystore = { path: 'F:\\Mahameh (App)\\android-key\\android-key.jks', size: 2070 };
        }
        setPhase('done', 'ok');
        stopTimer();
        renderResult();
        setPage('result');
      },
      generator() {
        openGenerator('field-keypass');
      },
      // Version dialog in install-progress mode (screenshots only).
      updateDialog(id?: string) {
        const upd = demoUpdates().deps.find((d) => d.id === (id || 'cmake')) || demoUpdates().deps.find((d) => d.id === 'cmake')!;
        const installer = upd.id === 'node' || upd.id === 'jdk';
        openVersionDialog(upd);
        enterInstallMode(installer ? 'installer' : 'sdk');
        setInstallProgress(null, installer ? 'Downloading…' : 'Downloading & installing…');
        setInstallProgress(installer ? 14 : 62, installer ? '1.2 MB of 8.9 MB' : 'Unzipping cmake;4.1.2');
        (installer
          ? ['Resolving https://api.adoptium.net/v3/installer/latest/21/windows/x64/jdk/hotspot/normal/eclipse',
             'Downloading temurin-jdk-21-latest-x64.msi']
          : ['[============================================ ]  62% Unzipping… cmake;4.1.2',
             'Installing SDK package cmake;4.1.2']
        ).forEach(appendInstallLog);
      },
      updateDialogDone() {
        finishInstall(true, 'Installed. Re-checking your tools…');
      },
      history() {
        state.project = {
          dir: 'F:\\Mahameh (App)',
          name: 'Mahameh',
          slug: 'mahameh',
          version: '1.37.18',
          versionCode: 13718,
          androidPackage: 'com.devorev.mahameh',
          expoRange: '~58.0.7',
          pm: 'yarn',
          lockfile: 'yarn.lock',
          hasAndroidDir: true,
          hasPersistentKey: true,
          appConfigName: null,
          appJsonWritable: true,
        };
        state.appName = 'Mahameh';
        const D = 86400000;
        demoBuilds = {
          'f:\\mahameh (app)': [
            { demo: true, ts: Date.now() - 0.2 * D, durationMs: 252000, status: 'failed', appName: 'Mahameh', version: '1.37.20', versionCode: 13720, format: 'apk', archs: ['arm64-v8a'], signed: true, debug: false, artifacts: [], keystore: null },
            { demo: true, ts: Date.now() - 1 * D, durationMs: 451000, status: 'success', appName: 'Mahameh', version: '1.37.19', versionCode: 13719, format: 'apk', archs: ['arm64-v8a', 'armeabi-v7a'], signed: true, debug: false,
              artifacts: [
                { path: 'F:\\Mahameh (App)\\Mahameh.v1.37.19.arm64-v8a.apk', size: 52428800 },
                { path: 'F:\\Mahameh (App)\\Mahameh.v1.37.19.armeabi-v7a.apk', size: 45298483 },
              ], keystore: { path: 'F:\\Mahameh (App)\\android-key\\android-key.jks', size: 2070 } },
            { demo: true, ts: Date.now() - 5 * D, durationMs: 365000, status: 'success', appName: 'Mahameh', version: '1.37.18', versionCode: 13718, format: 'apk', archs: ['arm64-v8a'], signed: true, debug: false,
              artifacts: [{ path: 'F:\\Mahameh (App)\\Mahameh.v1.37.18.arm64-v8a.apk', size: 51100000 }],
              keystore: { path: 'F:\\Mahameh (App)\\android-key\\android-key.jks', size: 2070 } },
          ],
        };
        renderProjectCard(state.project);
        $('#project-card').classList.remove('hidden');
        $('#select-card').classList.add('hidden');
        renderProjectsCard();
        setPage('select');
        const hc = $('#history-card');
        if (hc) hc.scrollIntoView({ block: 'center' });
      },
      historyDetail() {
        const builds = loadBuilds(state.project ? state.project.dir : '');
        if (builds.length) openHistoryDialog(builds[1] || builds[0]);
      },
      versionWarning() {
        $<HTMLInputElement>('#field-version').value = '1.37.18';
        $<HTMLInputElement>('#field-versioncode').value = computeVersionCode('1.37.18');
        $('#field-version').dispatchEvent(new Event('input'));
      },
      rebuildDialog() {
        $<HTMLInputElement>('#field-version').value = '1.37.18';
        $<HTMLInputElement>('#field-versioncode').value = computeVersionCode('1.37.18');
        $('#field-version').dispatchEvent(new Event('input'));
        maybeConfirmRebuild();
      },
      resetVersion() {
        $<HTMLInputElement>('#field-version').value = '1.37.19';
        $<HTMLInputElement>('#field-versioncode').value = computeVersionCode('1.37.19');
        $('#field-version').dispatchEvent(new Event('input'));
      },
      failDialog() {
        showFailDialog();
      },
      // Windows Hello unlock overlay (screenshots only): the frozen blurred
      // state, then the success path fading away + autofilling the fields.
      vaultAuth() {
        $<HTMLInputElement>('#field-keypass').value = '';
        $<HTMLInputElement>('#field-storepass').value = '';
        showVaultAuth();
      },
      vaultAuthDone(fill = true) {
        hideVaultAuth();
        if (!fill) {
          snack('Locked — Windows Hello did not verify.');
          return;
        }
        $<HTMLInputElement>('#field-keypass').value = 'nL54qLNBP2o8';
        $<HTMLInputElement>('#field-storepass').value = 'k8hi0d9x4E6O';
        for (const id of ['#wrap-keypass', '#wrap-storepass']) {
          const wrap = $(id);
          wrap.classList.remove('vault-filled');
          void wrap.offsetWidth;
          wrap.classList.add('vault-filled');
        }
        snack('Saved passwords unlocked with Windows Hello.');
      },
      countryOpen(query?: string) {
        $('#country-btn').click();
        if (query) {
          $<HTMLInputElement>('#country-search').value = query;
          $('#country-search').dispatchEvent(new Event('input'));
        }
      },
    };
  }

  document.addEventListener('DOMContentLoaded', init);
})();
