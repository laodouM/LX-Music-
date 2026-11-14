import { LIST_IDS, storageDataPrefix } from '@/config/constant'
import { getBoardsList, getListDetail } from '@/core/leaderboard'
import { hasDislike } from '@/core/dislikeList'
import { getListMusics } from '@/core/list'
import { getData, saveData } from '@/plugins/storage'
import listState from '@/store/list/state'
import { toNewMusicInfo } from '@/utils'
import musicSdk from '@/utils/musicSdk'
import {
  buildPreferences,
  getPreferenceLabels,
  hashNumber,
  scoreCandidates,
  selectDiverse,
  splitArtists,
  weightedSample,
  type Candidate,
  type CandidateRoute,
  type ScoredCandidate,
} from './engine'
import { recordRecommendationExposures, getRecommendationExposures } from './exposure'
import { getListenHistory, getTrackKey, normalizeText, recordMusicPlay } from './history'
import { discoverPublicMetadata, type PublicDiscovery } from './metadata'
import {
  createEmptyTagProfile,
  createSceneProfile,
  getTagLabel,
  getTopWeightedTags,
  mergeTagProfiles,
  type DailyScene,
  type SongTagProfile,
} from './tags'

export { recordMusicPlay }
export type { DailyScene } from './tags'

export interface DailyRecommendationResult {
  version: 2
  date: string
  scene: DailyScene
  list: LX.Music.MusicInfoOnline[]
  artists: string[]
  tags: string[]
  personalized: boolean
}

const DAILY_LIMIT = 20
const ARTIST_SEARCH_LIMIT = 24
const SIMILAR_ARTIST_SEARCH_LIMIT = 20
const TAG_SEARCH_LIMIT = 15
const SEARCH_SOURCES: LX.OnlineSource[] = ['kw', 'tx', 'mg']

const SCENE_SEARCH_QUERIES: Record<Exclude<DailyScene, 'all'>, string> = {
  calm: '安静 轻音乐',
  focus: '学习 纯音乐',
  workout: '运动 健身',
  night: '夜晚 轻音乐',
  commute: '通勤 驾驶',
}

