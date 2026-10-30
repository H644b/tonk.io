/* Compatibility bridge based on Manifold Client, MIT, SneezingCactus 2024. */
window.manifold = {
  active: true,
  room: null,
  socket: null,
  bots: [],
  confirmedReceipts: new Set(),
  confirmedRound(receipt) {
    if (
      !this.socket?.connected ||
      this.localId !== this.hostId ||
      this.confirmedReceipts.has(receipt.round)
    )
      return;
    this.confirmedReceipts.add(receipt.round);
    this.socket.emit("wb:round", receipt, (result) => {
      if (result?.error) console.warn("Round receipt:", result.error);
    });
  },
  announceHost() {
    parent.postMessage(
      { type: "bonk-host", isHost: this.localId === this.hostId },
      location.origin,
    );
  },
  matchComplete() {
    this.socket?.emit("14");
  },
  fakePeerInstance: {
    destroy() {},
    on(e, cb) {
      if (e === "open") setTimeout(() => cb("invalid"), 0);
    },
    connect() {
      return { on() {}, open: false };
    },
  },
  patchModules(args) {
    const io = args[0],
      self = this;
    args[0] = function (url, options = {}) {
      options = {
        ...options,
        secure: location.protocol === "https:",
        path: `/rooms/${self.room || "practice"}/socket.io`,
        transports: ["websocket", "polling"],
      };
      const socket = io(location.origin, options);
      self.socket = socket;
      self.playing = false;
      socket.on("15",()=>self.playing=true);
      socket.on("13",()=>self.playing=false);
      socket.on("wb:bots", (data) => { self.bots = Array.isArray(data?.bots) ? data.bots : []; parent.postMessage({type:"tonk-bots", ...data},location.origin); });
      socket.on("wb:moderation", (data) => { parent.postMessage({type:"tonk-moderation",message:String(data?.message||"Room closed.")},location.origin); });
      window.BonkMods?.bindSocket(socket);
      const emit = socket.emit.bind(socket),
        on = socket.on.bind(socket);
      socket.emit = function (event, data, ...rest) {
        if ((event == 5 || event == 11) && data?.gs)
          data.gs.wbMode = window.BonkMods?.profile.mode || null;
        if (event == 13) {
          data = {
            ...data,
            token: null,
            modProfile: window.BonkMods?.profile.hash || "",
            userName: self.localPlayerData.userName,
            level: 0,
          };
        }
        if (event == 11 && data?.gs) {
          data = {
            ...data,
            gs: {
              ...data.gs,
              map: self.mapEncoder.encodeToDatabase(data.gs.map),
            },
          };
        }
        parent.postMessage(
          { type: "bonk-packet", direction: "out", event },
          location.origin,
        );
        return emit(event, data, ...rest);
      };
      socket.on = function (event, callback) {
        if (event == 3 || event == 6 || event == 41) {
          const old = callback;
          callback = (...args) => {
            if (event == 3) {
              self.localId = args[0];
              self.playing = args[3] > 0;
              self.hostId = args[1];
            }
            if (event == 6) self.hostId = args[1];
            if (event == 41) self.hostId = args[0].newHost;
            self.announceHost();
            return old(...args);
          };
        }
        if (event == 21) {
          const old = callback;
          callback = (data) => {
            if (typeof data.map === "string") self.currentMap = data.map;
            return old({
              ...data,
              map:
                typeof data.map === "string"
                  ? self.mapEncoder.decodeFromDatabase(data.map)
                  : data.map,
            });
          };
        }
        if (event == 29) {
          const old = callback;
          callback = (map) => {
            self.currentMap = map;
            old(map);
          };
        }
        if (event == 16) {
          const old = callback;
          callback = (msg) => {
            const el = document.createElement("div");
            el.textContent = String(msg);
            old(el.innerHTML);
          };
        }
        if (event == 46) {
          const old = callback;
          callback = (data) => {
            delete data.newToken;
            old(data);
          };
        }
        return on(event, callback);
      };
      socket.on("connect", () =>
        parent.postMessage(
          { type: "bonk-connected", room: self.room },
          location.origin,
        ),
      );
      socket.on("connect_error", (e) =>
        parent.postMessage(
          { type: "bonk-error", message: e.message },
          location.origin,
        ),
      );
      socket.on("15", () => self.confirmedReceipts.clear());
      socket.on("wb:auto-start", () => {
        if (self.localId === self.hostId)
          document.getElementById("newbonklobby_startbutton")?.click();
      });
      socket.on("disconnect", () => {
        self.localId = null;
        self.hostId = -1;
        self.room = null;
        self.playing = false;
        self.bots = [];
        self.confirmedReceipts.clear();
        parent.postMessage({ type: "bonk-disconnected" }, location.origin);
        parent.postMessage(
          { type: "bonk-host", isHost: false },
          location.origin,
        );
      });
      return socket;
    };
    args[1].peerjs.Peer = function () {
      return self.fakePeerInstance;
    };
  },
  init() {
    const old = $.post,
      self = this;
    $.post = function (url, data, success, dataType) {
      const endpoint = String(url).split("/").pop().split("?")[0];
      if (endpoint === "getrooms.php") {
        const request = $.ajax({
          url:
            "/api/rooms/native?include=" +
            encodeURIComponent(self.pendingRoom || ""),
          method: "GET",
          dataType: "json",
          success,
        });
        request.done((result) => {
          self.latestRooms = result.rooms;
          queueMicrotask(() => self.finishJoin());
        });
        return request;
      }
      if (endpoint === "getroomaddress.php") {
        self.room = String(data.id);
        const ready = $.Deferred();
        $.ajax({
          url: "/api/rooms/" + encodeURIComponent(self.room) + "/address",
          method: "GET",
          dataType: "json",
        })
          .done(async (result) => {
            try {
              await window.BonkMods?.prepareRoom(self.room);
              success?.(result);
              ready.resolve(result);
            } catch (error) {
              ready.reject(error);
              self.cancelNativeJoin?.();
              if (error.name !== "AbortError")
                parent.postMessage(
                  { type: "bonk-mod-notice", message: error.message },
                  location.origin,
                );
            }
          })
          .fail((...args) => ready.reject(...args));
        return ready.promise();
      }
      if (
        endpoint === "map_save_pub.php" &&
        self.mapEncoder &&
        data?.leveldata
      ) {
        try {
          const map = self.mapEncoder.decodeFromDatabase(data.leveldata);
          data = {
            ...data,
            mode: map.m?.mo || data.mo || "b",
            remix: !!(map.m?.rxn || map.m?.rxa),
            spawns: map.spawns?.filter((spawn) => spawn.f).length || 0,
          };
        } catch {
          /* Native service validation rejects malformed maps. */
        }
      }
      const request = old.call(
        this,
        "/compat/" + endpoint,
        data,
        success,
        dataType,
      );
      if (
        ["login_legacy.php", "register_legacy.php", "login_auto.php"].includes(
          endpoint,
        )
      )
        request.done((result) => {
          if (result?.r === "success")
            queueMicrotask(() => {
              if (self.invitedRoom) self.joinRoom(self.invitedRoom);
            });
        });
      return request;
    };
    const value = (id) => document.getElementById(id)?.value;
    document.getElementById("roomlistcreatecreatebutton").addEventListener(
      "click",
      async (e) => {
        e.stopImmediatePropagation();
        e.preventDefault();
        try {
          const response = await fetch("/api/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: value("roomlistcreatewindowgamename"),
              password: value("roomlistcreatewindowpassword"),
              maxPlayers: value("roomlistcreatewindowmaxplayers"),
              minLevel: value("roomlistcreatewindowminlevel"),
              maxLevel: value("roomlistcreatewindowmaxlevel"),
              unlisted: document.getElementById(
                "roomlistcreatewindowunlistedcheckbox",
              ).checked,
            }),
          });
          const room = await response.json();
          if (!response.ok) throw Error(room.error);
          self.createdPassword = value("roomlistcreatewindowpassword");
          document.getElementById("roomlist_create_close")?.click();
          self.joinRoom(room.id);
        } catch (err) {
          parent.postMessage(
            { type: "bonk-error", message: err.message },
            location.origin,
          );
        }
      },
      true,
    );
    for (const [id, mode] of [
      ["Classic", "b"],
      ["Arrows", "ar"],
      ["Grapple", "sp"],
    ])
      document
        .getElementById("quickPlayWindow_" + id + "Button")
        .addEventListener(
          "click",
          async (e) => {
            e.stopImmediatePropagation();
            e.preventDefault();
            const rooms = await (await fetch("/api/rooms")).json();
            let room = rooms.find(
              (r) =>
                r.quick &&
                r.mode_mo === mode &&
                !r.password &&
                r.players < r.maxplayers,
            );
            if (!room)
              room = await (
                await fetch("/api/rooms", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name: id + " · Quick Play",
                    mode,
                    quick: true,
                  }),
                })
              ).json();
            document.getElementById("quickPlayWindow_close")?.click();
            self.joinRoom(room.id);
          },
          true,
        );
    const inviteObserver = new MutationObserver(() => {
      if (self.invitedRoom && self.localPlayerData.loggedIn) {
        const id = self.invitedRoom;
        self.invitedRoom = null;
        self.joinRoom(id);
      }
    });
    inviteObserver.observe(document.getElementById("mainmenuelements"), {
      attributes: true,
      subtree: true,
      childList: true,
    });
    const sourceDates = new MutationObserver(() => {
      for (const age of document.querySelectorAll(".maploadwindowtextage"))
        if (age.textContent === "Invalid date") age.textContent = "Bundled map";
    });
    sourceDates.observe(
      document.getElementById("maploadwindow") ||
        document.getElementById("bonkiocontainer"),
      {
        subtree: true,
        childList: true,
      },
    );
    this.ready = true;
    parent.postMessage({ type: "bonk-ready" }, location.origin);
  },
  joinRoom(id) {
    if (!this.localPlayerData.loggedIn) {
      this.invitedRoom = id;
      return;
    }
    this.invitedRoom = null;
    this.pendingRoom = id;
    document.getElementById("pretty_playbutton")?.click();
    document.getElementById("classic_mid_customgame")?.click();
    document.getElementById("roomlistrefreshbutton")?.click();
  },
  finishJoin() {
    if (!this.pendingRoom) return;
    const index = this.latestRooms?.findIndex((r) => r.id === this.pendingRoom);
    if (index < 0) return;
    const row = document.querySelector('tr[data-myid="' + index + '"]');
    if (!row) return;
    this.pendingRoom = null;
    row.click();
    document.getElementById("roomlistjoinbutton")?.click();
    if (this.createdPassword) {
      document.getElementById("roomlistjoinpasswordtext").value =
        this.createdPassword;
      this.createdPassword = null;
      document.getElementById("roomlistpassjoinbutton")?.click();
    }
  },
};
window.addEventListener("message", async (e) => {
  if (e.origin !== location.origin || e.source !== parent) return;
  if (
    e.data.type === "bonk-lobby" &&
    window.manifold.localId === window.manifold.hostId
  )
    window.manifold.socket?.emit("14");
  if (e.data.type === "bonk-open-account") {
    const m = window.manifold;
    if (m.socket?.connected)
      return parent.postMessage(
        {
          type: "bonk-notice",
          message: "Leave your current room to switch accounts.",
        },
        location.origin,
      );
    if (m.localPlayerData.loggedIn && !m.localPlayerData.guest) {
      document.getElementById("pretty_top_settings")?.click();
      return;
    }
    if (m.localPlayerData.loggedIn)
      document.getElementById("pretty_top_exit")?.click();
    document.getElementById("guestOrAccountContainer_accountButton")?.click();
  }
  if (e.data.type === "bonk-mod-rules") {
    const m = window.manifold,
      r = e.data.rules || {},
      rules = { rounds: r.rounds, teams: r.teams };
    if (!m.socket?.connected)
      return parent.postMessage(
        { type: "bonk-mod-result", message: "Join a room first." },
        location.origin,
      );
    if (
      typeof r.gravity === "number" &&
      Number.isFinite(r.gravity) &&
      Math.abs(r.gravity) <= 1000
    ) {
      const current = m.currentMap;
      if (!current) return;
      const map = m.mapEncoder.decodeFromDatabase(current);
      map.s.gd = r.gravity;
      rules.map = m.mapEncoder.encodeToDatabase(map);
    }
    m.socket.emit("wb:rules", rules, (result) =>
      parent.postMessage(
        {
          type: "bonk-mod-result",
          message: result.error || "Room rules applied.",
        },
        location.origin,
      ),
    );
  }
  if (e.data.type === "bonk-join" || e.data.type === "bonk-room-created") {
    window.manifold.joinRoom(e.data.room);
  }
});
