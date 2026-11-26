'use strict';

/* WebSocket keep-alive helpers shared by the simulator, bridge and relay.
 *
 * A connection can die without either end being told: a Starlink/5G link
 * changes address, a NAT forgets the mapping, a laptop sleeps. TCP then keeps
 * the socket "open" for many minutes while nothing gets through. These helpers
 * notice the silence and close the socket, so the normal reconnect logic runs.
 *
 *  - serverKeepAlive(wss): pings every client (protocol level) and terminates
 *    those that stop answering. It also sends web-app clients a small JSON
 *    heartbeat ({ctl:1,kind:'hb'}), because browsers can't see protocol pings:
 *    the app uses it to tell "no boat data" apart from "dead connection".
 *  - clientKeepAlive(ws): for the Node clients (bridge uplink to the relay,
 *    bridge to its peer bridge). Pings the server and terminates the socket
 *    when nothing comes back, which fires 'close' and so the reconnect.
 */

const PING_MS = 10000;            // protocol ping cadence
const HB_MS = 5000;               // app-level heartbeat to web-app clients
const HB_MSG = JSON.stringify({ ctl: 1, kind: 'hb' });

function serverKeepAlive(wss, { isApp = () => true, pingMs = PING_MS, hbMs = HB_MS } = {}) {
  wss.on('connection', (ws) => {
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });
    ws.on('message', () => { ws._alive = true; });
  });
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._alive === false) { try { ws.terminate(); } catch (_) {} continue; }   // missed a whole ping cycle
      ws._alive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, pingMs);
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === 1 && isApp(ws)) { try { ws.send(HB_MSG); } catch (_) {} }
    }
  }, hbMs);
  wss.on('close', () => { clearInterval(ping); clearInterval(hb); });
}

function clientKeepAlive(ws, { pingMs = PING_MS, deadMs = 2.5 * PING_MS } = {}) {
  let last = Date.now();
  const seen = () => { last = Date.now(); };
  ws.on('open', seen);
  ws.on('pong', seen);
  ws.on('message', seen);
  ws.on('ping', seen);
  const timer = setInterval(() => {
    if (Date.now() - last > deadMs) {
      clearInterval(timer);
      try { ws.terminate(); } catch (_) {}   // emits 'close' -> caller reconnects
      return;
    }
    if (ws.readyState === 1) { try { ws.ping(); } catch (_) {} }
  }, pingMs);
  ws.on('close', () => clearInterval(timer));
}

module.exports = { serverKeepAlive, clientKeepAlive, HB_MSG };
