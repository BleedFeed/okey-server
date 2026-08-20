'use strict'

// Deterministic 101 Okey BOT V1 planner.
// The planner never changes authoritative game state. It only proposes legal
// actions; server.js applies them through the same validation functions used by
// human players.

const DEFAULT_COLORS = ['red', 'blue', 'black', 'yellow']

function idNumber(id) {
  const match = String(id || '').match(/(\d+)$/)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function compareTileId(a, b) {
  const numberDiff = idNumber(a?.id) - idNumber(b?.id)
  if (numberDiff !== 0) return numberDiff
  return String(a?.id || '').localeCompare(String(b?.id || ''))
}

function stableTiles(tiles) {
  return [...(tiles || [])].sort(compareTileId)
}

function combinations(items, size) {
  const result = []
  const picked = []

  function visit(start) {
    if (picked.length === size) {
      result.push([...picked])
      return
    }

    const remaining = size - picked.length
    for (let index = start; index <= items.length - remaining; index++) {
      picked.push(items[index])
      visit(index + 1)
      picked.pop()
    }
  }

  if (size >= 0 && size <= items.length) {
    visit(0)
  }

  return result
}

function candidateKey(ids) {
  return [...ids]
    .sort((a, b) => idNumber(a) - idNumber(b) || String(a).localeCompare(String(b)))
    .join('|')
}

function createMeldCandidates(hand, rules) {
  const tiles = stableTiles(hand)
  const seen = new Set()
  const result = []

  function addCandidate(group) {
    const validation = rules.validateMeld(group)
    if (!validation) return

    const arrangedGroup = Array.isArray(validation.arrangedTiles)
      ? validation.arrangedTiles
      : group
    const ids = arrangedGroup.map(tile => tile.id)
    const key = candidateKey(ids)
    if (seen.has(key)) return
    seen.add(key)

    result.push({
      ids,
      score: Number(validation.score) || 0,
      type: validation.type,
      key,
    })
  }

  // Exact enumeration for the overwhelmingly common 3/4-tile melds. This
  // also catches joker substitutions and duplicate-copy choices correctly.
  for (const size of [3, 4]) {
    for (const group of combinations(tiles, size)) {
      addCandidate(group)
    }
  }

  // Runs longer than four tiles are generated as deterministic color/sequence
  // windows. The canonical candidate uses the lowest stable physical copy, but
  // we ALSO emit one-copy substitutions for duplicate naturals. This matters
  // when a specific physical side-discard id is mandatory: a legal 5+ run must
  // not be missed merely because the canonical window picked the twin copy.
  const colors = rules.colors || DEFAULT_COLORS
  const wildcards = tiles.filter(tile => rules.getEffectiveTile(tile).wildcard)

  for (const color of colors) {
    const byNumber = new Map()

    for (const tile of tiles) {
      const effective = rules.getEffectiveTile(tile)
      if (effective.wildcard || effective.color !== color) continue

      const list = byNumber.get(effective.number) || []
      list.push(tile)
      list.sort(compareTileId)
      byNumber.set(effective.number, list)
    }

    for (let length = 5; length <= 13; length++) {
      for (let start = 1; start <= 14 - length; start++) {
        const chosen = []
        const duplicateSlots = []
        let missing = 0

        for (let number = start; number < start + length; number++) {
          const naturals = byNumber.get(number) || []
          const natural = naturals[0]
          if (natural) {
            duplicateSlots.push({ index: chosen.length, naturals })
            chosen.push(natural)
          }
          else missing++
        }

        if (missing > wildcards.length) continue

        chosen.push(...wildcards.slice(0, missing))
        if (chosen.length !== length) continue

        addCandidate(chosen)

        // A single required physical id is the only place where twin identity
        // changes legality. Emitting each alternative copy independently keeps
        // candidate growth small while guaranteeing every twin id appears in a
        // valid long-run candidate when its canonical twin would have worked.
        for (const slot of duplicateSlots) {
          for (const alternative of slot.naturals.slice(1)) {
            const variant = [...chosen]
            variant[slot.index] = alternative
            addCandidate(variant)
          }
        }
      }
    }
  }

  return result.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.ids.length !== a.ids.length) return b.ids.length - a.ids.length
    return a.key.localeCompare(b.key)
  })
}

