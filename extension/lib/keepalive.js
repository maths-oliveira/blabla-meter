// MV3 service workers can be stopped after ~30 s without events. Long AI and
// bridge requests (up to 120 s) run in the background worker, so extension
// pages keep a port warm and ping it while they are open. If the page closes,
// the request is no longer useful anyway.
export function keepServiceWorkerAlive() {
  let port = null;
  const connect = () => {
    try {
      port = chrome.runtime.connect({ name: "keepalive" });
      port.onDisconnect.addListener(() => { port = null; });
    } catch { port = null; }
  };
  connect();
  const timer = setInterval(() => {
    if (!port) connect();
    try { port?.postMessage({ type: "ping" }); } catch { port = null; }
  }, 20000);
  return () => {
    clearInterval(timer);
    try { port?.disconnect(); } catch { /* already gone */ }
  };
}
