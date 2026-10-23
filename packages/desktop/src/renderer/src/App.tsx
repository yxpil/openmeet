import { useEffect } from 'react';
import { useAppStore, extractInviteUrl } from './store/app';
import TitleBar from './components/TitleBar';
import Toasts from './components/Toasts';
import SettingsDialog from './components/SettingsDialog';
import AuthScreen from './screens/AuthScreen';
import HomeScreen from './screens/HomeScreen';
import PrejoinScreen from './screens/PrejoinScreen';
import MeetingScreen from './screens/MeetingScreen';
import HistoryScreen from './screens/HistoryScreen';
import BrandMark from './components/BrandMark';

function BootScreen(): React.JSX.Element {
  return (
    <div className="boot-screen">
      <div className="boot-orbit">
        <BrandMark size={58} />
      </div>
      <div className="boot-title">OpenMeet</div>
      <div className="boot-subtitle">正在准备你的会议空间…</div>
    </div>
  );
}

export default function App(): React.JSX.Element {
  const screen = useAppStore((state) => state.screen);
  const appInfo = useAppStore((state) => state.appInfo);

  useEffect(() => {
    void useAppStore.getState().bootstrap();
    const unsubscribe = window.openmeet.onDeepLink((url) => {
      const inviteText = extractInviteUrl(url);
      if (inviteText) {
        // Opening a link is an explicit intent to attend: skip the confirmation step.
        useAppStore.getState().openInviteText(inviteText, true);
      } else {
        useAppStore.getState().toast('error', '邀请链接无法识别');
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const offJoin = window.openmeet.onScheduledJoin((event) =>
      useAppStore.getState().startScheduledJoin(event)
    );
    const offReminder = window.openmeet.onScheduledReminder((event) => {
      const seconds = Math.max(1, Math.round((event.at - Date.now()) / 1000));
      useAppStore.getState().toast(
        'info',
        `「${event.roomTitle}」将在 ${seconds} 秒后自动入会`,
        {
          ttlMs: Math.min(60_000, seconds * 1000 + 800),
          action: {
            label: '取消',
            run: () => {
              void useAppStore
                .getState()
                .cancelScheduled(event.id)
                .then(() => useAppStore.getState().toast('success', '已取消该定时入会'))
                .catch(() => useAppStore.getState().toast('error', '取消失败'));
            }
          }
        }
      );
    });
    const offMissed = window.openmeet.onScheduledMissed((event) => {
      useAppStore.getState().toast('error', `「${event.roomTitle}」的定时入会已过期，未执行`);
      void useAppStore.getState().refreshScheduled();
    });
    return () => {
      offJoin();
      offReminder();
      offMissed();
    };
  }, []);

  useEffect(() => {
    if (!appInfo) return;
    document.body.classList.toggle('platform-darwin', appInfo.platform === 'darwin');
    document.body.classList.toggle('platform-win', appInfo.platform === 'win32');
  }, [appInfo]);

  if (screen === 'boot') {
    return (
      <>
        <BootScreen />
        <Toasts />
      </>
    );
  }

  return (
    <div className="app-shell">
      <TitleBar />
      <div className={`app-body screen-${screen}`}>
        {screen === 'auth' && <AuthScreen />}
        {screen === 'home' && <HomeScreen />}
        {screen === 'prejoin' && <PrejoinScreen />}
        {screen === 'meeting' && <MeetingScreen />}
        {screen === 'history' && <HistoryScreen />}
      </div>
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
