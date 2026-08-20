'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

function loadServerInternals() {
  const serverPath = path.join(__dirname, 'server.js')
  const source = fs.readFileSync(serverPath, 'utf8')
  const appendix = `
module.exports.__botTest = {
  SEATS,
  players,
  createGame,
  createPlayerState,
  getJokerInfo,
  validateMeld,
  validatePair,
  createTableMeld,
  getBotRules,
  getBotContext,
  runBotTableActions,
  executeBotTableAction,
  botCanTakeDiscard,
  botDiscard,
  attemptLayoff,
  allPlayersOpenedPairs,
  setGame(value) { game = value },
  getGame() { return game },
  botV1,
}
`

  const mod = new Module(serverPath, module)
  mod.filename = serverPath
  mod.paths = Module._nodeModulePaths(path.dirname(serverPath))
  mod._compile(source + appendix, serverPath)
  return mod.exports.__botTest
}

const T = loadServerInternals()
let tileCounter = 1000

function normal(color, number, copy = 1, id = null) {
  return {
    id: id || `test-${tileCounter++}`,
    type: 'normal',
    color,
    number,
    copy,
  }
}

function fake(copy = 1, id = null) {
  return {
    id: id || `test-${tileCounter++}`,
    type: 'fake-joker',
    color: null,
    number: null,
    copy,
  }
}

function makePlayer(id, seat, options = {}) {
  const player = T.createPlayerState(
    id,
    options.name || id,
    seat,
    Boolean(options.isBot)
  )

  Object.assign(player, options)
  return player
}