function createPairCandidates(hand, rules) {
  const tiles = stableTiles(hand)
  const result = []

  for (const pair of combinations(tiles, 2)) {
    if (!rules.validatePair(pair)) continue

    result.push({
      ids: pair.map(tile => tile.id),
      score: pair.reduce(
        (sum, tile) => sum + (Number(rules.tilePenaltyValue?.(tile)) || 0),
        0
      ),
      type: 'pair',
      key: candidateKey(pair.map(tile => tile.id)),
    })
  }

  return result.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.key.localeCompare(b.key)
  })
}

function betterPlan(a, b, options) {
  if (!a) return b
  if (!b) return a

  if (options.requiredId) {
    if (a.requiredUsed !== b.requiredUsed) {
      return a.requiredUsed ? a : b
    }
  }

  if (options.objective === 'tiles') {
    if (a.usedCount !== b.usedCount) {
      return a.usedCount > b.usedCount ? a : b
    }
    if (a.score !== b.score) {
      return a.score > b.score ? a : b
    }
  }
  else {
    if (a.score !== b.score) {
      return a.score > b.score ? a : b
    }
    if (a.usedCount !== b.usedCount) {
      return a.usedCount > b.usedCount ? a : b
    }
  }

  return a.key <= b.key ? a : b
}

function solveCandidatePacking(hand, candidates, options = {}) {
  const tiles = stableTiles(hand)
  const indexById = new Map(tiles.map((tile, index) => [tile.id, index]))
  const usable = []

  for (const candidate of candidates) {
    let mask = 0n
    let valid = true

    for (const id of candidate.ids) {
      const index = indexById.get(id)
      if (index == null) {
        valid = false
        break
      }
      mask |= 1n << BigInt(index)
    }

    if (valid) {
      usable.push({ ...candidate, mask })
    }
  }

  const byIndex = Array.from({ length: tiles.length }, () => [])
  for (const candidate of usable) {
    for (let index = 0; index < tiles.length; index++) {
      if ((candidate.mask & (1n << BigInt(index))) !== 0n) {
        byIndex[index].push(candidate)
      }
    }
  }

  const maxUsed = Math.max(
    0,
    Math.min(
      Number.isInteger(options.maxUsed) ? options.maxUsed : tiles.length,
      tiles.length
    )
  )
  const fullMask = tiles.length === 0
    ? 0n
    : (1n << BigInt(tiles.length)) - 1n
  const memo = new Map()

  function solve(mask, capacity) {
    if (mask === 0n || capacity <= 0) {
      return {
        groups: [],
        score: 0,
        usedCount: 0,
        requiredUsed: false,
        key: '',
      }
    }

    const memoKey = `${mask.toString(16)}:${capacity}`
    const cached = memo.get(memoKey)
    if (cached) return cached

    let firstIndex = -1
    for (let index = 0; index < tiles.length; index++) {
      if ((mask & (1n << BigInt(index))) !== 0n) {
        firstIndex = index
        break
      }
    }

    const firstBit = 1n << BigInt(firstIndex)
    let best = solve(mask ^ firstBit, capacity)

    for (const candidate of byIndex[firstIndex]) {
      if (candidate.ids.length > capacity) continue
      if ((candidate.mask & mask) !== candidate.mask) continue

      const tail = solve(
        mask ^ candidate.mask,
        capacity - candidate.ids.length
      )
      const groups = [candidate, ...tail.groups]
      const keys = groups.map(group => group.key).sort()
      const next = {
        groups,
        score: candidate.score + tail.score,
        usedCount: candidate.ids.length + tail.usedCount,
        requiredUsed:
          tail.requiredUsed ||
          Boolean(options.requiredId && candidate.ids.includes(options.requiredId)),
        key: keys.join('||'),
      }

      best = betterPlan(best, next, options)
    }

    memo.set(memoKey, best)
    return best
  }

  return solve(fullMask, maxUsed)
}

