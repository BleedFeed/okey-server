'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

function loadServerInternals() {
  const serverPath = path.join(__dirname, 'server.js')
  const source = fs.readFileSync(serverPath, 'utf8')
  const appendix = `
module.exports.__botV2Test = {
  players,
  createGame,
  createPlayerState,
  getJokerInfo,
  getBotRules,
  getBotContext,
  validateMeld,
  createTableMeld,
  attemptLayoff,
  attemptOpenMelds,
  botDiscard,
  executeBotTableAction,
  runBotTableActions,
  botV1,
  botV2,
  setGame(value) { game = value },
  getGame() { return game },
}
`
  const mod = new Module(serverPath, module)
  mod.filename = serverPath
  mod.paths = Module._nodeModulePaths(path.dirname(serverPath))
  mod._compile(source + appendix, serverPath)
  return mod.exports.__botV2Test
}

const T = loadServerInternals()
let idCounter = 5000

function normal(color, number, copy = 1, id = null) {
  return {
    id: id || `v2-${idCounter++}`,
    type: 'normal',
    color,
    number,
    copy,
  }
}

function fake(copy = 1, id = null) {
  return {
    id: id || `v2-${idCounter++}`,
    type: 'fake-joker',
    color: null,
    number: null,
    copy,
  }
}

function makePlayer(id, seat, options = {}) {
  const player = T.createPlayerState(id, options.name || id, seat, Boolean(options.isBot))
  Object.assign(player, options)
  return player
}

function setup(options = {}) {
  T.players.clear()
  const game = T.createGame()
  game.phase = 'playing'
  game.round = 1
  game.currentSeat = 'player-bottom'
  game.starterSeat = 'player-bottom'
  game.dealerSeat = 'player-left'
  game.turnCounter = 1
  game.indicator = options.indicator || normal('yellow', 11, 1, 'v2-indicator')
  game.joker = T.getJokerInfo(game.indicator)
  game.stock = options.stock || Array.from(
    { length: 20 },
    (_, index) => normal('yellow', (index % 13) + 1, 1, `stock-${idCounter++}`)
  )
  game.discardPile = []
  game.tableMelds = []
  game.pairOpens = []
  T.setGame(game)

  const bot = makePlayer('bot', 'player-bottom', { isBot: true, name: 'BOT V2' })
  const right = makePlayer('right', 'player-right')
  const top = makePlayer('top', 'player-top')
  const left = makePlayer('left', 'player-left')
  right.hand = Array(21).fill(null)
  top.hand = Array(21).fill(null)
  left.hand = Array(21).fill(null)

  for (const player of [bot, right, top, left]) T.players.set(player.id, player)
  return { game, bot, right, top, left }
}