const getLocalDateKey = () => {
  const date = new Date()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const collectBehaviorData = async() => {
  const history = await getListenHistory()
  const [loveList, userLists] = await Promise.all([
    getListMusics(LIST_IDS.LOVE).catch(() => []),
    Promise.all(listState.userList.map(async list => getListMusics(list.id).catch(() => []))),
  ])
  const seeds: Array<{ musicInfo: LX.Music.MusicInfo, weight: number }> = []
  const knownIds = new Set<string>()
  const knownKeys = new Set<string>()
  const addKnown = (musicInfo: LX.Music.MusicInfo) => {
    knownIds.add(musicInfo.id)
    knownKeys.add(getTrackKey(musicInfo))
  }

  for (const item of history) {
    const ageDays = Math.max(0, (Date.now() - item.lastPlayedAt) / 86400000)
    const recencyWeight = 0.7 + Math.max(0, 45 - ageDays) / 45
    const weight = Math.min(4, Math.log2(item.playCount + 1) * 1.5) * recencyWeight
    seeds.push({ musicInfo: item.musicInfo, weight })
    addKnown(item.musicInfo)
  }
  const lists = [loveList, ...userLists]
  lists.forEach((list, listIndex) => {
    for (const musicInfo of list) {
      seeds.push({ musicInfo, weight: listIndex == 0 ? 6 : 3 })
      addKnown(musicInfo)
    }
  })
  return { seeds, knownIds, knownKeys }
}

const searchMusic = async(query: string, limit: number): Promise<LX.Music.MusicInfoOnline[]> => {
  for (const source of SEARCH_SOURCES) {
    try {
      const result = await musicSdk[source]?.musicSearch.search(query, 1, limit)
      if (!result?.list?.length) continue
      return result.list.map((info: any) => toNewMusicInfo(info) as LX.Music.MusicInfoOnline)
    } catch (error) {
      console.log(`daily recommendation search failed[${source}]:`, error)
    }
  }
  return []
}

const getHotCandidates = async(seed: number): Promise<LX.Music.MusicInfoOnline[]> => {
  const sources = [...SEARCH_SOURCES].sort((a, b) => hashNumber(`${seed}:${a}`) - hashNumber(`${seed}:${b}`))
  for (const source of sources) {
    try {
      let boardId = '16'
      if (source != 'kw') {
        const boards = await getBoardsList(source)
        if (!boards.length) continue
        boardId = boards[0].bangid
      }
      const page = 1 + seed % 3
      const result = await getListDetail(`${source}__${boardId}`, page, true)
      if (result.list.length) return result.list
    } catch (error) {
      console.log(`daily recommendation hot list failed[${source}]:`, error)
    }
  }
  return []
}

const emptyDiscovery = (): PublicDiscovery => ({
  tracks: {},
  artists: {},
  artistMbids: {},
  similarTracks: [],
  similarArtists: [],
})

const buildCandidateProfile = (
  musicInfo: LX.Music.MusicInfoOnline,
  queryArtist: string | null,
  metadata: PublicDiscovery,
  baseProfile?: SongTagProfile,
) => {
  const profile = createEmptyTagProfile()
  mergeTagProfiles(profile, baseProfile)
  const artistNames = new Set(splitArtists(musicInfo.singer).map(normalizeText))
  if (queryArtist) artistNames.add(normalizeText(queryArtist))
  for (const name of artistNames) {
    mergeTagProfiles(profile, metadata.artists[name]?.profile, 0.65)
  }
  return profile
}

const createArtistTask = async(
  artist: string,
  route: CandidateRoute,
  similarity: number,
  metadata: PublicDiscovery,
  sourceProfile?: SongTagProfile,
): Promise<Candidate[]> => {
  const limit = route == 'artist' ? ARTIST_SEARCH_LIMIT : SIMILAR_ARTIST_SEARCH_LIMIT
  const list = await searchMusic(artist, limit)
  return list.map((musicInfo, order) => ({
    musicInfo,
    route,
    queryArtist: artist,
    order,
    similarity,
    profile: buildCandidateProfile(musicInfo, artist, metadata, sourceProfile),
  }))
}

const isExpectedTrack = (musicInfo: LX.Music.MusicInfoOnline, name: string, artist: string) => {
  const expectedName = normalizeText(name)
  const actualName = normalizeText(musicInfo.name)
  const nameMatched = actualName == expectedName || actualName.includes(expectedName) || expectedName.includes(actualName)
  if (!nameMatched) return false
  const expectedArtists = splitArtists(artist).map(normalizeText)
  const actualArtists = splitArtists(musicInfo.singer).map(normalizeText)
  return expectedArtists.some(expected => actualArtists.some(actual => actual.includes(expected) || expected.includes(actual)))
}

const createSimilarTrackTask = async(
  name: string,
  artist: string,
  similarity: number,
  metadata: PublicDiscovery,
  sourceProfile: SongTagProfile,
): Promise<Candidate[]> => {
  const list = await searchMusic(`${name} ${artist}`, 6)
  const musicInfo = list.find(item => isExpectedTrack(item, name, artist))
  if (!musicInfo) return []
  return [{
    musicInfo,
    route: 'similar-track',
    queryArtist: null,
    order: 0,
    similarity,
    profile: buildCandidateProfile(musicInfo, null, metadata, sourceProfile),
  }]
}

const getCachedRecommendation = async(date: string, scene: DailyScene) => {
  const cached = await getData<DailyRecommendationResult>(storageDataPrefix.dailyRecommendationCache)
  if (cached?.version == 2 && cached.date == date && cached.scene == scene && Array.isArray(cached.list) && cached.list.length) return cached
  return null
}

export const getDailyRecommendation = async(
  force = false,
  scene: DailyScene = 'all',
): Promise<DailyRecommendationResult> => {
  const date = getLocalDateKey()
  if (!force) {
    const cached = await getCachedRecommendation(date, scene)
    if (cached) return cached
  }

  const behavior = await collectBehaviorData()
  const initialPreferences = buildPreferences(behavior.seeds, behavior.knownIds, behavior.knownKeys, emptyDiscovery())
  const sortedArtists = [...initialPreferences.artistWeights.values()]
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
  const publicSeedMap = new Map<string, { key: string, name: string, singer: string, weight: number }>()
  for (const seed of [...behavior.seeds].sort((a, b) => b.weight - a.weight)) {
    const key = getTrackKey(seed.musicInfo)
    if (!publicSeedMap.has(key)) {
      publicSeedMap.set(key, {
        key,
        name: seed.musicInfo.name,
        singer: seed.musicInfo.singer,
        weight: seed.weight,
      })
    }
  }
  const publicSeeds = [...publicSeedMap.values()].slice(0, 6)
  const metadata = await discoverPublicMetadata(publicSeeds, sortedArtists.slice(0, 6).map(artist => artist.name)).catch(error => {
    console.log('daily public metadata discovery failed:', error)
    return emptyDiscovery()
  })
  const preferences = buildPreferences(behavior.seeds, behavior.knownIds, behavior.knownKeys, metadata)
  const originalKnownKeys = new Set(preferences.knownKeys)
  const seed = force ? Date.now() : hashNumber(`${date}:${scene}`)
  const previousCache = await getData<DailyRecommendationResult>(storageDataPrefix.dailyRecommendationCache).catch(() => null)
  if (force && previousCache?.list?.length) {
    for (const musicInfo of previousCache.list) preferences.knownKeys.add(getTrackKey(musicInfo))
  }

  const candidateTasks: Array<Promise<Candidate[]>> = []
  const preferredArtists = sortedArtists.slice(0, 16)
  const selectedArtists = weightedSample(preferredArtists, Math.min(10, preferredArtists.length), seed)
  for (const artist of selectedArtists) {
    candidateTasks.push(createArtistTask(artist.name, 'artist', 0, metadata))
  }

  const preferredKeys = new Set(preferredArtists.map(artist => normalizeText(artist.name)))
  const similarArtists = metadata.similarArtists
    .filter(artist => !preferredKeys.has(normalizeText(artist.name)))
  const maxArtistSimilarity = Math.max(1, ...similarArtists.map(artist => artist.score))
  const similarArtistChoices = weightedSample(
    similarArtists.map(artist => ({ ...artist, weight: artist.score / maxArtistSimilarity })),
    Math.min(5, similarArtists.length),
    seed + 11,
  )
  for (const artist of similarArtistChoices) {
    const sourceProfile = metadata.artists[artist.sourceArtist]?.profile
    candidateTasks.push(createArtistTask(artist.name, 'similar-artist', artist.score / maxArtistSimilarity, metadata, sourceProfile))
  }

  const knownPublicKeys = new Set(behavior.knownKeys)
  const similarTracks = metadata.similarTracks.filter(track => !knownPublicKeys.has(normalizeText(`${track.name}__${track.artist}`)))
  const maxTrackSimilarity = Math.max(1, ...similarTracks.map(track => track.score))
  const similarTrackChoices = weightedSample(
    similarTracks.map(track => ({ ...track, name: `${track.name} ${track.artist}`, weight: track.score / maxTrackSimilarity })),
    Math.min(4, similarTracks.length),
    seed + 23,
  )
  for (const choice of similarTrackChoices) {
    const track = similarTracks.find(item => `${item.name} ${item.artist}` == choice.name)
    if (!track) continue
    const sourceProfile = metadata.tracks[track.sourceKey]?.profile ?? track.profile
    candidateTasks.push(createSimilarTrackTask(track.name, track.artist, track.score / maxTrackSimilarity, metadata, sourceProfile))
  }

  if (scene != 'all') {
    const profile = createSceneProfile(scene)
    const query = SCENE_SEARCH_QUERIES[scene]
    candidateTasks.push(searchMusic(query, TAG_SEARCH_LIMIT).then(list => list.map((musicInfo, order) => ({
      musicInfo,
      route: 'tag' as const,
      queryArtist: null,
      order,
      similarity: 0.25,
      profile: buildCandidateProfile(musicInfo, null, metadata, profile),
    }))))
  } else {
    const styleTags = getTopWeightedTags(preferences.tagWeights.styles, 2)
    for (const style of styleTags) {
      const profile = createEmptyTagProfile()
      profile.styles[style] = 0.65
      candidateTasks.push(searchMusic(getTagLabel('styles', style), TAG_SEARCH_LIMIT).then(list => list.map((musicInfo, order) => ({
        musicInfo,
        route: 'tag' as const,
        queryArtist: null,
        order,
        similarity: 0.2,
        profile: buildCandidateProfile(musicInfo, null, metadata, profile),
      }))))
    }
  }

  const allCandidates: Candidate[] = (await Promise.all(candidateTasks)).flat()
  const exposures = await getRecommendationExposures()
  const scoreOptions = { seed, scene, exposures }
  const filterDislike = (candidates: Candidate[]) => candidates.filter(candidate => !hasDislike(candidate.musicInfo))
  let scored: ScoredCandidate[] = scoreCandidates(filterDislike(allCandidates), preferences, scoreOptions)
  let selected = selectDiverse(scored, DAILY_LIMIT, seed + 37)

  if (selected.length < DAILY_LIMIT) {
    const hotList = await getHotCandidates(seed)
    const hotCandidates = hotList.map((musicInfo, order): Candidate => ({
      musicInfo,
      route: 'hot',
      queryArtist: null,
      order,
      similarity: 0,
      profile: buildCandidateProfile(musicInfo, null, metadata),
    }))
    allCandidates.push(...hotCandidates)
    scored = scoreCandidates(filterDislike(allCandidates), preferences, scoreOptions)
    selected = selectDiverse(scored, DAILY_LIMIT, seed + 37)
  }

  if (selected.length < DAILY_LIMIT && force && preferences.knownKeys.size > originalKnownKeys.size) {
    preferences.knownKeys = originalKnownKeys
    scored = scoreCandidates(filterDislike(allCandidates), preferences, scoreOptions)
    selected = selectDiverse(scored, DAILY_LIMIT, seed + 37)
  }
  if (!selected.length) throw new Error('No recommendation candidates')

  const list = selected.slice(0, DAILY_LIMIT).map(item => item.musicInfo)
  const personalized = behavior.seeds.length > 0 && selected.some(item => item.route != 'hot')
  const result: DailyRecommendationResult = {
    version: 2,
    date,
    scene,
    list,
    artists: sortedArtists.slice(0, 4).map(artist => artist.name),
    tags: getPreferenceLabels(preferences),
    personalized,
  }
  try {
    await saveData(storageDataPrefix.dailyRecommendationCache, result)
  } catch (error) {
    console.log('cache daily recommendation failed:', error)
  }
  await recordRecommendationExposures(list)
  return result
}
