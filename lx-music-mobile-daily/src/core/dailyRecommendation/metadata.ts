import { storageDataPrefix } from '@/config/constant'
import { getData, saveData } from '@/plugins/storage'
import { normalizeText } from './history'
import {
  addRawTags,
  createEmptyTagProfile,
  getEraLabel,
  mergeTagProfiles,
  type RawTag,
  type SongTagProfile,
} from './tags'

export interface MetadataSeed {
  key: string
  name: string
  singer: string
}

export interface PublicTrack {
  key: string
  name: string
  artist: string
  recordingMbid: string | null
  artistMbids: string[]
  profile: SongTagProfile
}

export interface PublicArtist {
  name: string
  mbid: string | null
  profile: SongTagProfile
}

export interface SimilarTrack {
  sourceKey: string
  recordingMbid: string
  name: string
  artist: string
  score: number
  profile: SongTagProfile
}

export interface SimilarArtist {
  sourceArtist: string
  mbid: string
  name: string
  score: number
}

export interface PublicDiscovery {
  tracks: Record<string, PublicTrack>
  artists: Record<string, PublicArtist>
  artistMbids: Record<string, string>
  similarTracks: SimilarTrack[]
  similarArtists: SimilarArtist[]
}

interface CacheEntry<T> {
  updatedAt: number
  value: T
}

interface MetadataCache {
  tracks: Record<string, CacheEntry<PublicTrack>>
  artists: Record<string, CacheEntry<PublicArtist>>
  similarTracks: Record<string, CacheEntry<SimilarTrack[]>>
  similarArtists: Record<string, CacheEntry<SimilarArtist[]>>
}

const CACHE_TTL = 30 * 86400000
const NEGATIVE_CACHE_TTL = 2 * 86400000
const REQUEST_TIMEOUT = 6500
const METADATA_BUDGET = 18000
const MAX_RECORDING_SEARCHES = 5
const MAX_ARTIST_SEARCHES = 6
const MAX_SIMILAR_SEEDS = 4
const MB_ROOT = 'https://musicbrainz.org/ws/2'
const LABS_ROOT = 'https://labs.api.listenbrainz.org'
const SIMILAR_TRACK_ALGORITHM = 'session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30'
const SIMILAR_ARTIST_ALGORITHM = 'session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30'
const USER_AGENT = 'LXMusicDaily/1.9.2 (https://github.com/lyswhut/lx-music-mobile)'

const emptyCache = (): MetadataCache => ({ tracks: {}, artists: {}, similarTracks: {}, similarArtists: {} })
let cachePromise: Promise<MetadataCache> | null = null
let musicBrainzQueue: Promise<void> = Promise.resolve()
let lastMusicBrainzRequest = 0

const loadCache = async() => {
  if (!cachePromise) {
    cachePromise = getData<MetadataCache>(storageDataPrefix.dailyMetadataCache).then(saved => ({
      ...emptyCache(),
      ...(saved ?? {}),
      tracks: saved?.tracks ?? {},
      artists: saved?.artists ?? {},
      similarTracks: saved?.similarTracks ?? {},
      similarArtists: saved?.similarArtists ?? {},
    })).catch(error => {
      console.log('load daily metadata cache failed:', error)
      return emptyCache()
    })
  }
  return cachePromise
}

const pruneEntries = <T>(entries: Record<string, CacheEntry<T>>, limit: number) => {
  const keys = Object.keys(entries)
  if (keys.length <= limit) return
  keys.sort((a, b) => entries[a].updatedAt - entries[b].updatedAt)
  for (const key of keys.slice(0, keys.length - limit)) delete entries[key]
}

const saveCache = async(cache: MetadataCache) => {
  pruneEntries(cache.tracks, 240)
  pruneEntries(cache.artists, 120)
  pruneEntries(cache.similarTracks, 160)
  pruneEntries(cache.similarArtists, 100)
  try {
    await saveData(storageDataPrefix.dailyMetadataCache, cache)
  } catch (error) {
    console.log('save daily metadata cache failed:', error)
  }
}

const isFresh = <T>(entry: CacheEntry<T> | undefined, negative = false): entry is CacheEntry<T> => {
  if (!entry?.updatedAt) return false
  return Date.now() - entry.updatedAt < (negative ? NEGATIVE_CACHE_TTL : CACHE_TTL)
}