function solveCandidatePackingByUsedCount(hand, candidates, options = {}) {
  const tiles = stableTiles(hand)
  const indexById = new Map(tiles.map((tile, index) => [tile.id, index]))
  const usable = []

  for (const candidate of candidates) {
    let mask = 0n
    let valid = true

    for (const id of candidate.ids) {
      const index = indexById.get(id)
      if (index == null) {
        valid = false
        break
      }
      mask |= 1n << BigInt(index)
    }

    if (valid) usable.push({ ...candidate, mask })
  }

  const byIndex = Array.from({ length: tiles.length }, () => [])
  for (const candidate of usable) {
    for (let index = 0; index < tiles.length; index++) {
      if ((candidate.mask & (1n << BigInt(index))) !== 0n) {
        byIndex[index].push(candidate)
      }
    }
  }

  const maxUsed = Math.max(
    0,
    Math.min(
      Number.isInteger(options.maxUsed) ? options.maxUsed : tiles.length,
      tiles.length
    )
  )
  const fullMask = tiles.length === 0
    ? 0n
    : (1n << BigInt(tiles.length)) - 1n
  const memo = new Map()

  function planKey(plan) {
    return plan.groups.map(group => group.key).sort().join('||')
  }

  function keepBest(map, plan) {
    const key = `${plan.usedCount}:${plan.requiredUsed ? 1 : 0}`
    const previous = map.get(key)
    if (
      !previous ||
      plan.score > previous.score ||
      (plan.score === previous.score && plan.key < previous.key)
    ) {
      map.set(key, plan)
    }
  }

  function solve(mask, capacity) {
    if (mask === 0n || capacity <= 0) {
      return new Map([[
        '0:0',
        { groups: [], score: 0, usedCount: 0, requiredUsed: false, key: '' },
      ]])
    }

    const memoKey = `${mask.toString(16)}:${capacity}`
    const cached = memo.get(memoKey)
    if (cached) return cached

    let firstIndex = -1
    for (let index = 0; index < tiles.length; index++) {
      if ((mask & (1n << BigInt(index))) !== 0n) {
        firstIndex = index
        break
      }
    }

    const firstBit = 1n << BigInt(firstIndex)
    const result = new Map()

    for (const skipped of solve(mask ^ firstBit, capacity).values()) {
      keepBest(result, skipped)
    }

    for (const candidate of byIndex[firstIndex]) {
      if (candidate.ids.length > capacity) continue
      if ((candidate.mask & mask) !== candidate.mask) continue

      for (const tail of solve(
        mask ^ candidate.mask,
        capacity - candidate.ids.length
      ).values()) {
        const groups = [candidate, ...tail.groups]
        const next = {
          groups,
          score: candidate.score + tail.score,
          usedCount: candidate.ids.length + tail.usedCount,
          requiredUsed:
            tail.requiredUsed ||
            Boolean(options.requiredId && candidate.ids.includes(options.requiredId)),
          key: '',
        }
        next.key = planKey(next)
        keepBest(result, next)
      }
    }

    memo.set(memoKey, result)
    return result
  }

  const plans = [...solve(fullMask, maxUsed).values()]
    .filter(plan => !options.requiredId || plan.requiredUsed)
    .filter(plan => plan.score >= (Number(options.minScore) || 0))
    .sort((a, b) => {
      if (b.usedCount !== a.usedCount) return b.usedCount - a.usedCount
      if (b.score !== a.score) return b.score - a.score
      return a.key.localeCompare(b.key)
    })

  return plans[0] || null
}

function normalizePlan(plan) {
  if (!plan) return null
  return {
    groups: plan.groups.map(group => [...group.ids]),
    score: plan.score,
    usedCount: plan.usedCount,
    requiredUsed: plan.requiredUsed,
  }
}

function findOpeningMeldPlan(hand, rules, options = {}) {
  if (!Array.isArray(hand) || hand.length < 4) return null

  const maxUsed = hand.length - 1
  const candidates = createMeldCandidates(hand, rules)
  const common = {
    requiredId: options.requiredId || null,
    maxUsed,
  }

  // Once 101 is legal, getting more physical tiles out of hand is normally
  // stronger than chasing a higher opening sum. For each used-tile count the
  // frontier solver keeps the highest score, then picks the largest count that
  // still satisfies 101 and the mandatory side-discard id.
  const openingPlan = solveCandidatePackingByUsedCount(hand, candidates, {
    ...common,
    minScore: 101,
  })

  if (openingPlan?.groups?.length) {
    return normalizePlan(openingPlan)
  }

  // Server rule: a 22-tile hand may put down exactly 21 legal meld tiles in
  // one initial opening even below 101, provided one discard remains.
  if (hand.length === 22) {
    const tilePlan = solveCandidatePacking(hand, candidates, {
      ...common,
      objective: 'tiles',
    })

    if (
      tilePlan &&
      tilePlan.usedCount === 21 &&
      (!common.requiredId || tilePlan.requiredUsed)
    ) {
      return normalizePlan(tilePlan)
    }
  }

  return null
}

