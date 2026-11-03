/*
 * Shared domain + IPC types used by the main process, the preload bridge and
 * the renderer. Deliberately ambient globals (no `export`) so the renderer
 * sources stay import-free plain scripts — see renderer/tsconfig.json.
 */

type BuildFormat = 'apk' | 'aab';

/** Payload the renderer sends with `startBuild`. */
interface BuildConfig {
  projectDir: string;
  appName: string;
  version: string;
  versionCode: number;
  signed: boolean;
  keyAlias: string;
  keyPassword: string;
  keystorePassword: string;
  countryCode: string;
  format: BuildFormat;
  archs: string[];
  relocate: boolean;
  debug: boolean;
  /** Target Android API level; unset = whatever the Expo SDK toolchain defaults to. */
  targetSdk?: number;
}

/** The config subset the main process echoes back in `meta` events. */
type BuildMetaCfg = Pick<
  BuildConfig,
  'projectDir' | 'appName' | 'version' | 'versionCode' | 'format' | 'archs' | 'signed' | 'debug' | 'targetSdk'
>;

type BuildEvent =
  | { type: 'meta'; notes: string[]; bash: string; debug: boolean; cfg: BuildMetaCfg }
  | { type: 'phase'; id: string }
  | { type: 'line'; text: string; stream: 'out' | 'err' }
  | { type: 'artifact'; path: string; size: number | null }
  | { type: 'keystore'; path: string; size: number | null }
  | { type: 'keyfail'; path: string }
  | { type: 'done-marker' }
  | { type: 'exit'; code: number; canceled: boolean }
  | { type: 'error'; message: string };

type BuildStatus = 'success' | 'failed' | 'canceled';

interface ArtifactInfo {
  path: string;
  size: number | null;
}

type KeystoreInfo = ArtifactInfo;

/** A finished build as recorded in the per-project history. */
interface BuildRecord {
  id?: string;
  demo?: boolean;
  projectDir?: string;
  ts: number;
  durationMs: number;
  status: BuildStatus;
  appName: string;
  version: string;
  versionCode: number;
  format: string;
  archs: string[];
  signed: boolean;
  debug: boolean;
  /** Target Android API level this build was pinned to, when one was chosen. */
  targetSdk?: number;
  artifacts: ArtifactInfo[];
  keystore: KeystoreInfo | null;
}

interface ProjectInfo {
  dir: string;
  name: string;
  slug: string;
  version: string;
  versionCode: number;
  androidPackage: string;
  expoRange: string;
  pm: string;
  lockfile: string;
  appConfigName: string | null;
  hasAndroidDir: boolean;
  hasPersistentKey: boolean;
  appJsonWritable: boolean;
}

type ValidateResult = { ok: true; info: ProjectInfo } | { ok: false; error: string };

type CheckStatus = 'ok' | 'warn' | 'missing';

/** One row of the environment gate. */
interface CheckResult {
  id: string;
  label: string;
  required: boolean;
  status: CheckStatus;
  version?: string | null;
  detail?: string;
  hint?: string;
  path?: string | null;
}

interface EnvCheckResult {
  ok: boolean;
  os: { platform: string; arch: string; release: string };
  requiredFailed: string[];
  optionalMissing: string[];
  sdk: string | null;
  bash: string;
  checks: CheckResult[];
  fatal?: string;
}

/**
 * Newest-release info for one dependency row of the environment gate.
 * `latest` is always a stable release — the channel Expo/React Native release
 * builds are tested against; previews are reported separately. Detection is
 * read-only: the app never installs or upgrades anything.
 */
interface DepUpdateInfo {
  id: string;
  label: string;
  /** Installed version (same value the environment check reports). */
  current: string | null;
  /** Newest stable release, or null when it could not be determined. */
  latest: string | null;
  /** Newest preview/beta release, purely informational. */
  preview: string | null;
  /** True when latest is newer than current. */
  newer: boolean;
  /** Where `latest` came from (e.g. "dl.google.com · repository2-3.xml"). */
  source: string;
  /** Why `latest` is unknown, when it is. */
  error: string | null;
}

