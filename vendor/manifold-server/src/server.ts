import express from 'express';
import cors from 'cors';
import http from 'node:http';
import https from 'node:https';
import * as socketIO from 'socket.io';
import fs from 'fs';
import path from 'node:path';

import ManifoldTerminal from './terminal';

import * as IN from './inPacketIds';
import * as OUT from './outPacketIds';
import { BanList, Config, GameSettings, Player, RatelimitRestrictions } from './types';
import moment from 'moment';

/** Optional embedding hooks. The upstream standalone entry remains supported. */
export interface ManifoldServerOptions {
  httpServer?: http.Server | https.Server;
  expressApp?: express.Application;
  socketPath?: string;
  metadataPath?: string | false;
  terminal?: boolean;
  storageDirectory?: string;
  origins?: string | string[] | boolean;
  /** Return a protocol error to reject; verified player fields may be replaced in place. */
  authorizeJoin?: (data: Record<string, any>, socket: socketIO.Socket) => string | void | Promise<string | void>;
  onChange?: (room: ManifoldServer) => void;
  onEmpty?: (room: ManifoldServer) => void;
  /** Own-account/map persistence adapter; no requests to the official service are made. */
  onServiceEvent?: (event: string, data: any, socket: socketIO.Socket, room: ManifoldServer) => void | Promise<void>;
}

const ratelimitMessages: Record<string, string> = {
  joining: 'join_rate_limited',
  chatting: 'chat_rate_limit',
  changingTeams: 'rate_limit_teams',
  readying: 'rate_limit_ready',
  transferringHost: 'host_change_rate_limited',
};

export default class ManifoldServer {
  public config;

  public server: http.Server | https.Server;
  public expressApp: express.Application;
  public io: socketIO.Server;

  public terminal?: ManifoldTerminal;
  public options: ManifoldServerOptions;
  public ownsHttpServer: boolean;
  private banListPath?: string;
  private pingTimer?: ReturnType<typeof setInterval>;

  public playerInfo: Player[] = [];
  public playerSockets: socketIO.Socket[] = [];
  public ratelimits: Record<string, Record<string, number>> = {};
  public banList: BanList;
  public chatLog: string = '';

  public hostId: number = -1;
  public gameStartTime: number = 0;
  public gameSettings: GameSettings;

  public roomName: string;
  public password: string | null;
  public playerAmount: number = 0;
  public closed: boolean = false;
  public scheduledForceStopTimeout?: NodeJS.Timeout;

