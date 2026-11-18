// Choosing how a conversation of one agent app that It reopens runs, as the owner chooses it on
// the site's Machines page, beside the app's Auto-wake switch: by the control the page has there,
// a radio button for each mode or one drop-down. The checks of the real apps use it to reopen a
// conversation in the mode that allows everything and in the one that allows least.

/**
 * Opens the Machines page in a new tab of a browser paired as the owner's, chooses `mode` for
 * `harness`, waits until the page shows it chosen, and closes the tab. Gives whether it did.
 */
export async function chooseWakeMode(context, site, harness, mode) {
  const tab = await context.newPage()
  try {
    await tab.goto(new URL('/machines', site).href)
    const radio = tab.locator(`input.wake-mode-pick[type="radio"][name$="-${harness}"][value="${mode}"]`)
    const select = tab.locator(`select.wake-mode-pick[id$="-${harness}"]`)
    await radio.or(select).first().waitFor({ timeout: 30_000 })
    if ((await select.count()) > 0) await select.selectOption(mode)
    // The page shows a mode as chosen once It has taken it, a moment after the click
    else await radio.click()
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      const chosen = (await select.count()) > 0 ? (await select.inputValue()) === mode : await radio.isChecked()
      if (chosen) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  } finally {
    await tab.close().catch(() => {})
  }
}
