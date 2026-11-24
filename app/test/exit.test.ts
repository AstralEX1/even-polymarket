import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OsEventTypeList as T } from '@evenrealities/even_hub_sdk'
import { exitDialogue } from '../src/exit.ts'

function setup() {
  const log: string[] = []
  let t = 1_000
  const exit = exitDialogue(() => { log.push('ask') }, async () => { log.push('restore') }, () => t)
  return { exit, log, later: (ms: number) => { t += ms } }
}

test('a double tap asks for the dialogue once; the firmware duplicate is dropped', async () => {
  const { exit, log, later } = setup()
  assert.equal(await exit.take([T.DOUBLE_CLICK_EVENT]), true)
  later(80)
  assert.equal(await exit.take([T.DOUBLE_CLICK_EVENT]), true)
  assert.deepEqual(log, ['ask'])
  assert.equal(exit.isOut(), true) // nothing is drawn over it
})

test('its ENTER draws nothing; its EXIT ("No") builds the page once and the app goes on', async () => {
  const { exit, log, later } = setup()
  await exit.take([T.DOUBLE_CLICK_EVENT])
  later(100)
  assert.equal(await exit.take([T.FOREGROUND_ENTER_EVENT]), true) // came up: hardware, and the notes' "page cleared" alike
  assert.equal(await exit.take([T.FOREGROUND_ENTER_EVENT]), true)
  assert.deepEqual(log, ['ask'])
  later(2000)
  assert.equal(await exit.take([T.FOREGROUND_EXIT_EVENT]), true)
  assert.deepEqual(log, ['ask', 'restore'])
  assert.equal(exit.isOut(), false)
  assert.equal(await exit.take([T.FOREGROUND_EXIT_EVENT]), false) // its duplicate is an ordinary leave: polling goes on
  later(2000)
  assert.equal(await exit.take([T.FOREGROUND_ENTER_EVENT]), false) // a later ENTER is the app's own again
  assert.deepEqual(log, ['ask', 'restore'])
})

test('"Yes": EXIT then SYSTEM_EXIT, or SYSTEM_EXIT alone; the app ends either way and is not left waiting', async () => {
  for (const yes of [[T.FOREGROUND_EXIT_EVENT, T.SYSTEM_EXIT_EVENT], [T.SYSTEM_EXIT_EVENT]]) {
    const { exit, later } = setup()
    await exit.take([T.DOUBLE_CLICK_EVENT])
    await exit.take([T.FOREGROUND_ENTER_EVENT])
    for (const type of yes) { later(500); await exit.take([type]) }
    assert.equal(await exit.take([T.SYSTEM_EXIT_EVENT]), false) // the app stops the mic
    assert.equal(exit.isOut(), false)
    later(5000)
    assert.equal(await exit.take([T.FOREGROUND_ENTER_EVENT]), false) // if it comes back, it draws again
  }
})

test('no answer seen: any input builds the page first, and a second double tap asks again after it', async () => {
  const { exit, log, later } = setup()
  await exit.take([T.DOUBLE_CLICK_EVENT])
  later(3000)
  assert.equal(await exit.take([T.SCROLL_BOTTOM_EVENT]), false) // the app handles the scroll as usual
  assert.deepEqual(log, ['ask', 'restore'])
  assert.equal(exit.isOut(), false)

  const second = setup()
  await second.exit.take([T.DOUBLE_CLICK_EVENT])
  second.later(3000)
  await second.exit.take([T.DOUBLE_CLICK_EVENT])
  assert.deepEqual(second.log, ['ask', 'restore', 'ask'])
  assert.equal(second.exit.isOut(), true)
})

test('outside the dialogue ENTER passes once; its duplicate is dropped', async () => {
  const { exit, later } = setup()
  assert.equal(await exit.take([T.FOREGROUND_ENTER_EVENT]), false)
  later(70)
  assert.equal(await exit.take([T.FOREGROUND_ENTER_EVENT]), true)
  assert.equal(await exit.take([T.CLICK_EVENT]), false)
})
