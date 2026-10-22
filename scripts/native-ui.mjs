/** Insert additions at measured native Bonk DOM anchors, failing on source drift. */
export function patchNativeUI(html) {
  if (html.includes('id="pretty_top_workbench"'))
    throw Error("Native UI anchor changed: additions already present");
  const anchors = {
    skins:
      '<div id="classic_mid_skins" class="brownButton brownButton_classic classic_mid_buttons">Skins</div>',
    tools:
      '<div id="pretty_top_help" class="pretty_top_button niceborderleft">',
    head: "</head>",
    end: "</body>",
  };
  for (const [name, anchor] of Object.entries(anchors)) {
    if (html.split(anchor).length !== 2)
      throw Error(`Native UI anchor changed: ${name}`);
  }
  html = html.replace(
    anchors.skins,
    `${anchors.skins}\n<button type="button" id="classic_mid_help" class="brownButton brownButton_classic classic_mid_buttons" aria-controls="workbench_help" aria-expanded="false">Help</button>`,
  );
  html = html.replace(
    anchors.tools,
    `<button type="button" id="pretty_top_workbench" class="native-workbench-button pretty_top_button niceborderleft" aria-expanded="false">Workbench</button>
<button type="button" id="pretty_top_fullscreen" class="native-workbench-button pretty_top_button niceborderleft" aria-label="Enter fullscreen" aria-pressed="false">Fullscreen</button>
<button type="button" id="pretty_top_lobby" class="native-workbench-button pretty_top_button niceborderleft" hidden>Lobby</button>
${anchors.tools}`,
  );
  html = html.replace(
    "</head>",
    '<link rel="stylesheet" href="/enhancements/help.css"></head>',
  );
  html = html.replace(
    anchors.end,
    '<script type="module" src="/enhancements/native-ui.js"></script></body>',
  );
  return html;
}
