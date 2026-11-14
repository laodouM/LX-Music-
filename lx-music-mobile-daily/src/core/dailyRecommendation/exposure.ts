import { storageDataPrefix } from '@/config/constant'
import { getData, saveData } from '@/plugins/storage'
import { getTrackKey } from './history'

export interface ExposureRecord {
  key: string
  shownAt: number
}

const MAX_EXPOSURES = 400
const EXPOSURE_TTL = 14 * 86400000
let writeQueue: Promise<void> = Promise.resolve()

export const getRecommendationExposures = async(): Promise<Record<string, number>> => {
  const now = Date.now()
  const saved = await getData<ExposureRecord[]>(storageDataPrefix.dailyRecommendationExposures).catch(error => {
    console.log('load daily recommendation exposures failed:', error)
    return null
  })
  const exposures: Record<string, number> = {}
  if (!Array.isArray(saved)) return exposures
  for (const item of saved) {
    if (!item?.key || !item.shownAt || now - item.shownAt > EXPOSURE_TTL) continue
    exposures[item.key] = Math.max(exposures[item.key] ?? 0, item.shownAt)
  }
  return exposures
}

export const recordRecommendationExposures = async(list: LX.Music.MusicInfoOnline[]) => {
  writeQueue = writeQueue.then(async() => {
    const exposures = await getRecommendationExposures()
    const now = Date.now()
    for (const musicInfo of list) exposures[getTrackKey(musicInfo)] = now
    const records = Object.entries(exposures)
      .map(([key, shownAt]) => ({ key, shownAt }))
      .sort((a, b) => b.shownAt - a.shownAt)
      .slice(0, MAX_EXPOSURES)
    await saveData(storageDataPrefix.dailyRecommendationExposures, records)
  }).catch(error => {
    console.log('save daily recommendation exposures failed:', error)
  })
  return writeQueue
}
