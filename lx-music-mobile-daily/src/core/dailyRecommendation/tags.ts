export type DailyScene = 'all' | 'calm' | 'focus' | 'workout' | 'night' | 'commute'
export type DailyMood = 'calm' | 'happy' | 'sad' | 'healing' | 'romantic' | 'energetic'
export type TagDimension = 'styles' | 'languages' | 'moods' | 'scenes'
export type TagWeights = Record<string, number>

export interface SongTagProfile {
  styles: TagWeights
  languages: TagWeights
  moods: TagWeights
  scenes: TagWeights
  era: string | null
}

export interface RawTag {
  name: string
  count?: number
}

export const SCENE_IDS: Array<Exclude<DailyScene, 'all'>> = ['calm', 'focus', 'workout', 'night', 'commute']

export const STYLE_LABELS: Record<string, string> = {
  pop: '流行',
  rock: '摇滚',
  folk: '民谣',
  'r&b': 'R&B',
  electronic: '电子',
  hiphop: '嘻哈',
  jazz: '爵士',
  classical: '古典',
  metal: '金属',
  punk: '朋克',
  indie: '独立',
  ambient: '氛围',
  lofi: 'Lo-fi',
  acoustic: '原声',
  piano: '钢琴',
  instrumental: '器乐',
  soundtrack: '影视原声',
  guofeng: '国风',
}

export const LANGUAGE_LABELS: Record<string, string> = {
  mandarin: '国语',
  cantonese: '粤语',
  english: '英语',
  japanese: '日语',
  korean: '韩语',
}

export const MOOD_LABELS: Record<DailyMood, string> = {
  calm: '安静',
  happy: '快乐',
  sad: '伤感',
  healing: '治愈',
  romantic: '浪漫',
  energetic: '高能',
}

export const SCENE_LABELS: Record<DailyScene, string> = {
  all: '全部',
  calm: '安静',
  focus: '学习',
  workout: '运动',
  night: '夜晚',
  commute: '通勤',
}

export const createEmptyTagProfile = (): SongTagProfile => ({
  styles: {},
  languages: {},
  moods: {},
  scenes: {},
  era: null,
})

const normalizeTag = (tag: string) => tag
  .toLocaleLowerCase()
  .trim()
  .replace(/[._/]/g, ' ')
  .replace(/\s+/g, ' ')

const addTag = (target: TagWeights, tag: string, value: number) => {
  const weight = Math.max(0, Math.min(1, value))
  if (!weight) return
  target[tag] = Math.min(1, (target[tag] ?? 0) + weight)
}

const hasTag = (tag: string, values: string[]) => values.some(value => tag == value || tag.includes(value))