interface UpdatesResult {
  when: number;
  deps: DepUpdateInfo[];
}

/**
 * Progress events for a running dependency update. SDK components stream
 * sdkmanager's percentages; Node/JDK stream installer-download progress and
 * end with `installer-launched` (the MSI wizard takes over).
 */
type UpdateEvent =
  | { type: 'phase'; id: 'license' | 'download' | 'install' }
  | { type: 'progress'; percent: number | null; text: string }
  | { type: 'line'; text: string; stream: 'out' | 'err' }
  | { type: 'installer-launched'; path: string }
  | { type: 'exit'; code: number; canceled: boolean };

type InstallStartResult = { ok: true; kind: 'sdk' | 'installer' } | { ok: false; error: string };

/** Default + last-saved target folder for a fresh Android SDK install. */
interface SdkDirInfo {
  default: string;
  saved: string | null;
}

/**
 * One selectable download source for the Android SDK repository (Google by
 * default; mirrors for networks where Google is blocked). The source decides
 * where the repository manifest and every SDK/NDK/CMake package zip are
 * fetched from; the active source is persisted app-wide in the main process.
 */
interface DownloadSourceProvider {
  id: string;
  label: string;
  region: string;
  host: string;
  note: string;
}

interface DownloadSourceInfo {
  /** Id of the currently active source (a provider id, or "custom"). */
  current: string;
  providers: DownloadSourceProvider[];
  /** Base URL of the custom source, when one is configured. */
  customBase?: string | null;
}

interface ZipEntry {
  path: string;
  name: string;
}

type ZipResult = { ok: true; path: string; size: number; uncompressed: number } | { ok: false; error: string };
type SaveResult = { ok: true; path: string } | { ok: false; canceled: true };
type StartBuildResult = { ok: true } | { ok: false; error: string };
type StatResult = { exists: true; size: number; mtime: number } | { exists: false };
type TrashResult = { ok: true } | { ok: false; error: string };
/** Result of archiving the old signing key (android-key → android-key-old[-N]). */
type KeyResetResult = { ok: true; from: string; to: string } | { ok: false; error: string };

/** Signing credentials stored in the per-project encrypted vault. */
interface VaultSecrets {
  keypass?: string;
  storepass?: string;
  alias?: string;
}

/** How the vault entry was unlocked: 'verified' = Windows Hello consent. */
type VaultAuth = 'verified' | 'unavailable' | 'none';

type VaultSaveResult = { ok: true } | { ok: false; error: string };
type VaultLoadResult =
  | { ok: true; auth: VaultAuth; secrets: VaultSecrets }
  | { ok: false; reason: 'empty' | 'denied' | 'no-encryption' | 'corrupt' };

// ── Google Play Console account (OAuth) + upload-key registration ──

/** Result of the browser consent flow; the account is only saved on ok. */
type GoogleConnectResult = { ok: true; email: string } | { ok: false; error: string };
type GoogleStatusResult = { connected: boolean; email: string | null };
/** True when the app ships its own OAuth client (resources/google-oauth.json) —
 *  then the connect card needs no client ID/secret, just the sign-in button. */
type GoogleConfigResult = { hasClient: boolean };

/** Uploads the signed AAB through the Play Developer API — the first committed
 *  bundle registers the signing keystore as the app's Play upload key. */
interface GoogleRegisterRequest {
  aabPath: string;
  packageName: string;
  /** Also attach the bundle as a draft release on the Internal testing track. */
  draftTrack: boolean;
  /** Release name shown in Play Console when draftTrack is on. */
  releaseName: string;
}
type GoogleRegisterResult = { ok: true; versionCode: number | null } | { ok: false; error: string };

/** Progress streamed while `googleRegister` runs (dedicated channel). */
type GoogleEvent =
  | { type: 'phase'; id: 'auth' | 'edit' | 'upload' | 'track' | 'commit' }
  | { type: 'line'; text: string; stream: 'out' | 'err' };

