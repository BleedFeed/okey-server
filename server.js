const express = require('express')
const http = require('http')
const cors = require('cors')
const { Server } = require('socket.io')
const { randomInt } = require('crypto')
const tableEngine = require('./table-engine')

const PORT = 3000
const MAX_TABLES = Math.max(4, Number.parseInt(process.env.MAX_TABLES || '40', 10) || 100)
const CREATE_TABLE_RATE_LIMIT_MS = Math.max(
  500,
  Number.parseInt(process.env.CREATE_TABLE_RATE_LIMIT_MS || '1200', 10) || 1200
)

const app = express()
app.use(cors())
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})

const tables = new Map()
let tableSerial = randomInt(1000, 9000)
let tableListBroadcastQueued = false

function nextTableId() {
  for (let attempt = 0; attempt < 10000; attempt++) {
    tableSerial = tableSerial >= 9999 ? 1000 : tableSerial + 1
    const id = String(tableSerial)
    if (!tables.has(id)) return id
  }
  return String(Date.now())
}

function getTableList() {
  return [...tables.values()]
    .filter(runtime => !runtime.isDestroyed())
    .map(runtime => runtime.getSummary())
    .filter(summary => summary.humanCount > 0)
    .sort((a, b) => {
      if (a.joinable !== b.joinable) return a.joinable ? -1 : 1
      if (a.phase !== b.phase) return a.phase === 'waiting' ? -1 : 1
      return Number(a.id) - Number(b.id)
    })
}

function broadcastTableList() {
  io.emit('table-list', getTableList())
}

function queueTableListBroadcast() {
  if (tableListBroadcastQueued) return
  tableListBroadcastQueued = true
  setImmediate(() => {
    tableListBroadcastQueued = false
    cleanupEmptyTables()
    broadcastTableList()
  })
}

function cleanupEmptyTables() {
  for (const [id, runtime] of tables) {
    if (runtime.isDestroyed()) {
      tables.delete(id)
      continue
    }

    if (!runtime.hasHumanPlayers()) {
      runtime.destroy()
      tables.delete(id)
    }
  }
}

function createRuntime(tableId) {
  const runtime = tableEngine.createTableRuntime(io, tableId, {
    onStateChanged: queueTableListBroadcast,
  })
  tables.set(String(tableId), runtime)
  return runtime
}

function attachSocketToRuntime(socket, runtime) {
  if (socket.data.tableId) {
    return {
      ok: false,
      message: 'Zaten bir masadasın.',
    }
  }

  if (!runtime || runtime.isDestroyed()) {
    return {
      ok: false,
      message: 'Masa artık mevcut değil.',
    }
  }

  if (!runtime.canJoin()) {
    return {
      ok: false,
      message: runtime.getSummary().phase === 'waiting'
        ? 'Masa dolu.'
        : 'Bu masada oyun başladı.',
    }
  }

  // Server-side join check and room membership happen synchronously before the
  // engine creates the player, preventing two simultaneous 3/4 join requests
  // from both claiming the last seat.
  socket.data.tableId = runtime.id
  socket.join(runtime.roomName)

  const attached = runtime.attachSocket(socket)
  if (!attached) {
    socket.leave(runtime.roomName)
    socket.data.tableId = null
    return {
      ok: false,
      message: 'Masaya katılınamadı.',
    }
  }

  queueTableListBroadcast()
  return {
    ok: true,
    table: runtime.getSummary(),
  }
}

io.on('connection', socket => {
  socket.data.tableId = null
  socket.data.lastTableCreateAt = 0

  socket.emit('table-list', getTableList())

  socket.on('request-table-list', callback => {
    callback?.({ ok: true, tables: getTableList() })
  })

  socket.on('create-table', callback => {
    if (socket.data.tableId) {
      callback?.({ ok: false, message: 'Zaten bir masadasın.' })
      return
    }

    const now = Date.now()
    if (now - socket.data.lastTableCreateAt < CREATE_TABLE_RATE_LIMIT_MS) {
      callback?.({ ok: false, message: 'Yeni masa açmak için kısa bir an bekle.' })
      return
    }
    socket.data.lastTableCreateAt = now

    cleanupEmptyTables()
    if (tables.size >= MAX_TABLES) {
      callback?.({ ok: false, message: 'Şu anda yeni masa açılamıyor. Bir masanın boşalmasını bekle.' })
      return
    }

    const tableId = nextTableId()
    const runtime = createRuntime(tableId)
    const result = attachSocketToRuntime(socket, runtime)

    if (!result.ok) {
      runtime.destroy()
      tables.delete(tableId)
    }

    callback?.(result)
    queueTableListBroadcast()
  })

  socket.on('join-table', (rawTableId, callback) => {
    if (socket.data.tableId) {
      callback?.({ ok: false, message: 'Zaten bir masadasın.' })
      return
    }

    const tableId = String(rawTableId || '').trim()
    const runtime = tables.get(tableId)
    const result = attachSocketToRuntime(socket, runtime)
    callback?.(result)
    queueTableListBroadcast()
  })

  // Runtime listeners are intentionally tied to one Socket.IO connection.
  // Returning to the browser therefore uses a clean reconnect, which removes
  // every table-specific listener and room membership in one atomic lifecycle.
  // This avoids stale handlers firing after table A -> browser -> table B.
  socket.on('leave-table', callback => {
    if (!socket.data.tableId) {
      callback?.({ ok: true, alreadyInBrowser: true })
      return
    }

    callback?.({ ok: true, reconnectRequired: true })
    setTimeout(() => {
      if (socket.connected) socket.disconnect(true)
    }, 25)
  })

  socket.on('disconnect', () => {
    // Table runtime's disconnect handler removes the player. Run cleanup after
    // all disconnect listeners for this socket have had a chance to execute.
    setImmediate(() => {
      cleanupEmptyTables()
      queueTableListBroadcast()
    })
  })
})

app.get('/', (req, res) => {
  res.send('3D Okey 101 çoklu masa sunucusu çalışıyor.')
})

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    tables: getTableList().length,
    connectedSockets: io.engine.clientsCount,
  })
})

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Okey 101 server: http://localhost:${PORT}`)
  })
}

// Existing rule/bot tests import server.js. Keep the same pure rule API while
// the live transport now uses independent table runtimes.
module.exports = {
  ...tableEngine,
  getTableList,
}