function setup(options = {}) {
  T.players.clear()

  const game = T.createGame()
  game.phase = 'playing'
  game.round = 1
  game.maxRounds = 5
  game.currentSeat = 'player-bottom'
  game.starterSeat = 'player-bottom'
  game.dealerSeat = 'player-left'
  game.indicator = options.indicator || normal('yellow', 11, 1, 'indicator')
  game.joker = options.joker || T.getJokerInfo(game.indicator)
  game.stock = options.stock || []
  game.discardPile = options.discardPile || []
  game.tableMelds = []
  game.pairOpens = []
  game.turnCounter = 1
  T.setGame(game)

  const bot = makePlayer('bot', 'player-bottom', {
    isBot: true,
    name: 'BOT TEST',
  })
  const right = makePlayer('right', 'player-right')
  const top = makePlayer('top', 'player-top')
  const left = makePlayer('left', 'player-left')

  for (const player of [bot, right, top, left]) {
    T.players.set(player.id, player)
  }

  return {
    game,
    bot,
    right,
    top,
    left,
    rules: T.getBotRules(),
  }
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

function actionContains(action, tileId) {
  if (!action) return false
  if (action.type === 'layoff') return action.tileId === tileId
  if (action.type === 'layoff-pair') return action.tileIds.includes(tileId)
  return action.groups?.flat().includes(tileId) || false
}

test('101 açılışı: legal perleri bulup >=101 açıyor', () => {
  const { bot, rules } = setup()
  bot.hand = [
    normal('red', 13), normal('blue', 13), normal('black', 13),
    normal('red', 12), normal('blue', 12), normal('black', 12),
    normal('red', 11), normal('blue', 11), normal('black', 11),
    normal('yellow', 2),
  ]

  const plan = T.botV1.findOpeningMeldPlan(bot.hand, rules)
  assert(plan)
  assert(plan.score >= 101)
  assert(plan.usedCount < bot.hand.length)
})

test('Yandan taş: yalnız o taş 101 açılışında kullanılabiliyorsa alıyor', () => {
  const { bot, rules, game, left } = setup()
  bot.hand = [
    normal('red', 13), normal('blue', 13), normal('black', 13),
    normal('red', 12), normal('blue', 12), normal('black', 12),
    normal('red', 10), normal('blue', 10),
    normal('yellow', 1), normal('yellow', 4), normal('yellow', 7),
  ]
  const pickup = normal('black', 10, 1, 'pickup-101')
  game.discardPile = [pickup]
  game.lastDiscardOwnerId = left.id
  game.lastDiscardOwnerSeat = left.seat

  assert.strictEqual(
    T.botV1.findOpeningMeldPlan(bot.hand, rules),
    null
  )
  assert.strictEqual(
    T.botV1.canUsePickup(T.getBotContext(bot), pickup),
    true
  )
  assert.strictEqual(T.botCanTakeDiscard(bot), true)
})

test('Yandan taş: 5. çifti tamamlıyorsa discardı alabiliyor', () => {
  const { bot, game, left } = setup()
  bot.hand = [
    normal('red', 1, 1), normal('red', 1, 2),
    normal('blue', 3, 1), normal('blue', 3, 2),
    normal('black', 5, 1), normal('black', 5, 2),
    normal('yellow', 7, 1), normal('yellow', 7, 2),
    normal('red', 9, 1, 'pair-half'),
    normal('blue', 12), normal('yellow', 13),
  ]
  const pickup = normal('red', 9, 2, 'pickup-pair')
  game.discardPile = [pickup]
  game.lastDiscardOwnerId = left.id
  game.lastDiscardOwnerSeat = left.seat

  assert.strictEqual(
    T.botV1.canUsePickup(T.getBotContext(bot), pickup),
    true
  )
})

test('Yandan taş: hemen legal kullanımı yoksa almıyor', () => {
  const { bot, game, left } = setup()
  bot.hand = [
    normal('red', 1), normal('blue', 4), normal('black', 7),
    normal('yellow', 10), normal('red', 13), normal('blue', 2),
  ]
  const pickup = normal('yellow', 6, 1, 'dead-pickup')
  game.discardPile = [pickup]
  game.lastDiscardOwnerId = left.id
  game.lastDiscardOwnerSeat = left.seat

  assert.strictEqual(T.botCanTakeDiscard(bot), false)
})

test('Gösterge-eşi: bot 4 doğal çift + eldeki ikinci gösterge taşıyla 5 çift planlayabiliyor', () => {
  const indicator = normal('blue', 5, 1, 'indicator-center-blue-5')
  const { bot } = setup({ indicator })
  const indicatorTwin = normal('blue', 5, 2, 'indicator-twin-blue-5')
  const wildcardMate = normal('red', 12, 1, 'indicator-pair-mate')

  bot.hand = [
    normal('red', 1, 1), normal('red', 1, 2),
    normal('blue', 3, 1), normal('blue', 3, 2),
    normal('black', 7, 1), normal('black', 7, 2),
    normal('yellow', 9, 1), normal('yellow', 9, 2),
    indicatorTwin, wildcardMate,
    normal('black', 13, 1, 'discard-after-indicator-pairs'),
  ]

  bot.mustDiscard = true
  bot.turnHasAcquiredTile = true

  // Production bot context'i oyuncuyu getBotRules'e geçirir; böylece yalnız
  // eldeki ikinci gösterge taşı özel çift jokeri olarak değerlendirilebilir.
  const action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert(action, 'Bot gösterge-eşi özel çiftiyle açılış aksiyonu bulmalı')
  assert.strictEqual(action.type, 'open-pairs')
  assert.strictEqual(action.groups.length >= 5, true)

  const indicatorTwinGroup = action.groups.find(group =>
    group.includes(indicatorTwin.id)
  )
  assert(indicatorTwinGroup, 'Plan eldeki ikinci gösterge taşını kullanmalı')
  assert.strictEqual(indicatorTwinGroup.length, 2)

  const indicatorTwinMateId = indicatorTwinGroup.find(id => id !== indicatorTwin.id)
  const indicatorTwinMate = bot.hand.find(tile => tile.id === indicatorTwinMateId)
  assert(indicatorTwinMate, 'Gösterge-eşinin bot planındaki eşi elde bulunmalı')
  assert.notStrictEqual(
    `${indicatorTwinMate.color}:${indicatorTwinMate.number}`,
    `${indicatorTwin.color}:${indicatorTwin.number}`,
    'Bot özel hakkı gerçek doğal çift yerine herhangi bir tek taşla kullanabilmeli'
  )
  assert.strictEqual(
    action.groups.flat().includes(indicator.id),
    false,
    'Ortadaki açık gösterge hiçbir bot planına girmemeli'
  )

  const result = T.executeBotTableAction(bot, action)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.indicatorUsed, true)
  assert.strictEqual(bot.opened, true)
  assert.strictEqual(bot.openType, 'pairs')
})

