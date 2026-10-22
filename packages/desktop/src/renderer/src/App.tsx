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
        useAppStore.getState().openInviteText(inviteText);
      } else {
        useAppStore.getState().toast('error', '邀请链接无法识别');
      }
    });
    return unsubscribe;
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
