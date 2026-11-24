import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfirm, parseIntent, pickSide } from '../src/voice.ts'
import { market } from '../src/fake.ts'

test('parseIntent reads "<amount> on <side>" in digits and words', () => {
  assert.deepEqual(parseIntent('Ten on KC.'), { kind: 'bet', usd: 10, side: 'kc' })
  assert.deepEqual(parseIntent('$5 on yes'), { kind: 'bet', usd: 5, side: 'yes' })
  assert.deepEqual(parseIntent('bet twenty five dollars on the Chiefs'), { kind: 'bet', usd: 25, side: 'chiefs' })
  assert.deepEqual(parseIntent('put 2.5 on no please'), { kind: 'bet', usd: 2.5, side: 'no' })
  assert.deepEqual(parseIntent('a hundred on Buffalo'), { kind: 'bet', usd: 100, side: 'buffalo' })
  assert.deepEqual(parseIntent('On BUF'), { kind: 'bet', usd: null, side: 'buf' })
})

test('parseIntent reads a cash-out, including "sell" and "get me out"', () => {
  for (const t of ['Cash out.', 'cashout', 'sell it all', 'sell KC', 'get me out of KC']) assert.deepEqual(parseIntent(t), { kind: 'cashout' }, t)
})

test('parseIntent refuses talk that is not clearly a bet', () => {
  for (const t of ['', '...', 'ten dollars', 'no', 'no thanks', 'KC', 'never mind the chiefs', "don't bet on KC", 'not on KC', 'wait, 10 on KC'])
    assert.equal(parseIntent(t), null, t)
})

test('parseIntent refuses an amount it cannot read whole', () => {
  assert.equal(parseIntent('two fifty on KC'), null)
  assert.equal(parseIntent('ten thousand on KC'), null)
  assert.equal(parseIntent('20 grand on KC'), null)
  assert.equal(parseIntent('zero on KC'), null)
  assert.deepEqual(parseIntent('KC by 20, put 5 on it'), null) // "it" names no side
  assert.deepEqual(parseIntent('KC by 20, put 5 on KC'), { kind: 'bet', usd: 5, side: 'kc' }) // the amount is the one before "on"
})

test('pickSide matches short names, team words and yes / no', () => {
  const game = market('1', 1, 'KC vs BUF', ['KC', 'Kansas City Chiefs'], ['BUF', 'Buffalo Bills'])
  assert.equal(pickSide(game, 'kc'), 0)
  assert.equal(pickSide(game, 'chiefs'), 0)
  assert.equal(pickSide(game, 'kansas city'), 0)
  assert.equal(pickSide(game, 'bills'), 1)
  assert.equal(pickSide(game, 'lakers'), null)
  assert.equal(pickSide(game, 'kc or bills'), null) // both named: refuse to guess

  const binary = market('2', 2, 'BTC >= 60,393', ['Yes'], ['No'])
  assert.equal(pickSide(binary, 'yes'), 0)
  assert.equal(pickSide(binary, 'no'), 1)
  assert.equal(pickSide(binary, 'nope'), null)

  const la = market('3', 3, 'LAC vs LAR', ['LAC', 'Los Angeles Chargers'], ['LAR', 'Los Angeles Rams'])
  assert.equal(pickSide(la, 'los angeles'), null)
  assert.equal(pickSide(la, 'rams'), 1)
})

test('parseConfirm takes only a whole yes or no', () => {
  for (const t of ['Yes.', 'yes please', 'Yeah!', 'confirm']) assert.equal(parseConfirm(t), true, t)
  for (const t of ['No.', 'nope', 'cancel', 'no thanks']) assert.equal(parseConfirm(t), false, t)
  for (const t of ['', 'yes no', 'yes, but wait', 'oh yes he scores', 'no way', 'ten on KC']) assert.equal(parseConfirm(t), null, t)
})