function findAdditionalMeldPlan(hand, rules, options = {}) {
  if (!Array.isArray(hand) || hand.length < 4) return null

  const plan = solveCandidatePacking(
    hand,
    createMeldCandidates(hand, rules),
    {
      requiredId: options.requiredId || null,
      maxUsed: hand.length - 1,
      objective: 'tiles',
    }
  )

  if (
    !plan ||
    plan.groups.length === 0 ||
    (options.requiredId && !plan.requiredUsed)
  ) {
    return null
  }

  return normalizePlan(plan)
}

function findPairPlan(hand, rules, options = {}) {
  if (!Array.isArray(hand) || hand.length < 3) return null

  const plan = solveCandidatePacking(
    hand,
    createPairCandidates(hand, rules),
    {
      requiredId: options.requiredId || null,
      maxUsed: hand.length - 1,
      objective: 'tiles',
    }
  )

  const minimumPairs = Number(options.minimumPairs) || 1
  if (
    !plan ||
    plan.groups.length < minimumPairs ||
    (options.requiredId && !plan.requiredUsed)
  ) {
    return null
  }

  return normalizePlan(plan)
}

function findNormalLayoff(player, tableMelds, rules, requiredId = null) {
  const choices = []

  for (const tile of stableTiles(player.hand)) {
    if (requiredId && tile.id !== requiredId) continue
    if (player.hand.length <= 1) continue

    for (let meldIndex = 0; meldIndex < tableMelds.length; meldIndex++) {
      const preview = rules.previewLayoff(tableMelds[meldIndex], tile)
      if (!preview) continue

      choices.push({
        type: 'layoff',
        tileId: tile.id,
        meldIndex,
        joker: Boolean(rules.isRealJoker?.(tile)),
        penaltyValue: Number(rules.tilePenaltyValue?.(tile)) || 0,
      })
    }
  }

  choices.sort((a, b) => {
    if (a.joker !== b.joker) return a.joker ? 1 : -1
    if (b.penaltyValue !== a.penaltyValue) return b.penaltyValue - a.penaltyValue
    if (a.meldIndex !== b.meldIndex) return a.meldIndex - b.meldIndex
    return idNumber(a.tileId) - idNumber(b.tileId)
  })

  return choices[0] || null
}

function pairTargets(players) {
  return [...(players || [])]
    .filter(player => player.opened && player.openType === 'pairs')
    .sort((a, b) => String(a.seat).localeCompare(String(b.seat)))
}

function findPairLayoff(player, players, rules, requiredId = null) {
  if (player.hand.length <= 2) return null

  const targets = pairTargets(players)
  if (targets.length === 0) return null

  const pairs = createPairCandidates(player.hand, rules)
    .filter(pair => !requiredId || pair.ids.includes(requiredId))

  if (pairs.length === 0) return null

  const pair = pairs[0]
  return {
    type: 'layoff-pair',
    tileIds: [...pair.ids],
    targetSeat: targets[0].seat,
  }
}

function openingPlanAllowed(meldPlan, pairPlan, policy = null) {
  if (!policy || !Object.prototype.hasOwnProperty.call(policy, 'allowOpening')) {
    return { meldPlan, pairPlan }
  }

  return policy.allowOpening
    ? { meldPlan, pairPlan }
    : { meldPlan: null, pairPlan: null }
}

