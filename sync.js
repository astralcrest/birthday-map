// peer-to-peer room over public relays (trystero, nostr strategy). handshakes are sealed with the password.
import { joinRoom, scale } from './vendor/trystero.min.mjs';

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
  const guest = room.makeUserState('guest', null, { maxBytes: 6000 });
  const vote = room.makeUserState('vote', null, { maxBytes: 400 });
  const show = room.makeState('show', null, { maxBytes: 60000 });
  const self = await room.getSelf();
  return { room, guest, vote, show, self };
}
