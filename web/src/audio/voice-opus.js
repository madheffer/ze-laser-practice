// What both ends of voice agree on (audio/voice-capture.js sends, audio/voice-playback.js plays): Opus through the
// browser's own codec (WebCodecs), 48 kHz mono in 20 ms packets.
//
// 40 kbit/s is Opus' fullband speech range (its docs: 28-40 kbit/s for fullband speech): clear, not "radio", and still
// only ~100 bytes a packet. 20 ms is the frame Opus is tuned for; shorter frames cost quality for a few ms.
export const RATE = 48000;
export const FRAME_US = 20_000;
export const BITRATE = 40_000;

export const encoderConfig = (sampleRate) => ({
  codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: BITRATE, bitrateMode: 'variable',
  // complexity 10: the best Opus does (a voice stream is nothing for a desktop CPU); voip: tuned for speech
  opus: { frameDuration: FRAME_US, complexity: 10, application: 'voip', signal: 'voice', useinbandfec: false, usedtx: false },
});
export const decoderConfig = { codec: 'opus', sampleRate: RATE, numberOfChannels: 1 };

// can this browser send / play voice at all (WebCodecs' AudioEncoder / AudioDecoder with Opus)
export async function canEncode(sampleRate) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false;
  try { return !!(await AudioEncoder.isConfigSupported(encoderConfig(sampleRate))).supported; } catch { return false; }
}
export const canDecode = () => typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined';

// loudness of a frame, 0..1: the speaking popup's sound bars (ui/voice-hud.js)
export function level(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  const db = 10 * Math.log10(s / Math.max(1, samples.length) + 1e-10); // dBFS of the RMS
  return Math.max(0, Math.min(1, (db + 50) / 40)); // -50 dBFS (room hiss) .. -10 dBFS (loud speech)
}
