import { RTCPeerConnection } from 'werift';
import { Navigator } from 'werift/nonstandard';

const nav = new Navigator({ dummyMedia: { enabled: true, audio: { packetIntervalMs: 20 } } });
const stream = await nav.mediaDevices.getUserMedia({ audio: true });
const track = stream.getAudioTracks()[0];
if (!track) throw new Error('no dummy audio track');

const pcA = new RTCPeerConnection({ iceServers: [] });
const pcB = new RTCPeerConnection({ iceServers: [] });

let received = 0;
let bytes = 0;
pcB.ontrack = (event) => {
  event.track.onReceiveRtp.subscribe((packet) => {
    received += 1;
    bytes += packet.payload.length;
  });
};

pcA.addTrack(track, stream);

const offer = await pcA.createOffer();
await pcA.setLocalDescription(offer);
await pcB.setRemoteDescription({ type: 'offer', sdp: pcA.localDescription.sdp });
await pcB.setLocalDescription(await pcB.createAnswer());
await pcA.setRemoteDescription({ type: 'answer', sdp: pcB.localDescription.sdp });

const waitFor = async (label, predicate, timeoutMs = 12000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`TIMEOUT ${label}: A=${pcA.connectionState}/${pcA.signalingState} B=${pcB.connectionState}/${pcB.signalingState}`);
  return false;
};

const connected = await waitFor('dtls', () => pcA.connectionState === 'connected' && pcB.connectionState === 'connected');
const flowed = await waitFor('rtp', () => received >= 20);

console.log(
  JSON.stringify({
    connected,
    flowed,
    aState: pcA.connectionState,
    bState: pcB.connectionState,
    receivedPackets: received,
    receivedBytes: bytes,
    receiverSsrc: pcB.getTransceivers()[0]?.receiver.track?.ssrc ?? null
  })
);

pcA.close();
pcB.close();
nav.mediaDevices.cleanup?.();
process.exit(connected && flowed ? 0 : 1);
