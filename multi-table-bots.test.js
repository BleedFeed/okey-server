'use strict'

const assert = require('assert')
const { spawn } = require('child_process')
const { io } = require('../client/node_modules/socket.io-client')

const URL = 'http://127.0.0.1:3000'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function once(socket, event, timeout = 3500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), timeout)
    socket.once(event, value => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

function emitAck(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3500)
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
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      BOT_COUNT: '3',
      BOT_TURN_DELAY_MS: '5',
      BOT_DECISION_DELAY_MS: '5',
      BOT_OPENING_CAMERA_LEAD_MS: '5',
      BOT_OPENING_GROUP_DELAY_MS: '120',
      BOT_TABLE_ACTION_DELAY_MS: '5',
      BOT_BEFORE_DISCARD_DELAY_MS: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', c => { log += c })
  child.stderr.on('data', c => { log += c })
  const sockets = []

  try {
    for (let i = 0; i < 50 && !log.includes('Okey 101 server'); i++) await wait(40)
    assert(log.includes('Okey 101 server'), log)

    const a = await connect('BotTableA'); sockets.push(a)
    const b = await connect('BotTableB'); sockets.push(b)
    const ta = await emitAck(a, 'create-table')
    const tb = await emitAck(b, 'create-table')
    assert(ta.ok && tb.ok)
    assert.strictEqual(ta.table.playerCount, 4)
    assert.strictEqual(tb.table.playerCount, 4)

    let bGameEventsAfterStart = 0
    let bSfxAfterStart = 0
    b.on('game-state', () => { bGameEventsAfterStart++ })
    b.on('game-sfx', () => { bSfxAfterStart++ })

    const ready = await emitAck(a, 'set-ready', true)
    assert(ready.ok)
    await wait(700)

    const list = await emitAck(b, 'request-table-list')
    const aSummary = list.tables.find(t => t.id === ta.table.id)
    const bSummary = list.tables.find(t => t.id === tb.table.id)
    assert(aSummary && bSummary)
    assert.strictEqual(aSummary.phase, 'playing')
    assert.strictEqual(bSummary.phase, 'waiting')
    assert.strictEqual(bGameEventsAfterStart, 0, 'bot game-state leaked into idle table')
    assert.strictEqual(bSfxAfterStart, 0, 'bot SFX leaked into idle table')

    console.log('MULTI TABLE BOT isolation: PASS')
  }
  finally {
    for (const socket of sockets) socket.disconnect()
    child.kill('SIGTERM')
    await wait(80)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