const fetchJson = async(url: string, timeout = REQUEST_TIMEOUT): Promise<any> => {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeout)
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) throw new Error('Unexpected metadata response')
    return response.json()
  } finally {
    clearTimeout(timer)
  }
}

const wait = async(duration: number) => new Promise(resolve => setTimeout(resolve, duration))

const fetchMusicBrainz = async(path: string, deadline: number) => {
  if (Date.now() >= deadline) throw new Error('Metadata time budget exhausted')
  let resolveTask: () => void = () => {}
  const previous = musicBrainzQueue
  musicBrainzQueue = new Promise<void>(resolve => { resolveTask = resolve })
  await previous
  try {
    const delay = Math.max(0, 1050 - (Date.now() - lastMusicBrainzRequest))
    if (delay) await wait(delay)
    if (Date.now() >= deadline) throw new Error('Metadata time budget exhausted')
    // Requests are serialized by musicBrainzQueue, so this timestamp cannot race.
    // eslint-disable-next-line require-atomic-updates
    lastMusicBrainzRequest = Date.now()
    return await fetchJson(`${MB_ROOT}${path}`)
  } finally {
    resolveTask()
  }
}

const escapeQuery = (value: string) => value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1')
const encodeQuery = (value: string) => encodeURIComponent(value)
const getRawTags = (value: any): RawTag[] => {
  const tags = Array.isArray(value?.tags) ? value.tags : []
  const genres = Array.isArray(value?.genres) ? value.genres : []
  return [...tags, ...genres].map((tag: any) => ({
    name: String(tag.name ?? ''),
    count: typeof tag.count == 'number' ? tag.count : undefined,
  })).filter((tag: RawTag) => tag.name)
}

const artistNames = (recording: any): string[] => {
  if (!Array.isArray(recording?.['artist-credit'])) return []
  return recording['artist-credit'].flatMap((credit: any) => {
    const names: string[] = [credit?.artist?.name, credit?.name]
      .filter((name: unknown): name is string => typeof name == 'string')
    if (Array.isArray(credit?.artist?.aliases)) {
      const aliases = credit.artist.aliases.map((alias: any) => String(alias?.name ?? '')).filter(Boolean) as string[]
      names.push(...aliases)
    }
    return names.map(name => normalizeText(name))
  })
}

const selectRecording = (recordings: any[], seed: MetadataSeed) => {
  const title = normalizeText(seed.name)
  const singer = normalizeText(seed.singer)
  return recordings.map(recording => {
    const recordingTitle = normalizeText(String(recording.title ?? ''))
    const artists = artistNames(recording)
    let score = Number(recording.score ?? 0) / 100
    if (recordingTitle == title) score += 5
    else if (recordingTitle.includes(title) || title.includes(recordingTitle)) score += 1
    if (artists.some(artist => singer.includes(artist) || artist.includes(singer))) score += 4
    if (recording.video) score -= 0.4
    if (recording['first-release-date']) score += 0.2
    return { recording, score }
  }).sort((a, b) => b.score - a.score)[0]?.recording ?? null
}

const emptyTrack = (seed: MetadataSeed): PublicTrack => ({
  key: seed.key,
  name: seed.name,
  artist: seed.singer,
  recordingMbid: null,
  artistMbids: [],
  profile: createEmptyTagProfile(),
})

const searchTrack = async(seed: MetadataSeed, deadline: number): Promise<PublicTrack> => {
  const primaryArtist = seed.singer.split(/[,，、;&；|/]/)[0].trim() || seed.singer
  const query = `recording:"${escapeQuery(seed.name)}" AND artist:"${escapeQuery(primaryArtist)}"`
  const path = `/recording/?query=${encodeQuery(query)}&fmt=json&limit=4&inc=artist-credits%2Btags%2Bgenres`
  const response = await fetchMusicBrainz(path, deadline)
  const recordings = (Array.isArray(response?.recordings) ? response.recordings : []) as any[]
  const recording = selectRecording(recordings, seed)
  if (!recording) return emptyTrack(seed)
  const profile = addRawTags(createEmptyTagProfile(), getRawTags(recording))
  const releaseDate = typeof recording['first-release-date'] == 'string' ? recording['first-release-date'] : null
  profile.era = getEraLabel(releaseDate)
  const credits = Array.isArray(recording['artist-credit']) ? recording['artist-credit'] : []
  return {
    key: seed.key,
    name: String(recording.title ?? seed.name),
    artist: credits.map((credit: any) => credit?.artist?.name ?? credit?.name).filter(Boolean).join('、') || seed.singer,
    recordingMbid: recording.id ?? null,
    artistMbids: credits.map((credit: any) => credit?.artist?.id).filter(Boolean),
    profile,
  }
}

