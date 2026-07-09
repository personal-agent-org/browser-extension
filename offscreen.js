// Offscreen capture document. MV3 forbids getUserMedia in the service worker, so all audio
// capture happens here. On a `start` message from the SW we:
//   - open the meeting WebSocket (subprotocol ["bearer."+token], same auth as the device socket),
//   - grab the tab-audio stream (from the SW-minted stream id) and the microphone stream,
//   - RE-ROUTE tab audio back to the speakers (else the user goes deaf on the call),
//   - downsample both to 16 kHz mono s16le PCM and send `audio` frames continuously,
//   - run a simple energy VAD on the mic to emit "Ich" speaker start/stop,
//   - forward speaker/meta events relayed from the content script (via the SW) verbatim.
// See the wire protocol in meeting.js / the backend /api/v1/ws/meeting endpoint.
import { api } from "./platform.js";

const OUT_RATE = 16000;
const CHUNK_SEC = 0.25; // ~250 ms per audio frame
const MIC_VAD_RMS = 0.012; // energy threshold for "someone is talking into the mic"
const MIC_VAD_HANGOVER = 0.6; // seconds of silence before we call the mic segment ended

let ws = null;
let wsOpen = false;
let sendQueue = [];
let config = null;
let startPerf = 0;
let audioCtx = null;
const streams = {}; // name -> { seq, outCount, pending, mic state }
let mediaStreams = []; // to stop() the tracks on teardown

const nowTs = () => (performance.now() - startPerf) / 1000;

// ---------- WebSocket ----------
function sendFrame(obj) {
  const json = JSON.stringify(obj);
  if (wsOpen && ws && ws.readyState === WebSocket.OPEN) ws.send(json);
  else sendQueue.push(json);
}

function openWs() {
  const wsUrl = config.serverUrl.replace(/^http/, "ws") + "/api/v1/ws/meeting";
  ws = new WebSocket(wsUrl, ["bearer." + config.token]);
  ws.onopen = () => {
    wsOpen = true;
    ws.send(
      JSON.stringify({
        t: "start",
        session: config.sessionId,
        title: config.title,
        platform: config.platform,
      }),
    );
    for (const j of sendQueue) ws.send(j);
    sendQueue = [];
  };
  ws.onclose = () => {
    wsOpen = false;
  };
  ws.onerror = () => {
    wsOpen = false;
  };
}

// ---------- PCM helpers ----------
function resampleToInt16(input, inRate) {
  const outLen = Math.max(1, Math.round((input.length * OUT_RATE) / inRate));
  const out = new Int16Array(outLen);
  const ratio = input.length > 1 ? (input.length - 1) / (outLen > 1 ? outLen - 1 : 1) : 0;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] || 0;
    const b = i0 + 1 < input.length ? input[i0 + 1] : a;
    let s = a * (1 - frac) + b * frac;
    s = Math.max(-1, Math.min(1, s));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function b64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function rms(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / (float32.length || 1));
}

// Accumulate native-rate Float32 for a stream; flush 250 ms output chunks as `audio` frames.
function pushSamples(name, samples, inRate) {
  const st = streams[name];
  const merged = new Float32Array(st.pending.length + samples.length);
  merged.set(st.pending, 0);
  merged.set(samples, st.pending.length);
  st.pending = merged;

  const chunkIn = Math.round(inRate * CHUNK_SEC);
  while (st.pending.length >= chunkIn) {
    const inChunk = st.pending.subarray(0, chunkIn);
    if (name === "mic") micVad(st, inChunk);
    const pcm = resampleToInt16(inChunk, inRate);
    const ts = st.outCount / OUT_RATE;
    st.outCount += pcm.length;
    sendFrame({
      t: "audio",
      session: config.sessionId,
      stream: name,
      seq: st.seq++,
      ts,
      pcm: b64(pcm),
    });
    st.pending = st.pending.slice(chunkIn);
  }
}

// Local mic segmentation: energy threshold + hangover -> "Ich" speaker start/stop on the mic stream.
function micVad(st, chunk) {
  const level = rms(chunk);
  const ts = nowTs();
  if (level >= MIC_VAD_RMS) st.lastVoice = ts;
  if (!st.speaking && level >= MIC_VAD_RMS) {
    st.speaking = true;
    sendFrame({ t: "speaker", session: config.sessionId, stream: "mic", speaker: "Ich", event: "start", ts });
  } else if (st.speaking && ts - (st.lastVoice || 0) > MIC_VAD_HANGOVER) {
    st.speaking = false;
    sendFrame({ t: "speaker", session: config.sessionId, stream: "mic", speaker: "Ich", event: "stop", ts });
  }
}

// ---------- capture graph ----------
async function getTabStream(streamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
  });
}

async function wireStream(name, media, { playback }) {
  streams[name] = { seq: 0, outCount: 0, pending: new Float32Array(0), speaking: false, lastVoice: 0 };
  mediaStreams.push(media);
  const source = audioCtx.createMediaStreamSource(media);
  const inRate = audioCtx.sampleRate;
  if (playback) source.connect(audioCtx.destination); // tab audio back to the speakers

  const muteSink = audioCtx.createGain();
  muteSink.gain.value = 0;
  muteSink.connect(audioCtx.destination);

  let node;
  if (audioCtx.audioWorklet) {
    node = new AudioWorkletNode(audioCtx, "pa-pcm-tap", { processorOptions: { stream: name } });
    node.port.onmessage = (e) => pushSamples(name, e.data.samples, inRate);
  } else {
    // ScriptProcessor fallback for engines without AudioWorklet.
    node = audioCtx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => pushSamples(name, new Float32Array(e.inputBuffer.getChannelData(0)), inRate);
  }
  source.connect(node);
  node.connect(muteSink); // keep the node pulled by the graph without adding audible output
}

async function start(streamId) {
  startPerf = performance.now();
  openWs();
  audioCtx = new AudioContext();
  if (audioCtx.audioWorklet) {
    try {
      await audioCtx.audioWorklet.addModule(api.runtime.getURL("meeting/pcm-worklet.js"));
    } catch {
      /* fall back to ScriptProcessor in wireStream */
    }
  }
  const tab = await getTabStream(streamId);
  await wireStream("tab", tab, { playback: true });
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    await wireStream("mic", mic, { playback: false });
  } catch {
    /* mic denied/unavailable: tab-only capture still works */
  }
}

async function stop() {
  try {
    if (wsOpen) ws.send(JSON.stringify({ t: "stop", session: config?.sessionId }));
  } catch {
    /* ignore */
  }
  for (const m of mediaStreams) {
    for (const track of m.getTracks()) track.stop();
  }
  mediaStreams = [];
  try {
    await audioCtx?.close();
  } catch {
    /* ignore */
  }
  audioCtx = null;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
}

// ---------- SW messaging ----------
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return; // not for us
  (async () => {
    try {
      if (msg.type === "start") {
        config = msg.config;
        await start(msg.streamId);
        sendResponse({ ok: true });
      } else if (msg.type === "stop") {
        await stop();
        sendResponse({ ok: true });
      } else if (msg.type === "speaker") {
        sendFrame({
          t: "speaker",
          session: config?.sessionId,
          stream: msg.stream,
          speaker: msg.speaker,
          event: msg.event,
          ts: nowTs(),
        });
        sendResponse({ ok: true });
      } else if (msg.type === "meta") {
        sendFrame({
          t: "meta",
          session: config?.sessionId,
          kind: msg.kind,
          name: msg.name || "",
          text: msg.text || "",
          ts: nowTs(),
        });
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async sendResponse
});
