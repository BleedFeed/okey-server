'use strict'

// Lightweight repeatable V1/V2 comparison. This is not used by the game at
// runtime; it exists so future bot changes can be measured against the same
// public-information scenarios instead of being judged by feel alone.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

function loadServerForBenchmark() {
  const serverPath = path.join(__dirname, 'server.js')
  const source = fs.readFileSync(serverPath, 'utf8')
  const appendix = `\nmodule.exports.__bench = {\n    players, createGame, createPlayerState, createDeck, getJokerInfo,\n    getBotRules, getBotContext, createTableMeld, validateMeld, setGame(v){game=v},\n    botV1, botV2\n  };\n`
  const mod = new Module(serverPath, module)
  mod.filename = serverPath
  mod.paths = Module._nodeModulePaths(__dirname)
  mod._compile(source + appendix, serverPath)
  return mod.exports.__bench
}

const T = loadServerForBenchmark()
const COLORS = ['red', 'blue', 'black', 'yellow']

function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function seededShuffle(array, random) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[array[i], array[j]] = [array[j], array[i]]
  }
  return array
}

let syntheticId = 1
function normal(color, number, copy = 1, id = null) {
  return { id: id || `bench-${syntheticId++}`, type: 'normal', color, number, copy }
}

function setupBase(seed = 1) {
  T.players.clear()
  const game = T.createGame()
  game.phase = 'playing'
  game.currentSeat = 'player-bottom'
  game.turnCounter = 1
  game.indicator = normal('yellow', 1, 1, `indicator-${seed}`)
  game.joker = T.getJokerInfo(game.indicator)
  game.stock = []
  game.discardPile = []
  game.tableMelds = []
  game.pairOpens = []
  T.setGame(game)

  const bot = T.createPlayerState(`bot-${seed}`, 'BOT', 'player-bottom', true)
  const right = T.createPlayerState(`right-${seed}`, 'RIGHT', 'player-right', false)
  const top = T.createPlayerState(`top-${seed}`, 'TOP', 'player-top', false)
  const left = T.createPlayerState(`left-${seed}`, 'LEFT', 'player-left', false)
  for (const player of [bot, right, top, left]) T.players.set(player.id, player)
  return { game, bot, right, top, left }
}

function createMeld(owner, tiles) {
  const validation = T.validateMeld(tiles, T.getBotContext(owner).rules?.joker)
    || T.getBotRules(owner).validateMeld(tiles)
  assert(validation)
  return T.createTableMeld(owner, tiles, validation)
}

function percentile(values, q) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]
}

function greedyComparison() {
  const { game, bot, top } = setupBase(100)
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  top.opened = true
  top.openType = 'normal'
  const run = [normal('red', 8), normal('red', 9), normal('red', 10)]
  const validation = T.getBotRules(bot).validateMeld(run)
  game.tableMelds = [T.createTableMeld(top, run, validation)]
  const red7 = normal('red', 7, 1, 'greedy-red-7')
  const blue7 = normal('blue', 7, 1, 'greedy-blue-7')
  const black7 = normal('black', 7, 1, 'greedy-black-7')
  bot.hand = [red7, blue7, black7, normal('yellow', 1)]
  const context = T.getBotContext(bot)
  return {
    v1: T.botV1.chooseNextTableAction(context),
    v2: T.botV2.chooseNextTableAction(context),
    v2Plan: T.botV2.searchBestTurn(context),
  }
}

function openingAgreement(samples = 300) {
  let legal = 0
  let disagreements = 0
  for (let sample = 0; sample < samples; sample++) {
    const random = rng(1000 + sample)
    const deck = seededShuffle(T.createDeck(), random)
    const indicatorIndex = deck.findIndex(tile => tile.type === 'normal')
    const indicator = deck.splice(indicatorIndex, 1)[0]
    const { game, bot } = setupBase(2000 + sample)
    game.indicator = indicator
    game.joker = T.getJokerInfo(indicator)
    game.stock = deck.slice(0, 20)
    bot.hand = deck.slice(20, 42)
    bot.mustDiscard = true
    bot.turnHasAcquiredTile = true
    const context = T.getBotContext(bot)
    const v1Action = T.botV1.chooseNextTableAction({
      ...context,
      openingPolicy: { allowOpening: true },
    })
    const v2Decision = T.botV2.evaluateOpeningPolicy(context)
    if (v1Action) legal++
    if (Boolean(v1Action) !== Boolean(v2Decision.legalOpening)) disagreements++
  }
  return { samples, legal, disagreements }
}

function performanceComparison(samples = 30) {
  const v1 = []
  const v2 = []
  for (let sample = 0; sample < samples; sample++) {
    const random = rng(5000 + sample)
    const deck = seededShuffle(T.createDeck(), random)
    const { game, bot, right, top, left } = setupBase(6000 + sample)
    bot.opened = true
    bot.openType = 'normal'
    bot.mustDiscard = true
    bot.turnHasAcquiredTile = true
    bot.hand = deck.splice(0, 22)
    for (const opponent of [right, top, left]) {
      opponent.opened = true
      opponent.openType = 'normal'
      opponent.hand = deck.splice(0, 7)
    }
    game.stock = deck.slice(0, Math.min(20, deck.length))

    let publicId = 0
    for (let i = 0; i < 6; i++) {
      const color = COLORS[i % COLORS.length]
      const start = 1 + ((sample * 3 + i * 2) % 10)
      const tiles = [start, start + 1, start + 2].map(number =>
        normal(color, number, 1, `pub-${sample}-${publicId++}`)
      )
      const validation = T.getBotRules(bot).validateMeld(tiles)
      if (validation) {
        game.tableMelds.push(T.createTableMeld([right, top, left][i % 3], tiles, validation))
      }
    }

    const context = T.getBotContext(bot)
    let started = process.hrtime.bigint()
    T.botV1.chooseNextTableAction(context)
    v1.push(Number(process.hrtime.bigint() - started) / 1e6)
    started = process.hrtime.bigint()
    T.botV2.chooseNextTableAction(context)
    v2.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  return {
    samples,
    v1_ms: { p50: percentile(v1, 0.50), p95: percentile(v1, 0.95), max: Math.max(...v1) },
    v2_ms: { p50: percentile(v2, 0.50), p95: percentile(v2, 0.95), max: Math.max(...v2) },
  }
}

const greedy = greedyComparison()
assert.strictEqual(greedy.v1?.type, 'layoff')
assert.strictEqual(greedy.v2?.type, 'open-melds')
assert((greedy.v2Plan?.metrics?.removedCount || 0) >= 3)

const opening = openingAgreement()
assert.strictEqual(opening.disagreements, 0)

const performance = performanceComparison()

console.log(JSON.stringify({
  greedy: {
    v1_first_action: greedy.v1?.type || null,
    v2_first_action: greedy.v2?.type || null,
    v2_planned_removed_tiles: greedy.v2Plan?.metrics?.removedCount || 0,
  },
  opening,
  performance,
}, null, 2))
process.exit(0)
