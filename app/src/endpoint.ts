// When to stop recording: you spoke, then went quiet. Saves the second tap after "20 on KC".

const BYTES_PER_MS = 32 // 16 kHz mono s16le
/** Speech is this many times louder than the quietest chunk so far, and never below MIN_SPEECH. */
const OVER_FLOOR = 3
const MIN_SPEECH = 400

/** Loudness of 16-bit little-endian PCM. */
export function rms(pcm: Uint8Array): number {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const n = Math.floor(pcm.byteLength / 2)
  let sum = 0
  for (let i = 0; i < n; i++) sum += v.getInt16(i * 2, true) ** 2
  return n ? Math.sqrt(sum / n) : 0
}

/**
 * Feed it each audio chunk; it returns true once there was speech and then `quietMs` of quiet.
 * The level is judged against the whole recording so far, so speech from the first chunk and a steady TV both work.
 * shortcut: a fixed ratio over the noise floor; tune OVER_FLOOR and MIN_SPEECH on real glasses in a loud room. The tap and the time cap still end a recording.
 */
export function endpointer(quietMs = 800) {
  const levels: { r: number; ms: number }[] = []
  return (pcm: Uint8Array): boolean => {
    levels.push({ r: rms(pcm), ms: pcm.byteLength / BYTES_PER_MS })
    let floor = Infinity
    let peak = 0
    for (const l of levels) { floor = Math.min(floor, l.r); peak = Math.max(peak, l.r) }
    const speech = Math.max(MIN_SPEECH, floor * OVER_FLOOR)
    if (peak <= speech) return false
    let quiet = 0
    for (let i = levels.length - 1; i >= 0 && levels[i].r <= speech; i--) quiet += levels[i].ms
    return quiet >= quietMs
  }
}
