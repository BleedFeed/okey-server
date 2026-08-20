'use strict'

// BOT V2: V1'in kanıtlanmış meld/pair solver'ını korur, fakat masa kararlarını
// birkaç hamle ileri simüle eder ve ilk açılışta rastgele tur eşiği yerine
// public bilgiye dayalı kısa bir one-draw lookahead kullanır.
const botV1 = require('./bot-v1')

const COLORS = ['red', 'blue', 'black', 'yellow']
const MAX_SEARCH_DEPTH = 9
const MAX_BRANCHES = 9
const MAX_SEARCH_NODES = 72
const STRONG_DRAW_WAIT_CHANCE = 0.18
const LOW_STOCK_OPEN_NOW = 8
const DANGER_HAND_COUNT = 7
const MAX_OPENING_WAIT_TURNS = 1

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function idNumber(id) {
  const match = String(id || '').match(/(\d+)$/)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function compareTile(a, b) {
  return idNumber(a?.id) - idNumber(b?.id) ||
    String(a?.id || '').localeCompare(String(b?.id || ''))
}

function stableTiles(tiles) {
  return [...(tiles || [])].sort(compareTile)
}

function actionKey(action) {
  if (!action) return ''
  if (action.type === 'layoff') return `layoff:${action.tileId}:${action.meldIndex}`
  if (action.type === 'layoff-pair') {
    return `layoff-pair:${[...action.tileIds].sort().join(',')}:${action.targetSeat}`
  }
  if (action.type === 'replace-joker-meld') {
    return `replace-meld:${action.tileId}:${action.meldIndex}`
  }
  if (action.type === 'replace-joker-pair') {
    return `replace-pair:${action.tileId}:${action.pairOpenIndex}:${action.pairIndex}`
  }
  return `${action.type}:${(action.groups || []).map(group => [...group].sort().join(',')).sort().join('|')}`
}

function actionUsesTile(action, tileId) {
  if (!action || !tileId) return false
  if (action.type === 'layoff') return action.tileId === tileId
  if (action.type === 'replace-joker-meld' || action.type === 'replace-joker-pair') {
    return action.tileId === tileId
  }
  if (action.type === 'layoff-pair') return action.tileIds.includes(tileId)
  return (action.groups || []).flat().includes(tileId)
}

function removeIds(hand, ids) {
  const remove = new Set(ids)
  return hand.filter(tile => !remove.has(tile.id))
}

function meldMeta(validation) {
  if (!validation) return null
  if (validation.type === 'group') {
    return {
      number: validation.number,
      assignments: clone(validation.assignments || {}),
    }
  }
  return {
    color: validation.color,
    sequence: clone(validation.sequence || []),
    assignments: clone(validation.assignments || {}),
  }
}

function createSimMeld(player, tiles, validation) {
  return {
    ownerId: player.id,
    ownerSeat: player.seat,
    tiles: clone(validation.arrangedTiles || tiles),
    type: validation.type,
    meta: meldMeta(validation),
  }
}

function bestOpeningActionForHand(context, hand, requiredId = null) {
  const player = {
    ...context.player,
    hand,
    opened: false,
    openType: null,
    mustDiscard: true,
    turnHasAcquiredTile: true,
    pickedDiscardId: requiredId,
    pickedDiscardRequiresOpening: Boolean(requiredId),
  }

  return botV1.chooseNextTableAction({
    ...context,
    player,
    requiredId,
    openingPolicy: { allowOpening: true },
  })
}

function openingActionMetrics(action, hand, rules) {
  if (!action) return null
  const ids = (action.groups || []).flat()
  const used = new Set(ids)
  let score = 0

  if (action.type === 'open-melds') {
    for (const group of action.groups || []) {
      const tiles = group.map(id => hand.find(tile => tile.id === id)).filter(Boolean)
      score += Number(rules.validateMeld(tiles)?.score) || 0
    }
  }
  else if (action.type === 'open-pairs') {
    for (const id of ids) {
      const tile = hand.find(item => item.id === id)
      score += Number(rules.tilePenaltyValue?.(tile)) || 0
    }
  }

  const remainingPenalty = hand.reduce((sum, tile) => {
    if (used.has(tile.id)) return sum
    return sum + (Number(rules.tilePenaltyValue?.(tile)) || 0)
  }, 0)

  return {
    usedCount: ids.length,
    score,
    remainingPenalty,
    type: action.type,
  }
}

function tileIdentity(tile) {
  if (!tile) return null
  if (tile.type === 'fake-joker') return 'fake-joker'
  return `${tile.color}:${Number(tile.number)}`
}

function physicalIdentityTotals() {
  const totals = new Map([['fake-joker', 2]])
  for (const color of COLORS) {
    for (let number = 1; number <= 13; number++) {
      totals.set(`${color}:${number}`, 2)
    }
  }
  return totals
}

function syntheticTile(identity, serial) {
  if (identity === 'fake-joker') {
    return {
      id: `__v2-draw-fake-${serial}`,
      type: 'fake-joker',
      color: null,
      number: null,
      copy: 99,
    }
  }

  const [color, rawNumber] = identity.split(':')
  return {
    id: `__v2-draw-${color}-${rawNumber}-${serial}`,
    type: 'normal',
    color,
    number: Number(rawNumber),
    copy: 99,
  }
}

function estimateStrongDrawChance(context, currentAction) {
  const current = openingActionMetrics(
    currentAction,
    context.player.hand,
    context.rules
  )
  if (!current) return 0

  // Beklemek demek bu tur yine bir taş discard etmek demektir. Bir sonraki
  // draw'u 23 taşlık hayali bir ele eklemek yerine, mevcut legal opening'in
  // dışında kalan taşlardan en zayıf discardı çıkarıp sonra yeni taşı ekleriz.
  // Böylece one-draw lookahead gerçek 21 -> 22 tur yapısını taklit eder.
  const openingIds = new Set((currentAction.groups || []).flat())
  const outsideOpening = context.player.hand.filter(tile => !openingIds.has(tile.id))
  if (outsideOpening.length === 0) return 0

  const waitDiscard = chooseDiscard({
    ...context,
    player: {
      ...context.player,
      hand: outsideOpening,
    },
  }) || outsideOpening[0]
  const baseNextHand = context.player.hand.filter(tile => tile.id !== waitDiscard.id)

  const totals = physicalIdentityTotals()
  for (const tile of context.knownVisibleTiles || context.player.hand || []) {
    const key = tileIdentity(tile)
    if (!key || !totals.has(key)) continue
    totals.set(key, Math.max(0, totals.get(key) - 1))
  }

  let unknownCount = 0
  let strongCount = 0
  let serial = 0

  for (const [identity, count] of totals) {
    if (count <= 0) continue
    unknownCount += count

    const draw = syntheticTile(identity, ++serial)
    const nextHand = [...baseNextHand, draw]
    const nextAction = bestOpeningActionForHand(context, nextHand)
    const next = openingActionMetrics(nextAction, nextHand, context.rules)
    if (!next) continue

    // Bir sonraki çekiş yalnız yeni taşı yere indirmekle kalmayıp en az bir
    // mevcut taşı daha çözüyor ise gerçekten "eli büyüten" draw sayılır.
    const materiallyMoreTiles = next.usedCount >= current.usedCount + 2
    const materiallyLowerPenalty =
      next.usedCount >= current.usedCount + 1 &&
      next.remainingPenalty <= current.remainingPenalty - 12

    if (materiallyMoreTiles || materiallyLowerPenalty) {
      strongCount += count
    }
  }

  return unknownCount > 0 ? strongCount / unknownCount : 0
}

function evaluateOpeningPolicy(context) {
  const player = context?.player
  if (!player || player.opened) {
    return {
      allowOpening: true,
      legalOpening: false,
      reason: 'already-opened',
      strongDrawChance: 0,
    }
  }

  // Starter 22 taşla henüz çekmeden server tarafından zaten açılamaz. Bunu
  // "legal opening gördü ve bekledi" saymayız.
  if (!player.mustDiscard || !player.turnHasAcquiredTile) {
    return {
      allowOpening: false,
      legalOpening: false,
      reason: 'must-acquire-first',
      strongDrawChance: 0,
    }
  }

  const requiredId = player.pickedDiscardId || null
  const action = bestOpeningActionForHand(context, player.hand, requiredId)
  if (!action) {
    return {
      allowOpening: false,
      legalOpening: false,
      reason: 'no-legal-opening',
      strongDrawChance: 0,
    }
  }

  // Yandan taşı aldıysak onu bu tur kullanmak zorundayız. Almayı seçmiş bir
  // botun burada "bir tur daha beklemesi" kural ihlalidir.
  if (requiredId) {
    return {
      allowOpening: true,
      legalOpening: true,
      reason: 'mandatory-side-discard',
      strongDrawChance: 0,
    }
  }

  const metrics = openingActionMetrics(action, player.hand, context.rules)
  const waitCount = Number(player.botOpeningWaitCount) || 0
  const stockCount = Number(context.stockCount) || 0
  const opponentCounts = (context.players || [])
    .filter(other => other.id !== player.id)
    .map(other => Number(other.handCount))
    .filter(Number.isFinite)
  const smallestOpponentHand = opponentCounts.length
    ? Math.min(...opponentCounts)
    : 99

  if (waitCount >= MAX_OPENING_WAIT_TURNS) {
    return {
      allowOpening: true,
      legalOpening: true,
      reason: 'max-wait-reached',
      strongDrawChance: 0,
    }
  }

  if (
    stockCount <= LOW_STOCK_OPEN_NOW ||
    smallestOpponentHand <= DANGER_HAND_COUNT ||
    metrics.usedCount >= 12
  ) {
    return {
      allowOpening: true,
      legalOpening: true,
      reason: 'table-pressure',
      strongDrawChance: 0,
    }
  }

  const strongDrawChance = estimateStrongDrawChance(context, action)
  if (strongDrawChance >= STRONG_DRAW_WAIT_CHANCE) {
    return {
      allowOpening: false,
      legalOpening: true,
      reason: 'one-draw-improvement',
      strongDrawChance,
    }
  }

  return {
    allowOpening: true,
    legalOpening: true,
    reason: 'open-now',
    strongDrawChance,
  }
}

function pairTargets(players) {
  return [...(players || [])]
    .filter(player => player.opened && player.openType === 'pairs')
    .sort((a, b) => String(a.seat).localeCompare(String(b.seat)))
}

function enumerateTableActions(context) {
  const { player, tableMelds = [], pairOpens = [], players = [], rules } = context
  if (!player?.mustDiscard || player.hand.length <= 1) return []

  if (!player.opened) {
    const opening = botV1.chooseNextTableAction(context)
    return opening ? [opening] : []
  }

  const requiredId = player.pickedDiscardId || context.requiredId || null
  const actions = []
  const seen = new Set()

  function add(action) {
    if (!action) return
    if (requiredId && !actionUsesTile(action, requiredId)) return
    const key = actionKey(action)
    if (seen.has(key)) return
    seen.add(key)
    actions.push(action)
  }

  for (const tile of stableTiles(player.hand)) {
    if (requiredId && tile.id !== requiredId) continue

    for (let meldIndex = 0; meldIndex < tableMelds.length; meldIndex++) {
      if (rules.previewLayoff(tableMelds[meldIndex], tile)) {
        add({ type: 'layoff', tileId: tile.id, meldIndex })
      }
      if (rules.canReplaceJokerInMeldWithTile?.(tableMelds[meldIndex], tile)) {
        add({ type: 'replace-joker-meld', tileId: tile.id, meldIndex })
      }
    }

    for (let pairOpenIndex = 0; pairOpenIndex < pairOpens.length; pairOpenIndex++) {
      const pairOpen = pairOpens[pairOpenIndex]
      for (let pairIndex = 0; pairIndex < (pairOpen?.pairs || []).length; pairIndex++) {
        if (rules.canReplaceJokerInPairWithTile?.(pairOpen.pairs[pairIndex], tile)) {
          add({
            type: 'replace-joker-pair',
            tileId: tile.id,
            pairOpenIndex,
            pairIndex,
          })
        }
      }
    }
  }

  if (player.openType === 'normal') {
    const plan = botV1.findAdditionalMeldPlan(player.hand, rules, { requiredId })
    if (plan) add({ type: 'open-melds', groups: plan.groups })
  }
  else if (player.openType === 'pairs') {
    const plan = botV1.findPairPlan(player.hand, rules, {
      requiredId,
      minimumPairs: 1,
    })
    if (plan) add({ type: 'open-pairs', groups: plan.groups })
  }

  const targets = pairTargets(players)
  if (targets.length > 0 && player.hand.length > 2) {
    const pairCandidates = botV1.createPairCandidates(player.hand, rules)
    for (const pair of pairCandidates) {
      if (requiredId && !pair.ids.includes(requiredId)) continue
      for (const target of targets) {
        add({
          type: 'layoff-pair',
          tileIds: [...pair.ids],
          targetSeat: target.seat,
        })
      }
    }
  }

  // Search branching is bounded. Multi-tile actions and joker recovery get
  // priority, but several alternative single layoffs remain so V2 can avoid a
  // greedy first fit that destroys a larger group.
  actions.sort((a, b) => {
    const immediate = action => {
      if (action.type === 'open-melds' || action.type === 'open-pairs') {
        return (action.groups || []).flat().length * 100
      }
      if (action.type === 'layoff-pair') return 200
      if (action.type.startsWith('replace-joker')) return 150
      return 100
    }
    const diff = immediate(b) - immediate(a)
    return diff || actionKey(a).localeCompare(actionKey(b))
  })

  return actions.slice(0, MAX_BRANCHES)
}

function findPairOpenIndexBySeat(pairOpens, seat) {
  return pairOpens.findIndex(item => item.ownerSeat === seat)
}

function simulateAction(context, action) {
  const next = {
    ...context,
    player: clone(context.player),
    players: clone(context.players || []),
    tableMelds: clone(context.tableMelds || []),
    pairOpens: clone(context.pairOpens || []),
  }
  const { player, rules } = next

  function consumeRequired(ids) {
    if (player.pickedDiscardId && ids.includes(player.pickedDiscardId)) {
      player.pickedDiscardId = null
      player.pickedDiscardSourceId = null
      player.pickedDiscardRequiresOpening = false
    }
  }

  if (action.type === 'layoff') {
    const tile = player.hand.find(item => item.id === action.tileId)
    const meld = next.tableMelds[action.meldIndex]
    const preview = tile && meld && rules.previewLayoff(meld, tile)
    if (!preview) return null
    next.tableMelds[action.meldIndex] = {
      ...meld,
      tiles: clone(preview.tiles),
      meta: clone(preview.meta),
    }
    player.hand = removeIds(player.hand, [tile.id])
    consumeRequired([tile.id])
  }
  else if (action.type === 'layoff-pair') {
    if (player.hand.length <= action.tileIds.length) return null
    const pair = action.tileIds
      .map(id => player.hand.find(tile => tile.id === id))
      .filter(Boolean)
    if (pair.length !== 2 || !rules.validatePair(pair)) return null
    player.hand = removeIds(player.hand, action.tileIds)
    consumeRequired(action.tileIds)

    let targetIndex = findPairOpenIndexBySeat(next.pairOpens, action.targetSeat)
    if (targetIndex < 0) {
      next.pairOpens.push({ ownerSeat: action.targetSeat, pairs: [] })
      targetIndex = next.pairOpens.length - 1
    }
    next.pairOpens[targetIndex].pairs.push(clone(pair))
  }
  else if (action.type === 'open-melds') {
    const allIds = (action.groups || []).flat()
    if (allIds.length >= player.hand.length) return null
    const created = []
    for (const group of action.groups || []) {
      const tiles = group.map(id => player.hand.find(tile => tile.id === id)).filter(Boolean)
      const validation = rules.validateMeld(tiles)
      if (!validation) return null
      created.push(createSimMeld(player, tiles, validation))
    }
    player.hand = removeIds(player.hand, allIds)
    consumeRequired(allIds)
    player.opened = true
    player.openType = 'normal'
    next.tableMelds.push(...created)
  }
  else if (action.type === 'open-pairs') {
    const allIds = (action.groups || []).flat()
    if (allIds.length >= player.hand.length) return null
    const pairs = []
    for (const group of action.groups || []) {
      const tiles = group.map(id => player.hand.find(tile => tile.id === id)).filter(Boolean)
      if (tiles.length !== 2 || !rules.validatePair(tiles)) return null
      pairs.push(clone(tiles))
    }
    player.hand = removeIds(player.hand, allIds)
    consumeRequired(allIds)
    player.opened = true
    player.openType = 'pairs'
    next.pairOpens.push({
      ownerId: player.id,
      ownerSeat: player.seat,
      pairs,
    })
  }
  else if (action.type === 'replace-joker-meld') {
    const tile = player.hand.find(item => item.id === action.tileId)
    const meld = next.tableMelds[action.meldIndex]
    const preview = tile && meld && rules.previewReplaceJokerInMeld?.(meld, tile)
    if (!preview?.receivedJoker || !preview?.meld) return null
    player.hand = removeIds(player.hand, [tile.id])
    player.hand.push(clone(preview.receivedJoker))
    next.tableMelds[action.meldIndex] = clone(preview.meld)
    consumeRequired([tile.id])
  }
  else if (action.type === 'replace-joker-pair') {
    const tile = player.hand.find(item => item.id === action.tileId)
    const pair = next.pairOpens[action.pairOpenIndex]?.pairs?.[action.pairIndex]
    const preview = tile && pair && rules.previewReplaceJokerInPair?.(pair, tile)
    if (!preview?.receivedJoker || !preview?.pair) return null
    player.hand = removeIds(player.hand, [tile.id])
    player.hand.push(clone(preview.receivedJoker))
    next.pairOpens[action.pairOpenIndex].pairs[action.pairIndex] = clone(preview.pair)
    consumeRequired([tile.id])
  }
  else {
    return null
  }

  if (player.hand.length < 1) return null
  return next
}

function identityVisibleCount(context, identity) {
  let count = 0
  for (const tile of context.knownVisibleTiles || []) {
    if (tileIdentity(tile) === identity) count++
  }
  return count
}

function availabilitySupportScore(tile, context) {
  const effective = context.rules.getEffectiveTile(tile)
  if (!effective || effective.wildcard) return 0

  let score = 0
  for (const distance of [1, 2]) {
    for (const number of [effective.number - distance, effective.number + distance]) {
      if (number < 1 || number > 13) continue
      const identity = `${effective.color}:${number}`
      const unseenCopies = Math.max(0, 2 - identityVisibleCount(context, identity))
      score += unseenCopies * (distance === 1 ? 7 : 3)
    }
  }

  for (const color of COLORS) {
    if (color === effective.color) continue
    const identity = `${color}:${effective.number}`
    score += Math.max(0, 2 - identityVisibleCount(context, identity)) * 3
  }
  return score
}

function opponentNearMeldRisk(tile, context) {
  const effective = context.rules.getEffectiveTile(tile)
  if (!effective || effective.wildcard) return 0
  const danger = (context.players || []).some(
    player => player.id !== context.player.id && Number(player.handCount) <= DANGER_HAND_COUNT
  )
  if (!danger) return 0

  let risk = 0
  for (const meld of context.tableMelds || []) {
    if (meld.ownerId === context.player.id || meld.type !== 'run') continue
    if (meld.meta?.color !== effective.color) continue
    const sequence = meld.meta?.sequence || []
    if (!sequence.length) continue
    const leftDistance = Math.abs(effective.number - sequence[0])
    const rightDistance = Math.abs(effective.number - sequence[sequence.length - 1])
    if (leftDistance === 2 || rightDistance === 2) risk += 18
  }
  return risk
}

function chooseDiscard(context) {
  const hand = stableTiles(context?.player?.hand || [])
  if (!hand.length) return null
  if (hand.length === 1) return hand[0]

  const ranked = hand.map(tile => {
    let keepScore = botV1.structuralKeepScore(tile, hand, context.rules)
    keepScore += botV1.highDiscardSourcePenaltyRisk(tile, context)
    keepScore += availabilitySupportScore(tile, context)
    keepScore += opponentNearMeldRisk(tile, context)

    const canLayoff = (context.tableMelds || []).some(
      meld => context.rules.previewLayoff(meld, tile)
    )
    if (canLayoff) keepScore += 10000

    const replaceMeld = (context.tableMelds || []).some(
      meld => context.rules.canReplaceJokerInMeldWithTile?.(meld, tile)
    )
    const replacePair = (context.pairOpens || []).some(pairOpen =>
      (pairOpen?.pairs || []).some(pair =>
        context.rules.canReplaceJokerInPairWithTile?.(pair, tile)
      )
    )
    if (replaceMeld || replacePair) keepScore += 14000

    return {
      tile,
      keepScore,
      penaltyValue: Number(context.rules.tilePenaltyValue?.(tile)) || 0,
    }
  })

  ranked.sort((a, b) => {
    if (a.keepScore !== b.keepScore) return a.keepScore - b.keepScore
    if (b.penaltyValue !== a.penaltyValue) return b.penaltyValue - a.penaltyValue
    return compareTile(a.tile, b.tile)
  })
  return ranked[0]?.tile || null
}

function terminalMetrics(context, initialHandCount) {
  if (context.player.pickedDiscardId) return null
  const discard = chooseDiscard(context)
  if (!discard) return null

  const postDiscard = context.player.hand.filter(tile => tile.id !== discard.id)
  const postDiscardPenalty = postDiscard.reduce(
    (sum, tile) => sum + (Number(context.rules.tilePenaltyValue?.(tile)) || 0),
    0
  )
  const realJokers = postDiscard.filter(tile => context.rules.isRealJoker?.(tile)).length
  const structural = postDiscard.reduce(
    (sum, tile) => sum + Math.min(400, botV1.structuralKeepScore(tile, postDiscard, context.rules)),
    0
  )

  return {
    removedCount: initialHandCount - context.player.hand.length,
    postDiscardPenalty,
    realJokers,
    structural,
    discardId: discard.id,
  }
}

function betterResult(a, b) {
  if (!a) return b
  if (!b) return a
  if (a.metrics.removedCount !== b.metrics.removedCount) {
    return a.metrics.removedCount > b.metrics.removedCount ? a : b
  }
  if (a.metrics.postDiscardPenalty !== b.metrics.postDiscardPenalty) {
    return a.metrics.postDiscardPenalty < b.metrics.postDiscardPenalty ? a : b
  }
  if (a.metrics.realJokers !== b.metrics.realJokers) {
    return a.metrics.realJokers > b.metrics.realJokers ? a : b
  }
  if (a.metrics.structural !== b.metrics.structural) {
    return a.metrics.structural > b.metrics.structural ? a : b
  }
  return a.key <= b.key ? a : b
}

function stateKey(context, depth) {
  const hand = stableTiles(context.player.hand).map(tile => tile.id).join(',')
  const melds = (context.tableMelds || []).map(meld =>
    (meld.tiles || []).map(tile => tile.id).sort().join('.')
  ).join('|')
  const pairs = (context.pairOpens || []).flatMap(open =>
    (open.pairs || []).map(pair => pair.map(tile => tile.id).sort().join('.'))
  ).join('|')
  return `${depth}:${context.player.pickedDiscardId || '-'}:${hand}:${melds}:${pairs}`
}

function searchBestTurn(context) {
  const initialHandCount = context.player.hand.length
  const memo = new Map()
  let expandedNodes = 0

  function visit(state, depth) {
    const key = stateKey(state, depth)
    if (memo.has(key)) return memo.get(key)

    let best = null
    const terminal = terminalMetrics(state, initialHandCount)
    if (terminal) {
      best = {
        firstAction: null,
        metrics: terminal,
        key: `stop:${terminal.discardId}`,
      }
    }

    // Full-turn planning must never stall the authoritative game loop. The
    // budget is a deterministic node cap (not a wall-clock timeout), so the
    // same state still produces the same action on fast and slow machines.
    // Action ordering puts multi-tile plans and joker recovery first, meaning
    // the most valuable alternatives are explored before the cap is reached.
    if (
      depth < MAX_SEARCH_DEPTH &&
      state.player.hand.length > 1 &&
      expandedNodes < MAX_SEARCH_NODES
    ) {
      expandedNodes++
      const actions = enumerateTableActions(state)
      for (const action of actions) {
        if (expandedNodes >= MAX_SEARCH_NODES && best) break
        const next = simulateAction(state, action)
        if (!next) continue
        const tail = visit(next, depth + 1)
        if (!tail) continue
        const candidate = {
          firstAction: action,
          metrics: tail.metrics,
          key: `${actionKey(action)}>>${tail.key}`,
        }
        best = betterResult(best, candidate)
      }
    }

    memo.set(key, best)
    return best
  }

  return visit(context, 0)
}

function chooseNextTableAction(context) {
  if (!context?.player?.mustDiscard || context.player.hand.length <= 1) return null

  if (!context.player.opened) {
    return botV1.chooseNextTableAction(context)
  }

  const best = searchBestTurn({
    ...context,
    player: clone(context.player),
    players: clone(context.players || []),
    tableMelds: clone(context.tableMelds || []),
    pairOpens: clone(context.pairOpens || []),
  })
  return best?.firstAction || null
}

function canUsePickup(context, tile) {
  if (!tile) return false
  const player = {
    ...context.player,
    hand: [...context.player.hand, tile],
    mustDiscard: true,
    turnHasAcquiredTile: true,
    pickedDiscardId: tile.id,
    pickedDiscardRequiresOpening: true,
  }
  const nextContext = {
    ...context,
    player,
    requiredId: tile.id,
  }

  if (!player.opened) {
    nextContext.openingPolicy = { allowOpening: true }
  }

  const action = chooseNextTableAction(nextContext)
  return actionUsesTile(action, tile.id)
}

function canFinishWithPickup(context, tile) {
  // Gösterge artık hiçbir koşulda alınmadığı için bu API yalnız geriye dönük
  // test uyumluluğu için tutulur.
  return false
}

module.exports = {
  ...botV1,
  canFinishWithPickup,
  canUsePickup,
  chooseDiscard,
  chooseNextTableAction,
  estimateStrongDrawChance,
  evaluateOpeningPolicy,
  searchBestTurn,
}
