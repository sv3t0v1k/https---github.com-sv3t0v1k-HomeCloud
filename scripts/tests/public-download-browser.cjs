// Browser acceptance check for a disposable public file share. The browser
// must trust the server certificate; TLS errors are intentionally not ignored.
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require(process.env.HOMECLOUD_PLAYWRIGHT_MODULE || 'playwright')

async function main() {
  const { HOMECLOUD_SHARE_URL: shareUrl, HOMECLOUD_EXPECTED_SHA256: expected, HOMECLOUD_SHARE_PASSWORD: password } = process.env
  if (!shareUrl || !/^https:\/\//.test(shareUrl) || !/^[a-f0-9]{64}$/i.test(expected || '')) {
    throw new Error('Set HOMECLOUD_SHARE_URL (HTTPS) and HOMECLOUD_EXPECTED_SHA256')
  }

  const browser = await chromium.launch({ headless: true })
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homecloud-public-download-'))
  try {
    const context = await browser.newContext({ acceptDownloads: true })
    const page = await context.newPage()
    const pageResponse = await page.goto(shareUrl)
    if (pageResponse?.status() !== 200) throw new Error('Public page did not return HTTP 200')
    const csp = pageResponse.headers()['content-security-policy'] || ''
    if (!csp.includes("frame-ancestors 'none'")) throw new Error('Expected CSP was not present')

    if (password) {
      await page.getByLabel('Пароль ссылки').fill(password)
      await page.getByRole('button', { name: 'Открыть доступ' }).click()
    }
    const button = page.getByRole('button', { name: 'Скачать файл' })
    await button.waitFor()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      button.click(),
    ])
    const failure = await download.failure()
    if (failure) throw new Error('Browser download failed')
    const filePath = path.join(tempDir, 'download')
    await download.saveAs(filePath)
    const actual = createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
    if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error('Downloaded SHA-256 differs from source')
    if (!page.url().startsWith(shareUrl)) throw new Error('Application page navigated away after download')
    console.log(JSON.stringify({ browser: 'Chromium', anonymousContext: true, download: 'PASS', sha256: actual, csp: 'PASS' }))
    await context.close()
  } finally {
    await browser.close()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  // Do not print errors from browser automation: they may contain the share URL.
  console.error(error.message.startsWith('Set HOMECLOUD_') ? error.message : 'Public browser download check failed')
  process.exitCode = 1
})
