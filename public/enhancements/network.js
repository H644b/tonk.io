/* All original service requests are routed to this independent server. */
(() => {
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const u = new URL(url, location.href);
    if (/(^|\.)(bonk|bonk2|bonkisback)\.io$/.test(u.hostname)) {
      url = /\/scripts\//.test(u.pathname)
        ? "/compat/" + u.pathname.split("/").pop() + u.search
        : "/game" + u.pathname + u.search;
    }
    return open.call(this, method, url, ...rest);
  };
  window.addEventListener("error", (e) =>
    parent.postMessage(
      { type: "bonk-error", message: e.error?.stack || e.message },
      location.origin,
    ),
  );
})();
