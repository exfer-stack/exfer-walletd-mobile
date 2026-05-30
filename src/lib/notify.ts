// OS-level desktop notification. In a Tauri build this fires a real
// system notification (taskbar/notification-center); in plain browser
// dev mode it's a no-op (the in-app toast still shows).
//
// Lazy-imported so the browser bundle doesn't choke on the Tauri plugin
// when running outside the webview.

import { devmock } from "./devmock";

export async function osNotify(title: string, body: string): Promise<void> {
  if (devmock.isActive()) {
    // Plain browser dev — skip OS notification (toast covers it).
    return;
  }
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    let granted = await mod.isPermissionGranted();
    if (!granted) {
      const perm = await mod.requestPermission();
      granted = perm === "granted";
    }
    if (granted) {
      mod.sendNotification({ title, body });
    }
  } catch {
    // Plugin unavailable / permission denied — toast already shown.
  }
}
