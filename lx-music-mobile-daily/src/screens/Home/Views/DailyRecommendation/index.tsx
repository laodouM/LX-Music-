import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import OnlineList, { type OnlineListType } from '@/components/OnlineList'
import Button from '@/components/common/Button'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { LIST_IDS } from '@/config/constant'
import { getDailyRecommendation, type DailyRecommendationResult, type DailyScene } from '@/core/dailyRecommendation'
import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'

interface HeaderProps {
  info: DailyRecommendationResult | null
  scene: DailyScene
  loading: boolean
  error: boolean
  onPlayAll: () => void
  onRefresh: () => void
  onSceneChange: (scene: DailyScene) => void
}

const Header = memo(({ info, scene, loading, error, onPlayAll, onRefresh, onSceneChange }: HeaderProps) => {
  const t = useI18n()
  const theme = useTheme()
  const scenes: Array<{ id: DailyScene, label: string }> = [
    { id: 'all', label: t('daily_scene_all') },
    { id: 'calm', label: t('daily_scene_calm') },
    { id: 'focus', label: t('daily_scene_focus') },
    { id: 'workout', label: t('daily_scene_workout') },
    { id: 'night', label: t('daily_scene_night') },
    { id: 'commute', label: t('daily_scene_commute') },
  ]
  const sceneLabel = scenes.find(item => item.id == scene)?.label ?? scenes[0].label
  const description = scene != 'all'
    ? t('daily_scene_subtitle', { scene: sceneLabel })
    : info && !info.personalized ? t('daily_hot_subtitle') : t('daily_subtitle')

  return (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Icon name="thumbs-up" size={25} color={theme['c-primary']} />
        <View style={styles.titleContent}>
          <Text size={24} color={theme['c-font']}>{t('nav_daily')}</Text>
          <Text size={12} color={theme['c-font-label']}>{new Date().toLocaleDateString()}</Text>
        </View>
      </View>
      <Text style={styles.description} size={13} color={theme['c-font-label']}>{description}</Text>
      <View style={styles.scenes}>
        {scenes.map(item => {
          const selected = item.id == scene
          return (
            <Button
              key={item.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={{
                ...styles.sceneButton,
                backgroundColor: theme['c-button-background'],
                borderColor: selected ? theme['c-primary'] : theme['c-button-background'],
              }}
              disabled={loading}
              onPress={() => { onSceneChange(item.id) }}
            >
              <Text size={12} color={selected ? theme['c-primary'] : theme['c-font-label']}>{item.label}</Text>
            </Button>
          )
        })}
      </View>
      {
        info?.tags.length
          ? <Text style={styles.preferences} size={13} color={theme['c-primary']}>{t('daily_preferences', { tags: info.tags.join(' · ') })}</Text>
          : null
      }
      <View style={styles.actions}>
        <Button
          style={{ ...styles.actionButton, backgroundColor: theme['c-button-background'] }}
          disabled={loading || !info?.list.length}
          onPress={onPlayAll}
        >
          <Icon name="play" size={15} color={theme['c-button-font']} />
          <Text style={styles.actionText} size={13} color={theme['c-button-font']}>{t('daily_play_all')}</Text>
        </Button>
        <Button
          style={{ ...styles.actionButton, backgroundColor: theme['c-button-background'] }}
          disabled={loading}
          onPress={onRefresh}
        >
          <Icon name="available_updates" size={16} color={theme['c-button-font']} />
          <Text style={styles.actionText} size={13} color={theme['c-button-font']}>{t('daily_refresh')}</Text>
        </Button>
      </View>
      <Text size={11} color={theme['c-font-label']}>{t('daily_privacy')}</Text>
      {error ? <Text style={styles.error} size={13} color={theme['c-primary']}>{t('daily_error')}</Text> : null}
    </View>
  )
})

export default () => {
  const listRef = useRef<OnlineListType>(null)
  const requestIdRef = useRef(0)
  const sceneRef = useRef<DailyScene>('all')
  const [info, setInfo] = useState<DailyRecommendationResult | null>(null)
  const [scene, setScene] = useState<DailyScene>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const loadRecommendations = useCallback(async(force: boolean, refreshing = false, requestedScene?: DailyScene) => {
    const targetScene = requestedScene ?? sceneRef.current
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(false)
    listRef.current?.setStatus(refreshing ? 'refreshing' : 'loading')
    try {
      const result = await getDailyRecommendation(force, targetScene)
      if (requestId != requestIdRef.current) return
      setInfo(result)
      listRef.current?.setList(result.list, false, true)
      listRef.current?.setStatus('end')
    } catch (error) {
      console.log('load daily recommendation failed:', error)
      if (requestId != requestIdRef.current) return
      setError(true)
      listRef.current?.setStatus('error')
    } finally {
      if (requestId == requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const requestId = requestIdRef
    void loadRecommendations(false)
    return () => {
      requestId.current++
    }
  }, [loadRecommendations])

  const playAtIndex = useCallback((index: number) => {
    if (!info?.list.length) return
    void setTempList(`daily_${info.date}_${info.scene}`, [...info.list]).then(async() => {
      await playList(LIST_IDS.TEMP, index)
    }).catch(error => {
      console.log('play daily recommendation failed:', error)
    })
  }, [info])

  const handleRetry = useCallback(() => {
    if (error && !loading) void loadRecommendations(true)
  }, [error, loading, loadRecommendations])

  const handleSceneChange = useCallback((nextScene: DailyScene) => {
    if (nextScene == sceneRef.current || loading) return
    sceneRef.current = nextScene
    setScene(nextScene)
    void loadRecommendations(true, false, nextScene)
  }, [loading, loadRecommendations])

  return (
    <OnlineList
      ref={listRef}
      onPlayList={playAtIndex}
      onRefresh={() => { void loadRecommendations(true, true) }}
      onLoadMore={handleRetry}
      ListHeaderComponent={
        <Header
          info={info}
          scene={scene}
          loading={loading}
          error={error}
          onPlayAll={() => { playAtIndex(0) }}
          onRefresh={() => { void loadRecommendations(true) }}
          onSceneChange={handleSceneChange}
        />
      }
      checkHomePagerIdle
      rowType="full"
    />
  )
}

const styles = createStyle({
  header: {
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 15,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  titleContent: {
    marginLeft: 12,
  },
  description: {
    marginTop: 14,
    lineHeight: 20,
  },
  scenes: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
    marginBottom: 4,
  },
  sceneButton: {
    minHeight: 40,
    paddingHorizontal: 15,
    marginRight: 8,
    marginBottom: 8,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  preferences: {
    marginTop: 7,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    marginTop: 16,
    marginBottom: 12,
  },
  actionButton: {
    minHeight: 40,
    paddingHorizontal: 16,
    marginRight: 12,
    borderRadius: 5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    marginLeft: 7,
  },
  error: {
    marginTop: 10,
  },
})
