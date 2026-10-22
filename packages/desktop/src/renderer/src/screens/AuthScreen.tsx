import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Eye,
  EyeOff,
  Globe2,
  KeyRound,
  Loader2,
  LockKeyhole,
  Network,
  Server,
  ShieldCheck,
  Sparkles,
  Wifi
} from 'lucide-react';
import { normalizeServerUrl } from '@openmeet/shared';
import type { ServerInfo } from '@openmeet/shared';
import { useAppStore } from '../store/app';
import { ApiRequestError, login, probeServer, register } from '../lib/api';
import BrandMark from '../components/BrandMark';

type AuthMode = 'login' | 'register';

function authErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return '操作失败，请稍后再试';
}

export default function AuthScreen(): React.JSX.Element {
  const storedServerUrl = useAppStore((state) => state.serverUrlDraft);
  const setServerUrlDraft = useAppStore((state) => state.setServerUrlDraft);
  const completeLogin = useAppStore((state) => state.completeLogin);
  const openInviteText = useAppStore((state) => state.openInviteText);
  const setScreen = useAppStore((state) => state.setScreen);
  const toast = useAppStore((state) => state.toast);

  const [mode, setMode] = useState<AuthMode>('login');
  const [serverUrl, setServerUrl] = useState(storedServerUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [inviteText, setInviteText] = useState('');

  useEffect(() => {
    setServerUrl(storedServerUrl);
  }, [storedServerUrl]);

  const checkServer = async (): Promise<ServerInfo | null> => {
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized) {
      setServerError('请输入形如 http://主机:8787 的服务器地址');
      setServerInfo(null);
      return null;
    }
    setProbing(true);
    setServerError(null);
    try {
      const info = await probeServer(normalized, 6000);
      setServerInfo(info);
      setServerUrl(normalized);
      setServerUrlDraft(normalized);
      if (info.mode === 'lan') {
        setServerError('这是局域网主机的地址，请使用下方的邀请加入或局域网入口');
      }
      return info;
    } catch (error) {
      setServerInfo(null);
      setServerError(authErrorMessage(error));
      return null;
    } finally {
      setProbing(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized) {
      setServerError('服务器地址不合法');
      return;
    }
    setBusy(true);
    setServerError(null);
    try {
      const info = serverInfo ?? (await probeServer(normalized, 6000));
      setServerInfo(info);
      if (info.mode === 'lan') {
        throw new Error('该地址是局域网主机，请通过邀请加入');
      }
      if (mode === 'register' && info.registration === 'closed') {
        throw new Error('该服务器已关闭注册');
      }
      const response =
        mode === 'login'
          ? await login(normalized, { username, password })
          : await register(normalized, {
              username,
              password,
              displayName: displayName.trim() || username
            });
      await completeLogin(response, normalized, info);
      toast('success', mode === 'login' ? '已登录' : '账号已创建');
    } catch (error) {
      setServerError(authErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const handleInvite = () => {
    if (!inviteText.trim()) {
      toast('error', '请先粘贴邀请内容');
      return;
    }
    openInviteText(inviteText.trim());
  };

  return (
    <div className="auth-screen">
      <section className="auth-hero">
        <div className="auth-hero-top">
          <div className="brand-lockup">
            <BrandMark size={38} />
            <div>
              <div className="brand-name">OpenMeet</div>
              <div className="brand-tag">开放、可控的会议空间</div>
            </div>
          </div>
          <span className="version-chip">v0.1 · MIT</span>
        </div>

        <div className="auth-hero-copy">
          <span className="eyebrow">
            <Sparkles size={14} />
            自托管 · 局域网优先
          </span>
          <h1>
            开会，
            <br />
            不必把数据交出去。
          </h1>
          <p>
            用你自己的服务器建立会议。局域网内 IPv4 / IPv6 直连，跨网络走 STUN，
            必要时用 TURN 桥接。聊天与历史留在本机。
          </p>
        </div>

        <div className="network-illustration" aria-hidden="true">
          <div className="network-ring ring-one" />
          <div className="network-ring ring-two" />
          <div className="network-node node-main">
            <BrandMark size={28} />
          </div>
          <div className="network-node node-a">
            <Wifi size={17} />
          </div>
          <div className="network-node node-b">
            <Globe2 size={17} />
          </div>
          <div className="network-node node-c">
            <Server size={17} />
          </div>
          <span className="network-label label-a">LAN IPv4</span>
          <span className="network-label label-b">IPv6</span>
          <span className="network-label label-c">TURN 桥接</span>
        </div>

        <div className="auth-feature-row">
          <div>
            <ShieldCheck size={18} />
            <span>账号与房间访问控制</span>
          </div>
          <div>
            <Network size={18} />
            <span>WebRTC Mesh 直连</span>
          </div>
          <div>
            <LockKeyhole size={18} />
            <span>本地加密保存登录</span>
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-tabs">
            <button
              className={mode === 'login' ? 'active' : ''}
              onClick={() => setMode('login')}
              type="button"
            >
              登录
            </button>
            <button
              className={mode === 'register' ? 'active' : ''}
              onClick={() => setMode('register')}
              type="button"
            >
              注册账号
            </button>
          </div>

          <form onSubmit={handleSubmit} className="auth-form">
            <label className="field">
              <span className="field-label">服务器</span>
              <div className="field-with-action">
                <Server size={16} />
                <input
                  value={serverUrl}
                  onChange={(event) => {
                    setServerUrl(event.target.value);
                    setServerInfo(null);
                    setServerError(null);
                  }}
                  onBlur={() => {
                    const normalized = normalizeServerUrl(serverUrl);
                    if (normalized) setServerUrl(normalized);
                  }}
                  placeholder="http://localhost:8787"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button type="button" className="field-action" onClick={() => void checkServer()} disabled={probing}>
                  {probing ? <Loader2 size={14} className="spin" /> : '检测'}
                </button>
              </div>
              {serverInfo && (
                <span className="field-hint success">
                  {serverInfo.name} · {serverInfo.mode === 'lan' ? '局域网主机' : serverInfo.registration === 'open' ? '开放注册' : '关闭注册'}
                </span>
              )}
              {serverError && <span className="field-hint error">{serverError}</span>}
            </label>

            <label className="field">
              <span className="field-label">用户名</span>
              <div className="field-with-icon">
                <KeyRound size={16} />
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="字母、数字、下划线"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={32}
                />
              </div>
            </label>

            {mode === 'register' && (
              <label className="field">
                <span className="field-label">显示名称</span>
                <div className="field-with-icon">
                  <Sparkles size={16} />
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="会议中展示的名字"
                    maxLength={40}
                  />
                </div>
              </label>
            )}

            <label className="field">
              <span className="field-label">密码</span>
              <div className="field-with-icon">
                <LockKeyhole size={16} />
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type={showPassword ? 'text' : 'password'}
                  placeholder={mode === 'register' ? '至少 8 个字符' : '输入密码'}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  required
                  minLength={mode === 'register' ? 8 : 1}
                  maxLength={128}
                />
                <button
                  type="button"
                  className="field-icon-button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </label>

            <button type="submit" className="primary-button wide" disabled={busy}>
              {busy ? <Loader2 size={17} className="spin" /> : <ArrowRight size={17} />}
              {mode === 'login' ? '进入 OpenMeet' : '创建账号并登录'}
            </button>
          </form>

          <div className="auth-divider">
            <span>没有账号，也可以加入</span>
          </div>

          <div className="invite-entry">
            <textarea
              value={inviteText}
              onChange={(event) => setInviteText(event.target.value)}
              placeholder="粘贴 OM1. 开头的邀请内容"
              rows={2}
            />
            <button type="button" className="secondary-button" onClick={handleInvite}>
              凭邀请加入
            </button>
          </div>

          <button
            type="button"
            className="local-entry"
            onClick={() => {
              setScreen('home');
              toast('info', '已进入局域网模式，可从首页发起或加入局域网会议');
            }}
          >
            <Wifi size={17} />
            <span>
              <strong>局域网会议</strong>
              <small>无需账号，设备间直连</small>
            </span>
            <ArrowRight size={16} />
          </button>
        </div>

        <p className="auth-footnote">
          登录令牌由系统安全存储加密；会议聊天与历史只写入本机 SQLite。
        </p>
      </section>
    </div>
  );
}