function chooseOpeningAction(player, rules, requiredId = null, policy = null) {
  const meldPlan = findOpeningMeldPlan(player.hand, rules, { requiredId })
  let pairPlan = findPairPlan(player.hand, rules, {
    requiredId,
    minimumPairs: 5,
  })
  let gatedMeldPlan = meldPlan

  const gated = openingPlanAllowed(gatedMeldPlan, pairPlan, policy)
  gatedMeldPlan = gated.meldPlan
  pairPlan = gated.pairPlan

  if (!gatedMeldPlan && !pairPlan) return null
  if (!gatedMeldPlan) {
    return { type: 'open-pairs', groups: pairPlan.groups }
  }
  if (!pairPlan) {
    return { type: 'open-melds', groups: gatedMeldPlan.groups }
  }

  // Compare the two legal openings by how many tiles they remove first, then
  // by remaining-value reduction. Stable tie-break keeps the policy deterministic.
  if (pairPlan.usedCount > gatedMeldPlan.usedCount) {
    return { type: 'open-pairs', groups: pairPlan.groups }
  }
  if (gatedMeldPlan.usedCount > pairPlan.usedCount) {
    return { type: 'open-melds', groups: gatedMeldPlan.groups }
  }

  if (gatedMeldPlan.score >= pairPlan.score) {
    return { type: 'open-melds', groups: gatedMeldPlan.groups }
  }

  return { type: 'open-pairs', groups: pairPlan.groups }
}

function findJokerReplacement(player, tableMelds, pairOpens, rules, requiredId = null) {
  if (!player?.hand || player.hand.length <= 1) return null

  const choices = []

  if (typeof rules.canReplaceJokerInMeldWithTile === 'function') {
    for (const tile of stableTiles(player.hand)) {
      if (requiredId && tile.id !== requiredId) continue
      for (let meldIndex = 0; meldIndex < (tableMelds || []).length; meldIndex++) {
        if (!rules.canReplaceJokerInMeldWithTile(tableMelds[meldIndex], tile)) continue
        choices.push({
          type: 'replace-joker-meld',
          tileId: tile.id,
          meldIndex,
          penaltyValue: Number(rules.tilePenaltyValue?.(tile)) || 0,
        })
      }
    }
  }

  if (typeof rules.canReplaceJokerInPairWithTile === 'function') {
    for (const tile of stableTiles(player.hand)) {
      if (requiredId && tile.id !== requiredId) continue
      for (let pairOpenIndex = 0; pairOpenIndex < (pairOpens || []).length; pairOpenIndex++) {
        const pairOpen = pairOpens[pairOpenIndex]
        for (let pairIndex = 0; pairIndex < (pairOpen?.pairs || []).length; pairIndex++) {
          if (!rules.canReplaceJokerInPairWithTile(pairOpen.pairs[pairIndex], tile)) continue
          choices.push({
            type: 'replace-joker-pair',
            tileId: tile.id,
            pairOpenIndex,
            pairIndex,
            penaltyValue: Number(rules.tilePenaltyValue?.(tile)) || 0,
          })
        }
      }
    }
  }

  choices.sort((a, b) => {
    if (b.penaltyValue !== a.penaltyValue) return b.penaltyValue - a.penaltyValue
    if (a.type !== b.type) return a.type.localeCompare(b.type)
    if ((a.meldIndex ?? a.pairOpenIndex) !== (b.meldIndex ?? b.pairOpenIndex)) {
      return (a.meldIndex ?? a.pairOpenIndex) - (b.meldIndex ?? b.pairOpenIndex)
    }
    return idNumber(a.tileId) - idNumber(b.tileId)
  })

  return choices[0] || null
}