const searchArtist = async(name: string, mbid: string | null, deadline: number): Promise<PublicArtist> => {
  let artist: any = null
  if (mbid) {
    artist = await fetchMusicBrainz(`/artist/${mbid}?fmt=json&inc=tags%2Bgenres`, deadline)
  } else {
    const path = `/artist/?query=${encodeQuery(`artist:"${escapeQuery(name)}"`)}&fmt=json&limit=3&inc=tags%2Bgenres`
    const response = await fetchMusicBrainz(path, deadline)
    const artists = Array.isArray(response?.artists) ? response.artists : []
    const normalizedName = normalizeText(name)
    artist = artists.map((item: any) => {
      const names = [item.name, item['sort-name'], ...(item.aliases ?? []).map((alias: any) => alias.name)]
        .filter(Boolean).map((value: string) => normalizeText(value))
      return { item, exact: names.some((value: string) => value == normalizedName) }
    }).sort((a: any, b: any) => Number(b.exact) - Number(a.exact) || Number(b.item.score ?? 0) - Number(a.item.score ?? 0))[0]?.item
  }
  return {
    name,
    mbid: artist?.id ?? mbid,
    profile: addRawTags(createEmptyTagProfile(), getRawTags(artist)),
  }
}

const fetchSimilarTracks = async(track: PublicTrack, sourceProfile: SongTagProfile): Promise<SimilarTrack[]> => {
  if (!track.recordingMbid) return []
  const url = `${LABS_ROOT}/similar-recordings/json?recording_mbids=${track.recordingMbid}&algorithm=${SIMILAR_TRACK_ALGORITHM}`
  const response = await fetchJson(url)
  if (!Array.isArray(response)) return []
  return response.flatMap((item: any): SimilarTrack[] => {
    if (!item?.recording_mbid || !item.recording_name || !item.artist_credit_name) return []
    const profile = createEmptyTagProfile()
    mergeTagProfiles(profile, sourceProfile, 0.45)
    return [{
      sourceKey: track.key,
      recordingMbid: item.recording_mbid,
      name: String(item.recording_name),
      artist: String(item.artist_credit_name),
      score: Math.max(0, Number(item.score ?? 0)),
      profile,
    }]
  }).slice(0, 20)
}

const fetchSimilarArtists = async(artistKey: string, mbid: string): Promise<SimilarArtist[]> => {
  const url = `${LABS_ROOT}/similar-artists/json?artist_mbids=${mbid}&algorithm=${SIMILAR_ARTIST_ALGORITHM}`
  const response = await fetchJson(url)
  if (!Array.isArray(response)) return []
  return response.flatMap((item: any): SimilarArtist[] => {
    if (!item?.artist_mbid || !item.name) return []
    return [{
      sourceArtist: artistKey,
      mbid: item.artist_mbid,
      name: String(item.name),
      score: Math.max(0, Number(item.score ?? 0)),
    }]
  }).slice(0, 25)
}

const emptyDiscovery = (): PublicDiscovery => ({
  tracks: {},
  artists: {},
  artistMbids: {},
  similarTracks: [],
  similarArtists: [],
})

