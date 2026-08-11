/**
 * Electron main entry point.
 *
 * Security posture for the window (all of these are load-bearing, not cargo cult):
 *
 *   contextIsolation: true    — renderer JS and preload JS run in separate
 *                               contexts, so the page cannot reach preload
 *                               internals by prototype walking.
 *   nodeIntegration: false    — no `require`, no `process`, no `fs` in the page.
 *   sandbox: true             — the renderer runs in an OS sandbox. This is why
 *                               the preload is emitted as CommonJS: ESM preloads
 *                               require sandbox to be disabled.
 *   webSecurity: true         — default, restated because it matters here.
 *
 * On top of that: a strict CSP is injected for the packaged app, navigation and
 * `window.open` are refused outright, and permission requests are denied.
 */

import { join } from 'node:path';
// `electron/main` rather than `electron`: the root module is CommonJS whose
// exports are installed dynamically, so Node's ESM named-export detection
// cannot see them and `import { BrowserWindow } from 'electron'` fails at load
// time. Electron provides `electron/main` precisely for ESM main processes.
import { app, BrowserWindow, dialog, session } from 'electron/main';
// `shell` is part of Electron's common (main + renderer) surface.
import { shell } from 'electron/common';
import { buildApplication, type Application } from './container';
import { DATA_DIR_ENV_VAR, prepareDataDirOverride } from './infra/data-dir';
import { registerIpc, unregisterIpc } from './ipc/register-ipc';
import { ElectronConfirmationService } from './services/confirmation-service';
import { WindowEventPublisher } from './services/event-bus';

/**
 * Redirect the whole profile before anything can write to the old one.
 *
 * This runs at module load, ahead of `requestSingleInstanceLock()` below, which
 * is the first thing that touches `userData` — it puts its lock file there. Any
 * later call would leave Chromium's `Preferences`, storage and lock behind in
 * the default directory while the database went somewhere else.
 *
 * Once `userData` is repointed, `app.getPath('userData')` returns the override,
 * so the database and worktrees follow automatically and there is no second
 * place that has to agree about where the override points.
 */
function redirectUserDataIfOverridden(): boolean {
  let override: string | null;

  try {
    override = prepareDataDirOverride();
    // `setPath` is inside the same `try` because it can reject the path too;
    // either failure means the override did not take effect.
    if (override) app.setPath('userData', override);
  } catch (error) {
    // Falling back to the real profile would write this run's data into the
    // user's own — the precise accident the override exists to prevent. Report
    // it once and let the caller stop.
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(
      'Agent Relay cannot start',
      `${message}\n\nUnset ${DATA_DIR_ENV_VAR} or point it at a writable directory.`
    );
    return false;
  }

  return true;
}

// `app.exit()` is not guaranteed to stop the current script synchronously, so
// startup is gated on the returned result rather than on the exit call having
// taken effect. Nothing below runs when the override failed.
const userDataReady = redirectUserDataIfOverridden();

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let application: Application | null = null;

const events = new WindowEventPublisher();
const confirmation = new ElectronConfirmationService();

function resolvePaths(): { dataDir: string; documentsDir: string } {
  return {
    // Already the override when one is set: `redirectUserDataIfOverridden()`
    // repointed `userData` at module load, so this is the single source of
    // truth for both the Chromium profile and the database.
    dataDir: app.getPath('userData'),
    documentsDir: app.getPath('documents')
  };
}

function hardenSession(): void {
  const defaultSession = session.defaultSession;

  // Deny every permission request: the app needs no camera, microphone,
  // geolocation, notifications or clipboard access.
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  defaultSession.setPermissionCheckHandler(() => false);

  // In development, Vite needs inline styles and a websocket for HMR; in the
  // packaged app everything is local and static, so lock it down hard.
  const csp = isDev
    ? "default-src 'self' 'unsafe-inline' data: blob: ws://localhost:* http://localhost:*; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*;"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';";

  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    });
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'Agent Relay',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false
    }
  });

  window.once('ready-to-show', () => window.show());

  // Never navigate the app frame anywhere; external links go to the OS browser
  // through the vetted `shell:openExternal` channel instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    const isDevServer = isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'http://localhost');
    if (!isDevServer) event.preventDefault();
  });

  // Refuse to attach a webview under any circumstances.
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (isDev && devServerUrl) {
    void window.loadURL(devServerUrl);
    if (process.env.AGENT_RELAY_DEVTOOLS === '1') {
      window.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  return window;
}

function bootstrap(): void {
  hardenSession();

  application = buildApplication({
    paths: resolvePaths(),
    events,
    confirmation
  });

  registerIpc({
    app: application,
    getWindow: () => mainWindow
  });

  mainWindow = createWindow();
  events.attach(mainWindow);
  confirmation.attach(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Warm the diagnostics cache so Settings is populated on first open. A failure
  // here must never prevent the window from appearing.
  void application.diagnostics.run(true).catch(() => undefined);
}

if (!userDataReady) {
  // The override was requested and could not be honoured. Take no lock, build
  // no application, open no window — just stop.
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  // A second instance would open a second SQLite connection to the same file
  // and two orchestrators against the same worktrees. Refuse, and focus the
  // original.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    bootstrap();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
        events.attach(mainWindow);
        confirmation.attach(mainWindow);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    unregisterIpc();
    application?.close();
    application = null;
  });
}
