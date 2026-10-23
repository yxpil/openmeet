import { BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TrayController {
  visible: boolean;
  dispose(): void;
}

/**
 * Keeps the app alive with no visible window so scheduled joins still fire.
 * Returns null when the platform or the icon is unavailable, in which case the
 * caller must fall back to quitting on window close — a silent failure here
 * would leave users believing a plan would fire when it cannot.
 */
export function createTray(
  onShow: () => void,
  onQuit: () => void,
  iconPath = join(__dirname, '../../resources/tray.png')
): TrayController | null {
  let image: Electron.NativeImage;
  try {
    // Packaged builds keep the icon inside the asar, where nativeImage's own
    // path reader cannot reach it; node:fs is asar-aware, so go through a buffer.
    image = nativeImage.createFromBuffer(readFileSync(iconPath));
  } catch (error) {
    console.warn(
      `tray icon unreadable at ${iconPath}; background mode disabled: ${String(error)}`
    );
    return null;
  }
  if (image.isEmpty()) {
    console.warn('tray icon could not be decoded; background mode disabled');
    return null;
  }
  const tray = new Tray(image);
  tray.setToolTip('OpenMeet');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开 OpenMeet',
        click: () => onShow()
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => onQuit()
      }
    ])
  );
  tray.on('click', () => onShow());
  tray.on('double-click', () => onShow());
  return {
    get visible() {
      return !tray.isDestroyed();
    },
    dispose() {
      if (!tray.isDestroyed()) tray.destroy();
    }
  };
}

export function showMainWindow(mainWindow: BrowserWindow | null): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}