export const discoverPublicMetadata = async(
  seeds: MetadataSeed[],
  preferredArtists: string[],
): Promise<PublicDiscovery> => {
  const cache = await loadCache()
  const result = emptyDiscovery()
  const deadline = Date.now() + METADATA_BUDGET
  let recordingSearches = 0

  for (const seed of seeds.slice(0, MAX_RECORDING_SEARCHES)) {
    const cached = cache.tracks[seed.key]
    const cachedValue = cached?.value
    if (isFresh(cached, !cached?.value.recordingMbid)) {
      result.tracks[seed.key] = cached.value
      continue
    }
    if (recordingSearches >= MAX_RECORDING_SEARCHES || Date.now() >= deadline) break
    recordingSearches++
    try {
      const track = await searchTrack(seed, deadline)
      cache.tracks[seed.key] = { updatedAt: Date.now(), value: track }
      result.tracks[seed.key] = track
    } catch (error) {
      console.log('daily recording metadata failed:', error)
      const fallback = cachedValue ?? emptyTrack(seed)
      cache.tracks[seed.key] = { updatedAt: Date.now(), value: fallback }
      result.tracks[seed.key] = fallback
    }
  }

  const artistSeeds = preferredArtists.slice(0, MAX_ARTIST_SEARCHES).map(name => ({
    name,
    key: normalizeText(name),
    mbid: null as string | null,
  }))
  for (const track of Object.values(result.tracks)) {
    const seed = seeds.find(item => item.key == track.key)
    const artistKey = seed ? normalizeText(seed.singer.split(/[,，、;&；|/]/)[0]) : ''
    const mbid = track.artistMbids[0]
    if (!artistKey || !mbid) continue
    result.artistMbids[artistKey] = mbid
    const preferred = artistSeeds.find(item => item.key == artistKey)
    if (preferred) preferred.mbid = mbid
  }

  let artistSearches = 0
  for (const seed of artistSeeds) {
    if (!seed.key) continue
    const cached = cache.artists[seed.key]
    const cachedValue = cached?.value
    if (isFresh(cached, !cached?.value.mbid)) {
      result.artists[seed.key] = cached.value
      if (cached.value.mbid) result.artistMbids[seed.key] = cached.value.mbid
      continue
    }
    if (artistSearches >= MAX_ARTIST_SEARCHES || Date.now() >= deadline) break
    artistSearches++
    try {
      const artist = await searchArtist(seed.name, seed.mbid ?? result.artistMbids[seed.key] ?? null, deadline)
      cache.artists[seed.key] = { updatedAt: Date.now(), value: artist }
      result.artists[seed.key] = artist
      if (artist.mbid) result.artistMbids[seed.key] = artist.mbid
    } catch (error) {
      console.log('daily artist metadata failed:', error)
      const fallback = cachedValue ?? { name: seed.name, mbid: seed.mbid, profile: createEmptyTagProfile() }
      cache.artists[seed.key] = { updatedAt: Date.now(), value: fallback }
      result.artists[seed.key] = fallback
    }
  }

  const similarTrackTasks: Array<Promise<void>> = []
  if (Date.now() < deadline) {
    for (const track of Object.values(result.tracks).slice(0, MAX_SIMILAR_SEEDS)) {
      if (!track.recordingMbid) continue
      const cached = cache.similarTracks[track.recordingMbid]
      const cachedValue = cached?.value ?? []
      if (isFresh(cached, !cachedValue.length)) {
        result.similarTracks.push(...cached.value)
        continue
      }
      similarTrackTasks.push(fetchSimilarTracks(track, track.profile).then(list => {
        cache.similarTracks[track.recordingMbid!] = { updatedAt: Date.now(), value: list }
        result.similarTracks.push(...list)
      }).catch(error => {
        console.log('daily similar tracks failed:', error)
        result.similarTracks.push(...cachedValue)
      }))
    }
  }

  const artistTasks: Array<Promise<void>> = []
  if (Date.now() < deadline) {
    const uniqueArtists = Object.entries(result.artistMbids).slice(0, MAX_SIMILAR_SEEDS)
    for (const [artistKey, mbid] of uniqueArtists) {
      const cached = cache.similarArtists[mbid]
      const cachedValue = cached?.value ?? []
      if (isFresh(cached, !cachedValue.length)) {
        result.similarArtists.push(...cached.value)
        continue
      }
      artistTasks.push(fetchSimilarArtists(artistKey, mbid).then(list => {
        cache.similarArtists[mbid] = { updatedAt: Date.now(), value: list }
        result.similarArtists.push(...list)
      }).catch(error => {
        console.log('daily similar artists failed:', error)
        result.similarArtists.push(...cachedValue)
      }))
    }
  }
  await Promise.all([...similarTrackTasks, ...artistTasks])

  const seenTracks = new Set<string>()
  result.similarTracks = result.similarTracks.filter(track => {
    const key = normalizeText(`${track.name}__${track.artist}`)
    if (seenTracks.has(key)) return false
    seenTracks.add(key)
    return true
  })
  const seenArtists = new Set<string>()
  result.similarArtists = result.similarArtists.filter(artist => {
    const key = normalizeText(artist.name)
    if (seenArtists.has(key)) return false
    seenArtists.add(key)
    return true
  })
  await saveCache(cache)
  return result
}
