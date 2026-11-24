import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endpointer, rms } from '../src/endpoint.ts'

/** `ms` of 16 kHz audio at a steady level, in 100 ms chunks as the glasses send it. */
const chunks = (level: number, ms: number) =>
  Array.from({ length: ms / 100 }, () => new Uint8Array(new Int16Array(1600).fill(level).buffer))

/** Feeds the chunks; returns after how many ms the recording ends, or null. */
function stopsAt(...parts: Uint8Array[][]) {
  const done = endpointer()
  let t = 0
  for (const c of parts.flat()) {
    t += 100
    if (done(c)) return t
  }
  return null
}

test('rms of a steady level is that level', () => {
  assert.equal(rms(chunks(1000, 100)[0]), 1000)
  assert.equal(rms(new Uint8Array(0)), 0)
})

test('stops 0.8 s after you stop talking, not in a pause between words', () => {
  assert.equal(stopsAt(chunks(100, 300), chunks(3000, 600), chunks(100, 200), chunks(3000, 400), chunks(100, 2000)), 2300)
})

test('speech from the first chunk works too', () => {
  assert.equal(stopsAt(chunks(3000, 1000), chunks(100, 2000)), 1800)
})

test('silence alone never stops it: the tap or the time cap does', () => {
  assert.equal(stopsAt(chunks(100, 5000)), null)
})

test('a steady TV in the room is the floor, speech over it still ends', () => {
  assert.equal(stopsAt(chunks(800, 500), chunks(4000, 700), chunks(800, 2000)), 2000)
})