const addStyleTags = (profile: SongTagProfile, rawTag: string, weight: number) => {
  const tag = normalizeTag(rawTag)
  if (!tag) return
  if (hasTag(tag, ['mandopop', 'cantopop', 'chinese pop', 'c pop', 'cpop'])) addTag(profile.styles, 'pop', weight)
  else if (hasTag(tag, ['synthpop', 'synth pop', 'electropop', 'dance pop', 'pop'])) addTag(profile.styles, 'pop', weight * 0.8)
  if (hasTag(tag, ['folk rock', 'folk'])) addTag(profile.styles, 'folk', weight)
  if (hasTag(tag, ['alternative rock', 'indie rock', 'soft rock', 'rock'])) addTag(profile.styles, 'rock', weight)
  if (hasTag(tag, ['rhythm and blues', 'rnb', 'r&b', 'contemporary r'])) addTag(profile.styles, 'r&b', weight)
  if (hasTag(tag, ['electronica', 'electronic', 'edm', 'house', 'techno', 'trance', 'synthwave'])) addTag(profile.styles, 'electronic', weight)
  if (hasTag(tag, ['hip hop', 'hiphop', 'rap'])) addTag(profile.styles, 'hiphop', weight)
  if (hasTag(tag, ['smooth jazz', 'jazz'])) addTag(profile.styles, 'jazz', weight)
  if (hasTag(tag, ['classical', 'orchestral', 'symphony'])) addTag(profile.styles, 'classical', weight)
  if (hasTag(tag, ['heavy metal', 'metal'])) addTag(profile.styles, 'metal', weight)
  if (hasTag(tag, ['punk'])) addTag(profile.styles, 'punk', weight)
  if (hasTag(tag, ['indie', 'independent'])) addTag(profile.styles, 'indie', weight * 0.8)
  if (hasTag(tag, ['ambient', 'downtempo'])) addTag(profile.styles, 'ambient', weight)
  if (hasTag(tag, ['lo fi', 'lofi', 'chillhop'])) addTag(profile.styles, 'lofi', weight)
  if (hasTag(tag, ['acoustic', 'unplugged'])) addTag(profile.styles, 'acoustic', weight)
  if (hasTag(tag, ['piano'])) addTag(profile.styles, 'piano', weight)
  if (hasTag(tag, ['instrumental'])) addTag(profile.styles, 'instrumental', weight)
  if (hasTag(tag, ['soundtrack', 'score', 'anime'])) addTag(profile.styles, 'soundtrack', weight * 0.8)
  if (hasTag(tag, ['guofeng', 'chinese traditional', 'chinese folk', '国风', '古风'])) addTag(profile.styles, 'guofeng', weight)
}

const addLanguageTags = (profile: SongTagProfile, rawTag: string, weight: number) => {
  const tag = normalizeTag(rawTag)
  if (hasTag(tag, ['cantopop', 'cantonese', 'hong kong pop'])) addTag(profile.languages, 'cantonese', weight)
  else if (hasTag(tag, ['mandopop', 'mandarin', 'chinese', 'cpop', 'c pop'])) addTag(profile.languages, 'mandarin', weight * 0.85)
  if (hasTag(tag, ['english', 'british', 'american'])) addTag(profile.languages, 'english', weight * 0.75)
  if (hasTag(tag, ['j pop', 'jpop', 'japanese', 'anime'])) addTag(profile.languages, 'japanese', weight * 0.85)
  if (hasTag(tag, ['k pop', 'kpop', 'korean'])) addTag(profile.languages, 'korean', weight * 0.85)
}

const addMoodAndSceneTags = (profile: SongTagProfile, rawTag: string, weight: number) => {
  const tag = normalizeTag(rawTag)
  if (hasTag(tag, ['calm', 'quiet', 'chill', 'relax', 'peaceful', 'mellow', 'soft', 'slow', 'ambient'])) {
    addTag(profile.moods, 'calm', weight * 0.85)
    addTag(profile.scenes, 'night', weight * 0.5)
  }
  if (hasTag(tag, ['happy', 'cheerful', 'feel good', 'sunshine', 'upbeat'])) addTag(profile.moods, 'happy', weight)
  if (hasTag(tag, ['sad', 'melanchol', 'heartbreak', 'bittersweet', 'emotional'])) addTag(profile.moods, 'sad', weight * 0.85)
  if (hasTag(tag, ['healing', 'soothing', 'warm', 'comfort'])) addTag(profile.moods, 'healing', weight)
  if (hasTag(tag, ['romantic', 'romance', 'love song', 'love'])) addTag(profile.moods, 'romantic', weight * 0.8)
  if (hasTag(tag, ['energetic', 'energy', 'powerful', 'party', 'upbeat'])) addTag(profile.moods, 'energetic', weight)

  if (hasTag(tag, ['study', 'studying', 'focus', 'concentration', 'work', 'reading'])) addTag(profile.scenes, 'focus', weight)
  if (hasTag(tag, ['instrumental', 'lo fi', 'lofi', 'chillhop', 'piano', 'acoustic', 'ambient'])) {
    addTag(profile.scenes, 'focus', weight * 0.55)
    addTag(profile.scenes, 'calm', weight * 0.5)
  }
  if (hasTag(tag, ['workout', 'gym', 'running', 'sports', 'training'])) addTag(profile.scenes, 'workout', weight)
  if (hasTag(tag, ['dance', 'edm', 'energetic', 'party'])) addTag(profile.scenes, 'workout', weight * 0.55)
  if (hasTag(tag, ['sleep', 'bedtime', 'night', 'evening', 'insomnia'])) addTag(profile.scenes, 'night', weight)
  if (hasTag(tag, ['driving', 'drive', 'commute', 'road trip', 'travel', 'car'])) addTag(profile.scenes, 'commute', weight)
  if (hasTag(tag, ['relax', 'chill', 'calm', 'quiet'])) addTag(profile.scenes, 'calm', weight * 0.8)
}

