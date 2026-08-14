// DeepSeek Agent Client for VSCode — webview boot loader.
//
// A classic (non-module) script that runs before the deferred module shell.
// The server serves window.__DSH_BOOT__ as an inline script, which the CSP
// forbids; webview-boot.ts de-inlines it into a non-executable
// <script type="application/json" id="dsh-boot"> element. This loader
// publishes that JSON back onto window.__DSH_BOOT__ before the SPA shell
// (a module script, executed after classic scripts) reads it.
(function () {
  'use strict'
  var node = document.getElementById('dsh-boot')
  if (!node) throw new Error('dsh-vscode: boot manifest element (#dsh-boot) is missing')
  window.__DSH_BOOT__ = JSON.parse(node.textContent)
})()