test('5 çift açılışı: en az 5 disjoint çift ve bir discard bırakıyor', () => {
  const { bot, rules } = setup()
  bot.hand = [
    normal('red', 1, 1), normal('red', 1, 2),
    normal('blue', 2, 1), normal('blue', 2, 2),
    normal('black', 3, 1), normal('black', 3, 2),
    normal('yellow', 4, 1), normal('yellow', 4, 2),
    normal('red', 5, 1), normal('red', 5, 2),
    normal('blue', 13),
  ]

  const plan = T.botV1.findPairPlan(bot.hand, rules, {
    minimumPairs: 5,
  })
  assert(plan)
  assert(plan.groups.length >= 5)
  assert(plan.usedCount <= bot.hand.length - 1)
})

test('Açılmış oyuncu yandan taşı normal pere işleyebiliyorsa alıyor', () => {
  const { bot, game } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.hand = [normal('blue', 13), normal('yellow', 2)]
  game.tableMelds = [meld(bot, [
    normal('red', 5), normal('red', 6), normal('red', 7),
  ])]

  const pickup = normal('red', 8, 1, 'layoff-pickup')
  assert.strictEqual(
    T.botV1.canUsePickup(T.getBotContext(bot), pickup),
    true
  )
})

test('Çiftten açmış oyuncu da normal perlere taş işleyebiliyor', () => {
  const { bot, game } = setup()
  bot.opened = true
  bot.openType = 'pairs'
  bot.mustDiscard = true
  const tile = normal('red', 8, 1, 'pair-player-layoff')
  bot.hand = [tile, normal('yellow', 13)]
  game.tableMelds = [meld(bot, [
    normal('red', 5), normal('red', 6), normal('red', 7),
  ])]

  const action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert(action)
  assert.strictEqual(action.type, 'layoff')
  assert.strictEqual(action.tileId, tile.id)
})

test('Kendi veya rakip normal perine aynı layoff mekanizmasını kullanıyor', () => {
  const { bot, right, game } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  const ownTile = normal('blue', 8, 1, 'own-layoff')
  bot.hand = [ownTile, normal('yellow', 13)]
  game.tableMelds = [meld(bot, [
    normal('blue', 5), normal('blue', 6), normal('blue', 7),
  ])]
  let action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert.strictEqual(action.meldIndex, 0)

  const otherTile = normal('black', 8, 1, 'other-layoff')
  bot.hand = [otherTile, normal('yellow', 13)]
  game.tableMelds = [meld(right, [
    normal('black', 5), normal('black', 6), normal('black', 7),
  ])]
  action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert.strictEqual(action.meldIndex, 0)
})

test('Normal açmış oyuncu çift açan rakibe geçerli çift işleyebiliyor', () => {
  const { bot, right } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  right.opened = true
  right.openType = 'pairs'
  bot.hand = [
    normal('yellow', 9, 1), normal('yellow', 9, 2), normal('red', 13),
  ]

  const action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert(action)
  assert.strictEqual(action.type, 'layoff-pair')
  assert.strictEqual(action.targetSeat, right.seat)
})

test('Çiftten açmış bot kendi yeni çiftlerini de açabiliyor', () => {
  const { bot } = setup()
  bot.opened = true
  bot.openType = 'pairs'
  bot.mustDiscard = true
  bot.hand = [
    normal('blue', 8, 1), normal('blue', 8, 2), normal('yellow', 13),
  ]

  const action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert(action)
  assert(['open-pairs', 'layoff-pair'].includes(action.type))
})

test('Normal açmış bot yeni normal perleri de açabiliyor', () => {
  const { bot } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  bot.hand = [
    normal('red', 11), normal('blue', 11), normal('black', 11),
    normal('yellow', 13),
  ]

  const action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert(action)
  assert.strictEqual(action.type, 'open-melds')
})

test('Layoff tekrar taranıyor: 8 ve ardından 9 aynı runa işleniyor', () => {
  const { bot, game } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  bot.hand = [
    normal('red', 8, 1, 'chain-8'),
    normal('red', 9, 1, 'chain-9'),
    normal('yellow', 13, 1, 'chain-discard'),
  ]
  game.tableMelds = [meld(bot, [
    normal('red', 5), normal('red', 6), normal('red', 7),
  ])]

  const result = T.runBotTableActions(bot)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(bot.hand.length, 1)
  assert.strictEqual(bot.hand[0].id, 'chain-discard')
  assert.deepStrictEqual(game.tableMelds[0].meta.sequence, [5, 6, 7, 8, 9])
})

