// peer-to-peer room over public relays (trystero, nostr strategy). handshakes are sealed with the password.
import { joinRoom, scale, getRelaySockets } from './vendor/trystero.min.mjs';

// relays from trystero's own list that answered on 2026-11-13; swap any that die
export const RELAYS = [
  'wss://relay.primal.net',
  'wss://fanfares.nostr1.com',
  'wss://nostr-01.yakihonne.com',
  'wss://nostr.sathoarder.com',
  'wss://nostrelay.circum.space',
  'wss://relay.wavlake.com',
];

export async function openRoom(password, roomId) {
  const room = joinRoom({ appId: 'astralcrest-party/v1', password, relayConfig: { urls: RELAYS }, use: [scale()] }, roomId);
  // connection failures (a network that blocks the direct link) arrive here; keep them until the app listens
  const errs = []; let errFn = null;
  try { room.onError(e => { errs.push(e); if (errFn) errFn(e); }); } catch (e) { /* older build */ }
  const onNetError = f => { errFn = f; errs.forEach(e => f(e)); };
  const guest = room.makeUserState('guest', null, { maxBytes: 6000 });
  const vote = room.makeUserState('vote', null, { maxBytes: 400 });
  const reply = room.makeUserState('reply', null, { maxBytes: 600 });
  const show = room.makeState('show', null, { maxBytes: 60000 });
  // the room's backup: the host writes it, every phone keeps a copy, a new host asks for the newest one
  const vault = room.makeState('vault', null, { maxBytes: 64000 });
  const need = room.makeState('need', null, { maxBytes: 200 });
  const keep = room.makeUserState('keep', null, { maxBytes: 64000 });
  const self = await room.getSelf();
  const relaysUp = () => { try { return Object.values(getRelaySockets() || {}).filter(w => w && w.readyState === 1).length; } catch (e) { return 1; } };
  return { room, guest, vote, reply, show, vault, need, keep, self, relaysUp, onNetError };
}