function chooseNextTableAction(context) {
  const { player, players, tableMelds, pairOpens = [], rules } = context
  if (!player?.mustDiscard || player.hand.length <= 1) return null

  const requiredId = player.pickedDiscardId || context.requiredId || null

  if (!player.opened) {
    return chooseOpeningAction(player, rules, requiredId, context.openingPolicy || null)
  }

  // A picked side-discard must be consumed before any unrelated table action.
  if (requiredId) {
    const replacement = findJokerReplacement(
      player,
      tableMelds,
      pairOpens,
      rules,
      requiredId
    )
    if (replacement) return replacement

    const layoff = findNormalLayoff(player, tableMelds, rules, requiredId)
    if (layoff) return layoff

    const pairLayoff = findPairLayoff(player, players, rules, requiredId)
    if (pairLayoff) return pairLayoff

    if (player.openType === 'normal') {
      const meldPlan = findAdditionalMeldPlan(player.hand, rules, { requiredId })
      if (meldPlan) {
        return { type: 'open-melds', groups: meldPlan.groups }
      }
    }
    else if (player.openType === 'pairs') {
      const ownPairs = findPairPlan(player.hand, rules, {
        requiredId,
        minimumPairs: 1,
      })
      if (ownPairs) {
        return { type: 'open-pairs', groups: ownPairs.groups }
      }
    }

    return null
  }

  // Replacing a table joker can unlock an additional wildcard in the same
  // turn, so it is considered before ordinary one-tile layoff in V1 too.
  const replacement = findJokerReplacement(player, tableMelds, pairOpens, rules)
  if (replacement) return replacement

  // Prefer getting already-open table value out of hand before creating new
  // melds. V2 performs deeper look-ahead; V1 stays intentionally conservative.
  const layoff = findNormalLayoff(player, tableMelds, rules)
  if (layoff) return layoff

  const pairLayoff = findPairLayoff(player, players, rules)
  if (pairLayoff) return pairLayoff

  if (player.openType === 'normal') {
    const meldPlan = findAdditionalMeldPlan(player.hand, rules)
    if (meldPlan) {
      return { type: 'open-melds', groups: meldPlan.groups }
    }
  }
  else if (player.openType === 'pairs') {
    const ownPairs = findPairPlan(player.hand, rules, { minimumPairs: 1 })
    if (ownPairs) {
      return { type: 'open-pairs', groups: ownPairs.groups }
    }
  }

  return null
}

function actionUsesTile(action, tileId) {
  if (!action || !tileId) return false
  if (action.type === 'layoff') return action.tileId === tileId
  if (action.type === 'replace-joker-meld' || action.type === 'replace-joker-pair') {
    return action.tileId === tileId
  }
  if (action.type === 'layoff-pair') return action.tileIds.includes(tileId)
  if (action.type === 'open-melds' || action.type === 'open-pairs') {
    return action.groups.flat().includes(tileId)
  }
  return false
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

  const action = chooseNextTableAction({
    ...context,
    player,
    requiredId: tile.id,
    // Pickup değerlendirmesi "bu taşı alırsam bu tur zorunlu olarak
    // kullanabilir miyim?" sorusudur. Açılış bekleme politikası bu legality
    // testini engelleyemez; taşı aldıktan sonra mandatory-use üstün gelir.
    openingPolicy: player.opened
      ? context.openingPolicy
      : { allowOpening: true },
  })

  return actionUsesTile(action, tile.id)
}

function structuralKeepScore(tile, hand, rules) {
  if (rules.isRealJoker?.(tile)) return 100000

  const effective = rules.getEffectiveTile(tile)
  if (effective.wildcard) return 100000

  let score = 0

  for (const other of hand) {
    if (other.id === tile.id) continue
    if (rules.isRealJoker?.(other)) continue

    const otherEffective = rules.getEffectiveTile(other)
    if (otherEffective.wildcard) continue

    if (
      otherEffective.color === effective.color &&
      otherEffective.number === effective.number
    ) {
      score += 120
      continue
    }

    if (
      otherEffective.number === effective.number &&
      otherEffective.color !== effective.color
    ) {
      score += 38
    }

    if (otherEffective.color === effective.color) {
      const distance = Math.abs(otherEffective.number - effective.number)
      if (distance === 1) score += 48
      else if (distance === 2) score += 20
    }
  }

  return score
}

const BOT_SEAT_ORDER = [
  'player-bottom',
  'player-right',
  'player-top',
  'player-left',
]

function visibleEffectiveIdentityCount(context, color, number) {
  let count = 0
  for (const visible of context?.knownVisibleTiles || []) {
    const effective = context?.rules?.getEffectiveTile?.(visible)
    if (!effective || effective.wildcard) continue
    if (effective.color === color && Number(effective.number) === Number(number)) {
      count++
    }
  }
  return count
}

function unseenEffectiveCopies(context, color, number) {
  if (!color || number < 1 || number > 13) return 0
  return Math.max(0, 2 - visibleEffectiveIdentityCount(context, color, number))
}