test('Son taş layoff yapılmıyor; discard için elde kalıyor', () => {
  const { bot, game } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  const finalTile = normal('red', 8, 1, 'last-tile')
  bot.hand = [finalTile]
  game.tableMelds = [meld(bot, [
    normal('red', 5), normal('red', 6), normal('red', 7),
  ])]

  assert.strictEqual(
    T.botV1.chooseNextTableAction(T.getBotContext(bot)),
    null
  )
  const serverResult = T.attemptLayoff(bot, finalTile.id, 0)
  assert.strictEqual(serverResult.ok, false)
})

test('Gerçek okey normal discardda korunuyor', () => {
  const { bot } = setup({
    indicator: normal('red', 4, 1, 'joker-indicator'),
  })
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  const realJoker = normal('red', 5, 1, 'real-joker')
  bot.hand = [
    realJoker,
    normal('yellow', 13, 1, 'dead-13'),
    normal('blue', 1, 1, 'dead-1'),
  ]

  const discard = T.botV1.chooseDiscard(T.getBotContext(bot))
  assert.notStrictEqual(discard.id, realJoker.id)
  assert.strictEqual(discard.id, 'dead-13')
})

test('Gerçek okey son tek taşsa okeyle bitiş discardı seçilebiliyor', () => {
  const { bot } = setup({
    indicator: normal('red', 4, 1, 'joker-indicator-2'),
  })
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  const realJoker = normal('red', 5, 1, 'final-real-joker')
  bot.hand = [realJoker]

  const discard = T.botV1.chooseDiscard(T.getBotContext(bot))
  assert.strictEqual(discard.id, realJoker.id)
})

test('Sahte okey wildcard değil, gerçek okeyin doğal kimliğiyle kullanılıyor', () => {
  const { bot } = setup({
    indicator: normal('red', 4, 1, 'fake-indicator'),
  })
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  const fakeJoker = fake(1, 'fake-natural-5')
  bot.hand = [
    normal('red', 3), normal('red', 4), fakeJoker,
    normal('yellow', 13),
  ]

  const action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert(action)
  assert.strictEqual(action.type, 'open-melds')
  assert(action.groups.flat().includes(fakeJoker.id))
})

test('12-13-1 wrap bot tarafından per sayılmıyor', () => {
  const { bot, rules } = setup()
  bot.hand = [
    normal('red', 12), normal('red', 13), normal('red', 1), normal('blue', 7),
  ]

  assert.strictEqual(
    T.botV1.findAdditionalMeldPlan(bot.hand, rules),
    null
  )
})

test('Set içinde aynı renk/sayı duplicate legal kabul edilmiyor', () => {
  const { bot, rules } = setup()
  bot.hand = [
    normal('red', 7, 1), normal('red', 7, 2), normal('blue', 7, 1), normal('yellow', 13),
  ]

  assert.strictEqual(
    T.botV1.findAdditionalMeldPlan(bot.hand, rules),
    null
  )
})

test('Discard heuristic: eşit derecede ölü taşlarda yüksek puanlı taşı önce atıyor', () => {
  const { bot } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  bot.hand = [
    normal('red', 2, 1, 'dead-low'),
    normal('blue', 13, 1, 'dead-high'),
    normal('yellow', 6, 1, 'dead-mid'),
  ]

  const discard = T.botV1.chooseDiscard(T.getBotContext(bot))
  assert.strictEqual(discard.id, 'dead-high')
})

test('Yandan alınan taş varsa ilk bot masa aksiyonu mutlaka o taşı kullanıyor', () => {
  const { bot, game } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  const picked = normal('red', 8, 1, 'required-pick')
  bot.pickedDiscardId = picked.id
  bot.hand = [
    picked,
    normal('blue', 11), normal('black', 11), normal('yellow', 11),
    normal('yellow', 13),
  ]
  game.tableMelds = [meld(bot, [
    normal('red', 5), normal('red', 6), normal('red', 7),
  ])]

  const action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert(action)
  assert.strictEqual(actionContains(action, picked.id), true)
})