export const getEraLabel = (date: string | null | undefined): string | null => {
  const yearText = date?.slice(0, 4) ?? ''
  if (!/^\d{4}$/.test(yearText)) return null
  const year = Number(yearText)
  if (year < 1900 || year > new Date().getFullYear() + 1) return null
  if (year < 1980) return '1980年前'
  return `${Math.floor(year / 10) * 10}年代`
}

export const addRawTags = (profile: SongTagProfile, tags: RawTag[], scale = 1) => {
  for (const item of tags) {
    const name = item.name?.trim()
    if (!name) continue
    const countWeight = item.count == null ? 0.65 : Math.min(1, 0.4 + Math.log2(item.count + 1) / 4)
    const weight = Math.max(0.05, Math.min(1, countWeight * scale))
    addStyleTags(profile, name, weight)
    addLanguageTags(profile, name, weight)
    addMoodAndSceneTags(profile, name, weight)
  }
  return profile
}

export const mergeTagProfiles = (target: SongTagProfile, source: SongTagProfile | null | undefined, scale = 1) => {
  if (!source) return target
  for (const dimension of ['styles', 'languages', 'moods', 'scenes'] as TagDimension[]) {
    for (const [tag, value] of Object.entries(source[dimension])) addTag(target[dimension], tag, value * scale)
  }
  if (!target.era && source.era) target.era = source.era
  return target
}

export const cloneTagProfile = (profile: SongTagProfile, scale = 1) => mergeTagProfiles(createEmptyTagProfile(), profile, scale)

export const createSceneProfile = (scene: DailyScene): SongTagProfile => {
  const profile = createEmptyTagProfile()
  if (scene == 'all') return profile
  profile.scenes[scene] = 1
  if (scene == 'calm') profile.moods.calm = 1
  if (scene == 'focus') {
    profile.styles.instrumental = 0.65
    profile.styles.lofi = 0.55
    profile.moods.calm = 0.6
  }
  if (scene == 'workout') profile.moods.energetic = 1
  if (scene == 'night') profile.moods.calm = 0.7
  return profile
}

export const getDimensionMatch = (preferences: TagWeights, candidate: TagWeights) => {
  const entries = Object.entries(preferences)
  if (!entries.length) return 0
  const maxPreference = Math.max(...entries.map(([, value]) => value), 0.0001)
  let score = 0
  for (const [tag, weight] of entries) {
    const candidateWeight = candidate[tag] ?? 0
    if (candidateWeight > 0) score += (weight / maxPreference) * Math.min(1, candidateWeight)
  }
  return Math.min(1, score)
}

export const getTopWeightedTags = (weights: TagWeights, limit: number) => Object.entries(weights)
  .filter(([, weight]) => weight > 0)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, limit)
  .map(([tag]) => tag)

export const getTagLabel = (dimension: TagDimension, tag: string) => {
  if (dimension == 'styles') return STYLE_LABELS[tag] ?? tag
  if (dimension == 'languages') return LANGUAGE_LABELS[tag] ?? tag
  if (dimension == 'moods') return MOOD_LABELS[tag as DailyMood] ?? tag
  return SCENE_LABELS[tag as DailyScene] ?? tag
}