function highDiscardSupportAvailability(tile, context) {
  const effective = context?.rules?.getEffectiveTile?.(tile)
  if (!effective || effective.wildcard) return 0

  let unseen = 0
  let total = 0

  // Aynı sayının diğer renkleri: set açılışında bu discardı değerli yapabilir.
  for (const color of context?.rules?.colors || DEFAULT_COLORS) {
    if (color === effective.color) continue
    unseen += unseenEffectiveCopies(context, color, effective.number)
    total += 2
  }

  // Aynı rengin yakın komşuları: özellikle +/-1, sonra +/-2 run desteğidir.
  for (const [distance, weight] of [[1, 1.35], [2, 0.65]]) {
    for (const number of [effective.number - distance, effective.number + distance]) {
      if (number < 1 || number > 13) continue
      unseen += unseenEffectiveCopies(context, effective.color, number) * weight
      total += 2 * weight
    }
  }

  return total > 0 ? unseen / total : 0
}

function highDiscardSourcePenaltyRisk(tile, context) {
  // Yandan alınan taş ilk açılışta kullanılırsa kaynak oyuncuya sayı x10 ceza
  // yazılıyor. Bu yüzden 8-13, sıradaki rakip henüz açmamışken yalnızca
  // "yüksek elde cezası" değil gerçek bir servis riski olarak değerlendirilir.
  if (!(Number(context?.stockCount) > 0)) return 0

  const seatIndex = BOT_SEAT_ORDER.indexOf(context?.player?.seat)
  if (seatIndex < 0) return 0

  const receiverSeat = BOT_SEAT_ORDER[(seatIndex + 1) % BOT_SEAT_ORDER.length]
  const receiver = (context?.players || []).find(
    player => player?.seat === receiverSeat
  )

  // Rakip daha önce açtıysa bu yandan alış artık kaynak x10 cezasını doğurmaz.
  if (!receiver || receiver.opened) return 0

  const effective = context?.rules?.getEffectiveTile?.(tile)
  if (!effective || effective.wildcard) return 0

  const number = Number(effective.number) || 0
  if (number < 8 || number > 13) return 0

  const stockCount = Math.max(0, Number(context?.stockCount) || 0)
  let phaseFactor = 1.05
  if (stockCount <= 2) phaseFactor = 1.5
  else if (stockCount <= 6) phaseFactor = 1.38
  else if (stockCount <= 12) phaseFactor = 1.25
  else if (stockCount <= 20) phaseFactor = 1.12

  // Public bilgide destek taşlarının çoğu hâlâ görünmüyorsa rakibin bu taşı
  // ilk açılışında kullanabilme ihtimali daha yüksek kabul edilir. Bu gizli el
  // okumak değildir; yalnız masada herkesin gördüğü fiziksel taşları kullanır.
  const supportAvailability = highDiscardSupportAvailability(tile, context)
  const availabilityFactor = 0.82 + (Math.max(0, Math.min(1, supportAvailability)) * 0.33)

  // Aynı fiziksel/effective taşın diğer kopyası görünmüyorsa çift açılış
  // ihtimaline küçük ama anlamlı bir ek risk verilir.
  const twinUnseen = unseenEffectiveCopies(
    context,
    effective.color,
    effective.number
  ) > 0
  const pairOpeningRisk = twinUnseen ? number * 2.5 : 0

  // 11-13 özellikle pahalı servislerdir; baz x10 cezanın üstünde ek koruma.
  const veryHighPremium = number >= 11 ? (number - 10) * 10 : 0

  return (
    (number * 10 * phaseFactor * availabilityFactor) +
    pairOpeningRisk +
    veryHighPremium
  )
}

