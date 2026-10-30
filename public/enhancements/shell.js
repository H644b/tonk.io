const $ = (s) => document.querySelector(s),
  frame = $("#maingameframe");
let returnFocus;
let host = false;
const drawer = $("#drawer");
const connection = $("#connection") || document.createElement("p");
connection.id = "connection";
connection.setAttribute("role", "status");
connection.textContent = "Connecting…";
drawer.querySelector("header").after(connection);
// Controls live in the native top navigation. Remove the obsolete floating UI.
$("#tools")?.remove();
$("#reveal")?.remove();
function updateNative() {
  frame.contentWindow?.bonkNativeUI?.update({
    workbenchOpen: !drawer.hidden,
    fullscreen: !!document.fullscreenElement,
    host,
    connection: connection.textContent,
  });
}
function connectNative() {
  updateNative();
  window.dispatchEvent(
    new CustomEvent("bonk:frame-ready", {
      detail: { window: frame.contentWindow, document: frame.contentDocument },
    }),
  );
}
const packs = document.createElement("div");
packs.id = "modpacks";
$("#mods").prepend(packs);

const focusable = () =>
  [
    ...drawer.querySelectorAll(
      'button, a[href], input, select, textarea, [tabindex="0"]',
    ),
  ].filter((element) => !element.disabled && element.getClientRects().length);
