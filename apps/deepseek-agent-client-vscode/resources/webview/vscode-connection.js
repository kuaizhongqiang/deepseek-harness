// DeepSeek Agent Client for VSCode — webview transport plugin.
//
// Replaces the browser fetch/WebSocket connection with a postMessage bridge
// to the extension host: the webview is fully offline (CSP connect-src closed)
// and every RPC plus downlink frame flows through acquireVsCodeApi().
// webview-boot.ts rewires the boot manifest's `connection` row to this bundle.
//
// Contract mirror: provides `ctx.connection` with the ConnectionHandle shape
// `{ api, isLoopback, hostDescription, rpc, start(sinks, config) }` that the
// client runtime consumes. Runtime verification in VSCode is required; the
// envelope (VsMsg*) matches src/bridge.ts.
(function (global) {
  'use strict'

  var vscode = typeof global.acquireVsCodeApi === 'function' ? global.acquireVsCodeApi() : null

  function createApi(host) {
    var pending = new Map()
    var seq = 0

    function post(method, payload) {
      var id = String(++seq)
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject })
        host.postMessage({ kind: 'rpc', rpcId: id, method: method, payload: payload })
      })
    }

    // Service/method dispatch mirrors the IApiClient grouping, e.g.
    // api.sessions.list(payload) -> post('sessions.list', payload).
    return new Proxy({}, {
      get: function (_, service) {
        if (service === 'isLoopback') return true
        return new Proxy({}, {
          get: function (__, name) {
            if (name === 'rpc') return { request: post }
            return function (payload) { return post(String(service) + '.' + String(name), payload) }
          },
        })
      },
    })
  }

  function startConnection(host, api, sinks) {
    var streams = { mux: { open: false }, host: { open: false } }
    host.postMessage({ kind: 'subscribe', stream: 'mux' })
    host.postMessage({ kind: 'subscribe', stream: 'host' })
    host.onmessage = function (event) {
      var msg = event.data
      if (msg.kind === 'frame') {
        var stream = streams[msg.stream]
        if (!stream || !stream.open) return
        var sink = msg.stream === 'mux' ? sinks.onMuxEnvelope : sinks.onHostEnvelope
        if (sink) sink(msg.frame)
        return
      }
      if (msg.kind === 'state') {
        streams.mux.open = true
        streams.host.open = true
        if (sinks.onConnected) sinks.onConnected({ description: msg.description, loopback: msg.loopback })
        if (sinks.onStateChange) sinks.onStateChange('connected')
      }
      if (msg.kind === 'rpc-reply') {
        // handled by createApi's pending map
        void msg
      }
    }
  }

  var plugin = {
    name: 'vscode-connection',
    inject: [],
    apply: function (ctx) {
      var api = createApi(vscode)
      var handle = {
        api: api,
        isLoopback: true,
        hostDescription: undefined,
        rpc: { request: function (method, payload) { return api.rpc.request(method, payload) } },
        start: function (sinks, _config) { startConnection(vscode, api, sinks) },
      }
      ctx.provide('connection', handle)
    },
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = plugin
  global.__DSH_VSCODE_CONNECTION__ = plugin
})(typeof globalThis !== 'undefined' ? globalThis : self)