  constructor(config: Config, options: ManifoldServerOptions = {}) {
    this.config = config;
    this.options = options;
    this.ownsHttpServer = !options.httpServer;

    this.gameSettings = JSON.parse(JSON.stringify(this.config.defaultGameSettings));
    this.roomName = this.config.roomNameOnStartup;
    this.password = this.config.roomPasswordOnStartup;

    if (options.terminal ?? this.ownsHttpServer) this.terminal = new ManifoldTerminal(this);
    const storageDirectory = options.storageDirectory ?? (this.ownsHttpServer ? '.' : undefined);
    if (storageDirectory) {
      fs.mkdirSync(storageDirectory, { recursive: true });
      this.banListPath = path.join(storageDirectory, 'banlist.json');
    }

    // gather ban list
    if (this.banListPath && fs.existsSync(this.banListPath)) {
      this.banList = JSON.parse(fs.readFileSync(this.banListPath, { encoding: 'utf8' }));
    } else {
      this.banList = { addresses: [], usernames: [] };
    }

    // init http server and metadata endpoint
    this.expressApp = options.expressApp ?? express();
    if (options.httpServer) {
      this.server = options.httpServer;
    } else if (this.config.useHttps) {
      if (!fs.existsSync('server-key.pem') || !fs.existsSync('server-cert.pem')) {
        console.log('HTTPS certificate files missing. Cannot start server.');
        process.exit(0);
      }

      this.server = https.createServer(
        {
          key: fs.readFileSync('server-key.pem'),
          cert: fs.readFileSync('server-cert.pem'),
        },
        this.expressApp,
      );
    } else {
      this.server = http.createServer(this.expressApp);
    }

    this.expressApp.use(
      cors({
        origin: options.origins ?? 'https://bonk.io',
        methods: ['GET', 'POST'],
        credentials: true,
      }),
    );

    if (options.metadataPath !== false) this.expressApp.get(options.metadataPath ?? '/', (_req, res) => {
      res.json({
        isBonkServer: true,
        roomname: this.roomName,
        password: this.password ? 1 : 0,
        players: this.playerAmount,
        maxplayers: this.config.maxPlayers,
        mode_ga: this.gameSettings.ga,
        mode_mo: this.gameSettings.mo,
        closed: this.closed,
      });
    });

    // init socket.io server and register socket connection events
    this.io = new socketIO.Server(this.server, {
      allowEIO3: true,
      path: options.socketPath ?? '/socket.io',
      maxHttpBufferSize: 2 * 1024 * 1024,
      cors: {
        origin: options.origins ?? 'https://bonk.io',
        methods: ['GET', 'POST'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    this.io.on('connection', (socket) => {
      socket.on('1', (data) => {
        if (data && data.id === socket.data.pingProbe) socket.data.ping = Math.max(0, Math.min(10000, Date.now() - socket.data.pingSentAt));
      });
      socket.on('2', () => this.sendPing(socket));
      // timesync packet handling
      socket.conn.on('packet', (packet) => {
        if (typeof packet.data === 'string' && /[0-9]\[18/.test(packet.data)) {
          let timeSyncInfo;
          try { timeSyncInfo = JSON.parse(packet.data.replace(/.*(\{.+\})\]/, '$1')); } catch { return; }
          if (!timeSyncInfo || !['string', 'number'].includes(typeof timeSyncInfo.id)) return;

          socket.emit(OUT.REPLY_TIMESYNC, {
            id: timeSyncInfo.id,
            result: Date.now(),
          });
        }
      });

      // new player joins the room and sends this packet
      socket.use((packet, next) => {
        if (!this.validPacket(packet)) { socket.emit(OUT.ERROR_MESSAGE, 'invalid_packet'); return; }
        next();
      });

      socket.on(IN.JOIN_REQUEST, async (playerData) => {
        if (!playerData || typeof playerData !== 'object' || typeof playerData.userName !== 'string') return;
        if (socket.data.joinPending || socket.data.bonkId !== undefined) return;
        socket.data.joinPending = true;
        try {
          const rejection = await options.authorizeJoin?.(playerData, socket);
          if (rejection) { socket.emit(OUT.ERROR_MESSAGE, rejection); return; }
          if (!socket.connected) return;
        } catch { socket.emit(OUT.ERROR_MESSAGE, 'authentication_failed'); return; }
        finally { socket.data.joinPending = false; }
        if (typeof playerData.userName !== 'string' || !Number.isFinite(Number(playerData.level))) return;
        playerData.level = Number(playerData.level);
        playerData.guest = Boolean(playerData.guest);
        playerData.avatar ??= { bc: 8355711, layers: [] };
        /* #region JOIN RESTRICTIONS */

        // server closed check
        if (this.closed) {
          socket.emit(OUT.ERROR_MESSAGE, 'closed');
          return;
        }

        // banned check
        if (this.banList.addresses.includes(socket.handshake.address)) {
          socket.emit(OUT.ERROR_MESSAGE, 'banned');
          return;
        }

        // already joined check
        if (socket.data.bonkId !== undefined) return;

        // join ratelimit check
        if (this.processRatelimit(socket, 'joining')) return;

        // username duplicate check
        if (config.restrictions.usernames.noDuplicates) {
          for (const player of this.playerInfo) {
            if (!player) continue;

            if (player.userName === playerData.userName) {
              socket.emit(OUT.ERROR_MESSAGE, 'already_in_this_room');
              return;
            }
          }
        }

        // username length check
        if (playerData.userName.length > config.restrictions.usernames.maxLength) {
          socket.emit(OUT.ERROR_MESSAGE, 'username_too_long');
          return;
        }

        // empty username check
        if (config.restrictions.usernames.noEmptyNames && !playerData.userName) {
          socket.emit(OUT.ERROR_MESSAGE, 'username_empty');
          return;
        }

        // username regex check
        if (config.restrictions.usernames.disallowRegex.test(playerData.userName)) {
          socket.emit(OUT.ERROR_MESSAGE, 'username_invalid');
          return;
        }

        // min level check
        if (this.config.restrictions.levels.minLevel > 0 && playerData.guest) {
          socket.emit(OUT.ERROR_MESSAGE, 'guests_not_allowed');
          return;
        }

        if (playerData.level < this.config.restrictions.levels.minLevel) {
          socket.emit(OUT.ERROR_MESSAGE, 'players_xp_too_low');
          return;
        }

        // max level check
        if (playerData.level > this.config.restrictions.levels.maxLevel) {
          socket.emit(OUT.ERROR_MESSAGE, 'players_xp_too_high');
          return;
        }

        // numeric level check
        if (this.config.restrictions.levels.onlyAllowNumbers && /[^0-9]/.test(playerData.level)) {
          socket.emit(OUT.ERROR_MESSAGE, 'player_xp_invalid');
          return;
        }

        // password check
        if (this.password && playerData.roomPassword !== this.password) {
          socket.emit(OUT.ERROR_MESSAGE, 'password_wrong');
          return;
        }

        // max players check
        if (this.playerAmount >= config.maxPlayers) {
          socket.emit(OUT.ERROR_MESSAGE, 'room_full');
          return;
        }

        /* #endregion JOIN RESTRICTIONS */

        this.registerSocketEvents(socket);
        socket.join('main');

        // assign id to new player and store it in the socket
        socket.data = {
          ...socket.data,
          bonkId: this.playerInfo.length,
        };

        // add new player to the player socket and info lists
        this.playerSockets[socket.data.bonkId] = socket;
        this.playerInfo[socket.data.bonkId] = {
          peerId: 'invalid',
          peerID: 'invalid',
          userName: playerData.userName,
          guest: playerData.guest,
          team: this.gameSettings.tl ? 0 : 1,
          level: this.config.restrictions.levels.censorLevels ? '-' : playerData.level,
          ready: false,
          tabbed: false,
          avatar: playerData.avatar,
        };

        this.playerAmount++;
        this.options.onChange?.(this);

        // emit initial lobby info to new player
        socket.emit(
          OUT.SERVER_INFORM,
          socket.data.bonkId,
          this.playerInfo[this.hostId] ? this.hostId : config.autoAssignHost ? socket.data.bonkId : -1,
          this.playerInfo,
          this.gameStartTime,
          this.gameSettings.tl,
          0,
          'invalid',
          null,
        );

        // notify everyone (but the new player) about the join
        socket.broadcast.emit(
          OUT.PLAYER_JOINED,
          socket.data.bonkId,
          'invalid',
          playerData.userName,
          playerData.guest,
          playerData.level,
          this.gameSettings.tl ? 0 : 1,
          playerData.avatar,
        );

        // log join message
        this.logChatMessage(`* ${playerData.userName} joined the game`);

        // if there's no host in the room, pretend to be the host and
        // send the "inform in lobby" packet. if autoAssignHost is on,
        // make the new player a host
        if (!this.playerInfo[this.hostId]) {
          if (config.autoAssignHost) this.hostId = socket.data.bonkId;
          socket.emit(OUT.HOST_INFORM_IN_LOBBY, this.gameSettings);
        }
      });
    });

    this.pingTimer = setInterval(() => {
      for (const socket of this.playerSockets) if (socket?.connected) this.sendPing(socket);
    }, 2000);
    this.pingTimer.unref();

    // start the server and the terminal
    if (this.ownsHttpServer) this.server.listen(this.config.port, () => {
      this.terminal?.start();
    });
  }

  /** Check protocol boundaries before handlers use supplied fields. */
  private validPacket(packet: any[]): boolean {
    const event = String(packet[0]);
    const data = packet[1];
    const objects = new Set(['13','11','40','6','10','16','27','35','44','7','9','20','21','23','25','26','29','32','34','36','4','5','52','53']);
    if (!objects.has(event)) return true;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const integer = (value: unknown, max = 1000000) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max;
    if (event === '13') return typeof data.userName === 'string' && data.userName.length <= 256 && (data.level === undefined || Number.isFinite(Number(data.level))) && (!data.avatar || (typeof data.avatar === 'object' && Array.isArray(data.avatar.layers) && data.avatar.layers.length <= 15));
    if (event === '10') return typeof data.message === 'string';
    if (event === '6') return integer(data.targetTeam, 5);
    if (event === '26') return integer(data.targetID) && integer(data.targetTeam, 5);
    if (event === '25') return integer(data.f, 1000000000) && data.a && typeof data.a === 'object';
    if (event === '11') return integer(data.sid) && data.gs && typeof data.gs === 'object';
    if (event === '40') return integer(data.sid) && data.allData && typeof data.allData === 'object';
    if (event === '9') return integer(data.banshortid);
    if (event === '35' || event === '34') return integer(data.id);
    if (event === '29') return integer(data.sid) && Number.isFinite(data.bal) && Math.abs(data.bal) <= 100;
    if (event === '21') return integer(data.w, 100);
    if (event === '23') return typeof data.m === 'string' || (data.m && typeof data.m === 'object');
    if (event === '20') return typeof data.ga === 'string' && data.ga.length <= 20 && typeof data.mo === 'string' && data.mo.length <= 20;
    if (event === '5') return data.gs && typeof data.gs === 'object' && !Array.isArray(data.gs) && Array.isArray(data.gs.bal) && data.gs.bal.length <= 1000000 && data.gs.map && typeof data.gs.ga === 'string' && typeof data.gs.mo === 'string' && typeof data.is === 'string' && data.is.length > 0 && data.is.length <= 2 * 1024 * 1024;
    if (event === '7') return typeof data.teamLock === 'boolean';
    if (event === '32') return typeof data.t === 'boolean';
    if (event === '36') return integer(data.num, 10);
    return true;
  }

  /** Disconnect this room without closing an externally owned HTTP server. */
  dispose() {
    this.closed = true;
    clearTimeout(this.scheduledForceStopTimeout);
    clearInterval(this.pingTimer);
    this.io.disconnectSockets(true);
    this.io.engine.close();
    this.terminal?.readlineInterface.close();
    if (this.ownsHttpServer) this.server.close();
  }

  private sendPing(socket: socketIO.Socket) {
    const pingData: Record<number, number> = {};
    for (const playerSocket of this.playerSockets) if (playerSocket) pingData[playerSocket.data.bonkId] = playerSocket.data.ping ?? 0;
    socket.data.pingSentAt = Date.now();
    socket.data.pingProbe = `${socket.id}:${socket.data.pingSentAt}`;
    socket.emit('1', pingData, socket.data.pingProbe);
  }

  processRatelimit(socket: socketIO.Socket, actionType: keyof RatelimitRestrictions) {
    const socketAddress = socket.handshake.address;
    const ratelimitOptions = this.config.restrictions.ratelimits[actionType as keyof RatelimitRestrictions];

    this.ratelimits[socketAddress] ??= {};
    const socketRatelimits = this.ratelimits[socketAddress];

    socketRatelimits[actionType] ??= 0;

    // if this is the first recorded instance of the action within the timeframe, start a timer that resets the
    // action recorder after the timeframe passes (unless it reaches the ratelimit within the timeframe)
    if (socketRatelimits[actionType] == 0) {
      setTimeout(() => {
        if (socketRatelimits[actionType] < ratelimitOptions.amount) {
          socketRatelimits[actionType] = 0;
        }
      }, ratelimitOptions.timeframe * 1000);
    }

    socketRatelimits[actionType]++;

    // if the ratelimit is reached, start a timer that resets the action recorder after the restore time passes
    if (socketRatelimits[actionType] == ratelimitOptions.amount) {
      setTimeout(() => {
        socketRatelimits[actionType] = 0;
      }, ratelimitOptions.restore * 1000);
    }

    // if the ratelimit has been reached, send a ratelimit error message to the socket and return true, otherwise just
    // return false
    if (socketRatelimits[actionType] >= ratelimitOptions.amount) {
      socket.emit(OUT.ERROR_MESSAGE, ratelimitMessages[actionType]);

      return true;
    } else {
      return false;
    }
  }

  assertPlayerIsHost(playerId: number, shouldErrorMessage: boolean = true): boolean {
    if (playerId == this.hostId) return true;

    if (shouldErrorMessage) {
      this.playerSockets[playerId]?.emit(OUT.ERROR_MESSAGE, 'not_hosting');
    }

    return false;
  }

  logChatMessage(content: string) {
    this.chatLog += `[${moment().format(this.config.timeStampFormat)}] ${content}\n`;
  }

  sendChatStatusMessage(message: string) {
    this.io.to('main').emit(OUT.MANIFOLD_CHAT_STATUS, message, '#b53030');
    this.logChatMessage(message);
  }

  saveChatLog() {
    if (this.chatLog == '') return;

    if (!fs.existsSync('./chatlogs')) fs.mkdirSync('./chatlogs');
    fs.writeFileSync(`./chatlogs/${moment().format(this.config.timeStampFormat)}.txt`, this.chatLog);
    this.chatLog = '';
  }

  transferHost(id: number) {
    const oldHostId = this.hostId;
    this.hostId = id;

    // send host change packet to everyone
    this.io.to('main').emit(OUT.TRANSFER_HOST, { oldHost: -1, newHost: this.hostId });

    // log host transfer message
    if (id == -1) {
      this.io.to('main').emit(OUT.RETURN_TO_LOBBY);
      this.sendChatStatusMessage(
        `* ${this.playerInfo[oldHostId].userName} had their host privileges taken away by the server, making the room hostless.`,
      );
    } else if (oldHostId == -1) {
      this.sendChatStatusMessage(`* ${this.playerInfo[id].userName} is now the game host.`);
    } else {
      this.sendChatStatusMessage(
        `* Server has taken host privileges from ${this.playerInfo[oldHostId].userName}, and ${this.playerInfo[id].userName} is now the game host.`,
      );
    }
  }

  banPlayer(id: number) {
    this.banList.addresses.push(this.playerSockets[id].handshake.address);
    this.banList.usernames.push(this.playerInfo[id].userName);

    if (this.banListPath) fs.writeFileSync(this.banListPath, JSON.stringify(this.banList), {
      encoding: 'utf8',
    });

    this.logChatMessage(`${this.playerInfo[id].userName} was banned from the server`);
    this.playerSockets[id].disconnect();
  }

  kickPlayer(id: number) {
    this.logChatMessage(`${this.playerInfo[id].userName} was kicked from the server`);
    this.playerSockets[id].disconnect();
  }

  scheduledClose(timeUntilForceStop?: number): string | undefined {
    this.closed = true;

    this.hostId = -1;
    this.io.to('main').emit(OUT.TRANSFER_HOST, { oldHost: -1, newHost: -1 });

    this.io.to('main').emit(OUT.RETURN_TO_LOBBY);

    if (timeUntilForceStop) {
      const forceStopTime = moment().add(timeUntilForceStop, 'minutes');

      this.scheduledForceStopTimeout = setTimeout(() => {
        console.log('Scheduled close time limit reached. Closing...');
        this.saveChatLog();
        process.exit(0);
      }, timeUntilForceStop * 60000);

      this.sendChatStatusMessage(
        `* The server has been closed. Player entry is now prohibited, and the server will shut down ${forceStopTime.fromNow()}, or as soon as everyone leaves the room.`,
      );

      return forceStopTime.fromNow();
    } else {
      this.sendChatStatusMessage(
        '* The server has been closed. Player entry is now prohibited, and as soon as everyone leaves the room, the server will shut down.',
      );
    }
  }

  abortScheduledClose() {
    this.closed = false;

    clearTimeout(this.scheduledForceStopTimeout);

    this.sendChatStatusMessage(
      '* The server has been re-opened! Player entry is no longer prohibited and the server will no longer automatically shut down.',
    );

    if (this.config.autoAssignHost) {
      const newHostId = this.playerSockets.findIndex((i) => i && this.hostId != i.data.bonkId);

      if (newHostId != -1) {
        this.transferHost(newHostId);
      }
    }
  }

  registerSocketEvents(socket: socketIO.Socket) {
    // Preserve native service packets behind an explicitly supplied independent persistence adapter.
    for (const event of ['38', '39', '41', '42', '47', '51']) socket.on(event, (data) => {
      Promise.resolve().then(() => this.options.onServiceEvent?.(event, data, socket, this)).catch(() => socket.emit(OUT.ERROR_MESSAGE, 'service_error'));
    });
    /* #region JOIN HANDLERS */

    // "inform in lobby" packet
    socket.on(IN.HOST_INFORM_IN_LOBBY, (data) => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;
      this.playerSockets[data.sid]?.emit(OUT.HOST_INFORM_IN_LOBBY, data.gs);
    });

    // "inform in game" packet
    socket.on(IN.HOST_INFORM_IN_GAME, (data) => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;
      this.playerSockets[data.sid]?.emit(OUT.HOST_INFORM_IN_GAME, data.allData);
    });

    /* #endregion JOIN HANDLERS */

    /* #region NON-HOST ACTIONS */

    // change own team
    socket.on(IN.CHANGE_OWN_TEAM, (data) => {
      if (this.processRatelimit(socket, 'changingTeams')) return;

      if (this.gameSettings.tl && !this.assertPlayerIsHost(socket.data.bonkId)) return;

      // change team in the player list
      this.playerInfo[socket.data.bonkId].team = data.targetTeam;

      // send team change packet to everyone
      this.io.to('main').emit(OUT.CHANGE_TEAM, socket.data.bonkId, data.targetTeam);
    });

    // send chat message
    socket.on(IN.CHAT_MESSAGE, (data) => {
      if (this.processRatelimit(socket, 'chatting')) return;

      // limit message length
      data.message = data.message.slice(0, this.config.restrictions.maxChatMessageLength);

      // send chat message to everyone
      this.io.to('main').emit(OUT.CHAT_MESSAGE, socket.data.bonkId, data.message);

      // log chat message
      this.logChatMessage([this.playerInfo[socket.data.bonkId].userName, ': ', data.message].join(''));
    });

    // set own ready state
    socket.on(IN.SET_READY, (data) => {
      if (this.processRatelimit(socket, 'readying')) return;
      if (typeof data.ready !== 'boolean') return;

      this.playerInfo[socket.data.bonkId].ready = data.ready;

      // send ready state to everyone
      this.io.to('main').emit(OUT.SET_READY, socket.data.bonkId, data.ready);
    });

    socket.on('17', () => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;
      for (const player of this.playerInfo) if (player) player.ready = false;
      this.io.to('main').emit('9');
    });

    // send map request
    socket.on(IN.MAP_REQUEST, (data) => {
      if (this.processRatelimit(socket, 'chatting')) return;

      if (this.hostId == -1) {
        this.io.emit(OUT.MAP_REQUEST_NON_HOST, data.mapname, data.mapauthor, socket.data.bonkId);
      } else {
        // send map request packet to everyone but the host (only contains metadata of the map)
        this.playerSockets[this.hostId].broadcast.emit(
          OUT.MAP_REQUEST_NON_HOST,
          data.mapname,
          data.mapauthor,
          socket.data.bonkId,
        );

        // send map request packet to host (contains the actual map)
        this.playerSockets[this.hostId].emit(OUT.MAP_REQUEST_HOST, data.m, socket.data.bonkId);
      }

      // log map request
      this.logChatMessage(
        [
          '* ',
          this.playerInfo[socket.data.bonkId].userName,
          ' has requested the map ',
          data.mapname,
          ' by ',
          data.mapauthor,
        ].join(''),
      );
    });

    // send friend request
    socket.on(IN.FRIEND_REQUEST, (data) => {
      // send friend request packet to the target player
      this.playerSockets[data.id]?.emit(OUT.FRIEND_REQUEST, socket.data.bonkId);
    });

    // set tabbed (afk) state
    socket.on(IN.SET_TABBED, (data) => {
      if (typeof data.out !== 'boolean') return;

      this.playerInfo[socket.data.bonkId].tabbed = data.out;

      // send tabbed (afk) state to everyone
      this.io.to('main').emit(OUT.SET_TABBED, socket.data.bonkId, data.out);
    });

    // save replay to main menu
    socket.on(IN.SAVE_REPLAY, () => {
      this.io.to('main').emit(OUT.SAVE_REPLAY, socket.data.bonkId);
    });

    // (unhandled) 38: request xp increase
    // (unhandled) 39: vote map
    // (unhandled) 51: curate map

    /* #endregion NON-HOST ACTIONS */

    /* #region HOST ACTIONS */

    // lock teams
    socket.on(IN.LOCK_TEAMS, (data) => {
      if (this.processRatelimit(socket, 'changingTeams')) return;
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      this.gameSettings.tl = data.teamLock;

      this.io.to('main').emit(OUT.LOCK_TEAMS, data.teamLock);
    });

    // kick/ban player
    socket.on(IN.KICK_BAN_PLAYER, (data) => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;
      if (!this.playerInfo[data.banshortid] || data.banshortid === socket.data.bonkId) return;

      if (data.kickonly) {
        this.kickPlayer(data.banshortid);
      } else {
        this.banPlayer(data.banshortid);
      }
    });

    // change mode
    socket.on(IN.CHANGE_MODE, (data) => {
      if (this.processRatelimit(socket, 'changingMode')) return;
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      this.gameSettings.ga = data.ga;
      this.gameSettings.mo = data.mo;

      this.io.to('main').emit(OUT.CHANGE_MODE, data.ga, data.mo);
    });

    // change rounds to win
    socket.on(IN.CHANGE_ROUNDS, (data) => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      this.gameSettings.wl = data.w;

      this.io.to('main').emit(OUT.CHANGE_ROUNDS, data.w);
    });

