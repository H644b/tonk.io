import { prepareHostPack } from "./prepare-pack.ts";
/** Parent-page controls for code packs. Executable pack bytes stay in the game runtime. */
type Pack = {
  id: string;
  name: string;
  version: string;
  hash: string;
  client?: string | null;
  serverCode?: boolean;
  description?: string;
  assets?: Record<string, unknown>;
};
type Profile = {
  api: number;
  hash: string;
  mods: Pack[];
  mode?: string | null;
};
type Mode = { id: string; name: string; base: string };
const nativeBases: Record<string, string> = {
  b: "Classic",
  ar: "Arrows",
  ard: "Death Arrows",
  bs: "Simple",
  sp: "Grapple",
  f: "Football",
  v: "VTOL",
};
type Consent = { id: string; profile: Profile };
function initialize(frame: HTMLIFrameElement, mount: HTMLElement) {
  const nativeWindow = () => frame.contentWindow as any;
  const native = () => nativeWindow()?.manifold;
  const runtime = () => nativeWindow()?.BonkMods;
  const node = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    className = "",
  ) => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text: string, action: () => any) => {
    const element = node("button", text);
    element.type = "button";
    element.onclick = action;
    return element;
  };
  const amount = (pack: Pack) => Object.keys(pack.assets || {}).length;
  const totalAssets = (profile: Profile) =>
    profile.mods.reduce((sum, pack) => sum + amount(pack), 0);
  let selectedProfile: Profile | null = null;
  let packs: Pack[] = [];
  let serverModes: Mode[] = [];
  let busy = false;
  let hostAction = false;
  let refreshPromise: Promise<void> | null = null;
  let refreshAgain = false;
  const selected = new Set<string>();
  const ownApproved = new Set<string>();
  const queue: Consent[] = [];
  let currentConsent: Consent | null = null;
  let loadingConsent: Profile | null = null;

  mount.replaceChildren();
  mount.classList.add("modpack-tools");
  mount.append(node("h2", "Modpacks"));
  const help = button("Modding help", () =>
    (window as any).bonkWorkbench?.help("modding"),
  );
  const example = node("a", "Download Orb Kit example");
  example.href = "/help/examples/orb-kit-1.0.0.tonkmod";
  example.download = "orb-kit-1.0.0.tonkmod";
  const links = node("p", "", "modpack-links");
  links.append(help, example);
  mount.append(links);
  const heading = node("h3", "This room");
  const roomStatus = node("p", "Join a room to manage mods.");
  const profileHash = node("p", "", "modpack-hash");
  const active = node("div", "", "modpack-active");
  const registrations = node("p", "", "modpack-registrations");
  const output = node("output", "", "modpack-status");
  output.setAttribute("aria-live", "polite");
  const progress = node("progress");
  progress.hidden = true;
  progress.setAttribute("aria-label", "Loading room modpack");
  mount.append(
    heading,
    roomStatus,
    profileHash,
    active,
    registrations,
    progress,
    output,
  );

  const hostTools = node("section", "", "modpack-host-tools");
  const hostHint = node("p");
  const installed = node("fieldset");
  installed.append(node("legend", "Available packs"));
  const choices = node("div");
  installed.append(choices);
  const apply = button("Apply packs", () =>
    hostChange(async () => {
      const result = await emit("mods:profile", [...selected]);
      return result.profile;
    }),
  );
  const clear = button("Remove packs", () =>
    hostChange(async () => {
      const result = await emit("mods:profile", []);
      return result.profile;
    }),
  );
  const actions = node("div", "", "modpack-actions");
  actions.append(apply, clear);
  const modeLabel = node("label", "Game rules");
  const modeSelect = node("select");
  modeLabel.append(modeSelect);
  const useMode = button("Use mode", () => {
    const id = modeSelect.value;
    const mode = availableModes().find((candidate) => candidate.id === id);
    if (id && !mode)
      return report(
        "This mode is no longer registered by the active packs. Refresh the Workbench.",
      );
    return hostChange(
      async () => {
        const result = await emit(
          "mods:mode",
          mode ? { id: mode.id, base: mode.base } : "",
        );
        return result.profile;
      },
      mode ? `${mode.name} selected for this room.` : "Default rules selected.",
    );
  });
  const fileLabel = node("label", "Modpack file");
  const file = node("input");
  file.type = "file";
  file.accept = ".tonkmod,.bonkmod,.zip,application/zip";
  fileLabel.append(file);
  const publish = button("Upload & apply", () =>
    hostChange(async () => {
      const archive = file.files?.[0];
      if (!archive) throw Error("Choose a .tonkmod or .zip archive first.");
      if (!/\.(tonkmod|bonkmod|zip)$/i.test(archive.name))
        throw Error(
          "Choose a .tonkmod or .zip pack containing tonk.mod.json, code, and assets.",
        );
      const room = native()?.room;
      if (!room) throw Error("Join a room first.");
      const platform: { packCompiler?: string; maxPackBytes?: number } = await fetch("/api/platform").then(response => response.ok ? response.json() : {}).catch(() => ({}));
      const limit = platform.maxPackBytes || 64 * 1024 * 1024;
      if (archive.size > limit) throw Error(`Pack archives must be ${Math.floor(limit / 1024 / 1024)} MB or smaller.`);
      const payload = platform.packCompiler === "browser" ? await prepareHostPack(archive, platform.maxPackBytes) : archive;
      const credential = await emit("mods:host-token");
      if (!credential.token)
        throw Error("The server did not issue a room-host upload token.");
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(room)}/modpack`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Bonk-Host": credential.token,
          },
          body: payload,
        },
      );
      const result = await response.json();
      if (!response.ok || result.error)
        throw Error(
          result.error?.message || result.error || "Pack upload failed.",
        );
      file.value = "";
      return result.profile;
    }),
  );
  hostTools.append(
    hostHint,
    installed,
    actions,
    node("h3", "Custom mode"),
    modeLabel,
    useMode,
    node("h3", "Upload pack"),
    fileLabel,
    publish,
  );
  mount.append(hostTools);

  // Keep the original lightweight tools accessible without confusing them with code packs.
  const legacy = node("details", "", "modpack-legacy");
  legacy.append(node("summary", "Appearance & isolated scripts"));
  let sibling = mount.nextSibling;
  while (sibling) {
    const next = sibling.nextSibling;
    legacy.append(sibling);
    sibling = next;
  }
  const oldHeading = legacy.querySelector("h2");
  if (oldHeading) oldHeading.textContent = "Appearance";
  const apiHeading = legacy.querySelector("h3");
  if (apiHeading) apiHeading.textContent = "Worker scripts";
  mount.after(legacy);

  const dialog = node("dialog", "", "modpack-consent");
  dialog.setAttribute("aria-labelledby", "modpack-consent-title");
  dialog.setAttribute("aria-describedby", "modpack-consent-description");
  const dialogHeader = node("header");
  const dialogTitle = node("h2", "Join a modded room?");
  dialogTitle.id = "modpack-consent-title";
  dialogHeader.append(dialogTitle);
  const dialogBody = node("div", "", "modpack-consent-body");
  const dialogDescription = node("p");
  dialogDescription.id = "modpack-consent-description";
  const permission = node(
    "p",
    "Mods can access your game and account data. Only download packs you trust.",
  );
  const dialogPacks = node("div", "", "modpack-consent-packs");
  const dialogHash = node("p", "", "modpack-hash");
  const dialogProgress = node("output", "", "modpack-consent-progress");
  dialogProgress.setAttribute("aria-live", "polite");
  const dialogProgressBar = node("progress");
  dialogProgressBar.hidden = true;
  dialogProgressBar.setAttribute(
    "aria-label",
    "Downloading and verifying room content",
  );
  const decline = button("Leave Room", () => decide(false));
  const accept = button("Download & Join", () => decide(true));
  decline.autofocus = true;
  const dialogActions = node("div", "", "modpack-consent-actions");
  dialogActions.append(decline, accept);
  dialogBody.append(
    dialogDescription,
    permission,
    dialogPacks,
    dialogHash,
    dialogProgressBar,
    dialogProgress,
    dialogActions,
  );
  dialog.append(dialogHeader, dialogBody);
  document.body.append(dialog);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    decide(false);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") event.stopPropagation();
  });

  function sendDecision(request: Consent, accepted: boolean) {
    frame.contentWindow?.postMessage(
      { type: "bonk-modpack-decision", id: request.id, accept: accepted },
      location.origin,
    );
  }
  function pump() {
    if (hostAction || currentConsent || loadingConsent || !queue.length) return;
    const request = queue.shift()!;
    if (ownApproved.has(request.profile.hash)) {
      sendDecision(request, true);
      pump();
      return;
    }
    currentConsent = request;
    dialogTitle.textContent = "Join a modded room?";
    accept.hidden = false;
    permission.hidden = false;
    dialogProgress.textContent = "";
    dialogProgressBar.hidden = true;
    const count = request.profile.mods.filter((pack) => !!pack.client).length;
    const assets = totalAssets(request.profile);
    dialogDescription.textContent = `${count} code ${count === 1 ? "pack" : "packs"} · ${assets} ${assets === 1 ? "asset" : "assets"}`;
    dialogPacks.replaceChildren();
    for (const pack of request.profile.mods) {
      const row = node("article");
      row.append(
        node("strong", `${pack.name} ${pack.version}`),
        node(
          "p",
          `${pack.id} · ${amount(pack)} ${amount(pack) === 1 ? "asset" : "assets"}${pack.serverCode ? " · Server component" : ""}`,
          "modpack-detail",
        ),
      );
      dialogPacks.append(row);
    }
    dialogHash.replaceChildren(
      node("span", "Profile SHA-256 "),
      node("code", request.profile.hash),
    );
    dialog.showModal();
    decline.focus();
  }
  function decide(accepted: boolean) {
    if (loadingConsent) {
      if (accepted) return;
      loadingConsent = null;
      dialog.close();
      runtime()?.leaveRoom();
      for (const request of queue.splice(0)) sendDecision(request, false);
      report("Left the room while loading its pack.");
      return;
    }
    if (!currentConsent) return;
    const request = currentConsent;
    currentConsent = null;
    sendDecision(request, accepted);
    if (accepted) {
      loadingConsent = request.profile;
      dialogTitle.textContent = "Loading room modpack";
      dialogDescription.textContent = "Downloading and verifying mods…";
      permission.hidden = true;
      accept.hidden = true;
      dialogProgressBar.hidden = false;
      dialogProgress.textContent = "Downloading mods…";
      decline.focus();
      report("Downloading mods…", true);
    } else {
      dialog.close();
      for (const request of queue.splice(0)) sendDecision(request, false);
      report("Leaving room…");
    }
  }
  function report(message: string, loading = false) {
    output.textContent = message;
    progress.hidden = !loading;
  }
  function isHost() {
    const game = native();
    return (
      !!game?.socket?.connected &&
      Number.isInteger(game.localId) &&
      game.localId === game.hostId
    );
  }
  function inLobby() {
    const element =
      frame.contentDocument?.querySelector<HTMLElement>("#newbonklobby");
    return (
      !!element &&
      !!element.getClientRects().length &&
      nativeWindow().getComputedStyle(element).visibility !== "hidden"
    );
  }
  function controls() {
    const allowed = isHost() && inLobby() && !busy;
    for (const control of [apply, clear, file, publish])
      control.disabled = !allowed;
    installed.disabled = !allowed;
    const ready =
      !!selectedProfile && runtime()?.profile?.hash === selectedProfile.hash;
    modeSelect.disabled = !allowed || !ready;
    useMode.disabled = !allowed || !ready;
    hostHint.textContent = !native()?.socket?.connected
      ? ""
      : !isHost()
        ? "Only the host can change mods."
        : !inLobby()
          ? "Return to the lobby to change mods."
          : "";
  }
  function renderProfile() {
    const game = native();
    const joined = !!game?.socket?.connected && Number.isInteger(game.localId);
    if (!joined) {
      roomStatus.textContent = "Join a room to manage mods.";
      profileHash.textContent = "";
      active.replaceChildren();
      renderModes();
      controls();
      return;
    }
    if (!selectedProfile) {
      roomStatus.textContent = `Loading mods…`;
      renderModes();
      controls();
      return;
    }
    const loaded = runtime()?.profile?.hash === selectedProfile.hash;
    roomStatus.textContent = selectedProfile.mods.length
      ? `${selectedProfile.mods.length} ${selectedProfile.mods.length === 1 ? "pack" : "packs"} selected · ${loaded ? "Ready" : "Loading…"}`
      : "No mods selected.";
    profileHash.replaceChildren(
      node("span", "Profile SHA-256 "),
      node("code", selectedProfile.hash),
    );
    active.replaceChildren();
    for (const pack of selectedProfile.mods) {
      const row = node("article", "", "modpack-row");
      row.append(
        node("strong", `${pack.name} ${pack.version}`),
        node(
          "p",
          `${pack.id} · ${amount(pack)} ${amount(pack) === 1 ? "asset" : "assets"}${pack.client ? " · Client code" : ""}${pack.serverCode ? " · Server code" : ""}`,
          "modpack-detail",
        ),
      );
      active.append(row);
    }
    renderModes();
    controls();
  }
  function availableModes(): Mode[] {
    const owners = new Set(
      (selectedProfile?.mods || []).map((pack) => pack.id),
    );
    const found = new Map<string, Mode>();
    const add = (mode: Mode) => {
      if (
        !mode ||
        typeof mode.id !== "string" ||
        !owners.has(mode.id.split(":")[0]) ||
        !nativeBases[mode.base]
      )
        return;
      if (!found.has(mode.id))
        found.set(mode.id, {
          id: mode.id,
          name: String(mode.name || mode.id),
          base: mode.base,
        });
    };
    serverModes.forEach(add);
    for (const entry of runtime()?.registries?.get("modes")?.values() || [])
      add({
        id: entry.id,
        name: entry.value?.name || entry.id,
        base: entry.value?.base,
      });
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  function renderModes() {
    const current = selectedProfile?.mode || "";
    modeSelect.replaceChildren();
    const base = node("option", "Default rules");
    base.value = "";
    modeSelect.append(base);
    for (const mode of availableModes()) {
      const option = node("option", `${mode.name} · ${nativeBases[mode.base]}`);
      option.value = mode.id;
      option.title = mode.id;
      modeSelect.append(option);
    }
    if (
      current &&
      ![...modeSelect.options].some((option) => option.value === current)
    ) {
      const pending = node("option", `${current} (waiting for declaration)`);
      pending.value = current;
      pending.disabled = true;
      modeSelect.append(pending);
    }
    modeSelect.value = current;
  }
  function renderChoices() {
    choices.replaceChildren();
    if (!packs.length)
      choices.append(node("p", "No installed packs.", "modpack-detail"));
    for (const pack of packs) {
      const label = node("label", "", "modpack-choice");
      const check = node("input");
      check.type = "checkbox";
      check.value = pack.id;
      check.checked = selected.has(pack.id);
      check.onchange = () => {
        if (check.checked) selected.add(pack.id);
        else selected.delete(pack.id);
      };
      const text = node("span");
      text.append(node("strong", `${pack.name} ${pack.version}`));
      if (pack.description)
        text.append(node("span", pack.description, "modpack-detail"));
      label.append(check, text);
      choices.append(label);
    }
  }
  async function refresh(): Promise<void> {
    if (refreshPromise) {
      refreshAgain = true;
      return refreshPromise;
    }
    refreshPromise = (async () => {
      controls();
      try {
        const response = await fetch("/api/mods");
        const data = await response.json();
        if (!response.ok)
          throw Error(data.error || "Could not load available packs.");
        packs = data.packs || [];
        serverModes = data.modes || [];
        const room = native()?.room;
        if (room && native()?.socket?.connected) {
          const response = await fetch(
            `/api/rooms/${encodeURIComponent(room)}/mods`,
          );
          const profile = await response.json();
          if (!response.ok)
            throw Error(profile.error || "Could not read room profile.");
          if (native()?.room !== room || !native()?.socket?.connected) {
            refreshAgain = true;
            return;
          }
          selectedProfile = profile;
          selected.clear();
          for (const pack of profile.mods || [])
            if (packs.some((candidate) => candidate.id === pack.id))
              selected.add(pack.id);
        } else {
          selectedProfile = null;
          selected.clear();
        }
        renderChoices();
        renderProfile();
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
      }
    })().finally(() => {
      refreshPromise = null;
      if (refreshAgain) {
        refreshAgain = false;
        void refresh();
      }
    });
    return refreshPromise;
  }
  function emit(event: string, ...args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = native()?.socket;
      if (!socket?.connected) return reject(Error("Join a room first."));
      const timer = setTimeout(
        () =>
          reject(Error("The server did not answer. Refresh and try again.")),
        15000,
      );
      socket.emit(event, ...args, (result: any) => {
        clearTimeout(timer);
        if (result?.error) reject(Error(result.error.message || result.error));
        else resolve(result || {});
      });
    });
  }
  async function hostChange(
    operation: () => Promise<Profile>,
    doneMessage?: string,
  ) {
    if (busy) return;
    if (!isHost() || !inLobby())
      return report("Only the host can change packs, while in the lobby.");
    busy = true;
    hostAction = true;
    controls();
    report("Applying mods…", true);
    try {
      const profile = await operation();
      if (!profile || !Array.isArray(profile.mods))
        throw Error("The server returned an invalid mod profile.");
      selectedProfile = profile;
      ownApproved.add(profile.hash);
      runtime().approve(profile.hash);
      // The host explicitly chose this exact published/selected content. Resolve
      // any matching broadcast prompt before awaiting the runtime’s in-flight load.
      for (let i = queue.length - 1; i >= 0; i--)
        if (queue[i].profile.hash === profile.hash)
          sendDecision(queue.splice(i, 1)[0], true);
      await runtime().prepareProfile(profile);
      await emit("mods:ready", profile.hash);
      report(doneMessage || "Mods applied.");
      await refresh();
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      hostAction = false;
      controls();
      pump();
    }
  }
  window.addEventListener("message", (event: MessageEvent) => {
    if (
      event.origin !== location.origin ||
      event.source !== frame.contentWindow
    )
      return;
    const message = event.data;
    if (!message || typeof message.type !== "string") return;
    if (message.type === "bonk-modpack-request") {
      if (
        !message.profile ||
        !Array.isArray(message.profile.mods) ||
        typeof message.profile.hash !== "string"
      )
        return;
      queue.push({ id: String(message.id), profile: message.profile });
      pump();
    }
    if (message.type === "bonk-modpack-progress") {
      report(String(message.message || ""), !message.done);
      if (loadingConsent) {
        dialogProgress.textContent = String(message.message || "");
        dialogProgressBar.hidden = !!message.done;
        if (message.done && /^Modpack failed:/i.test(String(message.message)))
          dialogTitle.textContent = "Room modpack could not load";
      }
    }
    if (message.type === "bonk-mod-notice")
      report(String(message.message || ""));
    if (message.type === "bonk-modpack-ready") {
      if (loadingConsent?.hash === message.profile?.hash) {
        loadingConsent = null;
        dialog.close();
        pump();
      }
      selectedProfile = message.profile;
      const counts = new Map<string, number>();
      for (const entry of message.registrations || [])
        counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
      registrations.textContent = counts.size
        ? "Registered content: " +
          [...counts]
            .map(([category, count]) => `${category}: ${count}`)
            .join(" · ")
        : "";
      renderProfile();
    }
    if (message.type === "bonk-modpack-left") {
      if (currentConsent) {
        sendDecision(currentConsent, false);
        dialog.close();
        currentConsent = null;
      }
      loadingConsent = null;
      if (dialog.open) dialog.close();
      for (const request of queue.splice(0)) sendDecision(request, false);
      selectedProfile = null;
      registrations.textContent = "";
      renderProfile();
      report("Left the modded room.");
    }
    if (["bonk-ready", "bonk-connected", "bonk-host"].includes(message.type))
      void refresh();
    // Native gameplay state changes do not need network polling; they only update
    // whether a host is allowed to use the controls currently visible in the drawer.
    if (
      message.type === "bonk-packet" &&
      ["3", "5", "13", "14", "41"].includes(String(message.event))
    )
      controls();
  });
  window.addEventListener("bonk:workbench-open", () => void refresh());
  window.addEventListener("bonk:frame-ready", () => void refresh());
  frame.addEventListener("load", () => {
    if (dialog.open) dialog.close();
    currentConsent = null;
    loadingConsent = null;
    queue.length = 0;
    selectedProfile = null;
    void refresh();
  });
  void refresh();
}
function start() {
  const frame = document.querySelector<HTMLIFrameElement>("#maingameframe");
  const mount = document.querySelector<HTMLElement>("#modpacks");
  if (!frame || !mount) return false;
  initialize(frame, mount);
  return true;
}
if (!start()) {
  const observer = new MutationObserver(() => {
    if (start()) observer.disconnect();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
export {};
