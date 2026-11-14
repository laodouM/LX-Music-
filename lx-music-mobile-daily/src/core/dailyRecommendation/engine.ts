import { getTrackKey, normalizeText } from './history'
import type { PublicDiscovery } from './metadata'
import {
  createEmptyTagProfile,
  getDimensionMatch,
  getTagLabel,
  getTopWeightedTags,
  type DailyScene,
  type SongTagProfile,
  type TagDimension,
  type TagWeights,
} from './tags'

export type CandidateRoute = 'artist' | 'similar-artist' | 'similar-track' | 'tag' | 'hot'

export interface WeightedName {
  name: string
  weight: number
}

export interface BehaviorSeed {
  musicInfo: LX.Music.MusicInfo
  weight: number
}

export interface RecommendationPreferences {
  artistWeights: Map<string, WeightedName>
  tagWeights: SongTagProfile
  eraWeights: TagWeights
  knownIds: Set<string>
  knownKeys: Set<string>
  seedCount: number
}

export interface Candidate {
  musicInfo: LX.Music.MusicInfoOnline
  route: CandidateRoute
  queryArtist: string | null
  order: number
  similarity: number
  profile: SongTagProfile
}

export interface ScoredCandidate extends Candidate {
  key: string
  group: string
  album: string
  score: number
}

export interface ScoreOptions {
  seed: number
  scene: DailyScene
  exposures: Record<string, number>
  now?: number
}

const IGNORED_ARTISTS = new Set(['群星', '未知', '未知艺术家', 'variousartists', 'unknown', 'unknownartist'])

