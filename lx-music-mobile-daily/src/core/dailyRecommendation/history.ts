import { storageDataPrefix } from '@/config/constant'
import { getData, saveData } from '@/plugins/storage'

export interface ListenRecord {
  musicInfo: LX.Music.MusicInfo
  playCount: number
  lastPlayedAt: number
}

const MAX_HISTORY_SIZE = 300
const COUNT_INTERVAL = 60 * 1000

let historyCache: ListenRecord[] | null = null
let writeQueue: Promise<void> = Promise.resolve()

export const normalizeText = (text: string) => text
  .toLocaleLowerCase()
  .replace(/[\s\-_—–·•,，.。!！?？:：;；'’"“”‘’()（）[\]【】]/g, '')

export const getTrackKey = (musicInfo: Pick<LX.Music.MusicInfo, 'name' | 'singer'>) => {
  return `${normalizeText(musicInfo.name)}__${normalizeText(musicInfo.singer)}`
}

const loadHistory = async(): Promise<ListenRecord[]> => {
  if (historyCache) return historyCache
  const saved = await getData<ListenRecord[]>(storageDataPrefix.dailyListenHistory)
  // eslint-disable-next-line require-atomic-updates
  historyCache = Array.isArray(saved)
    ? saved.filter(item => item?.musicInfo?.id && item.musicInfo.name && item.musicInfo.singer != null)
    : []
  return historyCache
}

export const getListenHistory = async(): Promise<ListenRecord[]> => {
  await writeQueue
  return [...await loadHistory()]
}

export const recordMusicPlay = async(musicInfo: LX.Music.MusicInfo): Promise<void> => {
  writeQueue = writeQueue.then(async() => {
    const history = await loadHistory()
    const now = Date.now()
    const key = getTrackKey(musicInfo)
    const index = history.findIndex(item => getTrackKey(item.musicInfo) == key)
    if (index < 0) {
      history.unshift({ musicInfo, playCount: 1, lastPlayedAt: now })
    } else {
      const previous = history[index]
      history.splice(index, 1)
      history.unshift({
        musicInfo,
        playCount: previous.playCount + (now - previous.lastPlayedAt >= COUNT_INTERVAL ? 1 : 0),
        lastPlayedAt: now,
      })
    }
    history.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    if (history.length > MAX_HISTORY_SIZE) history.splice(MAX_HISTORY_SIZE)
    await saveData(storageDataPrefix.dailyListenHistory, history)
  }).catch(error => {
    console.log('save daily listen history failed:', error)
  })
  return writeQueue
}