    // change current map
    socket.on(IN.CHANGE_MAP, (data) => {
      if (this.processRatelimit(socket, 'changingMap')) return;
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      this.gameSettings.map = data.m;

      this.io.to('main').emit(OUT.CHANGE_MAP, data.m);
    });

    // change someone's team
    socket.on(IN.CHANGE_OTHER_TEAM, (data) => {
      if (this.processRatelimit(socket, 'changingTeams')) return;
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      // change team in the player list
      if (!this.playerInfo[data.targetID]) return;
      this.playerInfo[data.targetID].team = data.targetTeam;

      // send team change packet to everyone
      this.io.to('main').emit(OUT.CHANGE_TEAM, data.targetID, data.targetTeam);
    });

    // change someone's balance (nerf/buff)
    socket.on(IN.CHANGE_BALANCE, (data) => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      // change balance in the game settings
      this.gameSettings.bal[data.sid] = data.bal;

      // send balance change packet to everyone
      this.io.to('main').emit(OUT.CHANGE_BALANCE, data.sid, data.bal);
    });

    // enable/disable teams
    socket.on(IN.TOGGLE_TEAMS, (data) => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      // change team enable/disable in the game settings
      this.gameSettings.tea = data.t;

      // send team enable/disable packet to everyone
      this.io.to('main').emit(OUT.TOGGLE_TEAMS, data.t);
    });

    // transfer host
    socket.on(IN.TRANSFER_HOST, (data) => {
      if (this.processRatelimit(socket, 'transferringHost')) return;
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      if (!this.playerInfo[data.id]) return;
      const oldHostId = this.hostId;

      // change host id
      this.hostId = data.id;

      // send host change packet to everyone
      this.io.to('main').emit(OUT.TRANSFER_HOST, { oldHost: oldHostId, newHost: this.hostId });

      // log host transfer message
      this.logChatMessage(`* ${this.playerInfo[this.hostId].userName} is now the game host`);
    });

    // send countdown "starting in" message
    socket.on(IN.SEND_COUNTDOWN_STARTING, (data) => {
      if (this.processRatelimit(socket, 'startGameCountdown')) return;
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      this.io.to('main').emit(OUT.SEND_COUNTDOWN_STARTING, data.num);
    });

    // send countdown "aborted" message
    socket.on(IN.SEND_COUNTDOWN_ABORTED, () => {
      if (this.processRatelimit(socket, 'startGameCountdown')) return;
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      this.io.to('main').emit(OUT.SEND_COUNTDOWN_ABORTED);
    });

    // (unhandled) 50: NO_HOST_SWAP
    socket.on(IN.CHANGE_ROOM_NAME, (data) => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;
      this.roomName = String(data.newName ?? data.name ?? data.roomName ?? data.roomname ?? '').slice(0, 80) || this.config.roomNameOnStartup;
      this.io.to('main').emit('58', this.roomName);
      this.options.onChange?.(this);
    });
    socket.on(IN.CHANGE_ROOM_PASSWORD, (data) => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;
      this.password = String(data.newPass ?? data.password ?? data.roomPassword ?? '').slice(0, 128) || null;
      this.io.to('main').emit('59', this.password ?? '');
      this.options.onChange?.(this);
    });

    /* #endregion HOST ACTIONS */

    /* #region IN-GAME ACTIONS */

    // send inputs
    socket.on(IN.SEND_INPUTS, (data) => {
      socket.broadcast.emit(OUT.SEND_INPUTS, socket.data.bonkId, data);
    });

    // The host schedules joins/leaves at a simulation frame. Without this relay,
    // late joins can appear in the room list but never enter the running simulation.
    socket.on('25', (data) => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;
      this.io.to('main').emit('31', data);
    });

    socket.on('24', () => socket.broadcast.emit('30', socket.data.bonkId));

    socket.on('28', (data) => {
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;
      this.io.to('main').emit('35', data);
    });

    // host start game
    socket.on(IN.START_GAME, (data) => {
      if (this.processRatelimit(socket, 'startingEndingGame')) return;
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      this.gameSettings = data.gs;
      this.gameStartTime = Date.now();
      this.options.onChange?.(this);

      this.io.to('main').emit(OUT.START_GAME, this.gameStartTime, data.is, data.gs);
    });

    // host end game
    socket.on(IN.RETURN_TO_LOBBY, () => {
      if (this.processRatelimit(socket, 'startingEndingGame')) return;
      if (!this.assertPlayerIsHost(socket.data.bonkId)) return;

      this.gameStartTime = 0;
      for (const player of this.playerInfo) if (player) player.ready = false;
      this.options.onChange?.(this);
      this.io.to('main').emit(OUT.RETURN_TO_LOBBY);
    });

    // (unhandled) 41: get map votes

    /* #endregion IN-GAME ACTIONS */

    socket.on('disconnect', () => {
      if (socket.data.bonkId === undefined) return;

      const leavingPlayerId = socket.data.bonkId;
      const leavingPlayerName = this.playerInfo[leavingPlayerId].userName;

      // this is the amount of game ticks (bonk runs at 30tps) at which the player left
      const tickCount = Math.round((Date.now() - this.gameStartTime) / (1000 / 30));

      if (this.config.autoAssignHost && this.assertPlayerIsHost(socket.data.bonkId, false)) {
        const newHostId = this.playerSockets.findIndex((i) => i && this.hostId != i.data.bonkId);

        // log disconnect message
        if (newHostId == -1) {
          this.logChatMessage(`* ${leavingPlayerName} left the game`);
        } else {
          this.logChatMessage(
            `* ${leavingPlayerName} left the game and ${this.playerInfo[newHostId].userName} is now the game host`,
          );
        }

        this.hostId = newHostId;
        this.io.to('main').emit(OUT.HOST_LEFT, socket.data.bonkId, newHostId, tickCount);
      } else {
        if (this.assertPlayerIsHost(socket.data.bonkId, false)) this.hostId = -1;

        // log disconnect message
        this.logChatMessage(`* ${leavingPlayerName} left the game`);

        this.io.to('main').emit(OUT.PLAYER_LEFT, socket.data.bonkId, tickCount);
      }

      delete this.playerInfo[socket.data.bonkId];
      delete this.playerSockets[socket.data.bonkId];

      this.playerAmount--;
      if (this.playerAmount === 0) {
        this.gameStartTime = 0;
        this.hostId = -1;
        this.playerInfo = [];
        this.playerSockets = [];
      }

      this.options.onChange?.(this);
      if (this.playerAmount <= 0) this.options.onEmpty?.(this);
      if (this.playerAmount <= 0 && this.closed && this.ownsHttpServer) {
        console.log('Everyone has left the room. Closing...');
        this.saveChatLog();
        process.exit(0);
      }
    });
  }
}