/** The full `window.builder` surface exposed by the preload bridge. */
interface BuilderApi {
  selectDirectory(): Promise<string | null>;
  validateProject(dir: string): Promise<ValidateResult>;
  checkEnvironment(): Promise<EnvCheckResult>;
  checkUpdates(force?: boolean): Promise<UpdatesResult>;
  /** Download + install a newer release (sdkmanager for SDK components; official installer for Node/JDK/Git).
   *  `version` accepts a concrete release or "latest" — resolved while the install runs. */
  installUpdate(id: string, version: string): Promise<InstallStartResult>;
  /** Where a fresh Android SDK would land (default) and the last one the app installed to. */
  sdkDefaultDir(): Promise<SdkDirInfo>;
  /** Selectable download sources for the Android SDK repository + the active one. */
  getDownloadSource(): Promise<DownloadSourceInfo>;
  /** Switch the download source (persisted; the next version check uses it).
   *  `customBase` is required when id is "custom" — a base URL serving repository2-3.xml. */
  setDownloadSource(id: string, customBase?: string): Promise<{ ok: boolean; current?: string; error?: string }>;
  /** Bootstrap a complete Android SDK (command-line tools + every required component) into `dir`. */
  installSdkRoot(dir: string): Promise<InstallStartResult>;
  cancelInstall(): Promise<{ ok: boolean }>;
  onUpdateEvent(cb: (evt: UpdateEvent) => void): () => void;
  startBuild(cfg: BuildConfig): Promise<StartBuildResult>;
  cancelBuild(): Promise<{ ok: boolean }>;
  makeZip(entries: ZipEntry[]): Promise<ZipResult>;
  saveFile(srcPath: string, suggestedName: string): Promise<SaveResult>;
  revealPath(p: string): Promise<{ ok: boolean }>;
  openPath(p: string): Promise<{ ok: boolean }>;
  statPath(p: string): Promise<StatResult>;
  trashPath(p: string): Promise<TrashResult>;
  /** Archive the project's old signing key (android-key → android-key-old[-N]); nothing is deleted. */
  renameKeystore(projectDir: string): Promise<KeyResetResult>;
  minimizeWindow(): Promise<{ ok: boolean }>;
  closeWindow(): Promise<{ ok: boolean }>;
  onBuildEvent(cb: (evt: BuildEvent) => void): () => void;
  // ── encrypted signing-password vault (Windows DPAPI + Windows Hello) ──
  saveSecrets(projectDir: string, secrets: VaultSecrets): Promise<VaultSaveResult>;
  loadSecrets(projectDir: string): Promise<VaultLoadResult>;
  secretStatus(projectDir: string): Promise<{ has: boolean }>;
  forgetSecrets(projectDir: string): Promise<{ ok: boolean }>;
  /** Dismiss a pending Windows Hello consent prompt (Cancel on the unlock overlay). */
  cancelVaultAuth(): Promise<{ ok: boolean }>;
  /** Fired when the OS Windows Hello consent prompt goes up ('prompt'). */
  onVaultAuthEvent(cb: (phase: 'prompt') => void): () => void;
  // ── Google Play Console: account capture + upload-key registration ──
  /** Whether the app ships its own OAuth client (no manual ID/secret needed). */
  googleConfig(): Promise<GoogleConfigResult>;
  /** Browser consent flow (PKCE + loopback); the account is saved encrypted on success. */
  googleConnect(clientId: string, clientSecret: string): Promise<GoogleConnectResult>;
  googleStatus(): Promise<GoogleStatusResult>;
  googleDisconnect(): Promise<{ ok: boolean; error?: string }>;
  /** Upload the signed AAB via the Play Developer API, registering the keystore as the upload key. */
  googleRegister(req: GoogleRegisterRequest): Promise<GoogleRegisterResult>;
  onGoogleEvent(cb: (evt: GoogleEvent) => void): () => void;
  /** Open a URL in the user's default browser (setup docs etc.). */
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
}