const show = (on, invoker) => {
  if (on && drawer.hidden)
    returnFocus =
      invoker || frame.contentDocument?.activeElement || document.activeElement;
  drawer.hidden = !on;
  $("main").inert = on;
  updateNative();
  if (on) {
    loadRooms();
    $("#close").focus();
    window.dispatchEvent(new CustomEvent("bonk:workbench-open"));
  } else {
    const target =
      returnFocus?.isConnected && !returnFocus.hidden
        ? returnFocus
        : frame.contentDocument?.querySelector("#pretty_top_workbench");
    target?.focus();
  }
};
$("#close").onclick = () => show(false);
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    frame.focus();
  } catch {
    connection.textContent =
      "Fullscreen unavailable; use your browser fullscreen command.";
    updateNative();
  }
}
function returnToLobby() {
  frame.contentWindow.postMessage({ type: "bonk-lobby" }, location.origin);
  frame.focus();
}
window.bonkWorkbench = {
  open: (invoker) => show(true, invoker),
  close: () => show(false),
  fullscreen: toggleFullscreen,
  lobby: returnToLobby,
  bind: connectNative,
  help: (topic) => {
    if (!drawer.hidden) show(false);
    frame.contentWindow?.bonkNativeUI?.openHelp(topic);
  },
};
frame.addEventListener("load", connectNative);
connectNative();
document.addEventListener("fullscreenchange", updateNative);
document.addEventListener("keydown", (e) => {
  if (drawer.hidden) return;
  if (e.code === "Escape") {
    e.preventDefault();
    show(false);
  }
  if (e.key === "Tab") {
    const elements = focusable(),
      first = elements[0],
      last = elements.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
});
$("#tabs").onclick = (e) => {
  if (!e.target.dataset.tab) return;
  for (const b of $("#tabs").children)
    b.setAttribute("aria-selected", String(b === e.target));
  for (const section of document.querySelectorAll(".tab"))
    section.hidden = section.id !== e.target.dataset.tab;
  if (e.target.dataset.tab === "library") loadMaps();
  if (e.target.dataset.tab === "account") loadProfile();
};
const status = (s) => ($("#status").textContent = s);
async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok)
    throw Error(data.error?.message || data.error || "Request failed");
  return data;
}
function text(tag, content) {
  const el = document.createElement(tag);
  el.textContent = content;
  return el;
}
async function loadRooms() {
  try {
    const rooms = await request("/api/rooms");
    $("#roomlist").replaceChildren();
    if (!rooms.length) $("#roomlist").append(text("p", "No rooms available."));
    for (const room of rooms) {
      const el = document.createElement("article");
      el.className = "room";
      el.append(
        text("strong", room.roomname),
        text(
          "p",
          `${room.players}/${room.maxplayers} players · ${room.password ? "Password protected" : "Open"} · ${room.mode_mo}`,
        ),
      );
      const join = text("button", "Join");
      join.onclick = () => {
        frame.contentWindow.postMessage(
          { type: "bonk-join", room: room.id },
          location.origin,
        );
        show(false);
      };
      const link = text("button", "Copy invite");
      link.onclick = () =>
        navigator.clipboard
          .writeText(location.origin + "/?room=" + room.id)
          .then(() => status("Invite copied."))
          .catch(() =>
            status("Invite: " + location.origin + "/?room=" + room.id),
          );
      el.append(join, link);
      $("#roomlist").append(el);
    }
  } catch (e) {
    status(e.message);
  }
}
$("#refresh").onclick = loadRooms;
$("#create").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(e.target));
    const r = await request("/api/rooms", {
      method: "POST",
      body: JSON.stringify(data),
    });
    await loadRooms();
    status("Room created.");
    frame.contentWindow.postMessage(
      { type: "bonk-room-created", room: r.id },
      location.origin,
    );
    show(false);
  } catch (e) {
    status(e.message);
  }
};
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
  if (e.data.type === "bonk-ready") {
    connection.textContent = "Ready";
    updateNative();
    const room = new URL(location.href).searchParams.get("room");
    if (room)
      frame.contentWindow.postMessage(
        { type: "bonk-join", room },
        location.origin,
      );
  }
  if (e.data.type === "bonk-connected") {
    connection.textContent = "Connected";
    updateNative();
    modEvent("room", { id: e.data.room });
  }
  if (e.data.type === "bonk-disconnected") {
    connection.textContent = "Ready";
    host = false;
    updateNative();
  }
  if (e.data.type === "bonk-host") {
    host = !!e.data.isHost;
    updateNative();
  }
  if (e.data.type === "bonk-notice") status(e.data.message);
  if (e.data.type === "bonk-error") {
    connection.textContent = "Game error";
    updateNative();
    console.error(e.data.message);
  }
  if (e.data.type === "bonk-mod-result")
    $("#modstatus").textContent = e.data.message;
  if (e.data.type === "bonk-packet")
    modEvent("packet", { direction: e.data.direction, event: e.data.event });
});
// Declarative visual mods are persisted locally; JavaScript runs in an isolated worker.
let mods = JSON.parse(localStorage.getItem("bonk.mods") || "[]");
let worker = null;
const examples = [
  {
    id: "wide-canvas",
    name: "Wide canvas",
    description: "",
    type: "builtin",
    enabled: true,
  },
  {
    id: "high-contrast",
    name: "Sharper controls",
    description: "",
    type: "css",
    css: ".brownButton{min-height:32px}:focus-visible{outline:3px solid #00bfa5!important}",
    enabled: false,
  },
];
for (const m of examples) if (!mods.some((x) => x.id === m.id)) mods.unshift(m);
function renderMods() {
  localStorage.setItem("bonk.mods", JSON.stringify(mods));
  $("#modlist").replaceChildren();
  for (const m of mods) {
    const row = document.createElement("article");
    row.className = "mod";
    const label = document.createElement("label"),
      check = document.createElement("input");
    check.type = "checkbox";
    check.checked = m.enabled;
    if (m.type === "builtin") {
      m.enabled = true;
      check.checked = true;
      check.disabled = true;
    }
    check.onchange = () => {
      m.enabled = check.checked;
      renderMods();
      applyMods();
    };
    label.append(check, text("strong", m.name));
    row.append(label);
    if (m.description && !examples.some((x) => x.id === m.id))
      row.append(text("p", m.description));
    if (!examples.some((x) => x.id === m.id)) {
      const remove = text("button", "Remove");
      remove.onclick = () => {
        mods = mods.filter((x) => x !== m);
        renderMods();
        applyMods();
      };
      row.append(remove);
    }
    $("#modlist").append(row);
  }
}
function applyMods() {
  const d = frame.contentDocument;
  if (!d) return;
  d.querySelectorAll("[data-workbench-mod]").forEach((x) => x.remove());
  for (const mod of mods.filter((x) => x.enabled && x.type === "css")) {
    const style = d.createElement("style");
    style.dataset.workbenchMod = mod.id;
    style.textContent = mod.css;
    d.head.append(style);
  }
}
frame.addEventListener("load", applyMods);
renderMods();
$("#importmod").onchange = async (e) => {
  try {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 100000) throw Error("Mod must be smaller than 100 KB.");
    const m = JSON.parse(await file.text());
    if (
      m.version !== 1 ||
      typeof m.name !== "string" ||
      !["css"].includes(m.type) ||
      typeof m.css !== "string"
    )
      throw Error("Use a version 1 CSS mod; see Download example mod.");
    if (/@import|url\s*\(/i.test(m.css))
      throw Error("CSS mods must not load external resources.");
    mods.push({
      id: crypto.randomUUID(),
      name: m.name.slice(0, 80),
      description: String(m.description || "").slice(0, 250),
      type: "css",
      css: m.css,
      enabled: false,
    });
    renderMods();
    status("Mod imported. Enable it to apply.");
  } catch (e) {
    status(e.message);
  }
  e.target.value = "";
};
function download(data, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("#exportmod").onclick = () =>
  download(
    {
      version: 1,
      name: "Teal controls",
      description: "A small appearance mod.",
      type: "css",
      css: ".brownButton{background:#007f73!important}",
    },
    "teal-controls.tonkmod.json",
  );
$("#loadscript").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 100000) return status("Script must be smaller than 100 KB.");
  $("#modsource").value = await file.text();
  status("Script loaded. Run it to activate.");
  e.target.value = "";
};
function modEvent(event, data) {
  worker?.postMessage({ event, data });
}
$("#runmod").onclick = () => {
  worker?.terminate();
  worker = new Worker("/enhancements/mod-worker.js");
  let messages = 0,
    started = Date.now();
  worker.onmessage = (e) => {
    if (Date.now() - started > 1000) {
      messages = 0;
      started = Date.now();
    }
    if (++messages > 30) {
      worker.terminate();
      worker = null;
      $("#modstatus").textContent = "Mod stopped: too many messages.";
      return;
    }
    if (e.data.type === "notify") $("#modstatus").textContent = e.data.message;
    if (e.data.type === "rules")
      frame.contentWindow.postMessage(
        { type: "bonk-mod-rules", rules: e.data.rules },
        location.origin,
      );
  };
  worker.onerror = (e) => {
    $("#modstatus").textContent = e.message;
    worker?.terminate();
    worker = null;
  };
  worker.postMessage({
    type: "initialize",
    code: $("#modsource").value.slice(0, 100000),
  });
  $("#modstatus").textContent = "Script mod running.";
};
$("#stopmod").onclick = () => {
  worker?.terminate();
  worker = null;
  $("#modstatus").textContent = "Script mod stopped.";
};
async function loadProfile() {
  try {
    const data = await request("/api/profile");
    $("#profile").replaceChildren(
      text(
        "p",
        data.user ? "Signed in as " + data.user.username : "Playing as guest.",
      ),
    );
    $("#nativeaccount").textContent = data.user
      ? "Settings"
      : "Log in or register";
  } catch (e) {
    status(e.message);
  }
}
$("#nativeaccount").onclick = () => {
  show(false);
  frame.contentWindow.postMessage(
    { type: "bonk-open-account" },
    location.origin,
  );
};
async function loadMaps() {
  try {
    const r = await request("/api/maps");
    $("#maps").replaceChildren();
    for (const m of Array.isArray(r) ? r : r.maps || []) {
      const el = document.createElement("article");
      el.className = "map";
      el.append(text("strong", m.name));
      const button = text("button", "Copy map code");
      button.onclick = () =>
        navigator.clipboard
          .writeText(
            typeof m.data === "string" ? m.data : JSON.stringify(m.data),
          )
          .then(() => status("Map code copied."));
      el.append(button);
      $("#maps").append(el);
    }
  } catch (e) {
    status(e.message);
  }
}
$("#savemap").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await request("/api/maps", {
      method: "POST",
      body: JSON.stringify(
        (() => {
          const d = Object.fromEntries(new FormData(e.target));
          const encoder = frame.contentWindow.manifold?.mapEncoder;
          if (!encoder)
            throw Error("The game is still loading. Try again in a moment.");
          try {
            encoder.decodeFromDatabase(d.code);
          } catch {
            throw Error("Invalid map code. Export the map again and retry.");
          }
          return { ...d, data: d.code };
        })(),
      ),
    });
    e.target.reset();
    await loadMaps();
    status("Map saved.");
  } catch (e) {
    status(e.message);
  }
};
loadRooms();