test('Stock=0: ortadaki gösterge hiçbir koşulda alınmıyor', () => {
  const indicator = normal('red', 9, 1, 'final-indicator')
  const { bot, game } = setup({ indicator })
  game.stock = []
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = false
  bot.hand = [
    normal('red', 8, 1, 'finish-8'),
    normal('yellow', 13, 1, 'finish-discard'),
  ]
  game.tableMelds = [meld(bot, [
    normal('red', 5), normal('red', 6), normal('red', 7),
  ])]

  assert.strictEqual(T.botV1.canFinishWithPickup(T.getBotContext(bot), game.indicator), false)
})

test('Stock=0: bitiş mümkün olmasa da ortadaki gösterge alınmıyor', () => {
  const indicator = normal('red', 9, 1, 'bad-final-indicator')
  const { bot, game } = setup({ indicator })
  game.stock = []
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = false
  bot.hand = [
    normal('blue', 2), normal('yellow', 13), normal('black', 6),
  ]

  assert.strictEqual(T.botV1.canFinishWithPickup(T.getBotContext(bot), game.indicator), false)
})

test('Karar deterministik: aynı state 50 kez aynı discard ve aynı opening planı veriyor', () => {
  const { bot, rules } = setup()
  bot.hand = [
    normal('red', 13), normal('blue', 13), normal('black', 13),
    normal('red', 12), normal('blue', 12), normal('black', 12),
    normal('red', 11), normal('blue', 11), normal('black', 11),
    normal('yellow', 13, 1, 'det-discard'),
  ]
  bot.mustDiscard = true

  const firstPlan = JSON.stringify(
    T.botV1.findOpeningMeldPlan(bot.hand, rules)
  )
  const firstDiscard = T.botV1.chooseDiscard(T.getBotContext(bot)).id

  for (let index = 0; index < 50; index++) {
    assert.strictEqual(
      JSON.stringify(T.botV1.findOpeningMeldPlan(bot.hand, rules)),
      firstPlan
    )
    assert.strictEqual(
      T.botV1.chooseDiscard(T.getBotContext(bot)).id,
      firstDiscard
    )
  }
})

test('Dört oyuncu da çift açınca bot açılışı turu iptal ediyor', () => {
  const { bot, right, top, left, game } = setup()
  for (const player of [right, top, left]) {
    player.opened = true
    player.openType = 'pairs'
  }

  bot.mustDiscard = true
  // Yeni kural: ilk açılış için bu tur gerçekten bir taş alınmış olmalı.
  bot.turnHasAcquiredTile = true
  bot.hand = [
    normal('red', 1, 1), normal('red', 1, 2),
    normal('blue', 2, 1), normal('blue', 2, 2),
    normal('black', 3, 1), normal('black', 3, 2),
    normal('yellow', 4, 1), normal('yellow', 4, 2),
    normal('red', 5, 1), normal('red', 5, 2),
    normal('yellow', 13),
  ]

  const action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert(action)
  assert.strictEqual(action.type, 'open-pairs')

  const result = T.executeBotTableAction(bot, action)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.roundEnded, true)
  assert.strictEqual(game.phase, 'round-ended')
  assert.strictEqual(game.roundEndReason, 'all-four-opened-pairs')
})

test('Son taş yalnız discard ile bitiyor', () => {
  const { bot, game } = setup()
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  bot.hand = [normal('yellow', 6, 1, 'winning-discard')]

  const result = T.botDiscard(bot, 'winning-discard')
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.finished, true)
  assert.strictEqual(game.roundWinner, bot.id)
  assert.strictEqual(game.discardPile.at(-1).id, 'winning-discard')
})