function meld(owner, tiles) {
  const validation = T.validateMeld(tiles, T.getGame().joker)
  assert(validation, 'Test perinin kendisi legal olmalı')
  return T.createTableMeld(owner, tiles, validation)
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

test('Server: açılmış oyuncu da yandan aldığı taşı önce kullanmak zorunda', () => {
  const { bot, right, game } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  bot.turnHasAcquiredTile = true
  right.opened = true
  right.openType = 'normal'

  game.tableMelds = [meld(right, [
    normal('red', 5), normal('red', 6), normal('red', 7),
  ])]

  const picked = normal('red', 8, 1, 'mandatory-red-8')
  const unrelated = normal('red', 4, 1, 'unrelated-red-4')
  bot.hand = [picked, unrelated, normal('yellow', 13)]
  bot.pickedDiscardId = picked.id
  bot.pickedDiscardSourceId = leftId(game) || 'left'
  bot.pickedDiscardRequiresOpening = true

  const unrelatedResult = T.attemptLayoff(bot, unrelated.id, 0)
  assert.strictEqual(unrelatedResult.ok, false)
  assert.match(unrelatedResult.message, /Yandan aldığın taşı/)

  const pickedResult = T.attemptLayoff(bot, picked.id, 0)
  assert.strictEqual(pickedResult.ok, true)
  assert.strictEqual(bot.pickedDiscardId, null)
})

function leftId() {
  return 'left'
}

test('Server: yandan taş kullanılmadan discard ile tur kapatılamıyor', () => {
  const { bot } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  const picked = normal('blue', 8, 1, 'picked-blue-8')
  const discard = normal('yellow', 13, 1, 'other-discard')
  bot.hand = [picked, discard]
  bot.pickedDiscardId = picked.id
  bot.pickedDiscardSourceId = 'left'
  bot.pickedDiscardRequiresOpening = true

  const result = T.botDiscard(bot, discard.id)
  assert.strictEqual(result.ok, false)
  assert.match(result.message, /yandan aldığı taşı kullanmadı/i)
})

test('Kaynak x10 cezası: yandan taşla İLK açılışta uygulanıyor', () => {
  const { bot, left } = setup()
  bot.mustDiscard = true
  bot.turnHasAcquiredTile = true
  const pickup = normal('black', 10, 1, 'first-open-pickup')
  bot.hand = [
    normal('red', 13), normal('blue', 13), normal('black', 13),
    normal('red', 12), normal('blue', 12), normal('black', 12),
    normal('red', 10), normal('blue', 10), pickup,
    normal('yellow', 2),
  ]
  bot.pickedDiscardId = pickup.id
  bot.pickedDiscardSourceId = left.id
  bot.pickedDiscardRequiresOpening = true

  const action = T.botV1.chooseNextTableAction({
    ...T.getBotContext(bot),
    openingPolicy: { allowOpening: true },
  })
  assert(action)
  assert.strictEqual(action.type, 'open-melds')
  const result = T.attemptOpenMelds(bot, action.groups)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(left.penalty, 100)
})

test('Kaynak x10 cezası: daha önce açmış oyuncunun sonraki yandan alışında YOK', () => {
  const { bot, right, left, game } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  bot.turnHasAcquiredTile = true
  right.opened = true
  right.openType = 'normal'
  game.tableMelds = [meld(right, [
    normal('red', 5), normal('red', 6), normal('red', 7),
  ])]

  const pickup = normal('red', 8, 1, 'later-pickup-red-8')
  bot.hand = [pickup, normal('yellow', 13)]
  bot.pickedDiscardId = pickup.id
  bot.pickedDiscardSourceId = left.id
  bot.pickedDiscardRequiresOpening = true

  const result = T.attemptLayoff(bot, pickup.id, 0)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(left.penalty, 0)
})

test('V2 greedy düzeltmesi: tek layoff yerine üçlü yeni peri indiriyor', () => {
  const { bot, top, game } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  top.opened = true
  top.openType = 'normal'
  game.tableMelds = [meld(top, [
    normal('red', 8), normal('red', 9), normal('red', 10),
  ])]

  const red7 = normal('red', 7, 1, 'greedy-red-7')
  const blue7 = normal('blue', 7, 1, 'greedy-blue-7')
  const black7 = normal('black', 7, 1, 'greedy-black-7')
  bot.hand = [red7, blue7, black7, normal('yellow', 1)]

  const v1 = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  const v2 = T.botV2.chooseNextTableAction(T.getBotContext(bot))
  assert.strictEqual(v1.type, 'layoff')
  assert.strictEqual(v2.type, 'open-melds')
  assert.deepStrictEqual(new Set(v2.groups.flat()), new Set([red7.id, blue7.id, black7.id]))
})

test('V2 okey planı: doğal taşı koyup aldığı okeyle aynı tur yeni per kurabiliyor', () => {
  const { bot, top, game } = setup({
    indicator: normal('red', 1, 1, 'replace-indicator-red-1'),
  })
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  bot.turnHasAcquiredTile = true
  top.opened = true
  top.openType = 'normal'

  const jokerTile = normal('red', 2, 1, 'table-real-joker')
  game.tableMelds = [meld(top, [
    normal('red', 12), normal('blue', 12), normal('black', 12), jokerTile,
  ])]

  const replacement = normal('yellow', 12, 1, 'natural-yellow-12')
  bot.hand = [
    replacement,
    normal('blue', 3, 1, 'blue-3'),
    normal('black', 3, 1, 'black-3'),
    normal('yellow', 9, 1, 'final-discard-9'),
  ]

  const first = T.botV2.chooseNextTableAction(T.getBotContext(bot))
  assert(first)
  assert.strictEqual(first.type, 'replace-joker-meld')

  const result = T.runBotTableActions(bot)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(bot.hand.length, 1)
  assert.strictEqual(bot.hand[0].id, 'final-discard-9')
})

test('Adaptif açılış: gelişme ihtimali yoksa 101 hazırken hemen açıyor', () => {
  const { bot } = setup()
  bot.mustDiscard = true
  bot.turnHasAcquiredTile = true
  bot.hand = [
    normal('red', 13), normal('blue', 13), normal('black', 13),
    normal('red', 12), normal('blue', 12), normal('black', 12),
    normal('red', 11), normal('blue', 11), normal('black', 11),
    normal('yellow', 2),
  ]

  const decision = T.botV2.evaluateOpeningPolicy(T.getBotContext(bot))
  assert.strictEqual(decision.legalOpening, true)
  assert.strictEqual(decision.allowOpening, true)
  assert.strictEqual(decision.reason, 'open-now')
})

test('Adaptif açılış: anlamlı tek-çekiş gelişmesi varsa yalnız bir tur bekleyebiliyor', () => {
  const { bot, game } = setup({
    indicator: normal('blue', 5, 1, 'wait-indicator-blue-5'),
  })
  game.stock = Array.from({ length: 20 }, (_, i) => normal('yellow', 1, 1, `wait-stock-${i}`))
  bot.mustDiscard = true
  bot.turnHasAcquiredTile = true
  bot.hand = [
    normal('blue', 12, 1), normal('red', 2, 1), normal('red', 1, 1),
    normal('red', 7, 2), normal('blue', 4, 1), normal('red', 3, 2),
    normal('yellow', 5, 2), normal('black', 6, 1), normal('yellow', 3, 1),
    normal('blue', 10, 1), normal('red', 2, 2), normal('yellow', 10, 2),
    normal('red', 8, 2), normal('yellow', 12, 1), normal('red', 6, 1),
    normal('blue', 2, 1), fake(1), normal('blue', 7, 1),
    normal('red', 1, 2), normal('blue', 5, 2), normal('blue', 2, 2),
    normal('blue', 6, 1),
  ]

  let decision = T.botV2.evaluateOpeningPolicy(T.getBotContext(bot))
  assert.strictEqual(decision.legalOpening, true)
  assert.strictEqual(decision.allowOpening, false)
  assert.strictEqual(decision.reason, 'one-draw-improvement')
  assert(decision.strongDrawChance >= 0.18)

  bot.botOpeningWaitCount = 1
  decision = T.botV2.evaluateOpeningPolicy(T.getBotContext(bot))
  assert.strictEqual(decision.allowOpening, true)
  assert.strictEqual(decision.reason, 'max-wait-reached')
})

test('Adaptif açılış: stock/rakip baskısında beklemiyor', () => {
  const { bot, game, right } = setup()
  game.stock = Array.from({ length: 6 }, (_, i) => normal('yellow', 1, 1, `low-stock-${i}`))
  right.hand = Array(6).fill(null)
  bot.mustDiscard = true
  bot.turnHasAcquiredTile = true
  bot.hand = [
    normal('red', 13), normal('blue', 13), normal('black', 13),
    normal('red', 12), normal('blue', 12), normal('black', 12),
    normal('red', 11), normal('blue', 11), normal('black', 11),
    normal('yellow', 2),
  ]
  const decision = T.botV2.evaluateOpeningPolicy(T.getBotContext(bot))
  assert.strictEqual(decision.legalOpening, true)
  assert.strictEqual(decision.allowOpening, true)
  assert.strictEqual(decision.reason, 'table-pressure')
})

test('V2 yandan alma: açılmış olsa bile yalnız bu tur kullanabileceği taşı alıyor', () => {
  const { bot, top, game } = setup()
  bot.opened = true
  bot.openType = 'normal'
  top.opened = true
  top.openType = 'normal'
  game.tableMelds = [meld(top, [
    normal('black', 5), normal('black', 6), normal('black', 7),
  ])]
  bot.hand = [normal('red', 1), normal('yellow', 13)]

  const useful = normal('black', 8, 1, 'useful-pickup')
  const dead = normal('yellow', 6, 1, 'dead-pickup')
  assert.strictEqual(T.botV2.canUsePickup(T.getBotContext(bot), useful), true)
  assert.strictEqual(T.botV2.canUsePickup(T.getBotContext(bot), dead), false)
})


test('V2 yüksek discard güvenliği: açmamış rakibe ölü 10 yerine ölü 4 atıyor', () => {
  const { bot, right, game } = setup()
  right.opened = false
  game.stock = Array(20).fill(null)
  bot.hand = [
    normal('red', 4, 1, 'v2-safe-dead-4'),
    normal('blue', 10, 1, 'v2-danger-dead-10'),
  ]

  const discard = T.botV2.chooseDiscard(T.getBotContext(bot))
  assert(discard)
  assert.strictEqual(discard.id, 'v2-safe-dead-4')
})

test('V2 yüksek discard güvenliği: tamamlanmış düşük runı sırf yüksek taşı korumak için bozmuyor', () => {
  const { bot, right, game } = setup()
  right.opened = false
  game.stock = Array(20).fill(null)
  bot.hand = [
    normal('yellow', 2, 1, 'v2-run-2'),
    normal('yellow', 3, 1, 'v2-run-3'),
    normal('yellow', 4, 1, 'v2-run-4'),
    normal('blue', 10, 1, 'v2-dead-10'),
  ]

  const discard = T.botV2.chooseDiscard(T.getBotContext(bot))
  assert(discard)
  assert.strictEqual(discard.id, 'v2-dead-10')
})

test('V2 yüksek discard güvenliği: sıradaki rakip açtıysa 10u gereksiz korumuyor', () => {
  const { bot, right, game } = setup()
  right.opened = true
  right.openType = 'normal'
  game.stock = Array(20).fill(null)
  bot.hand = [
    normal('red', 4, 1, 'v2-opened-4'),
    normal('blue', 10, 1, 'v2-opened-10'),
  ]

  const discard = T.botV2.chooseDiscard(T.getBotContext(bot))
  assert(discard)
  assert.strictEqual(discard.id, 'v2-opened-10')
})

let passed = 0
const failures = []
for (const { name, fn } of tests) {
  try {
    fn()
    passed++
    console.log(`PASS  ${name}`)
  }
  catch (error) {
    failures.push({ name, error })
    console.error(`FAIL  ${name}`)
    console.error(error.stack || error)
  }
}

console.log(`\nBOT V2 / server tests: ${passed}/${tests.length} passed`)
setImmediate(() => process.exit(failures.length ? 1 : 0))
