// Served with CSP default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'.
const listeners = new Map();
let initialized = false;
const api = Object.freeze({
  on(event, callback) {
    if (typeof callback !== "function") throw Error("Callback required");
    if ((listeners.get(event)?.length || 0) > 20)
      throw Error("Too many handlers");
    listeners.set(event, [...(listeners.get(event) || []), callback]);
  },
  notify(message) {
    postMessage({ type: "notify", message: String(message).slice(0, 200) });
  },
  setRoomRules(rules) {
    postMessage({ type: "rules", rules });
  },
});
self.onmessage = (e) => {
  if (e.data.type === "initialize" && !initialized) {
    initialized = true;
    try {
      new Function("api", '"use strict";\n' + e.data.code)(api);
      for (const fn of listeners.get("ready") || []) fn();
    } catch (err) {
      api.notify("Mod error: " + err.message);
    }
    return;
  }
  for (const fn of listeners.get(e.data.event) || [])
    try {
      fn(e.data.data);
    } catch (err) {
      api.notify("Mod error: " + err.message);
    }
};