function completeMeldTileIds(hand, rules) {
  const protectedIds = new Set()
  const tiles = stableTiles(hand)
  const records = []
  const colorsByNumber = new Map()
  const numbersByColor = new Map()
  let wildcardCount = 0

  for (const tile of tiles) {
    const effective = rules.getEffectiveTile(tile)
    if (!effective) continue
    if (effective.wildcard) {
      wildcardCount++
      protectedIds.add(tile.id)
      continue
    }

    records.push({ tile, effective })

    const colors = colorsByNumber.get(effective.number) || new Set()
    colors.add(effective.color)
    colorsByNumber.set(effective.number, colors)

    const numbers = numbersByColor.get(effective.color) || new Set()
    numbers.add(effective.number)
    numbersByColor.set(effective.color, numbers)
  }

  // Bu yalnız discard koruması için hızlı bir yapısal testtir. Normal legality
  // yine server validatorlarından geçer. Amaç tamamlanmış 3+ perin taşlarını,
  // yüksek discard riskini hesaplarken gereksiz yere parçalamamaktır.
  for (const { tile, effective } of records) {
    const sameNumberColors = colorsByNumber.get(effective.number) || new Set()
    if (sameNumberColors.size + wildcardCount >= 3) {
      protectedIds.add(tile.id)
      continue
    }

    const sameColorNumbers = numbersByColor.get(effective.color) || new Set()
    const minStart = Math.max(1, effective.number - 2)
    const maxStart = Math.min(effective.number, 11)

    for (let start = minStart; start <= maxStart; start++) {
      let missing = 0
      for (let number = start; number <= start + 2; number++) {
        if (!sameColorNumbers.has(number)) missing++
      }
      if (missing <= wildcardCount) {
        protectedIds.add(tile.id)
        break
      }
    }
  }

  return protectedIds
}

function chooseDiscard(context) {
  const { player, rules, tableMelds, pairOpens = [] } = context
  const hand = stableTiles(player.hand)
  if (hand.length === 0) return null
  if (hand.length === 1) return hand[0]

  const completeMeldIds = completeMeldTileIds(hand, rules)
  const ranked = hand.map(tile => {
    const sourcePenaltyRisk = highDiscardSourcePenaltyRisk(tile, context)
    let keepScore = structuralKeepScore(tile, hand, rules)
    keepScore += sourcePenaltyRisk
    if (completeMeldIds.has(tile.id)) keepScore += 180

    // Normally this situation should already have been consumed by
    // chooseNextTableAction; the extra protection makes the discard policy
    // robust if another action becomes unavailable during execution.
    const canLayoff = tableMelds.some(meld => rules.previewLayoff(meld, tile))
    if (canLayoff) keepScore += 5000

    const canReplaceMeld = typeof rules.canReplaceJokerInMeldWithTile === 'function' &&
      tableMelds.some(meld => rules.canReplaceJokerInMeldWithTile(meld, tile))
    const canReplacePair = typeof rules.canReplaceJokerInPairWithTile === 'function' &&
      pairOpens.some(pairOpen => (pairOpen?.pairs || []).some(
        pair => rules.canReplaceJokerInPairWithTile(pair, tile)
      ))
    if (canReplaceMeld || canReplacePair) keepScore += 8000

    return {
      tile,
      keepScore,
      sourcePenaltyRisk,
      penaltyValue: Number(rules.tilePenaltyValue?.(tile)) || 0,
    }
  })

  ranked.sort((a, b) => {
    if (a.keepScore !== b.keepScore) return a.keepScore - b.keepScore

    // Eşit yapısal değerde ve kaynak-ceza riski aktifken güvenli olan düşük
    // taşı önce çıkar. Risk yoksa eski davranış korunur: elde daha pahalı taşı
    // atarak kendi round-sonu cezasını azaltır.
    if (a.sourcePenaltyRisk !== b.sourcePenaltyRisk) {
      return a.sourcePenaltyRisk - b.sourcePenaltyRisk
    }
    if (a.sourcePenaltyRisk > 0 && b.sourcePenaltyRisk > 0) {
      if (a.penaltyValue !== b.penaltyValue) return a.penaltyValue - b.penaltyValue
    }
    else if (b.penaltyValue !== a.penaltyValue) {
      return b.penaltyValue - a.penaltyValue
    }
    return compareTileId(a.tile, b.tile)
  })

  return ranked[0]?.tile || null
}

// Ortadaki gösterge sabit masa objesidir; BOT hiçbir koşulda alamaz.
// API eski regresyon testleriyle uyumluluk için tutulur.
function canFinishWithPickup() {
  return false
}


module.exports = {
  canFinishWithPickup,
  canUsePickup,
  chooseDiscard,
  chooseNextTableAction,
  createMeldCandidates,
  createPairCandidates,
  findAdditionalMeldPlan,
  findJokerReplacement,
  findNormalLayoff,
  findOpeningMeldPlan,
  findPairLayoff,
  findPairPlan,
  structuralKeepScore,
  highDiscardSourcePenaltyRisk,
  completeMeldTileIds,
}