export const hashNumber = (text: string) => {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export const seededValue = (seed: number, key: string) => hashNumber(`${seed}:${key}`) / 4294967295

export const splitArtists = (singer: string) => {
  const names = singer.split(/[,，、;&；|]/).flatMap(part => part.split('/')).map(name => name.trim()).filter(Boolean)
  return names.length ? names : [singer.trim()]
}

export const getArtistKey = (singer: string) => normalizeText(splitArtists(singer)[0] ?? singer)

const addArtistWeight = (weights: Map<string, WeightedName>, singer: string, value: number) => {
  for (const name of splitArtists(singer)) {
    const key = normalizeText(name)
    if (!key || IGNORED_ARTISTS.has(key)) continue
    const current = weights.get(key)
    if (current) current.weight += value
    else weights.set(key, { name, weight: value })
  }
}

const addWeights = (target: TagWeights, source: TagWeights, scale: number) => {
  for (const [tag, value] of Object.entries(source)) target[tag] = (target[tag] ?? 0) + value * scale
}

export const buildPreferences = (
  seeds: BehaviorSeed[],
  knownIds: Set<string>,
  knownKeys: Set<string>,
  metadata: PublicDiscovery,
): RecommendationPreferences => {
  const artistWeights = new Map<string, WeightedName>()
  const tagWeights = createEmptyTagProfile()
  const eraWeights: TagWeights = {}
  for (const seed of seeds) {
    const { musicInfo, weight } = seed
    addArtistWeight(artistWeights, musicInfo.singer, weight)
    const track = metadata.tracks[getTrackKey(musicInfo)]
    if (track) {
      for (const dimension of ['styles', 'languages', 'moods', 'scenes'] as TagDimension[]) {
        addWeights(tagWeights[dimension], track.profile[dimension], weight)
      }
      if (track.profile.era) eraWeights[track.profile.era] = (eraWeights[track.profile.era] ?? 0) + weight
    }
    const primaryArtist = normalizeText(splitArtists(musicInfo.singer)[0] ?? musicInfo.singer)
    const artist = metadata.artists[primaryArtist]
    if (artist) {
      for (const dimension of ['styles', 'languages', 'moods', 'scenes'] as TagDimension[]) {
        addWeights(tagWeights[dimension], artist.profile[dimension], weight * 0.75)
      }
    }
  }
  return { artistWeights, tagWeights, eraWeights, knownIds, knownKeys, seedCount: seeds.length }
}

export const weightedSample = <T extends WeightedName>(items: T[], count: number, seed: number): T[] => {
  return items.map((item, index) => {
    const weight = Math.max(0.0001, item.weight)
    const random = Math.max(0.000001, seededValue(seed + index, item.name))
    return { item, rank: Math.pow(random, 1 / weight) }
  }).sort((a, b) => b.rank - a.rank || a.item.name.localeCompare(b.item.name))
    .slice(0, count)
    .map(({ item }) => item)
}

const getArtistPreference = (
  musicInfo: LX.Music.MusicInfoOnline,
  queryArtist: string | null,
  artistWeights: Map<string, WeightedName>,
) => {
  const singerKeys = splitArtists(musicInfo.singer).map(normalizeText)
  const queryKey = queryArtist ? normalizeText(queryArtist) : ''
  let weight = 0
  for (const [key, artist] of artistWeights) {
    if (singerKeys.some(singer => singer.includes(key) || key.includes(singer))) weight = Math.max(weight, artist.weight)
  }
  if (queryKey && singerKeys.some(singer => singer.includes(queryKey) || queryKey.includes(singer))) {
    weight = Math.max(weight, artistWeights.get(queryKey)?.weight ?? 0)
  }
  return weight
}

const getExposurePenalty = (timestamp: number | undefined, now: number) => {
  if (!timestamp) return 0
  const age = Math.max(0, now - timestamp)
  if (age < 86400000) return 5
  if (age < 7 * 86400000) return 3.5
  if (age < 14 * 86400000) return 1.5
  return 0
}

const hasSceneTags = (profile: SongTagProfile) => Object.values(profile.scenes).some(value => value > 0)

export const scoreCandidates = (
  candidates: Candidate[],
  preferences: RecommendationPreferences,
  options: ScoreOptions,
): ScoredCandidate[] => {
  const ids = new Set<string>()
  const keys = new Set<string>()
  const maxArtistWeight = Math.max(1, ...[...preferences.artistWeights.values()].map(item => item.weight))
  const now = options.now ?? Date.now()
  const scored: ScoredCandidate[] = []

  for (const candidate of candidates) {
    const { musicInfo, profile } = candidate
    const key = getTrackKey(musicInfo)
    if (!musicInfo.id || !musicInfo.name || preferences.knownIds.has(musicInfo.id) || preferences.knownKeys.has(key) || ids.has(musicInfo.id) || keys.has(key)) continue
    ids.add(musicInfo.id)
    keys.add(key)

    const artistScore = getArtistPreference(musicInfo, candidate.queryArtist, preferences.artistWeights) / maxArtistWeight
    const styleScore = getDimensionMatch(preferences.tagWeights.styles, profile.styles)
    const languageScore = getDimensionMatch(preferences.tagWeights.languages, profile.languages)
    const moodScore = getDimensionMatch(preferences.tagWeights.moods, profile.moods)
    const eraScore = profile.era ? Math.min(1, (preferences.eraWeights[profile.era] ?? 0) / Math.max(1, ...Object.values(preferences.eraWeights))) : 0
    const sceneWeights: TagWeights = options.scene == 'all' ? preferences.tagWeights.scenes : { [options.scene]: 1 }
    const sceneScore = getDimensionMatch(sceneWeights, profile.scenes)
    const popularityScore = 1 / (1 + candidate.order / 8)
    const explorationScore = seededValue(options.seed, `${candidate.route}:${musicInfo.id}`)
    const similarityScore = Math.max(0, Math.min(1, candidate.similarity))
    const sceneWeight = options.scene == 'all' ? 0.5 : 4.8
    const mismatchPenalty = options.scene != 'all' && !sceneScore && hasSceneTags(profile) ? 0.8 : 0

    const score = artistScore * 3.2 +
      styleScore * 2.4 +
      languageScore * 1.1 +
      moodScore * 0.9 +
      eraScore * 0.6 +
      sceneScore * sceneWeight +
      similarityScore * 2.4 +
      popularityScore * 0.35 +
      explorationScore * 1.2 +
      (candidate.route == 'hot' ? 0.15 : 0) -
      getExposurePenalty(options.exposures[key], now) -
      mismatchPenalty

    const group = getArtistKey(musicInfo.singer)
    const albumName = normalizeText(musicInfo.meta.albumName ?? '')
    scored.push({
      ...candidate,
      key,
      score,
      group,
      album: albumName ? `${group}__${albumName}` : '',
    })
  }
  return scored.sort((a, b) => b.score - a.score || a.musicInfo.id.localeCompare(b.musicInfo.id))
}

const profileRedundancy = (a: SongTagProfile, b: SongTagProfile) => {
  let common = 0
  for (const dimension of ['styles', 'moods', 'scenes'] as TagDimension[]) {
    for (const tag of Object.keys(a[dimension])) {
      if ((b[dimension][tag] ?? 0) > 0) common += Math.min(a[dimension][tag], b[dimension][tag])
    }
  }
  return Math.min(1, common / 3)
}

export const selectDiverse = (scored: ScoredCandidate[], limit: number, seed: number) => {
  const selected: ScoredCandidate[] = []
  const selectedIndexes = new Set<number>()

  const fill = (artistCap: number) => {
    while (selected.length < limit) {
      let bestIndex = -1
      let bestScore = -Infinity
      const artistCounts = new Map<string, number>()
      const albumCounts = new Map<string, number>()
      for (const item of selected) {
        artistCounts.set(item.group, (artistCounts.get(item.group) ?? 0) + 1)
        if (item.album) albumCounts.set(item.album, (albumCounts.get(item.album) ?? 0) + 1)
      }
      for (let index = 0; index < scored.length; index++) {
        if (selectedIndexes.has(index)) continue
        const candidate = scored[index]
        const artistCount = artistCounts.get(candidate.group) ?? 0
        const albumCount = candidate.album ? albumCounts.get(candidate.album) ?? 0 : 0
        if (artistCount >= artistCap || albumCount >= 2) continue
        let redundancy = artistCount * 0.85 + albumCount * 0.35
        for (const item of selected.slice(-6)) redundancy = Math.max(redundancy, profileRedundancy(candidate.profile, item.profile) * 0.45)
        const jitter = seededValue(seed + selected.length, candidate.musicInfo.id) * 0.05
        const finalScore = candidate.score - redundancy + jitter
        if (finalScore > bestScore) {
          bestScore = finalScore
          bestIndex = index
        }
      }
      if (bestIndex < 0) break
      selectedIndexes.add(bestIndex)
      selected.push(scored[bestIndex])
    }
  }

  fill(2)
  if (selected.length < limit) fill(3)
  if (selected.length < limit) fill(limit)
  return selected
}

export const getPreferenceLabels = (preferences: RecommendationPreferences) => {
  const labels = [
    ...getTopWeightedTags(preferences.tagWeights.languages, 1).map(tag => getTagLabel('languages', tag)),
    ...getTopWeightedTags(preferences.tagWeights.styles, 2).map(tag => getTagLabel('styles', tag)),
    ...getTopWeightedTags(preferences.tagWeights.moods, 1).map(tag => getTagLabel('moods', tag)),
    ...getTopWeightedTags(preferences.eraWeights, 1),
  ]
  if (labels.length) return [...new Set(labels)].slice(0, 4)
  return [...preferences.artistWeights.values()]
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, 4)
    .map(artist => artist.name)
}