test('5+ run physical twin: zorunlu yandan alınan kopya legal planda kaybolmuyor', () => {
  const { bot, rules } = setup()
  const red9A = normal('red', 9, 1, 'tile-001')
  const pickup = normal('red', 9, 2, 'tile-999')
  bot.hand = [
    red9A,
    normal('red', 10, 1, 'tile-010'),
    normal('red', 11, 1, 'tile-011'),
    normal('red', 12, 1, 'tile-012'),
    normal('red', 13, 1, 'tile-013'),
    normal('blue', 8), normal('blue', 9), normal('blue', 10),
    normal('blue', 11), normal('blue', 12),
    normal('black', 1), normal('black', 1), normal('black', 4),
    normal('black', 4), normal('black', 7), normal('black', 7),
    normal('black', 10), normal('black', 10), normal('yellow', 13),
    normal('yellow', 13), normal('blue', 1), pickup,
  ]

  const plan = T.botV1.findOpeningMeldPlan(bot.hand, rules, {
    requiredId: pickup.id,
  })
  assert(plan, 'Zorunlu fiziksel twin ile legal uzun run planı bulunmalı')
  assert.strictEqual(plan.requiredUsed, true)
  assert(plan.groups.flat().includes(pickup.id))
})

test('V1 güvenlik: doğal taşla masadaki okeyi değiştirme aksiyonunu görüyor', () => {
  const { bot, right, game } = setup({ indicator: normal('red', 1, 1, 'indicator-red-1') })
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  right.opened = true
  right.openType = 'normal'

  const jokerTile = normal('red', 2, 1, 'real-joker-on-table')
  // indicator red1 => gerçek okey red2; sette yellow12'yi temsil ediyor
  const groupTiles = [
    normal('red', 12), normal('blue', 12), normal('black', 12), jokerTile,
  ]
  game.tableMelds = [meld(right, groupTiles)]

  const replacement = normal('yellow', 12, 2, 'replacement-yellow-12')
  bot.hand = [replacement, normal('red', 1), normal('blue', 2)]

  const action = T.botV1.chooseNextTableAction(T.getBotContext(bot))
  assert(action)
  assert.strictEqual(action.type, 'replace-joker-meld')
  assert.strictEqual(action.tileId, replacement.id)
})

test('V1 discard koruması: okey yerine konabilecek doğal taşı işlek diye koruyor', () => {
  const { bot, right, game } = setup({ indicator: normal('red', 1, 1, 'indicator-red-1-b') })
  bot.opened = true
  bot.openType = 'normal'
  bot.mustDiscard = true
  right.opened = true
  right.openType = 'normal'

  const groupTiles = [
    normal('red', 12), normal('blue', 12), normal('black', 12),
    normal('red', 2, 1, 'real-joker-on-table-2'),
  ]
  game.tableMelds = [meld(right, groupTiles)]
  const replacement = normal('yellow', 12, 2, 'replacement-protected')
  bot.hand = [replacement, normal('red', 1), normal('blue', 2), normal('black', 4)]

  const discard = T.botV1.chooseDiscard(T.getBotContext(bot))
  assert(discard)
  assert.notStrictEqual(discard.id, replacement.id)
})


test('V1 yüksek discard güvenliği: açmamış rakibe ölü 10 yerine ölü 4 atıyor', () => {
  const { bot, right, game } = setup()
  game.stock = Array(20).fill(null)
  right.opened = false
  bot.hand = [
    normal('red', 4, 1, 'safe-dead-4'),
    normal('blue', 10, 1, 'danger-dead-10'),
  ]

  const discard = T.botV1.chooseDiscard(T.getBotContext(bot))
  assert(discard)
  assert.strictEqual(discard.id, 'safe-dead-4')
})

test('V1 yüksek discard güvenliği: 8 de riskli, ölü 6 varken 8 servis etmiyor', () => {
  const { bot, right, game } = setup()
  game.stock = Array(20).fill(null)
  right.opened = false
  bot.hand = [
    normal('yellow', 6, 1, 'safe-dead-6'),
    normal('black', 8, 1, 'danger-dead-8'),
  ]

  const discard = T.botV1.chooseDiscard(T.getBotContext(bot))
  assert(discard)
  assert.strictEqual(discard.id, 'safe-dead-6')
})

test('V1 yüksek discard güvenliği: tamamlanmış düşük peri bozmak yerine ölü 10u atabiliyor', () => {
  const { bot, right, game } = setup()
  game.stock = Array(20).fill(null)
  right.opened = false
  bot.hand = [
    normal('red', 2, 1, 'run-2'),
    normal('red', 3, 1, 'run-3'),
    normal('red', 4, 1, 'run-4'),
    normal('blue', 10, 1, 'dead-10-outside-run'),
  ]

  const discard = T.botV1.chooseDiscard(T.getBotContext(bot))
  assert(discard)
  assert.strictEqual(discard.id, 'dead-10-outside-run')
})

