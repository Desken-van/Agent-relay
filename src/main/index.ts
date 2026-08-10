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
import { app, BrowserWindow, session } from 'electron/main';
// `shell` is part of Electron's common (main + renderer) surface.
import { shell } from 'electron/common';
import { buildApplication, type Application } from './container';
import { registerIpc, unregisterIpc } from './ipc/register-ipc';
import { ElectronConfirmationService } from './services/confirmation-service';
import { WindowEventPublisher } from './services/event-bus';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let application: Application | null = null;

const events = new WindowEventPublisher();
const confirmation = new ElectronConfirmationService();

function resolvePaths(): { dataDir: string; documentsDir: string } {
  const override = process.env.AGENT_RELAY_DATA_DIR;
  return {
    dataDir: override && override.trim().length > 0 ? override : app.getPath('userData'),
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

// A second instance would open a second SQLite connection to the same file and
// two orchestrators against the same worktrees. Refuse, and focus the original.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
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
