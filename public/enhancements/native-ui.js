const $ = (selector) => document.querySelector(selector);
const bar = $("#pretty_top_bar");
const workbench = $("#pretty_top_workbench");
const fullscreen = $("#pretty_top_fullscreen");
const lobby = $("#pretty_top_lobby");
const helpButton = $("#classic_mid_help");
const parentAPI = () => window.parent.bonkWorkbench;

// Reparent the actual native progress nodes. Native reward/fill animations keep
// their original objects, while placement belongs to the identity in the nav.
const identity = document.createElement("div");
identity.id = "pretty_top_identity";
const preview = $("#pretty_top_small_preview");
bar.insertBefore(identity, preview);
const xp = $("#xpbarcontainer");
const xpBar = $("#xpbar");
identity.append(preview, $("#pretty_top_name"), $("#pretty_top_level"), xp);
$("#xpbartext").setAttribute("role", "status");
function synchronizeProgress() {
  identity.classList.toggle("has-native-xp", xp.style.visibility === "inherit");
  const width = xpBar.clientWidth;
  // Native Level Up reads style.width as the fill's animation target. Keep it
  // measured, rather than the old renderer's viewport-sized inline value.
  if (width > 0 && xpBar.style.width !== `${width}px`)
    xpBar.style.width = `${width}px`;
}
new MutationObserver(synchronizeProgress).observe(xp, {
  attributes: true,
  attributeFilter: ["style"],
});
new MutationObserver(synchronizeProgress).observe(xpBar, {
  attributes: true,
  attributeFilter: ["style"],
});
new ResizeObserver(synchronizeProgress).observe(identity);
synchronizeProgress();

// The existing top navigation owns these controls, including its native visibility.
bar.setAttribute("role", "navigation");
bar.setAttribute("aria-label", "Game controls");
workbench.onclick = () => parentAPI()?.open(workbench);
fullscreen.onclick = () => parentAPI()?.fullscreen();
lobby.onclick = () => parentAPI()?.lobby();

const help = document.createElement("section");
help.id = "workbench_help";
help.hidden = true;
help.setAttribute("aria-label", "Help and modding documentation");
help.innerHTML = `<header class="help-topbar windowTopBar_classic">
  <h1>Help</h1><button type="button" class="brownButton brownButton_classic" id="workbench_help_back">Back to game</button>
</header>
<div class="help-layout"><nav aria-label="Help topics" id="workbench_help_topics"></nav>
<article id="workbench_help_article" tabindex="-1"><p>Loading help…</p></article></div>`;
$("#bonkiocontainer").append(help);
let helpLoaded = false;
let helpReturnFocus;
function openHelp(topic) {
  if (help.hidden) helpReturnFocus = document.activeElement;
  help.hidden = false;
  helpButton?.setAttribute("aria-expanded", "true");
  helpButton?.setAttribute("aria-current", "page");
  for (const id of [
    "#mainmenuelements",
    "#newbonkgamecontainer",
    "#pretty_bottom",
  ])
    $(id).inert = true;
  if (!helpLoaded) {
    helpLoaded = true;
    import("/enhancements/help.js")
      .then(({ initializeHelp }) => initializeHelp(help, topic))
      .catch(() => {
        $("#workbench_help_article").textContent =
          "Help could not load. Reload the page and open Help again.";
        helpLoaded = false;
      });
  } else if (topic) {
    help.dispatchEvent(new CustomEvent("help:topic", { detail: topic }));
  }
  $("#workbench_help_back").focus();
}
function closeHelp() {
  help.hidden = true;
  helpButton?.setAttribute("aria-expanded", "false");
  helpButton?.removeAttribute("aria-current");
  for (const id of [
    "#mainmenuelements",
    "#newbonkgamecontainer",
    "#pretty_bottom",
  ])
    $(id).inert = false;
  (helpReturnFocus?.isConnected ? helpReturnFocus : helpButton)?.focus();
}
helpButton.onclick = () => openHelp();
$("#workbench_help_back").onclick = closeHelp;
help.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeHelp();
  }
});

window.bonkNativeUI = {
  openHelp,
  closeHelp,
  update(state = {}) {
    workbench.setAttribute("aria-expanded", String(!!state.workbenchOpen));
    fullscreen.textContent = state.fullscreen
      ? "Exit fullscreen"
      : "Fullscreen";
    fullscreen.setAttribute(
      "aria-label",
      state.fullscreen ? "Exit fullscreen" : "Enter fullscreen",
    );
    fullscreen.setAttribute("aria-pressed", String(!!state.fullscreen));
    lobby.hidden = !state.host;
    if (state.connection) workbench.title = state.connection;
  },
};
parentAPI()?.bind?.(window);