test('V1 yüksek discard güvenliği: rakip zaten açtıysa kaynak x10 korkusuyla 10u gereksiz tutmuyor', () => {
  const { bot, right, game } = setup()
  game.stock = Array(20).fill(null)
  right.opened = true
  right.openType = 'normal'
  bot.hand = [
    normal('red', 4, 1, 'opened-safe-4'),
    normal('blue', 10, 1, 'opened-dead-10'),
  ]

  const discard = T.botV1.chooseDiscard(T.getBotContext(bot))
  assert(discard)
  assert.strictEqual(discard.id, 'opened-dead-10')
})

test('V1 yüksek discard güvenliği: balya azaldıkça aynı 10un kaynak ceza riski büyüyor', () => {
  const { bot, right, game } = setup()
  right.opened = false
  bot.hand = [normal('blue', 10, 1, 'phase-risk-10')]

  game.stock = Array(20).fill(null)
  const early = T.botV1.highDiscardSourcePenaltyRisk(
    bot.hand[0],
    T.getBotContext(bot)
  )

  game.stock = Array(4).fill(null)
  const late = T.botV1.highDiscardSourcePenaltyRisk(
    bot.hand[0],
    T.getBotContext(bot)
  )

  assert(early > 0)
  assert(late > early)
})

test('V1 yüksek discard güvenliği: public destek taşları görünür oldukça servis riskini düşürüyor', () => {
  const { bot, right, game } = setup()
  game.stock = Array(20).fill(null)
  right.opened = false
  const risky = normal('red', 10, 1, 'visible-risk-red-10')
  bot.hand = [risky]

  const openContext = T.getBotContext(bot)
  const openRisk = T.botV1.highDiscardSourcePenaltyRisk(risky, openContext)

  const blockedContext = {
    ...openContext,
    knownVisibleTiles: [
      ...openContext.knownVisibleTiles,
      normal('red', 10, 2, 'visible-twin-10'),
      normal('blue', 10, 1, 'visible-blue-10-a'),
      normal('blue', 10, 2, 'visible-blue-10-b'),
      normal('black', 10, 1, 'visible-black-10-a'),
      normal('black', 10, 2, 'visible-black-10-b'),
      normal('yellow', 10, 1, 'visible-yellow-10-a'),
      normal('yellow', 10, 2, 'visible-yellow-10-b'),
      normal('red', 8, 1, 'visible-red-8-a'), normal('red', 8, 2, 'visible-red-8-b'),
      normal('red', 9, 1, 'visible-red-9-a'), normal('red', 9, 2, 'visible-red-9-b'),
      normal('red', 11, 1, 'visible-red-11-a'), normal('red', 11, 2, 'visible-red-11-b'),
      normal('red', 12, 1, 'visible-red-12-a'), normal('red', 12, 2, 'visible-red-12-b'),
    ],
  }
  const blockedRisk = T.botV1.highDiscardSourcePenaltyRisk(risky, blockedContext)

  assert(openRisk > blockedRisk)
})

test('V1 yüksek discard güvenliği: yalnız 8-13 kaldıysa kilitlenmeyip en düşük riskliyi atıyor', () => {
  const { bot, right, game } = setup()
  game.stock = Array(20).fill(null)
  right.opened = false
  bot.hand = [
    normal('red', 8, 1, 'only-high-8'),
    normal('blue', 10, 1, 'only-high-10'),
    normal('black', 13, 1, 'only-high-13'),
  ]

  const discard = T.botV1.chooseDiscard(T.getBotContext(bot))
  assert(discard)
  assert.strictEqual(discard.id, 'only-high-8')
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

console.log(`\nBOT V1 tests: ${passed}/${tests.length} passed`)

if (failures.length > 0) {
  process.exitCode = 1
}

// Some round-end tests intentionally create the server's 4-second next-round
// timer. The assertions are complete; do not keep the standalone test process
// alive for those production timers.
setImmediate(() => process.exit(failures.length > 0 ? 1 : 0))
