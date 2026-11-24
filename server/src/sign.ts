import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

/** msgpack encoder matching Python msgpack.packb for what Hyperliquid actions contain. */
export function msgpack(value: unknown): Uint8Array {
  const out: number[] = []
  const uint = (v: number | bigint, size: number) => {
    const b = BigInt.asUintN(size * 8, BigInt(v))
    for (let i = size - 1; i >= 0; i--) out.push(Number((b >> BigInt(i * 8)) & 0xffn))
  }
  const head = (n: number, fix: number, code16: number) => {
    if (n < 16) out.push(fix | n)
    else if (n < 0x10000) { out.push(code16); uint(n, 2) }
    else { out.push(code16 + 1); uint(n, 4) }
  }
  const write = (v: unknown): void => {
    if (v === null) out.push(0xc0)
    else if (v === false) out.push(0xc2)
    else if (v === true) out.push(0xc3)
    else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new Error(`msgpack: not an integer: ${v}`)
      if (v >= 0) {
        if (v < 0x80) out.push(v)
        else if (v < 0x100) { out.push(0xcc); uint(v, 1) }
        else if (v < 0x10000) { out.push(0xcd); uint(v, 2) }
        else if (v < 0x100000000) { out.push(0xce); uint(v, 4) }
        else { out.push(0xcf); uint(v, 8) }
      } else {
        if (v >= -32) uint(v, 1)
        else if (v >= -0x80) { out.push(0xd0); uint(v, 1) }
        else if (v >= -0x8000) { out.push(0xd1); uint(v, 2) }
        else if (v >= -0x80000000) { out.push(0xd2); uint(v, 4) }
        else { out.push(0xd3); uint(v, 8) }
      }
    } else if (typeof v === 'string') {
      const bytes = utf8ToBytes(v)
      const n = bytes.length
      if (n < 32) out.push(0xa0 | n)
      else if (n < 0x100) out.push(0xd9, n)
      else if (n < 0x10000) { out.push(0xda); uint(n, 2) }
      else { out.push(0xdb); uint(n, 4) }
      out.push(...bytes)
    } else if (Array.isArray(v)) {
      head(v.length, 0x90, 0xdc)
      v.forEach(write)
    } else if (typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined)
      head(entries.length, 0x80, 0xde)
      for (const [k, x] of entries) { write(k); write(x) }
    } else throw new Error(`msgpack: unsupported ${typeof v}`)
  }
  write(value)
  return Uint8Array.from(out)
}

const u64 = (n: number) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(n))
  return b
}
const address = (a: string) => hexToBytes(a.replace(/^0x/, ''))

export function actionHash(action: unknown, nonce: number, vaultAddress: string | null, expiresAfter: number | null): Uint8Array {
  const parts = [msgpack(action), u64(nonce)]
  parts.push(vaultAddress ? concatBytes(Uint8Array.of(1), address(vaultAddress)) : Uint8Array.of(0))
  if (expiresAfter != null) parts.push(Uint8Array.of(0), u64(expiresAfter))
  return keccak_256(concatBytes(...parts))
}

// EIP-712 field encodings: dynamic strings are hashed, the rest are 32-byte words.
const str = (s: string) => keccak_256(utf8ToBytes(s))
const word = (bytes: Uint8Array) => concatBytes(new Uint8Array(32 - bytes.length), bytes)
const hashStruct = (type: string, fields: Uint8Array[]) => keccak_256(concatBytes(str(type), ...fields))

const DOMAIN = hashStruct('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)', [
  str('Exchange'), str('1'), word(u64(1337)), word(address('0x0000000000000000000000000000000000000000')),
])

/** Python eth_utils.to_hex(int): no leading zeros. */
const intHex = (bytes: Uint8Array) => '0x' + BigInt('0x' + bytesToHex(bytes)).toString(16)

export function signL1(
  privateKey: string, action: unknown, nonce: number, isMainnet: boolean,
  vaultAddress: string | null = null, expiresAfter: number | null = null,
): { r: string; s: string; v: number } {
  const agent = hashStruct('Agent(string source,bytes32 connectionId)', [
    str(isMainnet ? 'a' : 'b'), actionHash(action, nonce, vaultAddress, expiresAfter),
  ])
  const digest = keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), DOMAIN, agent))
  // recovered format is [recovery, r(32), s(32)]; low-s is the default, as Ethereum requires
  const sig = secp256k1.sign(digest, hexToBytes(privateKey.replace(/^0x/, '')), { prehash: false, format: 'recovered' })
  return { r: intHex(sig.subarray(1, 33)), s: intHex(sig.subarray(33)), v: 27 + sig[0] }
}
