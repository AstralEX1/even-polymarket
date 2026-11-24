import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytesToHex } from '@noble/hashes/utils.js'
import { actionHash, msgpack, signL1 } from '../src/sign.ts'

// Vectors from hyperliquid-python-sdk tests/signing_test.py; wire forms as signing.py builds them.
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123'
const VAULT = '0x1719884eb866cb12b2287399b15f7db5e7d775ea'

const order = (t: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'order',
  orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t, ...extra }],
  grouping: 'na',
})
const dummy = { type: 'dummy', num: 100_000_000_000 } // float_to_int_for_hashing(1000)

const hex = (b: Uint8Array) => bytesToHex(b)

test('msgpack uses the minimal int encodings Python uses', () => {
  assert.equal(hex(msgpack(127)), '7f')
  assert.equal(hex(msgpack(255)), 'ccff')
  assert.equal(hex(msgpack(256)), 'cd0100')
  assert.equal(hex(msgpack(65536)), 'ce00010000')
  assert.equal(hex(msgpack(100_000_000_000)), 'cf000000174876e800')
  assert.equal(hex(msgpack(-1)), 'ff')
  assert.equal(hex(msgpack(-32)), 'e0')
  assert.equal(hex(msgpack(-33)), 'd0df')
  assert.equal(hex(msgpack(-129)), 'd1ff7f')
  assert.equal(hex(msgpack(-40000)), 'd2ffff63c0')
})

test('msgpack strings, maps, arrays, null and bools', () => {
  assert.equal(hex(msgpack('a'.repeat(31))).slice(0, 2), 'bf')
  assert.equal(hex(msgpack('a'.repeat(32))).slice(0, 4), 'd920')
  assert.equal(hex(msgpack('a'.repeat(256))).slice(0, 6), 'da0100')
  assert.equal(hex(msgpack('é')), 'a2c3a9')
  assert.equal(hex(msgpack({ b: 1, a: undefined, c: null })), '82a16201a163c0')
  assert.equal(hex(msgpack([true, false])), '92c3c2')
  assert.equal(hex(msgpack(new Array(16).fill(0))).slice(0, 6), 'dc0010')
})

test('msgpack refuses floats', () => {
  assert.throws(() => msgpack({ p: 0.5 }), /not an integer/)
})

test('phantom agent connectionId matches production', () => {
  const action = {
    type: 'order',
    orders: [{ a: 4, b: true, p: '1670.1', s: '0.0147', r: false, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  }
  assert.equal(hex(actionHash(action, 1677777606040, null, null)), '0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908')
})

const vectors: [string, unknown, string | null, [string, string, number], [string, string, number]][] = [
  ['dummy (uint64)', dummy, null,
    ['0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298', '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', 27],
    ['0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510', '0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613', 28]],
  ['Gtc order', order({ limit: { tif: 'Gtc' } }), null,
    ['0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e', '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e', 28],
    ['0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54', '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5', 27]],
  ['order with cloid', order({ limit: { tif: 'Gtc' } }, { c: '0x00000000000000000000000000000001' }), null,
    ['0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3', '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da', 27],
    ['0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d', '0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988', 28]],
  ['dummy with vault', dummy, VAULT,
    ['0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239', '0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c', 28],
    ['0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b', '0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60', 27]],
  ['tpsl order', order({ trigger: { isMarket: true, triggerPx: '103', tpsl: 'sl' } }), null,
    ['0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9', '0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405', 27],
    ['0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4', '0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac', 28]],
  ['createSubAccount', { type: 'createSubAccount', name: 'example' }, null,
    ['0x51096fe3239421d16b671e192f574ae24ae14329099b6db28e479b86cdd6caa7', '0xb71f7d293af92d3772572afb8b102d167a7cef7473388286bc01f52a5c5b423', 27],
    ['0xa699e3ed5c2b89628c746d3298b5dc1cca604694c2c855da8bb8250ec8014a5b', '0x53f1b8153a301c72ecc655b1c315d64e1dcea3ee58921fd7507e35818fcc1584', 28]],
  ['subAccountTransfer', { type: 'subAccountTransfer', subAccountUser: '0x1d9470d4b963f552e6f671a81619d395877bf409', isDeposit: true, usd: 10 }, null,
    ['0x43592d7c6c7d816ece2e206f174be61249d651944932b13343f4d13f306ae602', '0x71a926cb5c9a7c01c3359ec4c4c34c16ff8107d610994d4de0e6430e5cc0f4c9', 28],
    ['0xe26574013395ad55ee2f4e0575310f003c5bb3351b5425482e2969fa51543927', '0xefb08999196366871f919fd0e138b3a7f30ee33e678df7cfaf203e25f0a4278', 28]],
  ['scheduleCancel', { type: 'scheduleCancel' }, null,
    ['0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9', '0x6557ac307fa05d25b8d61f21fb8a938e703b3d9bf575f6717ba21ec61261b2a0', 27],
    ['0xc75bb195c3f6a4e06b7d395acc20bbb224f6d23ccff7c6a26d327304e6efaeed', '0x342f8ede109a29f2c0723bd5efb9e9100e3bbb493f8fb5164ee3d385908233df', 28]],
  ['scheduleCancel with time', { type: 'scheduleCancel', time: 123456789 }, null,
    ['0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55', '0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b', 28],
    ['0x4e4f2dbd4107c69783e251b7e1057d9f2b9d11cee213441ccfa2be63516dc5bc', '0x706c656b23428c8ba356d68db207e11139ede1670481a9e01ae2dfcdb0e1a678', 27]],
]

for (const [name, action, vault, [mr, ms, mv], [tr, ts, tv]] of vectors) {
  test(`signL1 matches the Python SDK: ${name}`, () => {
    assert.deepEqual(signL1(KEY, action, 0, true, vault), { r: mr, s: ms, v: mv })
    assert.deepEqual(signL1(KEY, action, 0, false, vault), { r: tr, s: ts, v: tv })
  })
}

test('expiresAfter changes the hash', () => {
  assert.notEqual(hex(actionHash(dummy, 0, null, 1)), hex(actionHash(dummy, 0, null, null)))
})
