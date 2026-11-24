import { OsEventTypeList } from '@evenrealities/even_hub_sdk'

const { DOUBLE_CLICK_EVENT, FOREGROUND_ENTER_EVENT, FOREGROUND_EXIT_EVENT, SYSTEM_EXIT_EVENT, ABNORMAL_EXIT_EVENT } = OsEventTypeList
const DUPLICATE_MS = 600 // the firmware sends one transition twice, 50-100 ms apart
const SETTLE_MS = 300 // an exit request sent while the page is still being rebuilt is lost

/**
 * The system exit dialogue that a double tap asks for (`ask` calls shutDownPageContainer(1)). Seen on hardware: it sends
 * FOREGROUND_ENTER when it comes up and FOREGROUND_EXIT when it is gone after "No"; "Yes" sends EXIT, then SYSTEM_EXIT
 * (or SYSTEM_EXIT alone). That ENTER and EXIT are the dialogue's, not the app entering or leaving. While it is out
 * nothing may be drawn, since a page call could cover it; `restore` builds the page again once it is gone.
 */
export function exitDialogue(ask: () => void, restore: () => Promise<unknown>, now = Date.now) {
  let out = false
  const last = new Map<OsEventTypeList, number>()
  const again = (type: OsEventTypeList) => {
    const dup = now() - (last.get(type) ?? -Infinity) < DUPLICATE_MS
    last.set(type, now())
    return dup
  }
  const back = () => { out = false; return restore() }
  return {
    /** From the request until the dialogue is gone. */
    isOut: () => out,
    /**
     * Called first with an event's types. True when the event needs nothing more: a double tap (it asks here), a duplicate,
     * or the dialogue's own ENTER / EXIT. Any other input while it is out means it is gone: the page is built again first.
     */
    async take(types: readonly (OsEventTypeList | null)[]): Promise<boolean> {
      const is = (t: OsEventTypeList) => types.includes(t)
      if (is(DOUBLE_CLICK_EVENT)) {
        if (again(DOUBLE_CLICK_EVENT)) return true
        if (out) { await back(); await new Promise(r => setTimeout(r, SETTLE_MS)) } // asked again with no answer seen: the page first
        out = true
        ask()
        return true
      }
      if (is(FOREGROUND_ENTER_EVENT)) return out || again(FOREGROUND_ENTER_EVENT)
      if (!out) return false
      if (is(FOREGROUND_EXIT_EVENT)) { await back(); return true }
      if (is(SYSTEM_EXIT_EVENT) || is(ABNORMAL_EXIT_EVENT)) out = false
      else await back()
      return false
    },
  }
}
