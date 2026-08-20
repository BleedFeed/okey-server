'use strict'

const assert = require('assert')
const { spawn } = require('child_process')
const path = require('path')
const { io } = require('../client/node_modules/socket.io-client')

const URL = 'http://127.0.0.1:3000'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function once(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`${event} timeout`))
    }, timeout)
    const handler = value => {
      clearTimeout(timer)
      resolve(value)
    }
    socket.once(event, handler)
  })
}

function emitAck(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000)
    socket.emit(event, ...args, result => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

async function connect(name) {
  const socket = io(URL, {
    auth: { name },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  })
  await once(socket, 'connect')
  return socket
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, BOT_COUNT: '0', BOT_TURN_DELAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  server.stdout.on('data', chunk => { serverLog += chunk })
  server.stderr.on('data', chunk => { serverLog += chunk })
  const clients = []

  try {
    for (let i = 0; i < 40; i++) {
      if (serverLog.includes('Okey 101 server')) break
      if (server.exitCode != null) throw new Error(`server exited: ${serverLog}`)
      await delay(50)
    }
    assert(serverLog.includes('Okey 101 server'), `server did not start: ${serverLog}`)

    const a1 = await connect('A1'); clients.push(a1)
    const b1 = await connect('B1'); clients.push(b1)
    const aCreate = await emitAck(a1, 'create-table')
    const bCreate = await emitAck(b1, 'create-table')
    assert(aCreate.ok && bCreate.ok)
    assert.notStrictEqual(aCreate.table.id, bCreate.table.id)

    const a2 = await connect('A2'); clients.push(a2)
    const b2 = await connect('B2'); clients.push(b2)
    assert((await emitAck(a2, 'join-table', aCreate.table.id)).ok)
    assert((await emitAck(b2, 'join-table', bCreate.table.id)).ok)

    // Room isolation: chat and look from table A must never reach table B.
    let bChatLeak = 0
    let bLookLeak = 0
    b1.on('chat-message', () => { bChatLeak++ })
    b2.on('chat-message', () => { bChatLeak++ })
    b1.on('player-look', () => { bLookLeak++ })
    b2.on('player-look', () => { bLookLeak++ })

    const aChat = once(a2, 'chat-message')
    await emitAck(a1, 'chat-message', 'yalnız masa A')
    assert.strictEqual((await aChat).text, 'yalnız masa A')
    a1.emit('player-look', { x: 0.4, y: -0.2 })
    await delay(120)
    assert.strictEqual(bChatLeak, 0, 'chat leaked across rooms')
    assert.strictEqual(bLookLeak, 0, 'player-look leaked across rooms')

    // Last-seat race: with 3/4 players, exactly one of two simultaneous joins wins.
    const r1 = await connect('R1'); clients.push(r1)
    const raceCreate = await emitAck(r1, 'create-table')
    const r2 = await connect('R2'); clients.push(r2)
    const r3 = await connect('R3'); clients.push(r3)
    assert((await emitAck(r2, 'join-table', raceCreate.table.id)).ok)
    assert((await emitAck(r3, 'join-table', raceCreate.table.id)).ok)
    const r4 = await connect('R4'); clients.push(r4)
    const r5 = await connect('R5'); clients.push(r5)
    const [race4, race5] = await Promise.all([
      emitAck(r4, 'join-table', raceCreate.table.id),
      emitAck(r5, 'join-table', raceCreate.table.id),
    ])
    assert.strictEqual(Number(Boolean(race4.ok)) + Number(Boolean(race5.ok)), 1)

    // Start a 4-player table and ensure deal/game-state/SFX stay in that room.
    const winner = race4.ok ? r4 : r5
    const racePlayers = [r1, r2, r3, winner]
    let bSfxLeak = 0
    let bGameLeak = 0
    b1.on('game-sfx', () => { bSfxLeak++ })
    b1.on('game-state', () => { bGameLeak++ })
    await Promise.all(racePlayers.map(sock => emitAck(sock, 'set-ready', true)))
    await delay(220)
    assert.strictEqual(bSfxLeak, 0, 'game SFX leaked across rooms')
    assert.strictEqual(bGameLeak, 0, 'game-state leaked across rooms')

    const listAfterStart = await emitAck(b1, 'request-table-list')
    const raceSummary = listAfterStart.tables.find(t => t.id === raceCreate.table.id)
    assert(raceSummary)
    assert.strictEqual(raceSummary.phase, 'playing')
    assert.strictEqual(raceSummary.joinable, false)

    // Explicit leave uses a clean disconnect; remaining table survives, and
    // when its last human leaves the table disappears without touching B.
    const a1Disc = once(a1, 'disconnect')
    const leaveAck = await emitAck(a1, 'leave-table')
    assert(leaveAck.ok && leaveAck.reconnectRequired)
    await a1Disc
    await delay(120)
    let list = await emitAck(b1, 'request-table-list')
    assert(list.tables.some(t => t.id === aCreate.table.id), 'table A vanished with one human remaining')
    assert(list.tables.some(t => t.id === bCreate.table.id), 'table B was affected by table A leave')

    a2.disconnect()
    await delay(150)
    list = await emitAck(b1, 'request-table-list')
    assert(!list.tables.some(t => t.id === aCreate.table.id), 'empty table A was not cleaned up')
    assert(list.tables.some(t => t.id === bCreate.table.id), 'table B was removed by unrelated cleanup')

    console.log('MULTI TABLE tests: PASS')
  }
  finally {
    for (const client of clients) {
      try { client.disconnect() } catch {}
    }
    server.kill('SIGTERM')
    await delay(80)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
