// 端到端：网关作为参与者加入 OpenMeet 房间，双向收发 Opus
// 用法: npx tsx scripts/e2e-room.ts <serverUrl> <roomCode> <inviteToken> [seconds]
import { RoomParticipant } from '../src/participant.js';
import { OpusTranscoder, FRAME_SAMPLES_48 } from '../src/opus.js';
import { decodeInvite } from '@openmeet/shared';

const [serverUrl, code, inviteArg, secondsArg] = process.argv.slice(2);
if (!serverUrl || !code || !inviteArg) {
  console.error('usage: e2e-room.ts <serverUrl> <roomCode> <invite-token-or-OM1-text> [seconds]');
  process.exit(2);
}
// The join API wants the inner HMAC token, not the whole OM1 envelope.
const decoded = decodeInvite(inviteArg);
const token = decoded?.token ?? inviteArg;
if (!decoded) console.error('argument was not a decodable OM1 invite; using it verbatim as a token');
const seconds = Number(secondsArg) || 8;

const codec = new OpusTranscoder();
const tone = new Int16Array(FRAME_SAMPLES_48);
for (let i = 0; i < tone.length; i += 1) {
  tone[i] = Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 48000));
}
const frame = codec.encode(tone);

let receivedBytes = 0;
let receivedPackets = 0;
let peers = 0;
let selfId = '';

const participant = await RoomParticipant.join(
  {
    serverUrl,
    roomCode: code,
    displayName: '电话接入',
    inviteToken: token
  },
  {
    onRemoteAudio: (payload) => {
      receivedPackets += 1;
      receivedBytes += payload.length;
    },
    onRoom: (room, participants) => {
      peers = participants.length;
      console.log(
        `room: code=${room.code} lobby=${room.lobby} locked=${room.locked} participants=${participants
          .map((p) => `${p.name}/${p.peerId.slice(0, 8)}`)
          .join(',')}`
      );
    },
    onEnded: (reason) => console.log(`room ended: ${reason}`),
    onFatal: (message) => console.log(`fatal: ${message}`)
  }
);

selfId = participant.participantId;
console.log(`joined as ${selfId}, peers=${peers}`);

// 20 ms cadence, like a real media clock
let sent = 0;
const timer = setInterval(() => {
  for (let i = 0; i < 2; i += 1) {
    participant.writeAudio(frame);
    sent += 1;
  }
}, 40);

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
clearInterval(timer);

const report = {
  selfId,
  peersSeen: peers,
  framesSent: sent,
  bytesReceived: receivedBytes,
  packetsReceived: receivedPackets
};
console.log(JSON.stringify(report));
participant.close();
codec.destroy();
process.exit(0);
